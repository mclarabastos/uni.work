import { Router } from 'express'
import {
  listar, contarNaoLidas, marcarComoLidas, removerNotificacao,
  preferenciasDe, atualizarPreferencias
} from '../domain/notifications.js'
import { registrarInscricao, removerInscricao, chavePublica, pushConfigurado } from '../services/push.js'
import { asyncRoute, requireAuth } from './helpers.js'

export const notificationsRouter = Router()

notificationsRouter.get('/', requireAuth, asyncRoute(async (req, res) => {
  const [itens, naoLidas] = await Promise.all([
    listar(req.user.id, { apenasNaoLidas: req.query.naoLidas === '1', limite: req.query.limite }),
    contarNaoLidas(req.user.id)
  ])
  res.json({ notificacoes: itens, naoLidas })
}))

notificationsRouter.post('/read', requireAuth, asyncRoute(async (req, res) => {
  res.json(await marcarComoLidas(req.user.id, req.body?.ids ?? null))
}))

notificationsRouter.delete('/:id', requireAuth, asyncRoute(async (req, res) => {
  res.json(await removerNotificacao(req.user.id, req.params.id))
}))

// ─── preferencias ────────────────────────────────────────────────────────────

export const mePreferencesRouter = Router()

mePreferencesRouter.get('/notification-preferences', requireAuth, asyncRoute(async (req, res) => {
  res.json({
    preferencias: await preferenciasDe(req.user.id),
    // A tela precisa saber o que existe neste ambiente antes de oferecer.
    disponivel: { push: pushConfigurado() }
  })
}))

mePreferencesRouter.put('/notification-preferences', requireAuth, asyncRoute(async (req, res) => {
  res.json({ preferencias: await atualizarPreferencias(req.user.id, req.body) })
}))

// ─── push do navegador ───────────────────────────────────────────────────────

export const pushRouter = Router()

pushRouter.get('/key', (_req, res) => {
  if (!pushConfigurado()) {
    return res.status(503).json({
      error: 'Os avisos no navegador não estão disponíveis neste ambiente.',
      codigo: 'push_nao_configurado',
      detalhes: null
    })
  }
  res.json({ chave: chavePublica() })
})

pushRouter.post('/subscribe', requireAuth, asyncRoute(async (req, res) => {
  if (!pushConfigurado()) {
    // Aceitar a inscricao e nunca enviar nada seria pior do que recusar.
    return res.status(503).json({
      error: 'Os avisos no navegador não estão disponíveis neste ambiente.',
      codigo: 'push_nao_configurado',
      detalhes: null
    })
  }
  await registrarInscricao(req.user.id, req.body?.inscricao, req.get('user-agent'))
  res.status(201).json({ ok: true })
}))

pushRouter.post('/unsubscribe', requireAuth, asyncRoute(async (req, res) => {
  res.json(await removerInscricao(req.user.id, req.body?.endpoint))
}))
