#!/usr/bin/env node
// npm run test:pg — roda a suite inteira contra um Postgres de verdade.
//
// Por que existe: o PGlite e o mesmo Postgres compilado para WASM, mas nao e
// a mesma coisa que um servidor com pool, rede no meio e timeouts. A fase 1
// exige que a suite passe nos dois drivers, e este script e o segundo driver.
//
// Sobe um container, espera aceitar conexao, roda a suite com DATABASE_URL
// apontando para ele e derruba o container no final, mesmo se a suite quebrar.

import { spawn, spawnSync } from 'node:child_process'

const NOME = 'uniwork-postgres-teste'
const SENHA = 'uniwork'
const IMAGEM = 'postgres:16-alpine'

// O Windows reserva faixas inteiras de porta para o Hyper-V, e o erro que ele
// devolve ao esbarrar numa delas nao diz isso. Por isso tentamos algumas.
const PORTAS = process.env.PGPORT_TESTE ? [process.env.PGPORT_TESTE] : ['5433', '15432', '25432', '5434']

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts })

function docker (...args) {
  return run('docker', args)
}

function dockerDisponivel () {
  const versao = docker('info', '--format', '{{.ServerVersion}}')
  return versao.status === 0
}

function derrubar () {
  docker('rm', '-f', NOME)
}

async function esperarPostgres (tentativas = 60) {
  for (let i = 0; i < tentativas; i += 1) {
    const pronto = docker('exec', NOME, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1')
    if (pronto.status === 0) return true
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

if (!dockerDisponivel()) {
  console.error(`
  Docker nao esta respondendo, entao a suite contra Postgres de verdade nao roda aqui.

  Para rodar:
    1. abra o Docker Desktop e espere ele subir
    2. npm run test:pg

  Alternativa sem Docker: aponte para qualquer Postgres que voce tenha e rode
    DATABASE_URL=postgresql://usuario:senha@host:5432/banco npm test
`)
  process.exit(1)
}

derrubar()
let porta = null
for (const candidata of PORTAS) {
  console.log(`\n  subindo ${IMAGEM} em 127.0.0.1:${candidata}…`)
  const subiu = docker(
    'run', '-d', '--name', NOME,
    '-e', `POSTGRES_PASSWORD=${SENHA}`,
    '-p', `${candidata}:5432`,
    IMAGEM
  )
  if (subiu.status === 0) { porta = candidata; break }
  console.log(`  porta ${candidata} indisponivel, tentando a proxima`)
  derrubar()
}
if (!porta) {
  console.error('\n  nao consegui subir o container em nenhuma porta candidata.')
  console.error('  Escolha uma porta livre: PGPORT_TESTE=6543 npm run test:pg\n')
  process.exit(1)
}
const URL = `postgresql://postgres:${SENHA}@127.0.0.1:${porta}/postgres`

process.on('exit', derrubar)
process.on('SIGINT', () => { derrubar(); process.exit(130) })

if (!await esperarPostgres()) {
  console.error('  o Postgres nao ficou pronto a tempo')
  derrubar()
  process.exit(1)
}
console.log('  Postgres pronto. Rodando a suite contra ele…\n')

const suite = spawn(
  process.execPath,
  ['--test', '--test-concurrency=4', 'tests/**/*.test.js'],
  {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: URL, UNIWORK_FORCA_POSTGRES: '1' },
    shell: false
  }
)

suite.on('exit', (codigo) => {
  derrubar()
  console.log(codigo === 0 ? '\n  suite verde contra Postgres de verdade.\n' : '\n  suite vermelha contra Postgres.\n')
  process.exit(codigo ?? 1)
})
