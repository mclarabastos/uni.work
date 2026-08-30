// Escrow do pagamento. Dois drivers, mesma interface.
//
//   vault  -> cofre custodial por vaga. Funciona sem deploy nenhum.
//             A autoridade sobre o cofre e da plataforma.
//   anchor -> programa Anchor deployado. A autoridade e do programa: nem o
//             contratante nem o Uni.work conseguem tirar o valor de la fora
//             das saidas previstas.
//
// As funcoes plan* sao puras: derivam endereco e montam instrucao sem tocar a
// rede. E por isso que a suite consegue decodificar a transacao byte a byte
// offline e provar que ela faz exatamente o que diz que faz.

import crypto from 'node:crypto'
import { Keypair, PublicKey, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js'
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token'
import { config } from '../config.js'
import { centsToBase, splitFee, TOKEN_DECIMALS } from '../lib/money.js'
import { platformKeypair, readPlatformState } from './platform.js'
import { getConnection, sendTransaction, ensureTokenAccountIx, describeInstructions, paymentMint } from './solana.js'

export function escrowDriverName () {
  return config.escrow.driver
}

// ─── driver vault ────────────────────────────────────────────────────────────

/**
 * Autoridade do cofre da vaga, derivada de forma deterministica da chave mestra
 * e do id da vaga. Deterministica de proposito: a plataforma consegue reabrir o
 * cofre depois de um restart sem guardar mais nenhum segredo por vaga.
 */
export function deriveVaultAuthority (jobId, masterKey = config.security.masterKey) {
  const seed = crypto.createHmac('sha512', String(masterKey))
    .update(`uniwork:vault:v1:${jobId}`)
    .digest()
    .subarray(0, 32)
  return Keypair.fromSeed(Uint8Array.from(seed))
}

/** Endereco do cofre: conta de token do mint de pagamento, dona a autoridade acima. */
export async function vaultAddress (jobId, mint) {
  const authority = deriveVaultAuthority(jobId)
  const address = await getAssociatedTokenAddress(mint, authority.publicKey, true)
  return { authority, address }
}

// ─── driver anchor ───────────────────────────────────────────────────────────

/** Discriminador Anchor: 8 primeiros bytes de sha256 sobre "global:<instrucao>". */
export function anchorDiscriminator (name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)
}

export function escrowProgramId () {
  const id = config.escrow.programId || readPlatformState()?.escrowProgramId
  if (!id) {
    throw new Error('ESCROW_PROGRAM_ID nao configurado. Rode: npm run setup (com o toolchain Anchor instalado)')
  }
  return new PublicKey(id)
}

/**
 * PDA do escrow: seeds ["escrow", sha256(jobId)].
 * O id da vaga e texto de tamanho variavel, e um seed precisa caber em 32 bytes,
 * entao entra o hash e nao o texto.
 */
export function escrowPda (jobId, programId = escrowProgramId()) {
  const jobHash = crypto.createHash('sha256').update(String(jobId)).digest()
  return PublicKey.findProgramAddressSync([Buffer.from('escrow'), jobHash], programId)
}

function u64 (value) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(BigInt(value))
  return buf
}

function u16 (value) {
  const buf = Buffer.alloc(2)
  buf.writeUInt16LE(Number(value))
  return buf
}

function i64 (value) {
  const buf = Buffer.alloc(8)
  buf.writeBigInt64LE(BigInt(value))
  return buf
}

// ─── plano: reservar o valor ─────────────────────────────────────────────────

/**
 * Instrucoes que tiram o valor da conta do contratante e prendem no cofre.
 * Puro: nao consulta a rede.
 */
export async function planFund ({
  jobId,
  companyPubkey,
  amountCents,
  mint,
  driver = escrowDriverName(),
  feeBps = config.escrow.feeBps,
  deadlineUnix = 0,
  mediator = null
}) {
  const mintKey = new PublicKey(mint)
  const company = new PublicKey(companyPubkey)
  const amountBase = centsToBase(amountCents)
  const companyAta = await getAssociatedTokenAddress(mintKey, company, true)

  if (driver === 'anchor') {
    const programId = escrowProgramId()
    const [escrow] = escrowPda(jobId, programId)
    const vault = await getAssociatedTokenAddress(mintKey, escrow, true)
    const platform = platformKeypair().publicKey
    const mediatorKey = mediator ? new PublicKey(mediator) : platform
    const jobHash = crypto.createHash('sha256').update(String(jobId)).digest()
    const data = Buffer.concat([
      anchorDiscriminator('initialize_and_deposit'),
      jobHash,
      u64(amountBase),
      u16(feeBps),
      i64(deadlineUnix)
    ])
    const instruction = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: escrow, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: company, isSigner: true, isWritable: false },
        { pubkey: companyAta, isSigner: false, isWritable: true },
        { pubkey: mintKey, isSigner: false, isWritable: false },
        { pubkey: mediatorKey, isSigner: false, isWritable: false },
        { pubkey: platform, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
      ],
      data
    })
    return {
      driver,
      instructions: [instruction],
      vault: vault.toBase58(),
      escrow: escrow.toBase58(),
      amountBase,
      source: companyAta.toBase58()
    }
  }

  const { address } = await vaultAddress(jobId, mintKey)
  const instruction = createTransferCheckedInstruction(
    companyAta,   // origem: conta do contratante
    mintKey,
    address,      // destino: cofre da vaga
    company,      // autoridade: o proprio contratante
    amountBase,
    TOKEN_DECIMALS
  )
  return {
    driver: 'vault',
    instructions: [instruction],
    vault: address.toBase58(),
    escrow: address.toBase58(),
    amountBase,
    source: companyAta.toBase58()
  }
}

// ─── plano: liberar o valor ──────────────────────────────────────────────────

/**
 * Instrucoes que soltam o valor para o estudante e cobram a taxa da plataforma.
 * No driver vault sao duas transferencias, autorizadas pelo cofre.
 * No driver anchor e uma instrucao so: a divisao acontece dentro do programa,
 * que le fee_bps do proprio estado do escrow.
 */
export async function planRelease ({
  jobId,
  studentPubkey,
  companyPubkey,
  amountCents,
  mint,
  feeBps = config.escrow.feeBps,
  driver = escrowDriverName()
}) {
  const mintKey = new PublicKey(mint)
  const student = new PublicKey(studentPubkey)
  const platform = platformKeypair().publicKey
  const split = splitFee(amountCents, feeBps)
  const studentAta = await getAssociatedTokenAddress(mintKey, student, true)
  const platformAta = await getAssociatedTokenAddress(mintKey, platform, true)

  if (driver === 'anchor') {
    const programId = escrowProgramId()
    const [escrow] = escrowPda(jobId, programId)
    const vault = await getAssociatedTokenAddress(mintKey, escrow, true)
    const instruction = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: escrow, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: new PublicKey(companyPubkey), isSigner: true, isWritable: false },
        { pubkey: student, isSigner: false, isWritable: false },
        { pubkey: studentAta, isSigner: false, isWritable: true },
        { pubkey: platformAta, isSigner: false, isWritable: true },
        { pubkey: mintKey, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
      ],
      data: anchorDiscriminator('confirm_and_release')
    })
    return {
      driver,
      instructions: [instruction],
      split,
      vault: vault.toBase58(),
      escrow: escrow.toBase58(),
      studentAta: studentAta.toBase58(),
      platformAta: platformAta.toBase58()
    }
  }

  const { authority, address } = await vaultAddress(jobId, mintKey)
  const instructions = [
    createTransferCheckedInstruction(
      address, mintKey, studentAta, authority.publicKey,
      centsToBase(split.studentCents), TOKEN_DECIMALS
    )
  ]
  if (split.feeCents > 0) {
    instructions.push(createTransferCheckedInstruction(
      address, mintKey, platformAta, authority.publicKey,
      centsToBase(split.feeCents), TOKEN_DECIMALS
    ))
  }
  return {
    driver: 'vault',
    instructions,
    split,
    signers: [authority],
    vault: address.toBase58(),
    escrow: address.toBase58(),
    studentAta: studentAta.toBase58(),
    platformAta: platformAta.toBase58()
  }
}

// ─── plano: devolver o valor ─────────────────────────────────────────────────

export async function planRefund ({ jobId, companyPubkey, amountCents, mint, driver = escrowDriverName() }) {
  const mintKey = new PublicKey(mint)
  const company = new PublicKey(companyPubkey)
  const companyAta = await getAssociatedTokenAddress(mintKey, company, true)

  if (driver === 'anchor') {
    const programId = escrowProgramId()
    const [escrow] = escrowPda(jobId, programId)
    const vault = await getAssociatedTokenAddress(mintKey, escrow, true)
    const instruction = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: escrow, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: company, isSigner: true, isWritable: false },
        { pubkey: companyAta, isSigner: false, isWritable: true },
        { pubkey: mintKey, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
      ],
      data: anchorDiscriminator('refund')
    })
    return { driver, instructions: [instruction], vault: vault.toBase58(), escrow: escrow.toBase58() }
  }

  const { authority, address } = await vaultAddress(jobId, mintKey)
  const instruction = createTransferCheckedInstruction(
    address, mintKey, companyAta, authority.publicKey,
    centsToBase(amountCents), TOKEN_DECIMALS
  )
  return {
    driver: 'vault',
    instructions: [instruction],
    signers: [authority],
    vault: address.toBase58(),
    escrow: address.toBase58()
  }
}

// ─── execucao: com rede ──────────────────────────────────────────────────────

async function withTokenAccounts (owners, instructions) {
  const prefix = []
  const seen = new Set()
  for (const owner of owners.filter(Boolean)) {
    if (seen.has(owner)) continue
    seen.add(owner)
    const { instruction } = await ensureTokenAccountIx(owner)
    if (instruction) prefix.push(instruction)
  }
  return [...prefix, ...instructions]
}

export async function fundEscrow ({ jobId, companyPubkey, companyKeypair, amountCents, feeBps, deadlineUnix }) {
  const mint = paymentMint()
  const plan = await planFund({ jobId, companyPubkey, amountCents, mint, feeBps, deadlineUnix })
  const vaultOwner = plan.driver === 'vault'
    ? deriveVaultAuthority(jobId).publicKey.toBase58()
    : null // no driver anchor o proprio programa cria a conta do cofre
  const instructions = await withTokenAccounts([companyPubkey, vaultOwner], plan.instructions)
  const { signature, transaction } = await sendTransaction(instructions, [companyKeypair])
  return { ...plan, signature, instructionsDescribed: describeInstructions(transaction) }
}

export async function releaseEscrow ({ jobId, studentPubkey, companyPubkey, companyKeypair, amountCents, feeBps }) {
  const mint = paymentMint()
  const plan = await planRelease({ jobId, studentPubkey, companyPubkey, amountCents, mint, feeBps })
  const instructions = await withTokenAccounts(
    [studentPubkey, platformKeypair().publicKey.toBase58()],
    plan.instructions
  )
  const extra = plan.driver === 'vault' ? plan.signers : [companyKeypair]
  const { signature, transaction } = await sendTransaction(instructions, extra.filter(Boolean))
  return { ...plan, signature, instructionsDescribed: describeInstructions(transaction) }
}

export async function refundEscrow ({ jobId, companyPubkey, companyKeypair, amountCents }) {
  const mint = paymentMint()
  const plan = await planRefund({ jobId, companyPubkey, amountCents, mint })
  const instructions = await withTokenAccounts([companyPubkey], plan.instructions)
  const extra = plan.driver === 'vault' ? plan.signers : [companyKeypair]
  const { signature, transaction } = await sendTransaction(instructions, extra.filter(Boolean))
  return { ...plan, signature, instructionsDescribed: describeInstructions(transaction) }
}

/** Saldo preso no cofre da vaga, em unidades base. */
export async function vaultBalance (jobId) {
  const mint = paymentMint()
  const { getAccount } = await import('@solana/spl-token')
  const address = escrowDriverName() === 'anchor'
    ? await getAssociatedTokenAddress(mint, escrowPda(jobId)[0], true)
    : (await vaultAddress(jobId, mint)).address
  try {
    const account = await getAccount(getConnection(), address)
    return account.amount
  } catch {
    return 0n
  }
}
