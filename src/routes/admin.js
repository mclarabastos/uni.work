// Painel de operacao.
//
// Tudo aqui exige conta de mediacao, que so se ganha por linha de comando
// (npm run admin). Nao existe rota que promove ninguem, de proposito.

import { Router } from 'express'
import { query, one, many } from '../db/index.js'
import { forbidden, notFound, badRequest } from '../lib/errors.js'
import { estadoDaFila, listarFila, reenfileirar } from '../domain/chain-queue.js'
import { registrarAuditoria, historicoDe } from '../domain/audit.js'
import { normalizarLimite, montarPagina, decodificarCursor } from '../lib/cursor.js'
import { asyncRoute, requireAuth } from './helpers.js'

export const adminRouter = Router()

function exigirMediacao (req, _res, next) {
  if (!req.user?.is_admin) return next(forbidden('Esta área é da equipe de operação.'))
  next()
}

adminRouter.use(requireAuth, exigirMediacao)

adminRouter.get('/overview', asyncRoute(async (_req, res) => {
  const [totais, fila, disputas, ultimas] = await Promise.all([
    one(`select
           (select count(*)::int from users)                                     as contas,
           (select count(*)::int from users where blocked_at is not null)        as suspensas,
           (select count(*)::int from jobs)                                      as vagas,
           (select count(*)::int from jobs where status = 'concluida')           as concluidas,
           (select count(*)::int from certificates)                              as certificados,
           (select count(*)::int from certificates where asset_id is null)       as certificadosPendentes,
           (select coalesce(sum(amount_cents), 0)::bigint from jobs where status = 'concluida') as pagoCentavos,
           (select coalesce(sum(amount_cents), 0)::bigint from jobs
             where status in ('garantida','aceita','em_andamento','entregue'))   as reservadoCentavos`),
    estadoDaFila(),
    one(`select count(*) filter (where status in ('open','in_review'))::int as abertas,
                count(*) filter (where status in ('open','in_review') and deadline_at < now())::int as atrasadas
           from disputes`),
    many(`select a.action, a.entity, a.entity_id, a.created_at, u.name as quem
            from audit_log a left join users u on u.id = a.actor_id
           order by a.created_at desc limit 20`)
  ])

  res.json({
    totais: {
      contas: totais.contas,
      suspensas: totais.suspensas,
      vagas: totais.vagas,
      concluidas: totais.concluidas,
      certificados: totais.certificados,
      certificadosPendentes: totais.certificadospendentes ?? totais.certificadosPendentes ?? 0,
      pagoCentavos: Number(totais.pagocentavos ?? totais.pagoCentavos ?? 0),
      reservadoCentavos: Number(totais.reservadocentavos ?? totais.reservadoCentavos ?? 0)
    },
    fila,
    disputas: { abertas: disputas.abertas, atrasadas: disputas.atrasadas },
    // O que precisa de olho humano agora.
    atencao: [
      fila.falhadas > 0 && { tipo: 'fila', quantidade: fila.falhadas, texto: `${fila.falhadas} operação(oes) desistiram após várias tentativas` },
      disputas.atrasadas > 0 && { tipo: 'disputa', quantidade: disputas.atrasadas, texto: `${disputas.atrasadas} contestação(oes) passaram do prazo` },
      (totais.certificadospendentes ?? 0) > 0 && { tipo: 'certificado', quantidade: totais.certificadospendentes, texto: `${totais.certificadospendentes} certificado(s) ainda sem registro público` }
    ].filter(Boolean),
    ultimasAcoes: ultimas.map((a) => ({
      acao: a.action, entidade: a.entity, id: a.entity_id, quem: a.quem ?? 'sistema', quando: a.created_at
    }))
  })
}))

adminRouter.get('/users', asyncRoute(async (req, res) => {
  const limite = normalizarLimite(req.query.limite)
  const params = []
  const where = []

  if (req.query.busca) {
    params.push(`%${req.query.busca}%`)
    where.push(`(u.name ilike $${params.length} or u.email ilike $${params.length})`)
  }
  if (req.query.perfil) {
    params.push(req.query.perfil)
    where.push(`u.role = $${params.length}`)
  }
  if (req.query.suspensas === '1') where.push('u.blocked_at is not null')

  const posicao = decodificarCursor(req.query.cursor)
  if (posicao) {
    params.push(posicao.v[0], posicao.v[1])
    where.push(`(u.created_at, u.id) < ($${params.length - 1}, $${params.length})`)
  }
  params.push(limite + 1)

  const linhas = await many(
    `select u.id, u.name, u.email, u.role, u.created_at, u.blocked_at, u.verified_email, u.is_admin,
            (select count(*)::int from jobs where company_id = u.id or student_id = u.id) as vagas
       from users u
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by u.created_at desc, u.id desc
      limit $${params.length}`,
    params
  )

  const pagina = montarPagina(linhas, limite, (l) => ({ o: 'recentes', v: [l.created_at, l.id] }))
  res.json({
    contas: pagina.itens.map((u) => ({
      id: u.id,
      nome: u.name,
      email: u.email,
      perfil: u.role,
      vagas: u.vagas,
      emailVerificado: u.verified_email,
      mediador: u.is_admin,
      suspensaEm: u.blocked_at,
      criadaEm: u.created_at
    })),
    proximoCursor: pagina.proximoCursor,
    temMais: pagina.temMais
  })
}))

adminRouter.post('/users/:id/block', asyncRoute(async (req, res) => {
  const alvo = await one('select id, name, blocked_at, is_admin from users where id = $1', [req.params.id])
  if (!alvo) throw notFound('Não encontramos essa conta.')
  if (alvo.id === req.user.id) throw badRequest('Você não pode suspender a própria conta.')
  if (alvo.is_admin) throw badRequest('Contas de mediação não são suspensas por aqui.')

  const motivo = String(req.body?.motivo ?? '').trim()
  if (motivo.length < 10) {
    throw badRequest('Escreva o motivo da suspensão, com pelo menos 10 caracteres.', { campo: 'motivo' })
  }

  await query('update users set blocked_at = now() where id = $1', [req.params.id])
  // Suspender encerra as sessoes: continuar navegando depois de suspenso seria
  // um bloqueio que so vale no proximo login.
  await query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [req.params.id])

  await registrarAuditoria({
    actorId: req.user.id, action: 'conta.suspensa', entity: 'user', entityId: req.params.id,
    before: { suspensa: false }, after: { suspensa: true, motivo }, ip: req.ip
  })
  res.json({ ok: true, suspensa: true })
}))

adminRouter.post('/users/:id/unblock', asyncRoute(async (req, res) => {
  const alvo = await one('select id, blocked_at from users where id = $1', [req.params.id])
  if (!alvo) throw notFound('Não encontramos essa conta.')
  await query('update users set blocked_at = null where id = $1', [req.params.id])
  await registrarAuditoria({
    actorId: req.user.id, action: 'conta.reativada', entity: 'user', entityId: req.params.id,
    before: { suspensa: true }, after: { suspensa: false }, ip: req.ip
  })
  res.json({ ok: true, suspensa: false })
}))

adminRouter.get('/chain-jobs', asyncRoute(async (req, res) => {
  res.json({
    resumo: await estadoDaFila(),
    itens: await listarFila({ apenasFalhas: req.query.falhas === '1', limite: req.query.limite })
  })
}))

adminRouter.post('/chain-jobs/:id/retry', asyncRoute(async (req, res) => {
  const voltou = await reenfileirar(req.params.id)
  if (!voltou) throw notFound('Não encontramos essa operação na fila.')
  await registrarAuditoria({
    actorId: req.user.id, action: 'fila.reenfileirada', entity: 'chain_job', entityId: req.params.id, ip: req.ip
  })
  res.json({ ok: true })
}))

adminRouter.get('/audit/:entidade/:id', asyncRoute(async (req, res) => {
  res.json({ historico: await historicoDe(req.params.entidade, req.params.id) })
}))
