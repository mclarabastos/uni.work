// A fila de operacoes on-chain.
//
// O princípio: erro de rede nunca bloqueia o fluxo de produto. A operacao entra
// aqui e a tela segue. O worker (src/workers/chain.js) tira daqui e tenta de
// novo, com espera crescente entre as tentativas.
//
// Duas protecoes contra o pior erro possivel, que e pagar duas vezes:
//
//   1. o banco tem um indice unico parcial em (kind, job_id) enquanto o item
//      esta vivo, entao nao existem duas liberacoes pendentes para a mesma vaga
//   2. todo handler comeca conferindo se o trabalho ja foi feito, e sai calado
//      se foi. Reprocessar precisa ser seguro por construcao, nao por sorte.

import { query, one } from '../db/index.js'
import { newId } from '../lib/ids.js'

export const TIPOS = ['escrow_fund', 'escrow_release', 'escrow_refund', 'cert_mint', 'cert_sync']

/** Espera entre tentativas: 15s, 30s, 1min, 2min, 4min… ate o teto de 30min. */
export const BASE_BACKOFF_MS = 15_000
export const TETO_BACKOFF_MS = 30 * 60_000
export const MAX_TENTATIVAS = 8

export function esperaPara (tentativas) {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, tentativas), TETO_BACKOFF_MS)
}

/**
 * Enfileira uma operacao.
 * Se ja existe uma viva do mesmo tipo para a mesma vaga, nao cria outra:
 * devolve a que ja estava la. Enfileirar duas vezes e comum (o usuario clica
 * de novo, o worker reprocessa) e nao pode virar duas transacoes.
 */
export async function enfileirar (kind, { jobId = null, payload = {}, atrasoMs = 0, maxTentativas = MAX_TENTATIVAS } = {}) {
  if (!TIPOS.includes(kind)) throw new Error(`tipo de operação desconhecido: ${kind}`)

  if (jobId) {
    const existente = await one(
      'select id from chain_jobs where kind = $1 and job_id = $2 and done_at is null and failed_at is null',
      [kind, jobId]
    )
    if (existente) return { id: existente.id, jaEstava: true }
  }

  const id = newId('cjb')
  await query(
    `insert into chain_jobs (id, kind, job_id, payload, run_after, max_attempts)
     values ($1, $2, $3, $4, now() + make_interval(secs => $5), $6)`,
    [id, kind, jobId, JSON.stringify(payload), Math.round(atrasoMs / 1000), maxTentativas]
  )
  return { id, jaEstava: false }
}

/**
 * Pega os proximos itens prontos e marca como em processamento.
 * O "for update skip locked" e o que permite mais de um worker sem dois
 * pegarem o mesmo item.
 */
export async function reservarLote (limite = 5, quem = 'worker') {
  const { rows } = await query(
    `update chain_jobs set locked_at = now(), locked_by = $2
      where id in (
        select id from chain_jobs
         where done_at is null and failed_at is null
           and run_after <= now()
           and (locked_at is null or locked_at < now() - interval '5 minutes')
         order by run_after asc
         limit $1
         for update skip locked
      )
      returning *`,
    [limite, quem]
  )
  return rows.map((linha) => ({
    ...linha,
    payload: typeof linha.payload === 'string' ? JSON.parse(linha.payload) : (linha.payload ?? {})
  }))
}

export async function marcarConcluido (id) {
  await query('update chain_jobs set done_at = now(), locked_at = null, last_error = null where id = $1', [id])
}

/**
 * Marca a falha e reagenda, ou desiste se ja tentou demais.
 * Desistir nao apaga: o item fica com failed_at e aparece no painel, porque
 * uma operacao de dinheiro que nao completou precisa de gente olhando.
 */
export async function marcarFalha (item, erro) {
  const tentativas = Number(item.attempts) + 1
  const maximo = Number(item.max_attempts ?? MAX_TENTATIVAS)
  const mensagem = String(erro?.message ?? erro).slice(0, 500)

  // Erro permanente nao ganha oito tentativas. Falta de ambiente preparado nao
  // melhora com o tempo: a decima tentativa falha igual a primeira, e o efeito
  // de insistir e uma pilha de falhas identicas no lugar da causa. Desiste na
  // hora, com o motivo registrado. Quando o ambiente ficar pronto, o operador
  // devolve o item para a fila com reenfileirar().
  const permanente = Boolean(erro?.permanente)

  if (permanente || tentativas >= maximo) {
    await query(
      'update chain_jobs set attempts = $2, last_error = $3, failed_at = now(), locked_at = null where id = $1',
      [item.id, tentativas, mensagem]
    )
    return { desistiu: true, tentativas, permanente }
  }

  const espera = esperaPara(tentativas)
  await query(
    `update chain_jobs
        set attempts = $2, last_error = $3, locked_at = null,
            run_after = now() + make_interval(secs => $4)
      where id = $1`,
    [item.id, tentativas, mensagem, Math.round(espera / 1000)]
  )
  return { desistiu: false, tentativas, proximaTentativaEm: espera }
}

/** Devolve um item que falhou para a fila, zerando a contagem. Acao de operador. */
export async function reenfileirar (id) {
  const { rowCount } = await query(
    `update chain_jobs
        set attempts = 0, failed_at = null, locked_at = null, last_error = null, run_after = now()
      where id = $1 and done_at is null`,
    [id]
  )
  return rowCount > 0
}

/** Tudo que ainda nao terminou, para o painel e para o doctor. */
export async function estadoDaFila () {
  const { rows } = await query(`
    select
      count(*) filter (where done_at is null and failed_at is null)                    as pendentes,
      count(*) filter (where done_at is null and failed_at is null and run_after <= now()) as prontas,
      count(*) filter (where failed_at is not null)                                    as falhadas,
      count(*) filter (where done_at is not null)                                      as concluidas
    from chain_jobs
  `)
  const contagem = rows[0] ?? {}
  return {
    pendentes: Number(contagem.pendentes ?? 0),
    prontas: Number(contagem.prontas ?? 0),
    falhadas: Number(contagem.falhadas ?? 0),
    concluidas: Number(contagem.concluidas ?? 0)
  }
}

export async function listarFila ({ apenasFalhas = false, limite = 50 } = {}) {
  const { rows } = await query(
    `select id, kind, job_id, attempts, max_attempts, last_error, run_after,
            done_at, failed_at, created_at
       from chain_jobs
      ${apenasFalhas ? 'where failed_at is not null' : 'where done_at is null'}
      order by created_at desc
      limit $1`,
    [limite]
  )
  return rows.map((r) => ({
    id: r.id,
    tipo: r.kind,
    vagaId: r.job_id,
    tentativas: Number(r.attempts),
    maximo: Number(r.max_attempts),
    ultimoErro: r.last_error,
    proximaTentativa: r.run_after,
    concluidaEm: r.done_at,
    desistiuEm: r.failed_at,
    criadaEm: r.created_at
  }))
}
