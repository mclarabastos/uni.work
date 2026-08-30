// Ambiente descartavel para os scripts que precisam de um banco proprio.
//
// Este arquivo nao importa nada do projeto, de proposito. Em ESM as importacoes
// sao avaliadas antes de qualquer statement do modulo, entao um script que
// escrevesse `process.env.PGLITE_DIR = ...` depois de `import { rootDir } from
// '../src/config.js'` estaria configurando tarde demais: o config ja teria lido
// o ambiente e apontado para o banco de desenvolvimento.
//
// Isso aconteceu de verdade: o teste de navegador rodou contra o banco real e
// so foi percebido porque a captura de tela mostrava as vagas do seed.
//
// Importe este arquivo ANTES de qualquer coisa do projeto.

import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Prepara um ambiente isolado. Devolve o caminho do banco descartavel para o
 * script apagar no fim.
 */
export function isolar (nome) {
  const banco = path.join(raiz, '.uniwork', `${nome}-pgdata`)

  process.env.PGLITE_DIR = banco
  process.env.WALLET_MASTER_KEY = process.env.WALLET_MASTER_KEY || crypto.randomBytes(32).toString('hex')
  // Um RPC que nao existe: estes scripts nao podem depender de a devnet estar
  // no ar para dizer se o codigo presta.
  process.env.SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'http://127.0.0.1:1'
  process.env.PLATFORM_STATE_FILE = path.join(raiz, '.uniwork', `${nome}-platform.json`)
  process.env.UPLOADS_DIR = path.join(raiz, '.uniwork', `${nome}-uploads`)
  delete process.env.DATABASE_URL
  delete process.env.HELIUS_API_KEY

  return { raiz, banco }
}

/** Estado de plataforma de mentira. Nenhuma destas chaves existe em rede nenhuma. */
export async function plataformaDeMentira () {
  const { Keypair } = await import('@solana/web3.js')
  const pagador = Keypair.generate()
  const estado = {
    cluster: 'devnet',
    publicKey: pagador.publicKey.toBase58(),
    secretKey: [...pagador.secretKey],
    usdcMint: Keypair.generate().publicKey.toBase58(),
    merkleTree: Keypair.generate().publicKey.toBase58(),
    treeCapacity: 16384,
    bootstrappedAt: new Date().toISOString()
  }
  process.env.UNIWORK_PLATFORM_STATE = JSON.stringify(estado)
  return estado
}
