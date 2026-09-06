// Contestacao.
//
// Existe porque a alternativa e pior. Sem disputa, um desacordo tem duas
// saidas: o contratante segura o valor para sempre, ou a plataforma decide
// sozinha sem processo nenhum. Com disputa, existe prazo, existe registro do
// que cada lado alegou, e existe uma autoridade de mediacao definida na criacao
// do escrow, que nao muda depois.
//
// Enquanto a disputa esta aberta, o valor nao vai para lado nenhum. Nem o
// contratante libera, nem ele recupera. E o unico jeito de nenhum dos dois
// ganhar por desgaste.

import { z } from 'zod'
import { query, one, many, transaction } from '../db/index.js'
import { newId } from '../lib/ids.js'
import { config } from '../config.js'
import { conflict, forbidden, notFound, badRequest } from '../lib/errors.js'
import { emitEvent } from './events.js'
import { enfileirar } from './chain-queue.js'
import { accountKeyFor } from './auth.js'
import { resolveEscrow } from '../services/escrow.js'
import { registrarAuditoria } from './audit.js'

/** Prazo para a mediacao olhar. Depois disso o caso aparece como atrasado. */
export const DIAS_DE_PRAZO = 7

/** Quantos dias depois da entrega a vaga se confirma sozinha. */
export const DIAS_ATE_AUTO_CONFIRMAR = 7

export const MOTIVOS = {
  nao_entregue: 'O trabalho não foi entregue',
  fora_do_combinado: 'A entrega não corresponde ao combinado',
  atrasado: 'A entrega passou muito do prazo',
  pagamento_travado: 'O contratante não confirma a entrega',
  conduta: 'Problema de conduta',
  outro: 'Outro motivo'
}

export const RESULTADOS = {
  resolved_student: 'Valor integral para o estudante',
  resolved_company: 'Valor integral de volta para o contratante',
  split: 'Valor dividido entre os dois'
}

export const abrirSchema = z.object({
  motivo: z.enum(Object.keys(MOTIVOS), {
    errorMap: () => ({ message: 'Escolha um dos motivos da lista.' })
  }),
  detalhe: z.string().trim().min(20, 'Explique o que aconteceu, com pelo menos 20 caracteres.').max(2000)
})

export const resolverSchema = z.object({
  resultado: z.enum(['resolved_student', 'resolved_company', 'split'], {
    errorMap: () => ({ message: 'Escolha como a contestação foi resolvida.' })
  }),
  divisaoBps: z.number().int().min(0).max(10000).optional().nullable(),
  resolucao: z.string().trim().min(20, 'Explique a decisão, com pelo menos 20 caracteres.').max(2000)
})

export function publicDispute (row) {
  if (!row) return null
  return {
    id: row.id,
    vagaId: row.job_id,
    vagaTitulo: row.job_title ?? null,
    valorCentavos: row.amount_cents ? Number(row.amount_cents) : null,
    abertaPor: { id: row.opened_by, nome: row.opened_by_name ?? null, perfil: row.opened_by_role ?? null },
    motivo: row.reason,
    motivoRotulo: MOTIVOS[row.reason] ?? row.reason,
    detalhe: row.detail,
    status: row.status,
    statusRotulo: rotuloDoStatus(row),
    resolucao: row.resolution ?? null,
    divisaoBps: row.split_bps ?? null,
    prazoEm: row.deadline_at,
    atrasada: row.status === 'open' && new Date(row.deadline_at).getTime() < Date.now(),
    resolvidaEm: row.resolved_at ?? null,
    criadaEm: row.created_at
  }
}

function rotuloDoStatus (row) {
  if (row.status === 'open') return 'Aguardando mediação'
  if (row.status === 'in_review') return 'Em análise'
  if (row.status === 'resolved_student') return 'Resolvida: valor para o estudante'
  if (row.status === 'resolved_company') return 'Resolvida: valor devolvido'
  if (row.status === 'split') return 'Resolvida: valor dividido'
  return row.status
}

const DISPUTE_SELECT = `
  select d.*, j.title as job_title, j.amount_cents, u.name as opened_by_name, u.role as opened_by_role
    from disputes d
    join jobs j on j.id = d.job_id
    join users u on u.id = d.opened_by`

/**
 * Abre a contestacao.
 * Vale para as duas partes, e por motivos diferentes: o contratante contesta
 * uma entrega que nao veio, e o estudante contesta um pagamento que nao sai.
 */
export async function abrirDisputa (usuario, jobId, input) {
  const dados = abrirSchema.parse(input)
  const vaga = await one('select * from jobs where id = $1', [jobId])
  if (!vaga) throw notFound('Não encontramos essa vaga.')

  const ehContratante = vaga.company_id === usuario.id
  const ehEstudante = vaga.student_id === usuario.id
  if (!ehContratante && !ehEstudante) {
    throw forbidden('Só o contratante e o estudante desta vaga podem abrir uma contestação.')
  }

  // So faz sentido contestar depois que ha trabalho combinado e valor reservado,
  // e antes de o dinheiro ja ter saido.
  if (!['aceita', 'em_andamento', 'entregue'].includes(vaga.status)) {
    throw conflict(
      vaga.status === 'concluida'
        ? 'Esta vaga já foi concluída e paga. Fale com o suporte se algo deu errado.'
        : 'Esta vaga ainda não está em um estágio que permita contestação.',
      'estagio_nao_permite_contestacao'
    )
  }

  const existente = await one('select id, status from disputes where job_id = $1', [jobId])
  if (existente) {
    throw conflict('Já existe uma contestação aberta para esta vaga.', 'contestacao_duplicada')
  }

  const id = newId('dis')
  const prazo = new Date(Date.now() + DIAS_DE_PRAZO * 86400_000)

  await transaction(async (tx) => {
    await tx.query(
      `insert into disputes (id, job_id, opened_by, reason, detail, status, deadline_at)
       values ($1, $2, $3, $4, $5, 'open', $6)`,
      [id, jobId, usuario.id, dados.motivo, dados.detalhe, prazo]
    )
    // A marca na vaga e o que trava a liberacao e a auto confirmacao.
    await tx.query('update jobs set disputed_at = now(), auto_confirm_at = null where id = $1', [jobId])
  })

  await emitEvent('disputa.aberta', {
    jobId, actorId: usuario.id,
    payload: { motivo: dados.motivo, prazoEm: prazo.toISOString() }
  })
  await registrarAuditoria({
    actorId: usuario.id, action: 'disputa.aberta', entity: 'job', entityId: jobId,
    after: { motivo: dados.motivo }
  })

  return publicDispute(await one(`${DISPUTE_SELECT} where d.id = $1`, [id]))
}

/** A contestacao que a pessoa pode ver: so a das vagas dela. */
export async function disputaDaVaga (jobId, usuario) {
  const linha = await one(`${DISPUTE_SELECT} where d.job_id = $1`, [jobId])
  if (!linha) return null
  const vaga = await one('select company_id, student_id from jobs where id = $1', [jobId])
  const podeVer = usuario?.is_admin || vaga?.company_id === usuario?.id || vaga?.student_id === usuario?.id
  return podeVer ? publicDispute(linha) : null
}

/** Fila de mediacao. So para a operacao. */
export async function listarDisputas (usuario, { status = null, limite = 50 } = {}) {
  if (!usuario?.is_admin) throw forbidden('Esta área é da equipe de mediação.')
  const condicoes = []
  const params = []
  if (status === 'abertas') condicoes.push("d.status in ('open','in_review')")
  else if (status === 'resolvidas') condicoes.push("d.status not in ('open','in_review')")
  params.push(Math.min(Number(limite) || 50, 200))

  const linhas = await many(
    `${DISPUTE_SELECT}
     ${condicoes.length ? `where ${condicoes.join(' and ')}` : ''}
     order by (d.status in ('open','in_review')) desc, d.deadline_at asc
     limit $1`,
    params
  )
  return linhas.map(publicDispute)
}

export async function assumirDisputa (usuario, disputeId) {
  if (!usuario?.is_admin) throw forbidden('Esta área é da equipe de mediação.')
  const { rowCount } = await query(
    "update disputes set status = 'in_review' where id = $1 and status = 'open'",
    [disputeId]
  )
  if (rowCount === 0) throw conflict('Esta contestação não está aguardando mediação.', 'estado_invalido')
  return publicDispute(await one(`${DISPUTE_SELECT} where d.id = $1`, [disputeId]))
}

/**
 * Resolve a contestacao e move o dinheiro conforme a decisao.
 *
 * Se a rede recusar, a decisao fica registrada mesmo assim e a movimentacao vai
 * para a fila. O contrario seria pior: obrigar o mediador a decidir de novo
 * porque a rede estava fora do ar naquele segundo.
 */
export async function resolverDisputa (usuario, disputeId, input) {
  if (!usuario?.is_admin) throw forbidden('Esta área é da equipe de mediação.')
  const dados = resolverSchema.parse(input)

  const disputa = await one(`${DISPUTE_SELECT} where d.id = $1`, [disputeId])
  if (!disputa) throw notFound('Não encontramos essa contestação.')
  if (!['open', 'in_review'].includes(disputa.status)) {
    throw conflict('Esta contestação já foi resolvida.', 'contestacao_ja_resolvida')
  }

  const divisaoBps = dados.resultado === 'resolved_student' ? 10000
    : dados.resultado === 'resolved_company' ? 0
      : dados.divisaoBps

  if (dados.resultado === 'split' && (divisaoBps === null || divisaoBps === undefined)) {
    throw badRequest('Diga qual parte do valor vai para o estudante.', { campo: 'divisaoBps' })
  }
  if (dados.resultado === 'split' && (divisaoBps === 0 || divisaoBps === 10000)) {
    throw badRequest(
      'Uma divisão de 0% ou 100% não é uma divisão. Escolha o resultado integral correspondente.',
      { campo: 'divisaoBps' }
    )
  }

  const vaga = await one('select * from jobs where id = $1', [disputa.job_id])
  if (!vaga) throw notFound('Não encontramos a vaga desta contestação.')

  const contaContratante = await accountKeyFor(vaga.company_id)
  const contaEstudante = vaga.student_id ? await accountKeyFor(vaga.student_id) : null
  if (!contaEstudante) throw conflict('Esta vaga não tem estudante.', 'sem_estudante')

  let movimentacao = null
  let enfileirado = false
  try {
    movimentacao = await resolveEscrow({
      jobId: vaga.id,
      studentPubkey: contaEstudante.public_key,
      companyPubkey: contaContratante.public_key,
      amountCents: Number(vaga.amount_cents),
      splitBps: divisaoBps,
      feeBps: Number(vaga.fee_bps)
    })
  } catch (err) {
    // A decisao vale. O dinheiro segue pela fila.
    await enfileirar('escrow_release', {
      jobId: vaga.id,
      payload: { resolucaoDeDisputa: true, divisaoBps }
    })
    enfileirado = true
    await query(
      `insert into chain_tx (id, job_id, kind, status, cluster, error, detail)
       values ($1, $2, 'escrow_release', 'falhou', $3, $4, $5)`,
      [newId('ctx'), vaga.id, config.solana.cluster, String(err.message).slice(0, 500),
        JSON.stringify({ resolucaoDeDisputa: true, divisaoBps, enfileirado: true })]
    )
  }

  const antes = { status: disputa.status }

  await transaction(async (tx) => {
    await tx.query(
      `update disputes
          set status = $2, resolution = $3, split_bps = $4,
              resolved_by = $5, resolved_at = now()
        where id = $1`,
      [disputeId, dados.resultado, dados.resolucao, divisaoBps, usuario.id]
    )
    // A vaga sai da disputa. Ela vira concluida so quando o valor de fato saiu.
    await tx.query(
      `update jobs
          set disputed_at = null,
              status = case when $2 then 'concluida' else status end,
              completed_at = case when $2 then now() else completed_at end,
              confirmed_at = coalesce(confirmed_at, now())
        where id = $1`,
      [vaga.id, Boolean(movimentacao)]
    )
  })

  if (movimentacao) {
    await query(
      `insert into chain_tx (id, job_id, kind, status, cluster, signature, instructions, detail, confirmed_at)
       values ($1, $2, 'escrow_release', 'confirmada', $3, $4, $5, $6, now())`,
      [newId('ctx'), vaga.id, config.solana.cluster, movimentacao.signature,
        JSON.stringify(movimentacao.instructionsDescribed ?? []),
        JSON.stringify({ resolucaoDeDisputa: true, divisaoBps, divisao: movimentacao.divisao })]
    )
  }

  await emitEvent('disputa.resolvida', {
    jobId: vaga.id, actorId: usuario.id,
    payload: { resultado: dados.resultado, divisaoBps, enfileirado }
  })
  await registrarAuditoria({
    actorId: usuario.id, action: 'disputa.resolvida', entity: 'dispute', entityId: disputeId,
    before: antes,
    after: { resultado: dados.resultado, divisaoBps, divisao: movimentacao?.divisao ?? null }
  })

  // Certificado: so quando houve trabalho reconhecido.
  if (movimentacao && divisaoBps > 0) {
    await enfileirar('cert_mint', { jobId: vaga.id })
  }

  return {
    disputa: publicDispute(await one(`${DISPUTE_SELECT} where d.id = $1`, [disputeId])),
    divisao: movimentacao?.divisao ?? null,
    pagamentoEmProcessamento: enfileirado
  }
}

/**
 * Auto confirmacao: a entrega que ninguem contestou e ninguem confirmou vira
 * confirmada sozinha depois do prazo.
 *
 * Isto e o outro lado do auto_release do programa. Aqui e a regra de produto que
 * decide quando; la e a rede que garante que a decisao pode ser executada mesmo
 * se o nosso servidor sumir.
 */
export async function confirmarEntregasVencidas () {
  const vencidas = await many(
    `select id from jobs
      where status = 'entregue'
        and disputed_at is null
        and confirmed_at is null
        and auto_confirm_at is not null
        and auto_confirm_at <= now()
      limit 50`
  )

  for (const vaga of vencidas) {
    await query('update jobs set confirmed_at = now() where id = $1', [vaga.id])
    await enfileirar('escrow_release', { jobId: vaga.id, payload: { autoConfirmada: true } })
    await emitEvent('vaga.auto_confirmada', { jobId: vaga.id, payload: {} })
    await registrarAuditoria({
      actorId: null, action: 'vaga.auto_confirmada', entity: 'job', entityId: vaga.id,
      after: { motivo: 'prazo de confirmação vencido' }
    })
  }

  return { confirmadas: vencidas.length }
}
