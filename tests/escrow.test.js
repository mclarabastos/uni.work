// Estes testes decodificam a instrucao byte a byte e provam que ela faz
// exatamente o que o produto diz que faz. Nenhum deles toca a rede.

import { fakePlatform } from './helpers.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { Keypair, PublicKey } from '@solana/web3.js'
import {
  TokenInstruction, decodeTransferCheckedInstruction,
  getAssociatedTokenAddress, TOKEN_PROGRAM_ID
} from '@solana/spl-token'
import {
  planFund, planRelease, planRefund, deriveVaultAuthority,
  anchorDiscriminator, escrowPda, escrowProgramId
} from '../src/services/escrow.js'
import { splitFee, centsToBase } from '../src/lib/money.js'

const ambiente = fakePlatform()
const mint = ambiente.mint

test('reservar o valor monta um TransferChecked que sai da conta do contratante, no valor certo', async () => {
  const contratante = Keypair.generate().publicKey.toBase58()
  const jobId = 'job_reserva'
  const valorCentavos = 24000 // R$ 240,00

  const plano = await planFund({ jobId, companyPubkey: contratante, amountCents: valorCentavos, mint, driver: 'vault' })
  assert.equal(plano.instructions.length, 1, 'reservar e uma instrução só')

  const ix = plano.instructions[0]
  assert.ok(ix.programId.equals(TOKEN_PROGRAM_ID), 'precisa chamar o programa de token')

  const decodificada = decodeTransferCheckedInstruction(ix)

  // 1. E TransferChecked, nao Transfer. TransferChecked confere o mint e as
  //    casas decimais dentro da propria rede: nao da para mandar o token errado.
  assert.equal(decodificada.data.instruction, TokenInstruction.TransferChecked)
  assert.equal(decodificada.data.decimals, 6)

  // 2. O valor em unidades base bate com os centavos pedidos.
  assert.equal(decodificada.data.amount.toString(), centsToBase(valorCentavos).toString())
  assert.equal(decodificada.data.amount.toString(), '240000000')

  // 3. Sai da conta do contratante.
  const contaContratante = await getAssociatedTokenAddress(mint, new PublicKey(contratante), true)
  assert.ok(decodificada.keys.source.pubkey.equals(contaContratante), 'a origem precisa ser a conta do contratante')

  // 4. Vai para o cofre da vaga.
  const autoridade = deriveVaultAuthority(jobId)
  const cofre = await getAssociatedTokenAddress(mint, autoridade.publicKey, true)
  assert.ok(decodificada.keys.destination.pubkey.equals(cofre), 'o destino precisa ser o cofre da vaga')
  assert.equal(plano.vault, cofre.toBase58())

  // 5. Quem autoriza e o proprio contratante, e ele assina.
  assert.ok(decodificada.keys.owner.pubkey.equals(new PublicKey(contratante)))
  const chaveContratante = ix.keys.find((k) => k.pubkey.equals(new PublicKey(contratante)))
  assert.equal(chaveContratante.isSigner, true, 'o contratante precisa assinar a saida da própria conta')

  // 6. O mint conferido e o mint de pagamento, nao outro qualquer.
  assert.ok(decodificada.keys.mint.pubkey.equals(mint))
})

test('liberar o valor divide entre estudante e plataforma, e as duas saidas partem do cofre', async () => {
  const estudante = Keypair.generate().publicKey.toBase58()
  const contratante = Keypair.generate().publicKey.toBase58()
  const jobId = 'job_liberacao'
  const valorCentavos = 12000
  const feeBps = 500

  const plano = await planRelease({
    jobId, studentPubkey: estudante, companyPubkey: contratante,
    amountCents: valorCentavos, mint, feeBps, driver: 'vault'
  })

  assert.equal(plano.instructions.length, 2, 'uma transferência para o estudante, uma para a plataforma')

  const esperado = splitFee(valorCentavos, feeBps)
  const autoridade = deriveVaultAuthority(jobId)
  const cofre = await getAssociatedTokenAddress(mint, autoridade.publicKey, true)
  const contaEstudante = await getAssociatedTokenAddress(mint, new PublicKey(estudante), true)

  // map passa o indice como segundo argumento, e o segundo argumento de
  // decodeTransferCheckedInstruction e o programId. Por isso a arrow function.
  const [paraEstudante, paraPlataforma] = plano.instructions.map((ix) => decodeTransferCheckedInstruction(ix))

  // O estudante recebe o valor combinado menos a taxa.
  assert.equal(paraEstudante.data.instruction, TokenInstruction.TransferChecked)
  assert.equal(paraEstudante.data.amount.toString(), centsToBase(esperado.studentCents).toString())
  assert.equal(paraEstudante.data.amount.toString(), '114000000') // R$ 114,00
  assert.ok(paraEstudante.keys.destination.pubkey.equals(contaEstudante))

  // A plataforma recebe a taxa.
  assert.equal(paraPlataforma.data.amount.toString(), centsToBase(esperado.feeCents).toString())
  assert.equal(paraPlataforma.data.amount.toString(), '6000000') // R$ 6,00

  // As duas saem do cofre e as duas sao autorizadas pelo cofre, nao pelo
  // contratante: depois de reservado, ele nao manda mais no dinheiro.
  for (const decodificada of [paraEstudante, paraPlataforma]) {
    assert.ok(decodificada.keys.source.pubkey.equals(cofre), 'a origem precisa ser o cofre')
    assert.ok(decodificada.keys.owner.pubkey.equals(autoridade.publicKey), 'quem autoriza e o cofre')
    assert.equal(decodificada.data.decimals, 6)
  }

  // A soma das duas saidas e exatamente o que entrou. O cofre zera.
  const somaSaidas = paraEstudante.data.amount + paraPlataforma.data.amount
  assert.equal(somaSaidas.toString(), centsToBase(valorCentavos).toString())

  // O plano expoe o cofre como signatario extra: sem ele a transacao nao passa.
  assert.equal(plano.signers.length, 1)
  assert.ok(plano.signers[0].publicKey.equals(autoridade.publicKey))
})

test('o cofre e deterministico por vaga e diferente entre vagas', async () => {
  // Deterministico: a plataforma reabre o mesmo cofre depois de um restart,
  // sem guardar segredo por vaga.
  const a1 = deriveVaultAuthority('job_alfa')
  const a2 = deriveVaultAuthority('job_alfa')
  assert.equal(a1.publicKey.toBase58(), a2.publicKey.toBase58())

  // Diferente por vaga: o dinheiro de uma vaga nunca encosta no de outra.
  const b = deriveVaultAuthority('job_beta')
  assert.notEqual(a1.publicKey.toBase58(), b.publicKey.toBase58())

  // E derivado da chave mestra: outra chave, outro cofre.
  const comOutraChave = deriveVaultAuthority('job_alfa', 'chave-mestra-diferente')
  assert.notEqual(a1.publicKey.toBase58(), comOutraChave.publicKey.toBase58())

  // Devolver o valor sai do cofre e volta para o contratante.
  const contratante = Keypair.generate().publicKey.toBase58()
  const plano = await planRefund({ jobId: 'job_alfa', companyPubkey: contratante, amountCents: 5000, mint, driver: 'vault' })
  const decodificada = decodeTransferCheckedInstruction(plano.instructions[0])
  const contaContratante = await getAssociatedTokenAddress(mint, new PublicKey(contratante), true)
  assert.ok(decodificada.keys.destination.pubkey.equals(contaContratante), 'a devolução volta para quem reservou')
  assert.ok(decodificada.keys.owner.pubkey.equals(a1.publicKey), 'quem autoriza a devolução e o cofre')
  assert.equal(decodificada.data.amount.toString(), '50000000')
})

test('o driver anchor monta a instrução com o discriminador e o endereço derivado corretos', async () => {
  // O program id vem da mesma funcao que o codigo de producao usa. Assim o
  // teste vale nos dois modos: com o driver vault ele cai no estado da
  // plataforma, e com ESCROW_DRIVER=anchor ele usa o id configurado.
  const ambienteAnchor = fakePlatform({ escrowProgramId: Keypair.generate().publicKey.toBase58() })
  const programa = escrowProgramId()

  const contratante = Keypair.generate().publicKey.toBase58()
  const jobId = 'job_anchor'
  const plano = await planFund({
    jobId, companyPubkey: contratante, amountCents: 30000,
    mint: ambienteAnchor.mint, driver: 'anchor', feeBps: 250, deadlineUnix: 1893456000
  })

  const ix = plano.instructions[0]
  assert.ok(ix.programId.equals(programa), 'precisa chamar o nosso programa, não o de token')

  // O discriminador Anchor sao os 8 primeiros bytes de sha256("global:<nome>").
  const esperado = crypto.createHash('sha256').update('global:initialize_and_deposit').digest().subarray(0, 8)
  assert.deepEqual([...ix.data.subarray(0, 8)], [...esperado])
  assert.deepEqual([...anchorDiscriminator('initialize_and_deposit')], [...esperado])

  // Depois do discriminador vem o hash do id da vaga, o valor, a taxa e o prazo.
  const hashDaVaga = crypto.createHash('sha256').update(jobId).digest()
  assert.deepEqual([...ix.data.subarray(8, 40)], [...hashDaVaga])
  assert.equal(ix.data.readBigUInt64LE(40).toString(), centsToBase(30000).toString())
  assert.equal(ix.data.readUInt16LE(48), 250, 'a taxa vai no próprio estado do escrow')
  assert.equal(ix.data.readBigInt64LE(50).toString(), '1893456000')
  assert.equal(ix.data.length, 58)

  // O endereco do escrow e derivado do programa, entao nem o contratante nem a
  // plataforma escolhem para onde o dinheiro vai.
  const [pdaEsperada] = escrowPda(jobId, programa)
  assert.equal(plano.escrow, pdaEsperada.toBase58())
  assert.ok(ix.keys[0].pubkey.equals(pdaEsperada))

  // O contratante continua assinando a saida da propria conta.
  const chaveContratante = ix.keys.find((k) => k.pubkey.equals(new PublicKey(contratante)))
  assert.equal(chaveContratante.isSigner, true)

  // Liberar no driver anchor e uma instrucao so: a divisao acontece no programa.
  const liberar = await planRelease({
    jobId, studentPubkey: Keypair.generate().publicKey.toBase58(),
    companyPubkey: contratante, amountCents: 30000, mint: ambienteAnchor.mint,
    feeBps: 250, driver: 'anchor'
  })
  assert.equal(liberar.instructions.length, 1)
  assert.deepEqual(
    [...liberar.instructions[0].data],
    [...anchorDiscriminator('confirm_and_release')]
  )

})
