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
    throw new Error('Conta da plataforma ainda nao existe. Rode: npm run bootstrap')
  }
  return Keypair.fromSecretKey(Uint8Array.from(state.secretKey))
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
