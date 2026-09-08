// Saude do servico.
//
// Duas rotas, porque as perguntas sao diferentes:
//
//   /live   o processo esta vivo? Se responder nao, reinicie.
//   /ready  ele consegue atender? Se responder nao, tire do balanceador, mas
//           NAO reinicie: o banco pode estar fora e reiniciar nao ajuda.
//
// Confundir as duas causa o pior tipo de incidente: o orquestrador reiniciando
// em laco todas as instancias porque uma dependencia externa caiu.

import { Router } from 'express'
import { query, dbInfo } from '../db/index.js'
import { versaoDoSchema, statusDasMigrations } from '../db/migrate.js'
import { config } from '../config.js'
import { getConnection } from '../services/solana.js'
import { platformSummary } from '../services/platform.js'
import { estadoDaFila } from '../domain/chain-queue.js'
import { lerContadores } from '../lib/logger.js'
import { asyncRoute } from './helpers.js'

export const healthRouter = Router()

const inicio = Date.now()

healthRouter.get('/live', (_req, res) => {
  res.json({
    ok: true,
    desdeSegundos: Math.round((Date.now() - inicio) / 1000),
    versao: process.env.npm_package_version ?? '0.1.0'
  })
})

/**
 * Pronto para atender.
 *
 * O banco e obrigatorio: sem ele nao ha produto. A rede nao e: com ela fora, o
 * produto continua funcionando e as operacoes entram na fila, que e exatamente
 * o que a fase 3 construiu. Por isso a rede entra como aviso, e nao derruba a
 * prontidao.
 */
healthRouter.get('/ready', asyncRoute(async (_req, res) => {
  const checagens = {}
  let pronto = true

  const t0 = Date.now()
  try {
    await query('select 1')
    const info = await dbInfo()
    const migrations = await statusDasMigrations()
    checagens.banco = {
      ok: migrations.pendentes.length === 0,
      driver: info.driver,
      ms: Date.now() - t0,
      schema: await versaoDoSchema(),
      migrationsPendentes: migrations.pendentes.length
    }
    // Rodar com migration pendente e servir um schema que o codigo nao espera.
    if (migrations.pendentes.length) pronto = false
  } catch (err) {
    checagens.banco = { ok: false, erro: err.message, ms: Date.now() - t0 }
    pronto = false
  }

  const t1 = Date.now()
  try {
    const versao = await Promise.race([
      getConnection().getVersion(),
      new Promise((_, rejeitar) => setTimeout(() => rejeitar(new Error('sem resposta em 3s')), 3000))
    ])
    checagens.rede = { ok: true, cluster: config.solana.cluster, versao: versao['solana-core'], ms: Date.now() - t1 }
  } catch (err) {
    // Aviso, nao falha: a fila absorve.
    checagens.rede = { ok: false, cluster: config.solana.cluster, erro: err.message, ms: Date.now() - t1, degradado: true }
  }

  try {
    const fila = await estadoDaFila()
    checagens.fila = { ok: fila.falhadas === 0, ...fila }
  } catch (err) {
    checagens.fila = { ok: false, erro: err.message }
  }

  const plataforma = platformSummary()
  // A origem entra na resposta de proposito: quem configura um servidor precisa
  // saber se a variavel de ambiente chegou, e isso nao da para inferir de fora.
  // Nao vaza segredo: sao os nomes "variavel", "arquivo" ou "ausente".
  checagens.plataforma = {
    ok: plataforma.ready,
    motivo: plataforma.ready ? undefined : plataforma.reason,
    fonte: plataforma.fonte,
    erro: plataforma.erro ?? undefined
  }

  res.status(pronto ? 200 : 503).json({ ok: pronto, checagens })
}))

/** Contadores do processo. Para o painel de operacao, nao para o produto. */
healthRouter.get('/metrics', asyncRoute(async (_req, res) => {
  const fila = await estadoDaFila().catch(() => null)
  res.json({
    processo: {
      desdeSegundos: Math.round((Date.now() - inicio) / 1000),
      memoriaMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      node: process.version
    },
    ...lerContadores(),
    fila
  })
}))
