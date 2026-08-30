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
  const rows = await many(
    `select c.code, c.title, c.hours, c.issuer_name, c.issued_at, c.asset_id, c.content_hash,
            j.category, j.modality
       from certificates c join jobs j on j.id = c.job_id
      where c.student_id = $1
      order by c.issued_at desc`,
    [req.user.id]
  )
  res.json({
    certificados: rows.map((r) => ({
      codigo: r.code,
      titulo: r.title,
      horas: Number(r.hours),
      contratante: r.issuer_name,
      categoria: r.category,
      modalidade: r.modality,
      emitidoEm: r.issued_at,
      registrado: Boolean(r.asset_id),
      emProcessamento: !r.asset_id,
      hash: r.content_hash,
      links: {
        verificacao: `/verificar/${r.code}`,
        imagem: `/api/certificates/${r.code}/image.svg`
      }
    })),
    horasTotais: rows.reduce((sum, r) => sum + Number(r.hours), 0)
  })
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
