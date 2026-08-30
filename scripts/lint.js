#!/usr/bin/env node
// npm run lint
//
// Nao e um linter de estilo. E uma checagem de coisas que quebram de verdade e
// que a suite nao pega por si so:
//
//   1. todo arquivo .js precisa ser sintaticamente valido
//   2. nenhum import aponta para arquivo que nao existe
//   3. nada de console.log solto no codigo de producao (log estruturado existe)
//   4. nenhum segredo obvio commitado
//
// Sem dependencia de linter porque cada uma delas traria um arquivo de
// configuracao para manter, e o que interessa aqui cabe em cem linhas.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { rootDir } from '../src/config.js'

const PASTAS = ['src', 'scripts', 'tests', 'public']
const problemas = []
let arquivosConferidos = 0

function listar (dir, filtro = /\.m?js$/) {
  const saida = []
  const completo = path.join(rootDir, dir)
  if (!fs.existsSync(completo)) return saida
  const andar = (atual) => {
    for (const item of fs.readdirSync(atual, { withFileTypes: true })) {
      if (item.name === 'node_modules' || item.name.startsWith('.')) continue
      const caminho = path.join(atual, item.name)
      if (item.isDirectory()) andar(caminho)
      else if (filtro.test(item.name)) saida.push(caminho)
    }
  }
  andar(completo)
  return saida
}

const relativo = (p) => path.relative(rootDir, p).replace(/\\/g, '/')

// ─── 1. sintaxe ──────────────────────────────────────────────────────────────
for (const pasta of PASTAS) {
  for (const arquivo of listar(pasta)) {
    arquivosConferidos += 1
    try {
      execFileSync(process.execPath, ['--check', arquivo], { stdio: 'pipe' })
    } catch (err) {
      const saida = `${err.stderr ?? ''}`.split('\n').slice(0, 3).join(' ').trim()
      problemas.push(`${relativo(arquivo)}: sintaxe invalida — ${saida}`)
    }
  }
}

// ─── 2. imports que apontam para o nada ──────────────────────────────────────
for (const pasta of ['src', 'scripts', 'tests']) {
  for (const arquivo of listar(pasta)) {
    const conteudo = fs.readFileSync(arquivo, 'utf8')
    const alvos = [
      ...conteudo.matchAll(/(?:^|\s)import\s+(?:[\s\S]*?from\s+)?['"](\.[^'"]+)['"]/g),
      ...conteudo.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)
    ]
    for (const m of alvos) {
      const destino = path.resolve(path.dirname(arquivo), m[1])
      if (!fs.existsSync(destino)) {
        problemas.push(`${relativo(arquivo)}: importa "${m[1]}", que nao existe`)
      }
    }
  }
}

// ─── 3. console solto no codigo de producao ──────────────────────────────────
// Scripts de linha de comando falam pelo console de proposito. O servidor nao:
// ele tem log estruturado, e uma linha solta nao carrega o requestId.
for (const arquivo of listar('src')) {
  const conteudo = fs.readFileSync(arquivo, 'utf8')
  if (relativo(arquivo) === 'src/lib/logger.js') continue
  if (relativo(arquivo) === 'src/server.js') continue // as linhas de boas-vindas
  for (const m of conteudo.matchAll(/^\s*console\.(log|info|warn|error)\(/gm)) {
    const linha = conteudo.slice(0, m.index).split('\n').length
    // Uma excecao consciente se marca com "lint-permitido" nas linhas de cima,
    // junto com o motivo. Sem o motivo escrito nao e excecao, e descuido.
    const antes = conteudo.slice(0, m.index).split('\n').slice(-6).join('\n')
    if (antes.includes('lint-permitido')) continue
    problemas.push(`${relativo(arquivo)}:${linha}: console.${m[1]} solto — use o log estruturado de src/lib/logger.js`)
  }
}

// ─── 4. segredo commitado ────────────────────────────────────────────────────
const SUSPEITAS = [
  { nome: 'chave privada em array', re: /secretKey"?\s*:\s*\[\s*\d{1,3}\s*,\s*\d{1,3}/ },
  { nome: 'chave da AWS', re: /AKIA[0-9A-Z]{16}/ },
  { nome: 'chave do Resend', re: /\bre_[A-Za-z0-9]{24,}/ },
  { nome: 'chave privada PEM', re: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/ }
]
for (const pasta of [...PASTAS, 'migrations']) {
  for (const arquivo of listar(pasta, /\.(m?js|sql|json|html|md)$/)) {
    const conteudo = fs.readFileSync(arquivo, 'utf8')
    // Um arquivo que precisa conter algo parecido com segredo (um teste que
    // prova que o segredo e removido, por exemplo) se marca com
    // "lint-permitido: segredo de mentira" e o motivo.
    if (conteudo.includes('lint-permitido: segredo de mentira')) continue
    for (const suspeita of SUSPEITAS) {
      if (suspeita.re.test(conteudo)) {
        problemas.push(`${relativo(arquivo)}: parece conter ${suspeita.nome}`)
      }
    }
  }
}

// O estado com a chave da plataforma nao pode estar versionado.
try {
  const versionados = execFileSync('git', ['ls-files'], { cwd: rootDir, encoding: 'utf8' })
  for (const linha of versionados.split('\n')) {
    if (linha.startsWith('.uniwork/') || linha === '.env') {
      problemas.push(`${linha}: nao pode estar versionado`)
    }
  }
} catch {
  // Sem git disponivel, esta checagem simplesmente nao roda.
}

// ─── resultado ───────────────────────────────────────────────────────────────
console.log(`\n  ${arquivosConferidos} arquivos conferidos\n`)

if (problemas.length) {
  for (const problema of problemas) console.log(`  X  ${problema}`)
  console.log(`\n  ${problemas.length} problema(s).\n`)
  process.exitCode = 1
} else {
  console.log('  nenhum problema.\n')
}
