// Worker da fila on-chain.
//
// Roda a cada 15 segundos, pega o que esta pronto e tenta de novo. Cada handler
// e escrito para ser seguro se rodar duas vezes: comeca conferindo se o
// trabalho ja foi feito e sai calado se foi.
//
// Roda dentro do mesmo processo do servidor. Para o volume deste produto isso
// basta, e evita uma peca a mais na demonstracao. Se um dia precisar escalar,
// o "for update skip locked" na reserva do lote ja permite varios processos.

import { query, one } from '../db/index.js'
import { config } from '../config.js'
import { newId } from '../lib/ids.js'
import {
  reservarLote, marcarConcluido, marcarFalha, enfileirar, estadoDaFila
} from '../domain/chain-queue.js'
import { emitEvent } from '../domain/events.js'
import { accountKeyFor } from '../domain/auth.js'
import { openAccount } from '../services/wallet.js'
import { releaseEscrow, refundEscrow, fundEscrow } from '../services/escrow.js'
import { issueViaBubblegum, buildContent, buildMetadata, contentHash } from '../services/certificate.js'
import { getAsset } from '../services/das.js'
import { newVerificationCode } from '../lib/ids.js'

const INTERVALO_MS = 15_000
const LOTE = 5

let temporizador = null
let rodando = false

import { log as registro, contar, registrarDuracao } from '../lib/logger.js'

function log (nivel, msg, extra = {}) {
  registro[nivel]?.(msg, { worker: 'chain', ...extra })
}

async function registrarTx ({ jobId, kind, signature, instructions = [], detail = {}, status = 'confirmada', error = null }) {
  await query(
    `insert into chain_tx (id, job_id, kind, status, cluster, signature, instructions, detail, error, confirmed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [newId('ctx'), jobId, kind, status, config.solana.cluster, signature,
      JSON.stringify(instructions), JSON.stringify(detail), error,
      status === 'confirmada' ? new Date() : null]
  )
}

// ─── handlers ────────────────────────────────────────────────────────────────

/**
 * Libera o pagamento de uma vaga confirmada.
 * Este e o handler mais delicado da fila: ele move dinheiro. A primeira coisa
 * que faz e conferir se o dinheiro ja saiu.
 */
async function liberarPagamento (item) {
  const jobId = item.job_id ?? item.payload?.jobId
  const vaga = await one('select * from jobs where id = $1', [jobId])
  if (!vaga) return { pulou: 'a vaga não existe mais' }
  if (vaga.status === 'concluida') return { pulou: 'o pagamento já foi liberado' }
  if (vaga.status === 'cancelada') return { pulou: 'a vaga foi cancelada' }
  if (!vaga.confirmed_at) return { pulou: 'o contratante ainda não confirmou' }
  if (!vaga.student_id) return { pulou: 'a vaga não tem estudante' }
  if (vaga.disputed_at) return { pulou: 'a vaga está em contestação' }

  // Quando a liberacao vem de uma resolucao de disputa, o destino do valor e a
  // divisao que o mediador decidiu, e nao o pagamento integral.
  if (item.payload?.resolucaoDeDisputa) {
    const { resolveEscrow } = await import('../services/escrow.js')
    const contaC = await accountKeyFor(vaga.company_id)
    const contaE = await accountKeyFor(vaga.student_id)
    const divisao = await resolveEscrow({
      jobId,
      studentPubkey: contaE.public_key,
      companyPubkey: contaC.public_key,
      amountCents: Number(vaga.amount_cents),
      splitBps: Number(item.payload.divisaoBps),
      feeBps: Number(vaga.fee_bps)
    })
    await query("update jobs set status = 'concluida', completed_at = now() where id = $1", [jobId])
    await registrarTx({
      jobId, kind: 'escrow_release', signature: divisao.signature,
      instructions: divisao.instructionsDescribed,
      detail: { resolucaoDeDisputa: true, divisao: divisao.divisao, pelaFila: true }
    })
    await emitEvent('vaga.concluida', { jobId, payload: { porDisputa: true } })
    if (Number(item.payload.divisaoBps) > 0) await enfileirar('cert_mint', { jobId })
    return { assinatura: divisao.signature }
  }

  const contaContratante = await accountKeyFor(vaga.company_id)
  const contaEstudante = await accountKeyFor(vaga.student_id)
  const chaveContratante = await openAccount(contaContratante.secret_cipher)

  const pagamento = await releaseEscrow({
    jobId,
    studentPubkey: contaEstudante.public_key,
    companyPubkey: contaContratante.public_key,
    companyKeypair: chaveContratante,
    amountCents: Number(vaga.amount_cents),
    feeBps: Number(vaga.fee_bps)
  })

  await query("update jobs set status = 'concluida', completed_at = now() where id = $1", [jobId])
  await registrarTx({
    jobId, kind: 'escrow_release', signature: pagamento.signature,
    instructions: pagamento.instructionsDescribed,
    detail: { divisao: pagamento.split, driver: pagamento.driver, pelaFila: true }
  })
  await emitEvent('vaga.concluida', {
    jobId, actorId: vaga.company_id,
    payload: { estudanteId: vaga.student_id, recebidoCentavos: pagamento.split.studentCents }
  })

  // Pago. Agora o certificado, que segue o proprio caminho.
  await enfileirar('cert_mint', { jobId })

  return { assinatura: pagamento.signature }
}

async function devolverValor (item) {
  const jobId = item.job_id ?? item.payload?.jobId
  const vaga = await one('select * from jobs where id = $1', [jobId])
  if (!vaga) return { pulou: 'a vaga não existe mais' }
  if (vaga.status !== 'cancelada') return { pulou: 'a vaga não está cancelada' }

  const jaVoltou = await one(
    "select id from chain_tx where job_id = $1 and kind = 'escrow_refund' and status = 'confirmada'",
    [jobId]
  )
  if (jaVoltou) return { pulou: 'o valor já voltou' }

  const conta = await accountKeyFor(vaga.company_id)
  const chave = await openAccount(conta.secret_cipher)
  const devolucao = await refundEscrow({
    jobId, companyPubkey: conta.public_key, companyKeypair: chave,
    amountCents: Number(vaga.amount_cents)
  })
  await registrarTx({
    jobId, kind: 'escrow_refund', signature: devolucao.signature,
    instructions: devolucao.instructionsDescribed, detail: { pelaFila: true }
  })
  return { assinatura: devolucao.signature }
}

async function reservarValor (item) {
  const jobId = item.job_id ?? item.payload?.jobId
  const vaga = await one('select * from jobs where id = $1', [jobId])
  if (!vaga) return { pulou: 'a vaga não existe mais' }
  if (vaga.status !== 'aberta') return { pulou: `a vaga está em ${vaga.status}` }

  const conta = await accountKeyFor(vaga.company_id)
  const chave = await openAccount(conta.secret_cipher)
  const reserva = await fundEscrow({
    jobId, companyPubkey: conta.public_key, companyKeypair: chave,
    amountCents: Number(vaga.amount_cents), feeBps: Number(vaga.fee_bps),
    deadlineUnix: vaga.deadline_at ? Math.floor(new Date(vaga.deadline_at).getTime() / 1000) : 0
  })
  await query(
    "update jobs set status = 'garantida', funded_at = now(), escrow_address = $2 where id = $1",
    [jobId, reserva.escrow]
  )
  await registrarTx({
    jobId, kind: 'escrow_fund', signature: reserva.signature,
    instructions: reserva.instructionsDescribed, detail: { cofre: reserva.escrow, pelaFila: true }
  })
  await emitEvent('vaga.garantida', { jobId, actorId: vaga.company_id, payload: { valorCentavos: Number(vaga.amount_cents) } })
  return { assinatura: reserva.signature }
}

/**
 * Emite o certificado, ou promove para cNFT um que nasceu como memo.
 * Um certificado de memo nao e o estado final: ele e um recibo provisorio ate a
 * arvore aceitar. Este handler existe para essa promessa ser cumprida.
 */
async function emitirCertificado (item) {
  const jobId = item.job_id ?? item.payload?.jobId
  const vaga = await one('select * from jobs where id = $1', [jobId])
  if (!vaga) return { pulou: 'a vaga não existe mais' }
  if (vaga.status !== 'concluida') return { pulou: 'a vaga ainda não foi concluída' }

  const existente = await one('select * from certificates where job_id = $1', [jobId])
  if (existente?.asset_id) return { pulou: 'o certificado já está registrado' }

  const contaEstudante = await accountKeyFor(vaga.student_id)
  const estudante = await one('select name from users where id = $1', [vaga.student_id])
  const contratante = await one('select name from users where id = $1', [vaga.company_id])

  // Um certificado ja emitido conserva codigo, hash e metadados: promover para
  // cNFT nao pode mudar o conteudo, senao o hash que alguem ja verificou
  // deixaria de bater.
  const code = existente?.code ?? newVerificationCode()
  const conteudo = existente
    ? (typeof existente.metadata === 'string' ? JSON.parse(existente.metadata) : existente.metadata).properties.uniwork.conteudo
    : buildContent({
        code,
        title: vaga.title,
        hours: Number(vaga.hours),
        studentName: estudante?.name ?? 'Estudante',
        issuerName: contratante?.name ?? 'Contratante',
        category: vaga.category,
        modality: vaga.modality,
        completedAt: vaga.completed_at ?? new Date()
      })
  const hash = existente?.content_hash ?? contentHash(conteudo)
  const metadados = existente
    ? (typeof existente.metadata === 'string' ? JSON.parse(existente.metadata) : existente.metadata)
    : buildMetadata({ content: conteudo, hash, code })

  const emitido = await issueViaBubblegum({
    code, metadata: metadados, studentPubkey: contaEstudante.public_key
  })

  if (existente) {
    await query(
      `update certificates set driver = 'bubblegum', asset_id = $2, signature = coalesce($3, signature),
                               upgraded_at = now()
        where id = $1`,
      [existente.id, emitido.assetId, emitido.signature]
    )
  } else {
    await query(
      `insert into certificates (id, code, job_id, student_id, title, hours, issuer_name,
                                 content_hash, metadata, driver, asset_id, signature)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'bubblegum', $10, $11)`,
      [newId('cer'), code, jobId, vaga.student_id, vaga.title, Number(vaga.hours),
        contratante?.name ?? 'Contratante', hash, JSON.stringify(metadados),
        emitido.assetId, emitido.signature]
    )
  }

  await registrarTx({
    jobId, kind: 'cert_mint', signature: emitido.signature,
    detail: { driver: 'bubblegum', assetId: emitido.assetId, promocao: Boolean(existente), pelaFila: true }
  })
  await emitEvent('certificado.emitido', {
    jobId, actorId: vaga.student_id, payload: { codigo: code, horas: Number(vaga.hours) }
  })

  // Se a transacao passou mas o id do ativo nao veio, o indexador resolve.
  if (!emitido.assetId) await enfileirar('cert_sync', { jobId, payload: { code } })

  return { assinatura: emitido.signature, assetId: emitido.assetId }
}

/** Pergunta ao indexador o id do ativo que a emissao nao conseguiu ler. */
async function sincronizarCertificado (item) {
  const code = item.payload?.code
  const certificado = await one('select * from certificates where code = $1', [code ?? ''])
  if (!certificado) return { pulou: 'o certificado não existe' }
  if (certificado.asset_id) return { pulou: 'o certificado já tem registro' }

  const contaEstudante = await accountKeyFor(certificado.student_id)
  const consulta = await getAsset(certificado.asset_id ?? '')
  if (!consulta.available) return { pulou: 'o indexador não está configurado' }
  if (!consulta.ok) throw new Error(`o indexador não respondeu: ${consulta.reason}`)

  const dono = consulta.result?.ownership?.owner
  if (dono !== contaEstudante.public_key) {
    throw new Error('o indexador devolveu um ativo de outro dono')
  }
  await query('update certificates set asset_id = $2 where id = $1', [certificado.id, consulta.result.id])
  return { assetId: consulta.result.id }
}

const HANDLERS = {
  escrow_fund: reservarValor,
  escrow_release: liberarPagamento,
  escrow_refund: devolverValor,
  cert_mint: emitirCertificado,
  cert_sync: sincronizarCertificado
}

// ─── laco ────────────────────────────────────────────────────────────────────

/**
 * Processa uma rodada. Exportada para o teste conseguir rodar o worker uma vez
 * so, sem depender de temporizador.
 */
export async function processarUmaRodada ({ limite = LOTE, quem = 'worker' } = {}) {
  // Antes de tirar da fila, ve se alguma entrega passou do prazo de confirmacao.
  // Uma entrega esquecida vira uma liberacao enfileirada como qualquer outra.
  try {
    const { confirmarEntregasVencidas } = await import('../domain/disputes.js')
    const auto = await confirmarEntregasVencidas()
    if (auto.confirmadas) log('info', 'auto_confirmacao', auto)
  } catch (err) {
    log('error', 'auto_confirmacao_falhou', { detail: err.message })
  }

  // Resumo diario de quem escolheu receber assim.
  try {
    const { enviarResumosDiarios } = await import('../domain/notifications.js')
    const resumo = await enviarResumosDiarios()
    if (resumo.enviados) log('info', 'resumos_enviados', resumo)
  } catch (err) {
    log('error', 'resumo_diario_falhou', { detail: err.message })
  }

  const itens = await reservarLote(limite, quem)
  const resultado = { processados: 0, concluidos: 0, falhas: 0, desistencias: 0, pulados: 0 }

  for (const item of itens) {
    resultado.processados += 1
    const handler = HANDLERS[item.kind]
    if (!handler) {
      await marcarFalha(item, new Error(`sem handler para ${item.kind}`))
      resultado.falhas += 1
      continue
    }
    try {
      const comecou = Date.now()
      const saida = await handler(item)
      registrarDuracao(`fila.${item.kind}`, Date.now() - comecou)
      contar(`fila.${item.kind}.${saida?.pulou ? 'desnecessaria' : 'concluida'}`)
      await marcarConcluido(item.id)
      if (saida?.pulou) {
        resultado.pulados += 1
        log('info', 'operacao_desnecessaria', { id: item.id, tipo: item.kind, motivo: saida.pulou })
      } else {
        resultado.concluidos += 1
        log('info', 'operacao_concluida', { id: item.id, tipo: item.kind, vaga: item.job_id, assinatura: saida?.assinatura })
      }
    } catch (err) {
      const { desistiu, tentativas, proximaTentativaEm } = await marcarFalha(item, err)
      contar(`fila.${item.kind}.${desistiu ? 'desistida' : 'falhou'}`)
      resultado.falhas += 1
      if (desistiu) {
        resultado.desistencias += 1
        log('error', 'operacao_desistida', { id: item.id, tipo: item.kind, vaga: item.job_id, tentativas, detail: err.message })
        await emitEvent('rede.desistiu', { jobId: item.job_id, payload: { tipo: item.kind, tentativas } })
      } else {
        log('warn', 'operacao_falhou', {
          id: item.id, tipo: item.kind, vaga: item.job_id, tentativas,
          proximaEmSegundos: Math.round(proximaTentativaEm / 1000), detail: err.message
        })
        await emitEvent('rede.enfileirada', { jobId: item.job_id, payload: { tipo: item.kind, tentativas } })
      }
    }
  }

  return resultado
}

export function iniciarWorker ({ intervaloMs = INTERVALO_MS } = {}) {
  if (temporizador) return { jaEstava: true }

  const tick = async () => {
    if (rodando) return
    rodando = true
    try {
      const resultado = await processarUmaRodada()
      if (resultado.processados) log('info', 'rodada', resultado)
    } catch (err) {
      log('error', 'rodada_falhou', { detail: err.message })
    } finally {
      rodando = false
    }
  }

  temporizador = setInterval(tick, intervaloMs)
  // unref: um worker ocioso nao pode segurar o processo de pe sozinho.
  temporizador.unref?.()
  setTimeout(tick, 1000).unref?.()

  log('info', 'worker_iniciado', { intervaloSegundos: intervaloMs / 1000 })
  return { jaEstava: false }
}

export function pararWorker () {
  if (!temporizador) return
  clearInterval(temporizador)
  temporizador = null
}

export { estadoDaFila }
