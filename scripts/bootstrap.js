#!/usr/bin/env node
// npm run bootstrap — prepara o ambiente de devnet, de forma idempotente.
//
// Faz, em ordem, o que ainda nao foi feito:
//   1. conta da plataforma (a fee payer de todo mundo)
//   2. SOL de teste, tentando o faucet do RPC, depois o do Helius, depois
//      imprimindo o endereco para a pessoa pegar na mao
//   3. token de teste de 6 casas que faz o papel do USDC
//   4. merkle tree do Bubblegum, profundidade 14, buffer 64, 16.384 certificados
//
// Rodar de novo nao recria nada: so completa o que faltou.

import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js'
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID
} from '@solana/spl-token'
import { config } from '../src/config.js'
import { getConnection, requestAirdrop, getSolBalance } from '../src/services/solana.js'
import {
  readPlatformState, writePlatformState, clearPlatformStateCache,
  TREE_DEPTH, TREE_BUFFER, TREE_CAPACITY, platformStatePath
} from '../src/services/platform.js'
import { TOKEN_DECIMALS } from '../src/lib/money.js'

const passo = (texto) => console.log(`  ${texto}`)
const ok = (texto) => console.log(`  ok   ${texto}`)
const aviso = (texto) => console.log(`  !    ${texto}`)

// Quanto o cofre da plataforma precisa para pagar taxa de todo mundo por um bom tempo.
const SOL_ALVO = 2
const SUPRIMENTO_DE_TESTE = 1_000_000 // um milhao de "reais" de mentira para o demo

console.log(`\n  bootstrap de ${config.solana.cluster}\n`)

if (config.solana.cluster !== 'devnet' && !process.env.UNIWORK_PERMITIR_OUTRA_REDE) {
  console.error(`  recusado: o cluster configurado e "${config.solana.cluster}".`)
  console.error('  Este projeto e uma demonstração e só opera em devnet.')
  console.error('  Para insistir, defina UNIWORK_PERMITIR_OUTRA_REDE=1.\n')
  process.exit(1)
}

const conexao = getConnection()

// ─── 1. conta da plataforma ──────────────────────────────────────────────────
let estado = readPlatformState()
if (estado?.secretKey) {
  ok(`conta da plataforma já existe: ${estado.publicKey}`)
} else {
  const nova = Keypair.generate()
  estado = writePlatformState({
    cluster: config.solana.cluster,
    publicKey: nova.publicKey.toBase58(),
    secretKey: [...nova.secretKey],
    criadoEm: new Date().toISOString()
  })
  ok(`conta da plataforma criada: ${estado.publicKey}`)
  passo(`     guardada em ${platformStatePath()} (fora do versionamento)`)
}

const plataforma = Keypair.fromSecretKey(Uint8Array.from(estado.secretKey))

// ─── 2. SOL de teste ─────────────────────────────────────────────────────────
let saldo = 0
try {
  saldo = await getSolBalance(estado.publicKey)
} catch (err) {
  console.error(`\n  não consegui falar com a rede em ${config.solana.rpcUrl}`)
  console.error(`  ${err.message}\n`)
  process.exit(1)
}

if (saldo >= SOL_ALVO * 0.5) {
  ok(`saldo suficiente para taxas: ${saldo.toFixed(3)} SOL`)
} else {
  passo(`saldo em ${saldo.toFixed(3)} SOL, pedindo mais…`)
  const resultado = await requestAirdrop(estado.publicKey, SOL_ALVO)
  if (resultado.ok) {
    ok(`recebido pelo faucet (${resultado.source})`)
    saldo = await getSolBalance(estado.publicKey)
  } else {
    aviso('os faucets automáticos recusaram. Isso acontece com frequência em devnet.')
    for (const tentativa of resultado.attempts) {
      passo(`     ${tentativa.source}: ${tentativa.error}`)
    }
    console.log(`
  Pegue SOL de teste na mao e rode o bootstrap de novo:

      endereço:  ${resultado.manual.address}
      faucet:    ${resultado.manual.url}

  O bootstrap e idempotente: ele retoma daqui.
`)
    process.exit(1)
  }
}

// ─── 3. token de teste que faz o papel do USDC ───────────────────────────────
if (estado.usdcMint) {
  ok(`token de pagamento já existe: ${estado.usdcMint}`)
} else {
  passo('criando o token de teste de 6 casas…')
  const mint = await createMint(
    conexao,
    plataforma,             // paga
    plataforma.publicKey,   // autoridade de emissao
    null,                   // sem autoridade de congelamento
    TOKEN_DECIMALS
  )
  estado = writePlatformState({ usdcMint: mint.toBase58() })
  ok(`token de pagamento criado: ${mint.toBase58()}`)
  passo('     6 casas decimais, mesmo comportamento técnico do USDC, zero valor financeiro')

  passo('emitindo o suprimento de demonstração para a plataforma…')
  const conta = await getOrCreateAssociatedTokenAccount(conexao, plataforma, mint, plataforma.publicKey)
  await mintTo(
    conexao, plataforma, mint, conta.address, plataforma,
    BigInt(SUPRIMENTO_DE_TESTE) * BigInt(10 ** TOKEN_DECIMALS)
  )
  ok(`${SUPRIMENTO_DE_TESTE.toLocaleString('pt-BR')} unidades de teste disponíveis para o seed distribuir`)
}

// ─── 4. merkle tree do Bubblegum ─────────────────────────────────────────────
if (estado.merkleTree) {
  ok(`merkle tree já existe: ${estado.merkleTree} (${estado.treeCapacity ?? TREE_CAPACITY} certificados)`)
} else {
  passo(`criando a merkle tree (profundidade ${TREE_DEPTH}, buffer ${TREE_BUFFER})…`)
  try {
    const [{ createUmi }, umiCore, bubblegum, adapters] = await Promise.all([
      import('@metaplex-foundation/umi-bundle-defaults'),
      import('@metaplex-foundation/umi'),
      import('@metaplex-foundation/mpl-bubblegum'),
      import('@metaplex-foundation/umi-web3js-adapters')
    ])

    const umi = createUmi(config.solana.rpcUrl).use(bubblegum.mplBubblegum())
    umi.use(umiCore.keypairIdentity(adapters.fromWeb3JsKeypair(plataforma)))

    const arvore = umiCore.generateSigner(umi)
    const construtor = await bubblegum.createTree(umi, {
      merkleTree: arvore,
      maxDepth: TREE_DEPTH,
      maxBufferSize: TREE_BUFFER,
      public: false // so a plataforma emite certificado nesta arvore
    })
    await construtor.sendAndConfirm(umi, { confirm: { commitment: 'confirmed' } })

    estado = writePlatformState({
      merkleTree: arvore.publicKey.toString(),
      treeDepth: TREE_DEPTH,
      treeBuffer: TREE_BUFFER,
      treeCapacity: TREE_CAPACITY
    })
    ok(`merkle tree criada: ${arvore.publicKey.toString()}`)
    passo(`     capacidade de ${TREE_CAPACITY.toLocaleString('pt-BR')} certificados`)
  } catch (err) {
    aviso(`não consegui criar a merkle tree agora: ${err.message}`)
    aviso('o certificado vai cair no registro de memo e entrar na fila até a árvore existir.')
  }
}

// ─── fecho ───────────────────────────────────────────────────────────────────
estado = writePlatformState({ bootstrappedAt: new Date().toISOString() })
clearPlatformStateCache()

const saldoFinal = await getSolBalance(estado.publicKey).catch(() => saldo)
console.log(`
  ambiente pronto

    cluster            ${estado.cluster}
    conta da plataforma ${estado.publicKey}
    saldo para taxas   ${saldoFinal.toFixed(3)} SOL
    token de pagamento ${estado.usdcMint ?? 'pendente'}
    merkle tree        ${estado.merkleTree ?? 'pendente'}
    programa de escrow ${estado.escrowProgramId ?? 'não deployado (driver vault)'}
`)

if (!estado.merkleTree) {
  aviso('sem merkle tree o certificado nasce como registro de memo e e reprocessado depois.\n')
}

process.exit(0)
