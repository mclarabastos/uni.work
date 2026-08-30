// Trilha de auditoria.
//
// Toda acao que move dinheiro ou muda estado importante entra aqui. Nao e log:
// log some, e log e sobre o processo. Isto e sobre o negocio, fica no banco e
// responde "quem fez, quando, e o que era antes".
//
// Nunca lanca. Uma auditoria que falha nao pode derrubar a operacao auditada,
// mas a falha em si vai para o log de erro para nao passar despercebida.

import { query } from '../db/index.js'
import { newId } from '../lib/ids.js'

/** Campos que nunca podem entrar no registro, mesmo por acidente. */
const SEGREDOS = ['secret_cipher', 'secretKey', 'token', 'refresh_token', 'password', 'senha']

function limpar (valor) {
  if (!valor || typeof valor !== 'object') return valor ?? null
  const copia = Array.isArray(valor) ? [...valor] : { ...valor }
  for (const chave of Object.keys(copia)) {
    if (SEGREDOS.some((s) => chave.toLowerCase().includes(s.toLowerCase()))) {
      copia[chave] = '[removido]'
    } else if (copia[chave] && typeof copia[chave] === 'object') {
      copia[chave] = limpar(copia[chave])
    }
  }
  return copia
}

export async function registrarAuditoria ({ actorId = null, action, entity, entityId, before = null, after = null, ip = null }) {
  try {
    await query(
      `insert into audit_log (id, actor_id, action, entity, entity_id, before, after, ip)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [newId('aud'), actorId, action, entity, String(entityId),
        before ? JSON.stringify(limpar(before)) : null,
        after ? JSON.stringify(limpar(after)) : null,
        ip]
    )
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'auditoria_nao_gravada', action, detail: err.message }))
  }
}

/** Historico de uma entidade, do mais novo para o mais velho. */
export async function historicoDe (entity, entityId, limite = 50) {
  const { rows } = await query(
    `select a.*, u.name as actor_name
       from audit_log a left join users u on u.id = a.actor_id
      where a.entity = $1 and a.entity_id = $2
      order by a.created_at desc limit $3`,
    [entity, String(entityId), limite]
  )
  return rows.map((r) => ({
    id: r.id,
    acao: r.action,
    quem: r.actor_name ?? 'sistema',
    quando: r.created_at,
    antes: typeof r.before === 'string' ? JSON.parse(r.before) : r.before,
    depois: typeof r.after === 'string' ? JSON.parse(r.after) : r.after
  }))
}
