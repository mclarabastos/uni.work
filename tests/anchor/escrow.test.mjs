// Testes do programa de escrow, contra um validador de verdade.
//
// Rodam com `anchor test`, que compila, sobe um validador local e chama este
// arquivo. Sem o toolchain Anchor instalado eles nao rodam, e dizem isso em vez
// de passar em silencio: um teste que passa sem testar nada e pior que nenhum.
//
// A metade mais importante deste arquivo sao os casos que PRECISAM falhar. Um
// escrow que solta o dinheiro para quem nao devia nao adianta ter caminho feliz
// funcionando.

import test, { before, describe } from 'node:test'
import assert from 'node:assert/strict'
import anchor from '@coral-xyz/anchor'
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, LAMPORTS_PER_SOL } from '@solana/web3.js'
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount,
  getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
} from '@solana/spl-token'
import crypto from 'node:crypto'

const DECIMAIS = 6
const UM_TOKEN = 10n ** BigInt(DECIMAIS)
const VALOR = 240n * UM_TOKEN  // R$ 240,00 de mentira
const TAXA_BPS = 500           // 5%

let provider
let programa
let plataforma
let mint
let disponivel = false
let motivoIndisponivel = ''

before(async () => {
  try {
    provider = anchor.AnchorProvider.env()
    anchor.setProvider(provider)
    // A chave do workspace ja mudou de convencao entre versoes do Anchor
    // (UniworkEscrow, uniworkEscrow, uniwork_escrow). Procurar so uma delas faz
    // este arquivo inteiro virar skip em silencio quando a versao muda — que e
    // exatamente o que o cabecalho aqui em cima diz para nao fazer. O acesso vai
    // dentro de try porque o workspace e um Proxy: chave errada pode lancar em
    // vez de devolver undefined.
    for (const nome of ['UniworkEscrow', 'uniworkEscrow', 'uniwork_escrow', 'uniwork-escrow']) {
      try {
        programa = anchor.workspace[nome]
      } catch {
        programa = undefined
      }
      if (programa) break
    }
    if (!programa) {
      let expostas = 'nenhuma'
      try {
        expostas = Object.keys(anchor.workspace).join(', ') || 'nenhuma'
      } catch { /* o Proxy pode recusar ate a listagem */ }
      throw new Error(`o workspace não expos o programa de escrow (rode com anchor test). Chaves disponíveis: ${expostas}`)
    }

    plataforma = provider.wallet.payer ?? Keypair.generate()
    await provider.connection.getVersion()

    mint = await createMint(provider.connection, plataforma, plataforma.publicKey, null, DECIMAIS)
    disponivel = true
  } catch (err) {
    motivoIndisponivel = err.message
  }
})

/** Cria conta de token, tentando de novo se a rede ainda nao propagou a criacao. */
async function ataComRetentativa (dono) {
  let ultimoErro
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    try {
      return await getOrCreateAssociatedTokenAccount(
        provider.connection, plataforma, mint, dono.publicKey
      )
    } catch (err) {
      ultimoErro = err
      await new Promise((resolve) => setTimeout(resolve, 800))
    }
  }
  throw ultimoErro
}

/** Cria uma conta com SOL e conta de token abastecida. */
async function conta (comSaldo = 0n) {
  const dono = Keypair.generate()
  const tx = new anchor.web3.Transaction().add(
    SystemProgram.transfer({
      fromPubkey: plataforma.publicKey,
      toPubkey: dono.publicKey,
      lamports: 0.05 * LAMPORTS_PER_SOL,
    })
  )
  await provider.sendAndConfirm(tx, [plataforma])
  const tokenAccount = await ataComRetentativa(dono)
  if (comSaldo > 0n) {
    await mintTo(provider.connection, plataforma, mint, tokenAccount.address, plataforma, comSaldo)
  }
  return { dono, token: tokenAccount.address }
}

function pdaDoEscrow (jobId) {
  const hash = crypto.createHash('sha256').update(jobId).digest()
  const [endereco] = PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), hash], programa.programId
  )
  return { hash: [...hash], endereco }
}

async function saldo (tokenAccount) {
  return (await getAccount(provider.connection, tokenAccount)).amount
}

/**
 * Cria um escrow financiado e devolve tudo que os testes precisam mexer.
 */
async function escrowFinanciado ({ prazo = 0, mediador = null } = {}) {
  const jobId = `job_${crypto.randomBytes(6).toString('hex')}`
  const { hash, endereco } = pdaDoEscrow(jobId)
  const contratante = await conta(VALOR * 2n)
  const estudante = await conta()
  const plataformaToken = await getOrCreateAssociatedTokenAccount(
    provider.connection, plataforma, mint, plataforma.publicKey
  )
  const cofre = await getAssociatedTokenAddress(mint, endereco, true)
  const quemMedeia = mediador ?? plataforma.publicKey

  await programa.methods
    .initializeAndDeposit(hash, new anchor.BN(VALOR.toString()), TAXA_BPS, new anchor.BN(prazo))
    .accounts({
      escrow: endereco,
      vault: cofre,
      company: contratante.dono.publicKey,
      companyToken: contratante.token,
      mint,
      mediator: quemMedeia,
      platform: plataforma.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY
    })
    .signers([contratante.dono, plataforma])
    .rpc()

  return { jobId, hash, escrow: endereco, cofre, contratante, estudante, plataformaToken: plataformaToken.address }
}

async function escolherEstudante (ctx) {
  await programa.methods
    .assignStudent(ctx.estudante.dono.publicKey)
    .accounts({ escrow: ctx.escrow, company: ctx.contratante.dono.publicKey })
    .signers([ctx.contratante.dono])
    .rpc()
}

/** Roda o corpo e exige que ele falhe com o erro nomeado. */
async function precisaFalhar (fn, nomeDoErro) {
  try {
    await fn()
  } catch (err) {
    const texto = `${err.error?.errorCode?.code ?? ''} ${err.message ?? ''}`
    assert.match(texto, new RegExp(nomeDoErro, 'i'),
      `esperava falhar com ${nomeDoErro}, falhou com: ${texto.slice(0, 200)}`)
    return
  }
  assert.fail(`esperava falhar com ${nomeDoErro}, mas passou`)
}

describe('programa de escrow', () => {
  test('sem o toolchain Anchor estes testes não rodam, e dizem isso', (t) => {
    if (!disponivel) {
      t.diagnostic(`toolchain indisponível: ${motivoIndisponivel}`)
      t.diagnostic('instale o Anchor e rode: anchor test')
      t.skip('precisa de anchor test')
      return
    }
    assert.ok(programa.programId)
  })

  // ─── caminho feliz ─────────────────────────────────────────────────────────

  test('depositar tranca o valor no cofre do programa', async (t) => {
    if (!disponivel) return t.skip('precisa de anchor test')
    const ctx = await escrowFinanciado()

    assert.equal(await saldo(ctx.cofre), VALOR, 'o valor precisa estar no cofre')

    const estado = await programa.account.escrow.fetch(ctx.escrow)
    assert.equal(estado.state, 0, 'estado financiado')
    assert.equal(estado.amount.toString(), VALOR.toString())
    assert.equal(estado.feeBps, TAXA_BPS, 'a taxa fica gravada na rede, não no servidor')
    assert.ok(estado.company.equals(ctx.contratante.dono.publicKey))
    assert.ok(estado.student.equals(PublicKey.default), 'ainda sem estudante')
  })

  test('confirmar libera para o estudante e cobra a taxa, e a soma fecha', async (t) => {
    if (!disponivel) return t.skip('precisa de anchor test')
    const ctx = await escrowFinanciado()
    await escolherEstudante(ctx)

    const taxaAntes = await saldo(ctx.plataformaToken)

    await programa.methods
      .confirmAndRelease()
      .accounts({
        escrow: ctx.escrow,
        vault: ctx.cofre,
        company: ctx.contratante.dono.publicKey,
        studentToken: ctx.estudante.token,
        platformToken: ctx.plataformaToken,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID
      })
      .signers([ctx.contratante.dono])
      .rpc()

    const esperadoTaxa = (VALOR * BigInt(TAXA_BPS)) / 10000n
    const esperadoEstudante = VALOR - esperadoTaxa

    assert.equal(await saldo(ctx.estudante.token), esperadoEstudante)
    assert.equal((await saldo(ctx.plataformaToken)) - taxaAntes, esperadoTaxa)
    assert.equal(await saldo(ctx.cofre), 0n, 'o cofre precisa zerar: nada pode ficar preso')

    const estado = await programa.account.escrow.fetch(ctx.escrow)
    assert.equal(estado.state, 1, 'estado liberado')
  })

  test('devolver funciona enquanto ninguém foi escolhido', async (t) => {
    if (!disponivel) return t.skip('precisa de anchor test')
    const ctx = await escrowFinanciado()
    const antes = await saldo(ctx.contratante.token)

    await programa.methods
      .refund()
      .accounts({
        escrow: ctx.escrow,
        vault: ctx.cofre,
        company: ctx.contratante.dono.publicKey,
        companyToken: ctx.contratante.token,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID
      })
      .signers([ctx.contratante.dono])
      .rpc()

    assert.equal((await saldo(ctx.contratante.token)) - antes, VALOR, 'o valor volta inteiro')
    assert.equal(await saldo(ctx.cofre), 0n)
    assert.equal((await programa.account.escrow.fetch(ctx.escrow)).state, 2)
  })

  // ─── caminhos que precisam falhar ──────────────────────────────────────────

  test('um terceiro não consegue liberar o valor', async (t) => {
    if (!disponivel) return t.skip('precisa de anchor test')
    const ctx = await escrowFinanciado()
    await escolherEstudante(ctx)
    const estranho = await conta()

    await precisaFalhar(() => programa.methods
      .confirmAndRelease()
      .accounts({
        escrow: ctx.escrow,
        vault: ctx.cofre,
        company: estranho.dono.publicKey,
        studentToken: ctx.estudante.token,
        platformToken: ctx.plataformaToken,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID
      })
      .signers([estranho.dono])
      .rpc(), 'SemAutoridade')

    assert.equal(await saldo(ctx.cofre), VALOR, 'o valor continua trancado')
  })

  test('o próprio estudante não consegue liberar para si', async (t) => {
    if (!disponivel) return t.skip('precisa de anchor test')
    const ctx = await escrowFinanciado()
    await escolherEstudante(ctx)

    await precisaFalhar(() => programa.methods
      .confirmAndRelease()
      .accounts({
        escrow: ctx.escrow,
        vault: ctx.cofre,
        company: ctx.estudante.dono.publicKey,
        studentToken: ctx.estudante.token,
        platformToken: ctx.plataformaToken,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID
      })
      .signers([ctx.estudante.dono])
      .rpc(), 'SemAutoridade')

    assert.equal(await saldo(ctx.cofre), VALOR)
  })

  test('liberar duas vezes não paga duas vezes', async (t) => {
    if (!disponivel) return t.skip('precisa de anchor test')
    const ctx = await escrowFinanciado()
    await escolherEstudante(ctx)

    const liberar = () => programa.methods
      .confirmAndRelease()
      .accounts({
        escrow: ctx.escrow, vault: ctx.cofre,
        company: ctx.contratante.dono.publicKey,
        studentToken: ctx.estudante.token,
        platformToken: ctx.plataformaToken,
        mint, tokenProgram: TOKEN_PROGRAM_ID
      })
      .signers([ctx.contratante.dono])
      .rpc()

    await liberar()
    const depoisDaPrimeira = await saldo(ctx.estudante.token)

    await precisaFalhar(liberar, 'EstadoNaoPermiteEssaAcao')
    assert.equal(await saldo(ctx.estudante.token), depoisDaPrimeira, 'não pagou de novo')
  })

  test('devolver depois de liberado e recusado', async (t) => {
    if (!disponivel) return t.skip('precisa de anchor test')
    const ctx = await escrowFinanciado()
    await escolherEstudante(ctx)

    await programa.methods
      .confirmAndRelease()
      .accounts({
        escrow: ctx.escrow, vault: ctx.cofre,
        company: ctx.contratante.dono.publicKey,
        studentToken: ctx.estudante.token,
        platformToken: ctx.plataformaToken,
        mint, tokenProgram: TOKEN_PROGRAM_ID
      })
      .signers([ctx.contratante.dono])
      .rpc()

    await precisaFalhar(() => programa.methods
      .refund()
      .accounts({
        escrow: ctx.escrow, vault: ctx.cofre,
        company: ctx.contratante.dono.publicKey,
        companyToken: ctx.contratante.token,
        mint, tokenProgram: TOKEN_PROGRAM_ID
      })
      .signers([ctx.contratante.dono])
      .rpc(), 'EstadoNaoPermiteEssaAcao')
  })

  test('depois de escolher o estudante o contratante não recupera o valor sozinho', async (t) => {
    if (!disponivel) return t.skip('precisa de anchor test')
    const ctx = await escrowFinanciado()
    await escolherEstudante(ctx)

    await precisaFalhar(() => programa.methods
      .refund()
      .accounts({
        escrow: ctx.escrow, vault: ctx.cofre,
        company: ctx.contratante.dono.publicKey,
        companyToken: ctx.contratante.token,
        mint, tokenProgram: TOKEN_PROGRAM_ID
      })
      .signers([ctx.contratante.dono])
      .rpc(), 'EstudanteJaEscolhidoUseDisputa')

    assert.equal(await saldo(ctx.cofre), VALOR)
  })

  test('pagar para a conta de token de outra pessoa e recusado', async (t) => {
    if (!disponivel) return t.skip('precisa de anchor test')
    const ctx = await escrowFinanciado()
    await escolherEstudante(ctx)
    const estranho = await conta()

    await precisaFalhar(() => programa.methods
      .confirmAndRelease()
      .accounts({
        escrow: ctx.escrow, vault: ctx.cofre,
        company: ctx.contratante.dono.publicKey,
        studentToken: estranho.token,       // nao e do estudante do escrow
        platformToken: ctx.plataformaToken,
        mint, tokenProgram: TOKEN_PROGRAM_ID
      })
      .signers([ctx.contratante.dono])
      .rpc(), 'ContaDeDestinoErrada')
  })

  test('taxa acima do teto e recusada na criação', async (t) => {
    if (!disponivel) return t.skip('precisa de anchor test')
    const jobId = `job_${crypto.randomBytes(6).toString('hex')}`
    const { hash, endereco } = pdaDoEscrow(jobId)
    const contratante = await conta(VALOR * 2n)
    const cofre = await getAssociatedTokenAddress(mint, endereco, true)

    await precisaFalhar(() => programa.methods
      .initializeAndDeposit(hash, new anchor.BN(VALOR.toString()), 5000, new anchor.BN(0))
      .accounts({
        escrow: endereco, vault: cofre,
        company: contratante.dono.publicKey, companyToken: contratante.token,
        mint, mediator: plataforma.publicKey, platform: plataforma.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY
      })
      .signers([contratante.dono, plataforma])
      .rpc(), 'TaxaAcimaDoTeto')
  })

  // ─── disputa ───────────────────────────────────────────────────────────────

  test('qualquer uma das partes abre disputa, e isso trava a liberação', async (t) => {
    if (!disponivel) return t.skip('precisa de anchor test')
    const ctx = await escrowFinanciado()
    await escolherEstudante(ctx)

    await programa.methods
      .openDispute(3)
      .accounts({ escrow: ctx.escrow, party: ctx.estudante.dono.publicKey })
      .signers([ctx.estudante.dono])
      .rpc()

    const estado = await programa.account.escrow.fetch(ctx.escrow)
    assert.equal(estado.state, 3, 'estado em disputa')
    assert.equal(estado.disputeReason, 3)
    assert.ok(estado.openedBy.equals(ctx.estudante.dono.publicKey))

    // Com disputa aberta, nem o contratante libera nem recupera.
    await precisaFalhar(() => programa.methods
      .confirmAndRelease()
      .accounts({
        escrow: ctx.escrow, vault: ctx.cofre,
        company: ctx.contratante.dono.publicKey,
        studentToken: ctx.estudante.token, platformToken: ctx.plataformaToken,
        mint, tokenProgram: TOKEN_PROGRAM_ID
      })
      .signers([ctx.contratante.dono])
      .rpc(), 'EstadoNaoPermiteEssaAcao')

    assert.equal(await saldo(ctx.cofre), VALOR, 'o valor fica parado até a mediação')
  })

  test('um terceiro não abre disputa em contrato que não e dele', async (t) => {
    if (!disponivel) return t.skip('precisa de anchor test')
    const ctx = await escrowFinanciado()
    await escolherEstudante(ctx)
    const estranho = await conta()

    await precisaFalhar(() => programa.methods
      .openDispute(1)
      .accounts({ escrow: ctx.escrow, party: estranho.dono.publicKey })
      .signers([estranho.dono])
      .rpc(), 'SemAutoridade')
  })

  test('só o mediador resolve a disputa, e a divisão bate centavo por centavo', async (t) => {
    if (!disponivel) return t.skip('precisa de anchor test')
    const mediador = Keypair.generate()
    const txMediador = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: plataforma.publicKey,
        toPubkey: mediador.publicKey,
        lamports: 0.05 * LAMPORTS_PER_SOL,
      })
    )
    await provider.sendAndConfirm(txMediador, [plataforma])

    const ctx = await escrowFinanciado({ mediador: mediador.publicKey })
    await escolherEstudante(ctx)
    await programa.methods
      .openDispute(2)
      .accounts({ escrow: ctx.escrow, party: ctx.contratante.dono.publicKey })
      .signers([ctx.contratante.dono])
      .rpc()

    // Quem nao e o mediador nao resolve, nem o contratante.
    await precisaFalhar(() => programa.methods
      .resolveDispute(10000)
      .accounts({
        escrow: ctx.escrow, vault: ctx.cofre,
        mediator: ctx.contratante.dono.publicKey,
        studentToken: ctx.estudante.token,
        companyToken: ctx.contratante.token,
        platformToken: ctx.plataformaToken,
        mint, tokenProgram: TOKEN_PROGRAM_ID
      })
      .signers([ctx.contratante.dono])
      .rpc(), 'SemAutoridade')

    const estudanteAntes = await saldo(ctx.estudante.token)
    const contratanteAntes = await saldo(ctx.contratante.token)
    const plataformaAntes = await saldo(ctx.plataformaToken)

    // Meio a meio.
    await programa.methods
      .resolveDispute(5000)
      .accounts({
        escrow: ctx.escrow, vault: ctx.cofre,
        mediator: mediador.publicKey,
        studentToken: ctx.estudante.token,
        companyToken: ctx.contratante.token,
        platformToken: ctx.plataformaToken,
        mint, tokenProgram: TOKEN_PROGRAM_ID
      })
      .signers([mediador])
      .rpc()

    const brutoEstudante = VALOR / 2n
    const taxa = (brutoEstudante * BigInt(TAXA_BPS)) / 10000n
    const liquidoEstudante = brutoEstudante - taxa
    const paraContratante = VALOR - brutoEstudante

    assert.equal((await saldo(ctx.estudante.token)) - estudanteAntes, liquidoEstudante)
    assert.equal((await saldo(ctx.contratante.token)) - contratanteAntes, paraContratante)
    assert.equal((await saldo(ctx.plataformaToken)) - plataformaAntes, taxa)
    assert.equal(await saldo(ctx.cofre), 0n, 'o cofre zera: nada fica preso na divisão')
    assert.equal((await programa.account.escrow.fetch(ctx.escrow)).state, 4)
  })

  test('divisão acima de 10000 e recusada', async (t) => {
    if (!disponivel) return t.skip('precisa de anchor test')
    const ctx = await escrowFinanciado()
    await escolherEstudante(ctx)
    await programa.methods
      .openDispute(1)
      .accounts({ escrow: ctx.escrow, party: ctx.contratante.dono.publicKey })
      .signers([ctx.contratante.dono])
      .rpc()

    await precisaFalhar(() => programa.methods
      .resolveDispute(10001)
      .accounts({
        escrow: ctx.escrow, vault: ctx.cofre, mediator: plataforma.publicKey,
        studentToken: ctx.estudante.token, companyToken: ctx.contratante.token,
        platformToken: ctx.plataformaToken, mint, tokenProgram: TOKEN_PROGRAM_ID
      })
      .signers([plataforma])
      .rpc(), 'DivisaoInvalida')
  })

  // ─── liberacao por prazo ───────────────────────────────────────────────────

  test('auto release e recusado dentro do prazo e liberado depois dele', async (t) => {
    if (!disponivel) return t.skip('precisa de anchor test')

    // Prazo no futuro: ninguem libera ainda.
    const futuro = Math.floor(Date.now() / 1000) + 86400
    const ctx = await escrowFinanciado({ prazo: futuro })
    await escolherEstudante(ctx)
    const qualquerUm = await conta()

    await precisaFalhar(() => programa.methods
      .autoRelease()
      .accounts({
        escrow: ctx.escrow, vault: ctx.cofre, caller: qualquerUm.dono.publicKey,
        studentToken: ctx.estudante.token, platformToken: ctx.plataformaToken,
        mint, tokenProgram: TOKEN_PROGRAM_ID
      })
      .signers([qualquerUm.dono])
      .rpc(), 'AindaDentroDoPrazo')

    // Prazo bem no passado, alem da carencia: agora qualquer pessoa libera para
    // o estudante. E isso que impede o contratante de segurar o pagamento
    // simplesmente sumindo.
    const passado = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60)
    const vencido = await escrowFinanciado({ prazo: passado })
    await escolherEstudante(vencido)
    const antes = await saldo(vencido.estudante.token)

    await programa.methods
      .autoRelease()
      .accounts({
        escrow: vencido.escrow, vault: vencido.cofre, caller: qualquerUm.dono.publicKey,
        studentToken: vencido.estudante.token, platformToken: vencido.plataformaToken,
        mint, tokenProgram: TOKEN_PROGRAM_ID
      })
      .signers([qualquerUm.dono])
      .rpc()

    const taxa = (VALOR * BigInt(TAXA_BPS)) / 10000n
    assert.equal((await saldo(vencido.estudante.token)) - antes, VALOR - taxa)
    assert.equal(await saldo(vencido.cofre), 0n)
    assert.equal((await programa.account.escrow.fetch(vencido.escrow)).state, 1)
  })

  test('auto release não atropela disputa aberta', async (t) => {
    if (!disponivel) return t.skip('precisa de anchor test')
    const passado = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60)
    const ctx = await escrowFinanciado({ prazo: passado })
    await escolherEstudante(ctx)
    await programa.methods
      .openDispute(1)
      .accounts({ escrow: ctx.escrow, party: ctx.contratante.dono.publicKey })
      .signers([ctx.contratante.dono])
      .rpc()

    const qualquerUm = await conta()
    await precisaFalhar(() => programa.methods
      .autoRelease()
      .accounts({
        escrow: ctx.escrow, vault: ctx.cofre, caller: qualquerUm.dono.publicKey,
        studentToken: ctx.estudante.token, platformToken: ctx.plataformaToken,
        mint, tokenProgram: TOKEN_PROGRAM_ID
      })
      .signers([qualquerUm.dono])
      .rpc(), 'EstadoNaoPermiteEssaAcao')

    assert.equal(await saldo(ctx.cofre), VALOR, 'a disputa continua segurando o valor')
  })

  test('só o contratante escolhe o estudante, e só uma vez', async (t) => {
    if (!disponivel) return t.skip('precisa de anchor test')
    const ctx = await escrowFinanciado()
    const estranho = await conta()

    await precisaFalhar(() => programa.methods
      .assignStudent(estranho.dono.publicKey)
      .accounts({ escrow: ctx.escrow, company: estranho.dono.publicKey })
      .signers([estranho.dono])
      .rpc(), 'SemAutoridade')

    await escolherEstudante(ctx)

    // Trocar o destinatario depois seria uma forma de desviar o pagamento.
    await precisaFalhar(() => programa.methods
      .assignStudent(estranho.dono.publicKey)
      .accounts({ escrow: ctx.escrow, company: ctx.contratante.dono.publicKey })
      .signers([ctx.contratante.dono])
      .rpc(), 'EstudanteJaDefinido')
  })
})
