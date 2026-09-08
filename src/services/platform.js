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
let cachedMtimeMs = null

// De onde o estado veio, e por que ele nao veio. Isto existe para a checagem
// de saude poder responder "a variavel nao chegou" em vez de deixar quem
// configurou o servidor adivinhando entre tres causas parecidas.
let fonte = 'ausente'
let erroDeLeitura = null

export function platformStatePath () {
  return config.solana.platformStateFile
}

/**
 * Le o estado. Devolve null se o bootstrap ainda nao rodou.
 *
 * O cache e invalidado pela data de modificacao do arquivo, e nao guardado para
 * sempre. Isto nao e detalhe de performance: o bootstrap roda em OUTRO processo
 * e escreve o arquivo, entao um servidor que subiu antes dele guardaria a versao
 * sem o token de pagamento pela vida inteira. O erro diz "rode npm run
 * bootstrap", a pessoa roda, o bootstrap termina certo — e o servidor continua
 * dizendo a mesma coisa, porque nunca releu. Com a data, a proxima operacao ja
 * enxerga o ambiente pronto, sem reiniciar nada.
 */
export function readPlatformState () {
  const fromSecret = process.env.UNIWORK_PLATFORM_STATE
  if (fromSecret) {
    if (!cached) {
      try {
        cached = JSON.parse(fromSecret)
        fonte = 'variavel'
        erroDeLeitura = null
      } catch (erro) {
        // Segredo mal colado nao pode derrubar a checagem de saude: e justamente
        // ela que precisa continuar respondendo para alguem descobrir o motivo.
        // Uma variavel de ambiente atravessa painel, formulario e area de
        // transferencia antes de chegar aqui, e volta e meia chega com quebra de
        // linha no meio ou aspas em volta.
        fonte = 'variavel_invalida'
        erroDeLeitura = erro.message
        return null
      }
    }
    return cached
  }

  const file = platformStatePath()
  let assinatura = null
  try {
    const info = fs.statSync(file)
    assinatura = `${info.mtimeMs}:${info.size}`
  } catch {
    // Arquivo ausente: o bootstrap ainda nao rodou, ou o reset --tudo apagou.
    // Esquecer o que estava em memoria e parte da resposta correta.
    cached = null
    cachedMtimeMs = null
    fonte = 'ausente'
    erroDeLeitura = null
    return null
  }

  if (cached && cachedMtimeMs === assinatura) return cached

  try {
    cached = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (erro) {
    fonte = 'arquivo_invalido'
    erroDeLeitura = erro.message
    return null
  }
  cachedMtimeMs = assinatura
  fonte = 'arquivo'
  erroDeLeitura = null
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

export function clearPlatformStateCache () {
  cached = null
  cachedMtimeMs = null
}

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

/**
 * De onde o estado foi lido nesta ultima tentativa, e o erro se houve.
 *
 * Sem isto, "bootstrap_pendente" cobre tres situacoes muito diferentes: nao ha
 * nada configurado, ha uma variavel que nao e JSON valido, ou ha um arquivo
 * ilegivel. Quem esta configurando um servidor precisa saber qual das tres,
 * porque a acao e diferente em cada uma.
 */
export function platformStateOrigin () {
  readPlatformState()
  return { fonte, erro: erroDeLeitura }
}

/** Resumo sem segredo, seguro para log, doctor e resposta de API. */
export function platformSummary () {
  const state = readPlatformState()
  if (!state) {
    return {
      ready: false,
      // O motivo diz o que fazer: colar a variavel, corrigir o que foi colado,
      // ou rodar o bootstrap.
      reason: fonte === 'variavel_invalida'
        ? 'estado_invalido'
        : fonte === 'arquivo_invalido'
          ? 'arquivo_invalido'
          : 'bootstrap_pendente',
      fonte,
      erro: erroDeLeitura
    }
  }
  return {
    ready: Boolean(state.publicKey && state.usdcMint),
    fonte,
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
