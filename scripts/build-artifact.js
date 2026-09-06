#!/usr/bin/env node
// npm run build:artifact
//
// Prova o criterio 1 da secao 13 do brief: um clone limpo sobe e responde.
//
// Nao ha bundler nem transpilador aqui, porque nao ha o que transpilar. O que
// este script faz e verificar de verdade que o que esta versionado basta para o
// servico subir: aplica as migrations num banco descartavel, sobe o servidor,
// bate nas rotas que precisam responder sem configuracao nenhuma, e so entao
// escreve o manifesto.
//
// Um "build" que so copia arquivos nao prova nada. Este derruba a CI quando o
// clone limpo nao sobe.

// Isolar o ambiente ANTES de qualquer import do projeto, senao a verificacao
// roda contra o banco de desenvolvimento em vez de um banco novo, e "o clone
// limpo sobe" deixa de ser o que esta sendo verificado.
import { isolar } from './ambiente-isolado.js'
const { raiz: rootDir } = isolar('artefato')

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const DESTINO = path.join(rootDir, '.artifacts')

const passo = (t) => console.log(`  ${t}`)
const ok = (t) => console.log(`  ok   ${t}`)

console.log('\n  artefato do Uni.work\n')

// ─── 1. o que vai junto ──────────────────────────────────────────────────────
const OBRIGATORIOS = [
  'package.json', 'package-lock.json', '.env.example', 'README.md',
  'src/server.js', 'src/config.js', 'public/index.html', 'public/app.js',
  'public/sw.js', 'public/logo.png', 'public/logo-simbolo.png', 'public/favicon.png',
  'migrations/0001_init.sql'
]

const faltando = OBRIGATORIOS.filter((arquivo) => !fs.existsSync(path.join(rootDir, arquivo)))
if (faltando.length) {
  console.error(`\n  faltam arquivos no repositório: ${faltando.join(', ')}\n`)
  process.exit(1)
}
ok(`${OBRIGATORIOS.length} arquivos essenciais presentes`)

// ─── 2. o clone limpo sobe? ──────────────────────────────────────────────────
passo('subindo o serviço com um banco descartável…')

const bancoTemporario = process.env.PGLITE_DIR
await fsp.rm(bancoTemporario, { recursive: true, force: true })
await fsp.mkdir(DESTINO, { recursive: true })

const { migrar, versaoDoSchema } = await import('../src/db/migrate.js')
const { createApp } = await import('../src/server.js')
const { closeDb } = await import('../src/db/index.js')

await migrar()
const schema = await versaoDoSchema()
ok(`migrations aplicadas em banco novo (schema ${schema})`)

const servidor = createApp().listen(0)
await new Promise((r) => servidor.once('listening', r))
const base = `http://127.0.0.1:${servidor.address().port}`

const conferencias = [
  { nome: 'interface', caminho: '/', esperado: 200, contem: 'Uni.work' },
  { nome: 'script da interface', caminho: '/app.js', esperado: 200 },
  { nome: 'saúde (vivo)', caminho: '/api/health/live', esperado: 200 },
  { nome: 'saúde (pronto)', caminho: '/api/health/ready', esperado: 200 },
  { nome: 'busca de vagas', caminho: '/api/jobs/search', esperado: 200 },
  { nome: 'metricas', caminho: '/api/metrics', esperado: 200 },
  { nome: 'rota inexistente', caminho: '/api/nao-existe', esperado: 404 }
]

let falhou = false
for (const conferencia of conferencias) {
  try {
    const resposta = await fetch(base + conferencia.caminho)
    const texto = await resposta.text()
    const statusOk = resposta.status === conferencia.esperado
    const conteudoOk = !conferencia.contem || texto.includes(conferencia.contem)
    if (statusOk && conteudoOk) {
      ok(`${conferencia.nome} respondeu ${resposta.status}`)
    } else {
      console.error(`  X    ${conferencia.nome}: status ${resposta.status}, esperado ${conferencia.esperado}${conteudoOk ? '' : ', e o conteúdo não confere'}`)
      falhou = true
    }
  } catch (err) {
    console.error(`  X    ${conferencia.nome}: ${err.message}`)
    falhou = true
  }
}

// O cadastro precisa funcionar num clone limpo: e a primeira coisa que qualquer
// pessoa faz, e ele cria a conta de rede junto.
try {
  const resposta = await fetch(`${base}/api/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nome: 'Teste do Artefato', email: `artefato.${Date.now()}@teste.br`, perfil: 'student' })
  })
  if (resposta.status === 201) ok('cadastro funciona num banco novo')
  else { console.error(`  X    cadastro respondeu ${resposta.status}`); falhou = true }
} catch (err) {
  console.error(`  X    cadastro: ${err.message}`)
  falhou = true
}

servidor.close()
await closeDb()
await fsp.rm(bancoTemporario, { recursive: true, force: true })

if (falhou) {
  console.error('\n  o clone limpo NÃO sobe. O artefato não foi gerado.\n')
  process.exit(1)
}

// ─── 3. manifesto ────────────────────────────────────────────────────────────
function hashDoConteudo (arquivos) {
  const soma = crypto.createHash('sha256')
  for (const arquivo of arquivos.sort()) {
    soma.update(arquivo)
    soma.update(fs.readFileSync(path.join(rootDir, arquivo)))
  }
  return soma.digest('hex')
}

function listarVersionados () {
  try {
    return execFileSync('git', ['ls-files'], { cwd: rootDir, encoding: 'utf8' })
      .split('\n').filter(Boolean)
  } catch {
    return OBRIGATORIOS
  }
}

const versionados = listarVersionados()
let commit = 'desconhecido'
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim()
} catch { /* fora de um repositorio git */ }

const manifesto = {
  nome: 'uniwork',
  versao: JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version,
  commit,
  geradoEm: new Date().toISOString(),
  node: process.version,
  schema,
  arquivos: versionados.length,
  hash: hashDoConteudo(versionados.filter((f) => fs.existsSync(path.join(rootDir, f)))),
  verificacoes: conferencias.map((c) => c.nome).concat('cadastro'),
  comoSubir: ['npm ci --omit=dev', 'npm run migrate', 'npm start']
}

await fsp.writeFile(path.join(DESTINO, 'manifesto.json'), `${JSON.stringify(manifesto, null, 2)}\n`)

console.log(`
  artefato pronto

    commit   ${manifesto.commit.slice(0, 12)}
    schema   ${manifesto.schema}
    arquivos ${manifesto.arquivos}
    hash     ${manifesto.hash.slice(0, 16)}

  manifesto em .artifacts/manifesto.json
`)
