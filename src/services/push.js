// Push do navegador (Web Push, padrao VAPID).
//
// Sem VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY o push fica indisponivel, e o
// sistema diz isso: a tela nao oferece o botao, a API responde que nao esta
// configurado e o doctor avisa. Ele nunca aceita a inscricao e depois nao envia
// nada em silencio.
//
// Gere um par com: npx web-push generate-vapid-keys

import { query, many, one } from '../db/index.js'
import { newId } from '../lib/ids.js'
import { config } from '../config.js'

let webpushCarregado = null

export function pushConfigurado () {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
}

export function chavePublica () {
  return process.env.VAPID_PUBLIC_KEY ?? null
}

async function webpush () {
  if (!pushConfigurado()) throw new Error('push não configurado')
  if (!webpushCarregado) {
    const modulo = await import('web-push')
    webpushCarregado = modulo.default ?? modulo
    webpushCarregado.setVapidDetails(
      process.env.VAPID_SUBJECT || `mailto:contato@${new URL(config.publicBaseUrl).hostname}`,
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    )
  }
  return webpushCarregado
}

/** Guarda a inscricao do dispositivo. O endpoint e a identidade dela. */
export async function registrarInscricao (userId, inscricao, userAgent = null) {
  const endpoint = inscricao?.endpoint
  const p256dh = inscricao?.keys?.p256dh
  const auth = inscricao?.keys?.auth
  if (!endpoint || !p256dh || !auth) {
    throw new Error('inscrição incompleta')
  }
  await query(
    `insert into push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (endpoint) do update
        set user_id = excluded.user_id, p256dh = excluded.p256dh,
            auth = excluded.auth, failures = 0`,
    [newId('psh'), userId, endpoint, p256dh, auth, userAgent?.slice(0, 300) ?? null]
  )
  return { ok: true }
}

export async function removerInscricao (userId, endpoint) {
  const { rowCount } = await query(
    'delete from push_subscriptions where user_id = $1 and endpoint = $2',
    [userId, endpoint]
  )
  return { removidas: rowCount }
}

export async function inscricoesDe (userId) {
  return many('select * from push_subscriptions where user_id = $1', [userId])
}

/**
 * Envia para todos os dispositivos da pessoa.
 * Uma inscricao que o navegador ja descartou responde 404 ou 410; nesse caso
 * apagamos na hora, porque insistir nela so gera erro para sempre.
 */
export async function enviarPush (userId, { title, body, url, tag }) {
  if (!pushConfigurado()) return 0

  const inscricoes = await inscricoesDe(userId)
  if (!inscricoes.length) return 0

  const wp = await webpush()
  const carga = JSON.stringify({ title, body, url, tag })
  let enviados = 0

  for (const inscricao of inscricoes) {
    try {
      await wp.sendNotification(
        { endpoint: inscricao.endpoint, keys: { p256dh: inscricao.p256dh, auth: inscricao.auth } },
        carga,
        { TTL: 12 * 3600 }
      )
      enviados += 1
      await query('update push_subscriptions set last_used_at = now(), failures = 0 where id = $1', [inscricao.id])
    } catch (err) {
      const status = err.statusCode
      if (status === 404 || status === 410) {
        await query('delete from push_subscriptions where id = $1', [inscricao.id])
      } else {
        await query('update push_subscriptions set failures = failures + 1 where id = $1', [inscricao.id])
        // Cinco falhas seguidas: o endpoint nao volta mais.
        await query('delete from push_subscriptions where id = $1 and failures >= 5', [inscricao.id])
      }
    }
  }
  return enviados
}

export async function resumoDoPush () {
  const linha = await one('select count(*)::int as total from push_subscriptions')
  return { configurado: pushConfigurado(), inscricoes: linha?.total ?? 0 }
}
