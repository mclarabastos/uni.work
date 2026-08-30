// Rotas da camada tecnica.
//
// Este e o unico canto do produto que fala a lingua da rede, e ele existe para
// demonstracao: alimenta a gaveta "camada tecnica" do rodape. Nenhuma tela do
// fluxo normal consome estas rotas.

import { Router } from 'express'
import { many, one } from '../db/index.js'
import { config, explorerUrl } from '../config.js'
import { platformSummary } from '../services/platform.js'
import { getConnection, getSolBalance, getPaymentBalance, requestAirdrop } from '../services/solana.js'
import { escrowDriverName } from '../services/escrow.js'
import { indexerAvailable } from '../services/das.js'
import { asyncRoute, requireAuth } from './helpers.js'
import { accountKeyFor } from '../domain/auth.js'

export const chainRouter = Router()

chainRouter.get('/status', asyncRoute(async (req, res) => {
  const platform = platformSummary()
  let rede = { alcancavel: false, versao: null, atraso: null }
  const started = Date.now()
  try {
    const version = await getConnection().getVersion()
    rede = { alcancavel: true, versao: version['solana-core'], atraso: Date.now() - started }
  } catch (err) {
    rede = { alcancavel: false, versao: null, atraso: Date.now() - started, motivo: err.message }
  }

  const transacoes = await many(
    `select id, job_id, kind, status, signature, created_at, error
       from chain_tx order by created_at desc limit 25`
  )

  res.json({
    cluster: config.solana.cluster,
    rpc: config.solana.rpcUrl.replace(/api-key=[^&]+/, 'api-key=***'),
    rede,
    plataforma: platform,
    escrow: { driver: escrowDriverName(), programId: config.escrow.programId || platform.escrowProgramId || null },
    certificado: { driver: config.certificate.driver },
    indexador: { configurado: indexerAvailable() },
    transacoes: transacoes.map((t) => ({
      id: t.id,
      vagaId: t.job_id,
      tipo: t.kind,
      status: t.status,
      assinatura: t.signature,
      quando: t.created_at,
      erro: t.error,
      link: t.signature ? explorerUrl('tx', t.signature) : null
    }))
  })
}))

chainRouter.get('/tx/:id', asyncRoute(async (req, res) => {
  const row = await one('select * from chain_tx where id = $1', [req.params.id])
  if (!row) return res.status(404).json({ error: 'Registro nao encontrado.', codigo: 'nao_encontrado', detalhes: null })
  res.json({
    id: row.id,
    tipo: row.kind,
    status: row.status,
    assinatura: row.signature,
    cluster: row.cluster,
    instrucoes: typeof row.instructions === 'string' ? JSON.parse(row.instructions) : row.instructions,
    detalhe: typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail,
    erro: row.error,
    link: row.signature ? explorerUrl('tx', row.signature) : null
  })
}))

/** Saldos da conta de rede do usuario logado. Consumido so pela gaveta tecnica. */
chainRouter.get('/balances', requireAuth, asyncRoute(async (req, res) => {
  const account = await accountKeyFor(req.user.id)
  const [sol, pagamento] = await Promise.all([
    getSolBalance(account.public_key).catch(() => null),
    getPaymentBalance(account.public_key).catch(() => 0n)
  ])
  res.json({
    endereco: account.public_key,
    sol,
    pagamentoBase: pagamento.toString(),
    link: explorerUrl('address', account.public_key)
  })
}))

chainRouter.post('/faucet', requireAuth, asyncRoute(async (req, res) => {
  const platform = platformSummary()
  if (!platform.ready) {
    return res.status(409).json({
      error: 'O ambiente de rede ainda nao foi preparado.',
      codigo: 'bootstrap_pendente',
      detalhes: { comando: 'npm run bootstrap' }
    })
  }
  const out = await requestAirdrop(platform.publicKey, Number(req.body?.sol ?? 2))
  res.status(out.ok ? 200 : 502).json(out)
}))
