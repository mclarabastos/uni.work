// Metricas de produto. Numeros que fazem sentido no pitch e no painel lateral.

import { Router } from 'express'
import { many } from '../db/index.js'
import { readCounters } from '../domain/events.js'
import { asyncRoute } from './helpers.js'

export const metricsRouter = Router()

metricsRouter.get('/', asyncRoute(async (_req, res) => {
  const [totals] = await many(`
    select
      (select count(*)::int from users where role = 'student')       as estudantes,
      (select count(*)::int from users where role = 'company')       as contratantes,
      (select count(*)::int from jobs)                                as vagas,
      (select count(*)::int from jobs where status = 'concluida')     as concluidas,
      (select count(*)::int from certificates)                        as certificados,
      (select coalesce(sum(hours), 0)::float from certificates)       as horas,
      (select coalesce(sum(amount_cents), 0)::bigint from jobs where status = 'concluida') as pagoCentavos,
      (select coalesce(sum(amount_cents), 0)::bigint from jobs
        where status in ('garantida','aceita','em_andamento','entregue'))                  as reservadoCentavos
  `)

  const porStatus = await many('select status, count(*)::int as total from jobs group by status')
  const porCategoria = await many(
    'select category, count(*)::int as total from jobs group by category order by total desc limit 8'
  )
  const porModalidade = await many('select modality, count(*)::int as total from jobs group by modality')

  res.json({
    totais: {
      estudantes: totals.estudantes,
      contratantes: totals.contratantes,
      vagas: totals.vagas,
      concluidas: totals.concluidas,
      certificados: totals.certificados,
      horasCertificadas: Number(totals.horas),
      pagoCentavos: Number(totals.pagocentavos ?? totals.pagoCentavos ?? 0),
      reservadoCentavos: Number(totals.reservadocentavos ?? totals.reservadoCentavos ?? 0)
    },
    porStatus: Object.fromEntries(porStatus.map((r) => [r.status, r.total])),
    porCategoria: porCategoria.map((r) => ({ categoria: r.category, total: r.total })),
    porModalidade: Object.fromEntries(porModalidade.map((r) => [r.modality, r.total])),
    contadores: readCounters()
  })
}))
