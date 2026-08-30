// Preparo comum da suite.
//
// Regra da suite: nada aqui toca a rede. Os testes que provam a construcao de
// transacao decodificam os bytes localmente, sem enviar nada para lugar nenhum.

import './env.js'
import { Keypair } from '@solana/web3.js'
import { clearPlatformStateCache } from '../src/services/platform.js'
import { query, closeDb } from '../src/db/index.js'
import { migrar } from '../src/db/migrate.js'

/**
 * Estado de plataforma falso, em memoria, para as funcoes que precisam de uma
 * conta pagadora e de um mint. Nenhuma dessas chaves existe em rede nenhuma.
 */
export function fakePlatform ({ escrowProgramId = null } = {}) {
  const payer = Keypair.generate()
  const mint = Keypair.generate()
  const tree = Keypair.generate()
  process.env.PLATFORM_STATE_FILE = ':memoria-de-teste:'
  const estado = {
    cluster: 'devnet',
    publicKey: payer.publicKey.toBase58(),
    secretKey: [...payer.secretKey],
    usdcMint: mint.publicKey.toBase58(),
    merkleTree: tree.publicKey.toBase58(),
    treeCapacity: 16384,
    escrowProgramId,
    bootstrappedAt: new Date().toISOString()
  }
  clearPlatformStateCache()
  process.env.UNIWORK_PLATFORM_STATE = JSON.stringify(estado)
  return { payer, mint: mint.publicKey, tree: tree.publicKey, estado }
}

export async function prepararBanco () {
  await migrar()
  return { query, closeDb }
}

/** Cria usuario direto no banco, sem passar pela rede. */
export async function criarUsuario ({ id, role = 'student', name = 'Fulano', email }) {
  const { newId } = await import('../src/lib/ids.js')
  const { createAccount } = await import('../src/services/wallet.js')
  const userId = id ?? newId('usr')
  const conta = await createAccount()
  await query(
    'insert into users (id, role, name, email) values ($1, $2, $3, $4)',
    [userId, role, name, email ?? `${userId}@teste.br`]
  )
  await query(
    'insert into accounts (user_id, public_key, secret_cipher) values ($1, $2, $3)',
    [userId, conta.publicKey, conta.secretCipher]
  )
  return { id: userId, role, name, email: email ?? `${userId}@teste.br`, publicKey: conta.publicKey }
}
