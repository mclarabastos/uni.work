#!/usr/bin/env node
// npm run setup — deixa tudo no ar em um comando.
//
// Idempotente do comeco ao fim: rodar de novo so completa o que faltou.
// Nenhuma etapa mente. Se algo nao deu, o setup diz o que foi e como resolver,
// e segue para o que ainda da para fazer.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { rootDir } from '../src/config.js'

const cabecalho = (t) => console.log(`\n  ${t}\n  ${'─'.repeat(Math.max(10, t.length))}`)
const ok = (t) => console.log(`  ok   ${t}`)
const passo = (t) => console.log(`  ${t}`)
const aviso = (t) => console.log(`  !    ${t}`)

const pendencias = []

function rodar (comando, args, opcoes = {}) {
  return spawnSync(comando, args, {
    cwd: rootDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...opcoes
  })
}

function rodarNode (script, args = []) {
  return spawnSync(process.execPath, [path.join(rootDir, 'scripts', script), ...args], {
    cwd: rootDir,
    stdio: 'inherit'
  })
}

console.log('\n  setup do Uni.work')

// ─── 1. Node e dependencias ──────────────────────────────────────────────────
cabecalho('1. ambiente')

const major = Number(process.versions.node.split('.')[0])
if (major < 20) {
  console.error(`\n  Node ${process.version} e antigo demais. Instale o Node 20 ou mais novo.\n`)
  process.exit(1)
}
ok(`Node ${process.version}`)

if (!fs.existsSync(path.join(rootDir, 'node_modules'))) {
  passo('instalando dependencias…')
  const instalou = rodar('npm', ['install', '--no-audit', '--no-fund'], { stdio: 'inherit' })
  if (instalou.status !== 0) {
    console.error('\n  npm install falhou. Resolva e rode npm run setup de novo.\n')
    process.exit(1)
  }
  ok('dependencias instaladas')
} else {
  ok('dependencias ja instaladas')
}

// ─── 2. .env ─────────────────────────────────────────────────────────────────
cabecalho('2. configuracao')

const envPath = path.join(rootDir, '.env')
const exemploPath = path.join(rootDir, '.env.example')

if (!fs.existsSync(envPath)) {
  fs.copyFileSync(exemploPath, envPath)
  ok('.env criado a partir do .env.example')
} else {
  ok('.env ja existe')
}

// A chave mestra e gerada uma vez e nunca mais mexida: trocar sem rotacao
// tornaria ilegivel o segredo de todas as contas ja criadas.
let env = fs.readFileSync(envPath, 'utf8')
if (/^WALLET_MASTER_KEY=\s*$/m.test(env)) {
  const chave = crypto.randomBytes(32).toString('hex')
  env = env.replace(/^WALLET_MASTER_KEY=\s*$/m, `WALLET_MASTER_KEY=${chave}`)
  fs.writeFileSync(envPath, env)
  ok('chave mestra gerada e gravada no .env')
  passo('     ela cifra o segredo de cada conta. Nao troque sem rotacionar.')
} else {
  ok('chave mestra ja configurada')
}

if (!/^HELIUS_API_KEY=.+$/m.test(env)) {
  pendencias.push({
    titulo: 'HELIUS_API_KEY nao configurada',
    porque: 'sem ela nao ha confirmacao independente do certificado, e o faucet publico costuma recusar',
    como: 'pegue uma chave gratuita em https://dashboard.helius.dev e coloque em HELIUS_API_KEY no .env'
  })
}

// ─── 3. bootstrap de devnet ──────────────────────────────────────────────────
cabecalho('3. ambiente de devnet')

const bootstrap = rodarNode('bootstrap.js')
if (bootstrap.status !== 0) {
  pendencias.push({
    titulo: 'o ambiente de devnet nao ficou completo',
    porque: 'sem conta com saldo, token de teste e merkle tree, o fluxo on-chain nao roda',
    como: 'siga a instrucao impressa acima e rode npm run setup de novo (ele retoma de onde parou)'
  })
}

// ─── 4. programa Anchor ──────────────────────────────────────────────────────
cabecalho('4. programa de escrow')

const temAnchor = rodar('anchor', ['--version']).status === 0
const temCargo = rodar('cargo', ['--version']).status === 0

if (!temAnchor || !temCargo) {
  aviso('toolchain Anchor nao encontrado, pulando a compilacao e o deploy')
  passo('     o driver vault funciona sem deploy nenhum, entao o produto roda assim mesmo')
  pendencias.push({
    titulo: 'programa Anchor nao deployado',
    porque: 'no driver vault a autoridade sobre o cofre e da plataforma; no anchor e do programa',
    como: 'instale o Anchor (https://www.anchor-lang.com/docs/installation) e rode npm run setup de novo'
  })
} else {
  passo('compilando o programa…')
  const build = rodar('anchor', ['build'], { stdio: 'inherit' })
  if (build.status !== 0) {
    pendencias.push({
      titulo: 'anchor build falhou',
      porque: 'sem o programa compilado nao ha deploy',
      como: 'veja o erro acima; o driver vault continua funcionando enquanto isso'
    })
  } else {
    ok('programa compilado')
    passo('fazendo o deploy em devnet…')
    const deploy = rodar('anchor', ['deploy', '--provider.cluster', 'devnet'], { encoding: 'utf8' })
    process.stdout.write(deploy.stdout ?? '')

    // O deploy imprime o program id. Em vez de pedir para a pessoa copiar na
    // mao, lemos daqui e gravamos no .env e no estado da plataforma.
    const encontrado = `${deploy.stdout ?? ''}${deploy.stderr ?? ''}`
      .match(/Program Id:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/)

    if (deploy.status === 0 && encontrado) {
      const programId = encontrado[1]
      env = fs.readFileSync(envPath, 'utf8')
      env = /^ESCROW_PROGRAM_ID=.*$/m.test(env)
        ? env.replace(/^ESCROW_PROGRAM_ID=.*$/m, `ESCROW_PROGRAM_ID=${programId}`)
        : `${env.trimEnd()}\nESCROW_PROGRAM_ID=${programId}\n`
      env = env.replace(/^ESCROW_DRIVER=.*$/m, 'ESCROW_DRIVER=anchor')
      fs.writeFileSync(envPath, env)

      const { writePlatformState } = await import('../src/services/platform.js')
      writePlatformState({ escrowProgramId: programId })

      ok(`programa deployado: ${programId}`)
      ok('ESCROW_PROGRAM_ID gravado no .env e o driver trocado para anchor')
    } else {
      aviso('o deploy nao concluiu; seguindo com o driver vault')
      pendencias.push({
        titulo: 'anchor deploy falhou',
        porque: 'o driver vault e custodial: a plataforma tem autoridade sobre o cofre',
        como: 'confira o saldo de SOL da conta de deploy e rode npm run setup de novo'
      })
    }
  }
}

// ─── 5. banco ────────────────────────────────────────────────────────────────
cabecalho('5. banco de dados')

const migrou = rodarNode('migrate.js')
if (migrou.status !== 0) {
  console.error('\n  as migrations falharam. Sem banco o resto nao anda.\n')
  process.exit(1)
}

const semeou = rodarNode('seed.js')
if (semeou.status !== 0) {
  aviso('o seed nao completou; o banco esta migrado, so sem dado de exemplo')
}

// ─── 6. diagnostico ──────────────────────────────────────────────────────────
cabecalho('6. diagnostico')
rodarNode('doctor.js')

// ─── fecho ───────────────────────────────────────────────────────────────────
if (pendencias.length) {
  console.log(`  ${pendencias.length} pendencia(s) que precisam de voce:\n`)
  for (const [i, p] of pendencias.entries()) {
    console.log(`   ${i + 1}. ${p.titulo}`)
    console.log(`      por que importa: ${p.porque}`)
    console.log(`      como resolver:   ${p.como}\n`)
  }
}

console.log(`  para subir o servico:

      npm run dev

  e abra http://localhost:4000
`)
