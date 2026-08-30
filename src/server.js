// Servidor Express: API e interface no mesmo processo.
// Um comando, uma porta, nenhum build.

import fs from 'node:fs'
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
import { uploadsRouter, profilesRouter, mePerfilRouter } from './routes/uploads.js'
import { healthRouter } from './routes/health.js'
import { adminRouter } from './routes/admin.js'
import { logDeRequisicao, log, anotar } from './lib/logger.js'
import { cabecalhosDeSeguranca, idempotencia } from './lib/seguranca.js'
import { metricsRouter } from './routes/metrics.js'
import { chainRouter } from './routes/chain.js'
import { streamRouter } from './routes/stream.js'
import { demoRouter } from './routes/demo.js'

export function createApp () {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', true)

  app.use(express.json({ limit: '1mb' }))

  app.use(cabecalhosDeSeguranca())
  app.use(logDeRequisicao())

  // O barramento de eventos passa a gerar notificacao aqui, e nao no
  // startServer: quem monta o app sem subir o servidor tambem precisa delas.
  ligarNotificacoes()

  app.use(attachUser)
  // O userId entra no contexto de log assim que a sessao e resolvida, para
  // toda linha da requisicao ja sair identificada.
  app.use((req, _res, next) => { if (req.user) anotar({ userId: req.user.id }); next() })
  app.use('/api', limitePorRequisicao())

  // Idempotencia so onde ela importa: nas rotas que movem dinheiro.
  app.use(['/api/jobs/:id/fund', '/api/jobs/:id/confirm', '/api/jobs/:id/cancel', '/api/disputes/:id/resolve'],
    idempotencia())

  app.use('/api', authRouter)
  app.use('/api/jobs', jobsRouter)
  app.use('/api/disputes', disputesRouter)
  app.use('/api/notifications', notificationsRouter)
  app.use('/api/me', mePreferencesRouter)
  app.use('/api/push', pushRouter)
  app.use('/api/uploads', uploadsRouter)
  app.use('/api/perfis', profilesRouter)
  app.use('/api/me', mePerfilRouter)
  app.use('/api/health', healthRouter)
  app.use('/api/admin', adminRouter)
  app.use('/api', certificatesRouter)
  app.use('/api/metrics', metricsRouter)
  app.use('/api/chain', chainRouter)
  app.use('/api/stream', streamRouter)
  app.use('/api/demo', demoRouter)

  // Mantida por compatibilidade com quem ja aponta para ca. O detalhe esta
  // em /api/health/live e /api/health/ready.
  app.get('/api/health', asyncRoute(async (_req, res) => {
    const info = await dbInfo()
    res.json({ ok: true, banco: info.driver, cluster: config.solana.cluster })
  }))

  /**
   * A marca, resolvida em tempo de execucao.
   *
   * A interface aponta sempre para /marca. Se existir public/logo.png, e ele
   * que sai; senao sai o logo.svg de reserva. Trocar a marca e soltar o
   * arquivo na pasta, sem editar CSS em lugar nenhum.
   */
  app.get('/marca', (_req, res) => {
    const png = path.join(rootDir, 'public', 'logo.png')
    const svg = path.join(rootDir, 'public', 'logo.svg')
    const existePng = fs.existsSync(png)
    res.set('content-type', existePng ? 'image/png' : 'image/svg+xml')
    res.set('cache-control', 'public, max-age=300')
    res.sendFile(existePng ? png : svg)
  })

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

  // O perfil publico e uma pagina que a pessoa manda para um contratante.
  // Precisa abrir direto pelo link, sem conta.
  app.get('/perfil/:id', (_req, res) => {
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
