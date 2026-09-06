// Barramento de eventos.
//
// Um evento de dominio e gravado uma vez e consumido por tres lugares:
// a timeline da vaga, o contador de metricas e o SSE de quem esta com a tela
// aberta. Quem publica nao sabe quem escuta.

import { EventEmitter } from 'node:events'
import { query } from '../db/index.js'
import { newId } from '../lib/ids.js'
import { log } from '../lib/logger.js'

const bus = new EventEmitter()
bus.setMaxListeners(0) // uma conexao SSE por aba aberta, nao ha limite util aqui

/** Rotulo em portugues de cada evento, usado na timeline da vaga. */
export const EVENT_LABELS = {
  'vaga.publicada': 'Vaga publicada',
  'vaga.garantida': 'Valor reservado pelo contratante',
  'vaga.candidatura': 'Nova candidatura',
  'vaga.aceita': 'Estudante escolhido',
  'vaga.iniciada': 'Trabalho iniciado',
  'vaga.entregue': 'Entrega enviada',
  'vaga.concluida': 'Entrega confirmada, pagamento liberado',
  'vaga.cancelada': 'Vaga cancelada, valor devolvido',
  'disputa.aberta': 'Contestação aberta',
  'disputa.resolvida': 'Contestação resolvida',
  'vaga.auto_confirmada': 'Confirmada automaticamente por prazo',
  'certificado.emitido': 'Certificado emitido',
  'certificado.pendente': 'Certificado em processamento',
  'mensagem.enviada': 'Mensagem enviada',
  'avaliacao.registrada': 'Avaliação registrada',
  'conta.criada': 'Conta criada',
  'conta.entrou': 'Entrou na conta',
  'rede.operacao': 'Operação registrada na rede',
  'rede.enfileirada': 'Operação aguardando nova tentativa',
  'rede.desistiu': 'Operação precisa de atenção da equipe'
}

export function labelFor (type) {
  return EVENT_LABELS[type] ?? type
}

const counters = new Map()

export function bumpCounter (name, by = 1) {
  counters.set(name, (counters.get(name) ?? 0) + by)
  return counters.get(name)
}

export function readCounters () {
  return Object.fromEntries(counters)
}

export function resetCounters () {
  counters.clear()
}

/**
 * Publica um evento: grava, conta e avisa quem esta ouvindo.
 * Nunca lanca. Um evento perdido nao pode derrubar a operacao que o gerou.
 */
export async function emitEvent (type, { jobId = null, actorId = null, payload = {} } = {}) {
  const event = {
    id: newId('evt'),
    type,
    job_id: jobId,
    actor_id: actorId,
    payload,
    created_at: new Date().toISOString(),
    label: labelFor(type)
  }
  bumpCounter(`evento.${type}`)
  try {
    await query(
      'insert into events (id, type, job_id, actor_id, payload) values ($1, $2, $3, $4, $5)',
      [event.id, type, jobId, actorId, JSON.stringify(payload)]
    )
  } catch (err) {
    log.error('evento_nao_gravado', { tipo: type, detalhe: err.message })
  }
  bus.emit('event', event)
  bus.emit(type, event)
  return event
}

export function onEvent (listener) {
  bus.on('event', listener)
  return () => bus.off('event', listener)
}

export function onceEvent (type, listener) {
  bus.once(type, listener)
}

/** Timeline de uma vaga, em ordem cronologica, ja rotulada em portugues. */
export async function timelineForJob (jobId) {
  const { rows } = await query(
    'select id, type, actor_id, payload, created_at from events where job_id = $1 order by created_at asc, id asc',
    [jobId]
  )
  return rows.map((row) => ({
    id: row.id,
    tipo: row.type,
    rotulo: labelFor(row.type),
    quando: row.created_at,
    detalhes: row.payload ?? {}
  }))
}

export { bus }
