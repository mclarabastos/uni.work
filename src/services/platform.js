// Estado do bootstrap de devnet: conta da plataforma, token de teste de 6 casas
// que faz o papel do USDC, e a merkle tree do Bubblegum.
//
// O arquivo contem a chave privada da plataforma. Fica em .uniwork/, que esta
// no .gitignore. Em producao esse conteudo vem do gerenciador de segredos
// (UNIWORK_PLATFORM_STATE), nunca de arquivo em disco.

import fs from 'node:fs'
import path from 'node:path'
import { Keypair } from '@solana/web3.js'
import { config } from '../config.js'

export const SCHEMA_VERSION = 1
export const TREE_DEPTH = 14
export const TREE_BUFFER = 64
export const TREE_CAPACITY = 2 ** TREE_DEPTH // 16384 certificados

let cached = null

export function platformStatePath () {
  return config.solana.platformStateFile
}

/** Le o estado. Devolve null se o bootstrap ainda nao rodou. */
export function readPlatformState () {
  if (cached) return cached
  const fromSecret = process.env.UNIWORK_PLATFORM_STATE
  if (fromSecret) {
    cached = JSON.parse(fromSecret)
    return cached
  }
  const file = platformStatePath()
  if (!fs.existsSync(file)) return null
  cached = JSON.parse(fs.readFileSync(file, 'utf8'))
  return cached
}

export function writePlatformState (patch) {
  const file = platformStatePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const current = readPlatformState() ?? {}
  const next = { ...current, ...patch, schemaVersion: SCHEMA_VERSION }
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  cached = next
  return next
}

export function clearPlatformStateCache () { cached = null }

/** Keypair da plataforma. Ela e sempre a fee payer: ninguem mais precisa de SOL. */
export function platformKeypair () {
  const state = readPlatformState()
  if (!state?.secretKey) {
    throw new Error('Conta da plataforma ainda não existe. Rode: npm run bootstrap')
  }
  return Keypair.fromSecretKey(Uint8Array.from(state.secretKey))
}

/**
 * Quanto de valor de teste uma conta de contratante nova recebe.
 *
 * Isto existe porque o ambiente e de demonstracao: o token e criado pelo
 * bootstrap, tem zero valor financeiro, e sem saldo nenhum o contratante nao
 * consegue reservar — a acao principal do produto ficaria impossivel para
 * qualquer conta criada na tela, e a tela nao teria como explicar por que.
 *
 * Em producao, com USDC de verdade, isto nao roda: quem paga traz o proprio
 * saldo. A porta e a existencia do token de teste no estado da plataforma.
 */
export const SALDO_DE_DEMONSTRACAO_CENTAVOS = 500_000_00

/**
 * Abastece uma conta com o token de teste, se o ambiente for de demonstracao.
 *
 * Nunca lanca: uma conta criada e uma conta criada, mesmo que a rede esteja
 * fora. Devolve o que aconteceu para quem chamou registrar.
 */
export async function abastecerContaDeDemonstracao (publicKeyBase58, centavos = SALDO_DE_DEMONSTRACAO_CENTAVOS) {
  const state = readPlatformState()
  if (!state?.usdcMint) return { ok: false, motivo: 'bootstrap_pendente' }
  if (config.solana.cluster !== 'devnet' && config.solana.cluster !== 'localnet') {
    return { ok: false, motivo: 'cluster_de_producao' }
  }

  try {
    const [{ PublicKey }, spl, { getConnection }, { centsToBase }] = await Promise.all([
      import('@solana/web3.js'),
      import('@solana/spl-token'),
      import('./solana.js'),
      import('../lib/money.js')
    ])
    const conexao = getConnection()
    const plataforma = platformKeypair()
    const mint = new PublicKey(state.usdcMint)
    const conta = await spl.getOrCreateAssociatedTokenAccount(
      conexao, plataforma, mint, new PublicKey(publicKeyBase58)
    )
    const assinatura = await spl.mintTo(
      conexao, plataforma, mint, conta.address, plataforma, centsToBase(centavos)
    )
    return { ok: true, assinatura, centavos }
  } catch (erro) {
    return { ok: false, motivo: 'falha_na_rede', detalhe: erro.message }
  }
}

/** Resumo sem segredo, seguro para log, doctor e resposta de API. */
export function platformSummary () {
  const state = readPlatformState()
  if (!state) {
    return { ready: false, reason: 'bootstrap_pendente' }
  }
  return {
    ready: Boolean(state.publicKey && state.usdcMint),
    cluster: state.cluster ?? config.solana.cluster,
    publicKey: state.publicKey ?? null,
    paymentMint: state.usdcMint ?? null,
    merkleTree: state.merkleTree ?? null,
    treeCapacity: state.treeCapacity ?? null,
    escrowProgramId: state.escrowProgramId ?? null,
    schemaVersion: state.schemaVersion ?? null,
    bootstrappedAt: state.bootstrappedAt ?? null,
    outdated: (state.schemaVersion ?? 0) < SCHEMA_VERSION
  }
}
