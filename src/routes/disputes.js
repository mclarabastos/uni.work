// Contestacao: as duas partes abrem, a mediacao resolve.

import { Router } from 'express'
import {
  abrirDisputa, listarDisputas, assumirDisputa, resolverDisputa, MOTIVOS, RESULTADOS
} from '../domain/disputes.js'
import { asyncRoute, requireAuth } from './helpers.js'

export const disputesRouter = Router()

/** Os motivos que a tela oferece. Lista fechada: texto livre vai no detalhe. */
disputesRouter.get('/motivos', (_req, res) => {
  res.json({
    motivos: Object.entries(MOTIVOS).map(([valor, rotulo]) => ({ valor, rotulo })),
    resultados: Object.entries(RESULTADOS).map(([valor, rotulo]) => ({ valor, rotulo }))
  })
})

disputesRouter.get('/', requireAuth, asyncRoute(async (req, res) => {
  res.json({ contestacoes: await listarDisputas(req.user, { status: req.query.status }) })
}))

disputesRouter.post('/:id/assumir', requireAuth, asyncRoute(async (req, res) => {
  res.json({ contestacao: await assumirDisputa(req.user, req.params.id) })
}))

disputesRouter.post('/:id/resolve', requireAuth, asyncRoute(async (req, res) => {
  res.json(await resolverDisputa(req.user, req.params.id, req.body))
}))

/** Anexada ao router de vagas: quem abre, abre a partir da vaga. */
export function registrarRotaDeAbertura (jobsRouter) {
  jobsRouter.post('/:id/dispute', requireAuth, asyncRoute(async (req, res) => {
    res.status(201).json({ contestacao: await abrirDisputa(req.user, req.params.id, req.body) })
  }))
}
