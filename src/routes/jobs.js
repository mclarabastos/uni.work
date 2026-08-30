import { Router } from 'express'
import {
  listJobs, getJobDetail, createJob, fundJob, applyToJob, acceptApplication,
  startJob, deliverJob, confirmJob, cancelJob, listMessages, sendMessage, reviewJob
} from '../domain/jobs.js'
import { asyncRoute, requireAuth } from './helpers.js'
import { registrarRotaDeAbertura } from './disputes.js'

export const jobsRouter = Router()

// A contestacao nasce a partir da vaga, entao a rota mora no router de vagas
// mesmo que a logica esteja em disputes.
registrarRotaDeAbertura(jobsRouter)

jobsRouter.get('/', asyncRoute(async (req, res) => {
  const vagas = await listJobs({
    status: req.query.status,
    modalidade: req.query.modalidade,
    categoria: req.query.categoria,
    busca: req.query.busca,
    autor: req.query.autor,
    estudante: req.query.estudante,
    limit: req.query.limit
  })
  res.json({ vagas })
}))

jobsRouter.post('/', requireAuth, asyncRoute(async (req, res) => {
  res.status(201).json({ vaga: await createJob(req.user, req.body) })
}))

// Aceitar candidatura vem antes de "/:id" para nao ser capturada por ele.
jobsRouter.post('/applications/:id/accept', requireAuth, asyncRoute(async (req, res) => {
  res.json({ vaga: await acceptApplication(req.user, req.params.id) })
}))

jobsRouter.get('/:id', asyncRoute(async (req, res) => {
  res.json({ vaga: await getJobDetail(req.params.id, req.user) })
}))

jobsRouter.post('/:id/fund', requireAuth, asyncRoute(async (req, res) => {
  res.json({ vaga: await fundJob(req.user, req.params.id) })
}))

jobsRouter.post('/:id/apply', requireAuth, asyncRoute(async (req, res) => {
  res.status(201).json({ candidatura: await applyToJob(req.user, req.params.id, req.body) })
}))

jobsRouter.post('/:id/start', requireAuth, asyncRoute(async (req, res) => {
  res.json({ vaga: await startJob(req.user, req.params.id) })
}))

jobsRouter.post('/:id/deliver', requireAuth, asyncRoute(async (req, res) => {
  res.json({ vaga: await deliverJob(req.user, req.params.id, req.body) })
}))

jobsRouter.post('/:id/confirm', requireAuth, asyncRoute(async (req, res) => {
  res.json(await confirmJob(req.user, req.params.id))
}))

jobsRouter.post('/:id/cancel', requireAuth, asyncRoute(async (req, res) => {
  res.json({ vaga: await cancelJob(req.user, req.params.id, req.body?.motivo ?? null) })
}))

jobsRouter.post('/:id/review', requireAuth, asyncRoute(async (req, res) => {
  res.status(201).json({ avaliacao: await reviewJob(req.user, req.params.id, req.body) })
}))

jobsRouter.get('/:id/messages', requireAuth, asyncRoute(async (req, res) => {
  res.json({ mensagens: await listMessages(req.user, req.params.id) })
}))

jobsRouter.post('/:id/messages', requireAuth, asyncRoute(async (req, res) => {
  res.status(201).json({ mensagem: await sendMessage(req.user, req.params.id, req.body) })
}))
