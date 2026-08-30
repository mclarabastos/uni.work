// Toda a configuracao do Uni.work em um lugar so.
// Le o .env (se existir), aplica padroes seguros e expoe um objeto congelado.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Carrega o .env sem depender de pacote externo. Node 20.6+ tem loadEnvFile,
// mas ele lanca se o arquivo nao existir, entao checamos antes.
function loadEnvFile (file) {
  if (!fs.existsSync(file)) return false
  const text = fs.readFileSync(file, 'utf8')
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    if (key in process.env) continue // variavel de ambiente real sempre vence
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
  return true
}

loadEnvFile(path.join(rootDir, '.env'))

const env = process.env

function str (key, fallback = '') {
  const value = env[key]
  return value === undefined || value === '' ? fallback : String(value)
}

function int (key, fallback) {
  const value = Number.parseInt(env[key] ?? '', 10)
  return Number.isFinite(value) ? value : fallback
}

function oneOf (key, allowed, fallback) {
  const value = str(key, fallback)
  return allowed.includes(value) ? value : fallback
}

const nodeEnv = str('NODE_ENV', 'development')
const isProduction = nodeEnv === 'production'
const isTest = nodeEnv === 'test'

// A chave mestra e obrigatoria em producao. Em desenvolvimento e teste, se
// estiver faltando, derivamos uma chave estavel do proprio diretorio do projeto
// para que a suite rode sem configuracao, mas o doctor avisa que ela e efemera.
function resolveMasterKey () {
  const provided = str('WALLET_MASTER_KEY')
  if (provided) return { key: provided, ephemeral: false }
  if (isProduction) {
    throw new Error(
      'WALLET_MASTER_KEY nao configurada. Em producao ela precisa vir do gerenciador de segredos.'
    )
  }
  const derived = crypto.createHash('sha256').update(`uniwork-dev:${rootDir}`).digest('hex')
  return { key: derived, ephemeral: true }
}

const master = resolveMasterKey()
const heliusKey = str('HELIUS_API_KEY')
const cluster = oneOf('SOLANA_CLUSTER', ['devnet', 'testnet', 'localnet'], 'devnet')

const defaultRpc = heliusKey
  ? `https://${cluster}.helius-rpc.com/?api-key=${heliusKey}`
  : 'https://api.devnet.solana.com'

const publicBaseUrl = str('PUBLIC_BASE_URL', `http://localhost:${int('PORT', 4000)}`).replace(/\/+$/, '')

export const config = Object.freeze({
  nodeEnv,
  isProduction,
  isTest,
  port: int('PORT', 4000),
  publicBaseUrl,
  // Metadados de certificado precisam de URL alcancavel de fora. localhost nao serve.
  publicBaseUrlIsLocal: /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(publicBaseUrl),

  db: Object.freeze({
    url: str('DATABASE_URL'),
    driver: str('DATABASE_URL') ? 'postgres' : 'pglite',
    pgliteDir: path.resolve(rootDir, str('PGLITE_DIR', '.uniwork/pgdata')),
    poolMax: int('DB_POOL_MAX', 10),
    statementTimeoutMs: int('DB_STATEMENT_TIMEOUT_MS', 15000),
    idleTxTimeoutMs: int('DB_IDLE_TX_TIMEOUT_MS', 30000)
  }),

  security: Object.freeze({
    masterKey: master.key,
    masterKeyIsEphemeral: master.ephemeral,
    sessionTtlHours: int('SESSION_TTL_HOURS', 720)
  }),

  solana: Object.freeze({
    cluster,
    rpcUrl: str('SOLANA_RPC_URL', defaultRpc),
    heliusApiKey: heliusKey,
    hasIndexer: Boolean(heliusKey),
    dasUrl: heliusKey ? `https://${cluster}.helius-rpc.com/?api-key=${heliusKey}` : '',
    platformStateFile: path.resolve(rootDir, str('PLATFORM_STATE_FILE', '.uniwork/platform.json')),
    explorerBase: 'https://explorer.solana.com'
  }),

  escrow: Object.freeze({
    driver: oneOf('ESCROW_DRIVER', ['vault', 'anchor'], 'vault'),
    programId: str('ESCROW_PROGRAM_ID'),
    feeBps: int('PLATFORM_FEE_BPS', 500)
  }),

  certificate: Object.freeze({
    driver: oneOf('CERT_DRIVER', ['bubblegum', 'memo'], 'bubblegum')
  })
})

export function explorerUrl (kind, value) {
  const suffix = config.solana.cluster === 'localnet'
    ? '?cluster=custom'
    : `?cluster=${config.solana.cluster}`
  return `${config.solana.explorerBase}/${kind}/${value}${suffix}`
}

export default config
