// Servidor Express: API e interface no mesmo processo.
// Um comando, uma porta, nenhum build.

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import express from 'express'
import { config, rootDir } from './config.js'
import { getDb, dbInfo } from './db/index.js'
import { migrar, versaoDoSchema } from './db/migrate.js'
import { attachUser, errorHandler, asyncRoute } from './routes/helpers.js'
import { limitePorRequisicao } from './lib/ratelimit.js'
import { iniciarWorker } from './workers/chain.js'
import { ligarNotificacoes } from './domain/notifications.js'
import { authRouter } from './routes/auth.js'
import { jobsRouter } from './routes/jobs.js'
import { certificatesRouter } from './routes/certificates.js'
import { disputesRouter } from './routes/disputes.js'
import { notificationsRouter, mePreferencesRouter, pushRouter } from './routes/notifications.js'
import { metricsRouter } from './routes/metrics.js'
import { chainRouter } from './routes/chain.js'
import { streamRouter } from './routes/stream.js'

export function createApp () {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', true)

  app.use(express.json({ limit: '1mb' }))

  app.use((_req, res, next) => {
    res.set('x-content-type-options', 'nosniff')
    res.set('referrer-policy', 'strict-origin-when-cross-origin')
    next()
  })

  // O barramento de eventos passa a gerar notificacao aqui, e nao no
  // startServer: quem monta o app sem subir o servidor tambem precisa delas.
  ligarNotificacoes()

  app.use(attachUser)
  app.use('/api', limitePorRequisicao())

  app.use('/api', authRouter)
  app.use('/api/jobs', jobsRouter)
  app.use('/api/disputes', disputesRouter)
  app.use('/api/notifications', notificationsRouter)
  app.use('/api/me', mePreferencesRouter)
  app.use('/api/push', pushRouter)
  app.use('/api', certificatesRouter)
  app.use('/api/metrics', metricsRouter)
  app.use('/api/chain', chainRouter)
  app.use('/api/stream', streamRouter)

  app.get('/api/health', asyncRoute(async (_req, res) => {
    const info = await dbInfo()
    res.json({ ok: true, banco: info.driver, cluster: config.solana.cluster })
  }))

  app.use(express.static(path.join(rootDir, 'public'), { extensions: ['html'] }))

  // A verificacao publica e uma rota de leitura da interface: qualquer pessoa
  // abre o link e ve o certificado, sem conta.
  app.get('/verificar/:code', (_req, res) => {
    res.sendFile(path.join(rootDir, 'public', 'index.html'))
  })

  // O link do e-mail cai aqui. A interface le o token da URL e troca por sessao.
  app.get('/entrar', (_req, res) => {
    res.sendFile(path.join(rootDir, 'public', 'index.html'))
  })

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Rota nao encontrada.', codigo: 'rota_nao_encontrada', detalhes: null })
  })

  app.use(errorHandler)
  return app
}

export async function startServer () {
  await getDb()
  await migrar({ log: (m) => console.log(`  migration: ${m}`) })
  const info = await dbInfo()
  const schema = await versaoDoSchema()
  const app = createApp()
  // O worker sobe junto com o servidor: a fila so serve se alguem tirar dela.
  iniciarWorker()
  return new Promise((resolve) => {
    const server = app.listen(config.port, () => {
      console.log(`\n  Uni.work no ar em http://localhost:${config.port}`)
      console.log(`  banco:   ${info.label} (schema ${schema})`)
      console.log(`  rede:    ${config.solana.cluster}`)
      console.log(`  escrow:  ${config.escrow.driver}   certificado: ${config.certificate.driver}\n`)
      resolve(server)
    })
  })
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  startServer().catch((err) => {
    console.error('Nao foi possivel subir o servidor:', err.message)
    process.exit(1)
  })
}
