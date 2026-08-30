import { Router } from 'express'
import { many } from '../db/index.js'
import { signup, login, logout, publicUser, accountSummary } from '../domain/auth.js'
import {
  pedirMagicLink, verificarMagicLink, renovarSessao,
  listarSessoes, revogarSessao, revogarOutrasSessoes
} from '../domain/sessions.js'
import { asyncRoute, requireAuth } from './helpers.js'

export const authRouter = Router()

authRouter.post('/signup', asyncRoute(async (req, res) => {
  const out = await signup(req.body)
  res.status(201).json(out)
}))

authRouter.post('/login', asyncRoute(async (req, res) => {
  res.json(await login(req.body))
}))

authRouter.post('/logout', asyncRoute(async (req, res) => {
  await logout(req.token)
  res.json({ ok: true })
}))

authRouter.get('/me', requireAuth, asyncRoute(async (req, res) => {
  res.json({ usuario: publicUser(req.user) })
}))

authRouter.get('/me/dashboard', requireAuth, asyncRoute(async (req, res) => {
  res.json(await accountSummary(req.user))
}))

authRouter.get('/me/certificates', requireAuth, asyncRoute(async (req, res) => {
  const { meusCertificados } = await import('../domain/search.js')
  const pagina = await meusCertificados(req.user, { cursor: req.query.cursor, limite: req.query.limite })

  // O total de horas e do perfil inteiro, nao so da pagina atual: seria
  // estranho o numero mudar conforme a pessoa rola a lista.
  const totais = await many(
    'select coalesce(sum(hours), 0)::float as horas from certificates where student_id = $1',
    [req.user.id]
  )
  res.json({ ...pagina, horasTotais: Number(totais[0]?.horas ?? 0) })
}))

// ─── autenticacao por link no e-mail ─────────────────────────────────────────
// Sem senha para lembrar, sem senha para vazar. O link vale por poucos minutos
// e funciona uma vez so.

authRouter.post('/auth/magic-link', asyncRoute(async (req, res) => {
  res.json(await pedirMagicLink(req.body, { ip: req.ip }))
}))

authRouter.post('/auth/verify', asyncRoute(async (req, res) => {
  const out = await verificarMagicLink(req.body, { ip: req.ip, userAgent: req.get('user-agent') })
  res.json(out)
}))

authRouter.post('/auth/refresh', asyncRoute(async (req, res) => {
  res.json({ sessao: await renovarSessao(req.body, { ip: req.ip }) })
}))

authRouter.get('/auth/sessions', requireAuth, asyncRoute(async (req, res) => {
  res.json({ sessoes: await listarSessoes(req.user.id, req.token) })
}))

authRouter.delete('/auth/sessions/:id', requireAuth, asyncRoute(async (req, res) => {
  res.json(await revogarSessao(req.user.id, req.params.id))
}))

// O botao de "perdi meu celular": encerra tudo menos a sessao atual.
authRouter.post('/auth/sessions/revoke-others', requireAuth, asyncRoute(async (req, res) => {
  res.json(await revogarOutrasSessoes(req.user.id, req.token))
}))
