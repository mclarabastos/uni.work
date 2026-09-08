// Conexao com a rede, envio de transacao, saldos e faucet.
//
// Duas regras que valem para todo o arquivo:
//   1. A plataforma e SEMPRE a fee payer. Estudante e contratante assinam como
//      donos das suas contas de token, mas nunca precisam de SOL.
//   2. Nenhuma mensagem daqui chega crua na tela. Quem chama traduz.

import { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { getAccount, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { config } from '../config.js'
import { platformKeypair, readPlatformState } from './platform.js'
import { contar, registrarDuracao } from '../lib/logger.js'
import { ambienteIncompleto } from '../lib/errors.js'

let connection = null

export function getConnection () {
  if (!connection) {
    connection = new Connection(config.solana.rpcUrl, { commitment: 'confirmed' })
  }
  return connection
}

/** Usado nos testes para injetar uma conexao falsa e nao tocar a rede. */
export function setConnection (fake) { connection = fake }

export function paymentMint () {
  const state = readPlatformState()
  if (!state?.usdcMint) {
    throw ambienteIncompleto('Token de pagamento ainda nao existe. Rode: npm run bootstrap')
  }
  return new PublicKey(state.usdcMint)
}

export async function tokenAccountFor (ownerBase58) {
  return getAssociatedTokenAddress(paymentMint(), new PublicKey(ownerBase58), true)
}

/**
 * Garante que a conta de token do dono existe, criando-a se preciso.
 * A plataforma paga o aluguel: o dono nao precisa ter nada na conta antes.
 */
export async function ensureTokenAccountIx (ownerBase58) {
  const owner = new PublicKey(ownerBase58)
  const ata = await getAssociatedTokenAddress(paymentMint(), owner, true)
  const conn = getConnection()
  try {
    await getAccount(conn, ata)
    return { address: ata, instruction: null }
  } catch {
    return {
      address: ata,
      instruction: createAssociatedTokenAccountInstruction(
        platformKeypair().publicKey, // fee payer e dono do aluguel
        ata,
        owner,
        paymentMint()
      )
    }
  }
}

/**
 * Monta, assina e envia. A plataforma entra como fee payer e como signatario,
 * mais quaisquer signatarios extras que a instrucao exigir.
 * Devolve tambem a transacao montada, para o teste conseguir inspecionar bytes.
 */
export async function buildTransaction (instructions, extraSigners = []) {
  const payer = platformKeypair()
  const conn = getConnection()
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight })
  tx.add(...instructions)
  const signers = [payer, ...extraSigners.filter((s) => !s.publicKey.equals(payer.publicKey))]
  tx.sign(...signers)
  return { transaction: tx, blockhash, lastValidBlockHeight, signers }
}

export async function sendTransaction (instructions, extraSigners = []) {
  const conn = getConnection()
  const comecou = Date.now()
  try {
    const { transaction, lastValidBlockHeight, blockhash } = await buildTransaction(instructions, extraSigners)
    const signature = await conn.sendRawTransaction(transaction.serialize(), {
      skipPreflight: true,
      maxRetries: 3
    })
    contar('rede.enviadas')
    await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
    contar('rede.confirmadas')
    registrarDuracao('rede.ateConfirmar', Date.now() - comecou)
    return { signature, transaction }
  } catch (err) {
    contar('rede.falhas')
    throw err
  }
}

/** Descreve as instrucoes de uma transacao para a gaveta "camada tecnica". */
export function describeInstructions (transaction) {
  return transaction.instructions.map((ix, index) => ({
    index,
    programId: ix.programId.toBase58(),
    accounts: ix.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      signer: k.isSigner,
      writable: k.isWritable
    })),
    dataBase64: Buffer.from(ix.data).toString('base64'),
    dataLength: ix.data.length
  }))
}

export async function getSolBalance (publicKeyBase58) {
  const lamports = await getConnection().getBalance(new PublicKey(publicKeyBase58))
  return lamports / LAMPORTS_PER_SOL
}

/** Saldo do token de pagamento em unidades base. Zero se a conta ainda nao existe. */
export async function getPaymentBalance (publicKeyBase58) {
  try {
    const ata = await tokenAccountFor(publicKeyBase58)
    const account = await getAccount(getConnection(), ata)
    return account.amount
  } catch {
    return 0n
  }
}

export function transferSolIx (fromKeypair, toBase58, sol) {
  return SystemProgram.transfer({
    fromPubkey: fromKeypair.publicKey,
    toPubkey: new PublicKey(toBase58),
    lamports: Math.round(sol * LAMPORTS_PER_SOL)
  })
}

/**
 * Pede SOL de teste, tentando as fontes em ordem.
 * O faucet publico recusa com frequencia, entao existe plano B e plano C:
 * o plano C nao consegue nada sozinho, mas diz exatamente o que fazer na mao.
 */
export async function requestAirdrop (publicKeyBase58, sol = 2) {
  const attempts = []

  // 1. faucet do proprio RPC
  try {
    const conn = getConnection()
    const signature = await conn.requestAirdrop(new PublicKey(publicKeyBase58), Math.round(sol * LAMPORTS_PER_SOL))
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
    await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
    return { ok: true, source: 'rpc', signature, attempts }
  } catch (err) {
    attempts.push({ source: 'rpc', error: err.message })
  }

  // 2. faucet do Helius, quando ha chave configurada
  if (config.solana.heliusApiKey) {
    try {
      const res = await fetch(`https://api.helius.xyz/v0/addresses/${publicKeyBase58}/airdrop?api-key=${config.solana.heliusApiKey}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: Math.round(sol * LAMPORTS_PER_SOL) })
      })
      if (res.ok) {
        const body = await res.json().catch(() => ({}))
        return { ok: true, source: 'helius', signature: body.signature ?? null, attempts }
      }
      attempts.push({ source: 'helius', error: `HTTP ${res.status}` })
    } catch (err) {
      attempts.push({ source: 'helius', error: err.message })
    }
  } else {
    attempts.push({ source: 'helius', error: 'HELIUS_API_KEY não configurada' })
  }

  // 3. ultimo recurso: instrucao manual
  return {
    ok: false,
    source: 'manual',
    attempts,
    manual: {
      address: publicKeyBase58,
      url: 'https://faucet.solana.com',
      hint: `Cole o endereço ${publicKeyBase58} em https://faucet.solana.com e peca ${sol} SOL de devnet.`
    }
  }
}

export { PublicKey, TOKEN_PROGRAM_ID, LAMPORTS_PER_SOL }
