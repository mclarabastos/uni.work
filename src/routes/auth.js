import { Router } from 'express'
import { many } from '../db/index.js'
import { signup, login, logout, publicUser, accountSummary } from '../domain/auth.js'
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
