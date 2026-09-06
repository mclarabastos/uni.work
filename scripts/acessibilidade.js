#!/usr/bin/env node
// npm run test:a11y
//
// Auditoria de acessibilidade com axe, nas telas de verdade e com dado dentro.
// Auditar a tela vazia esconderia justamente os problemas que aparecem quando
// a lista tem conteudo.
//
// Erro critico ou serio derruba. Moderado e leve sao listados para decisao, e
// nao para ignorar em silencio.

import { isolar, plataformaDeMentira } from './ambiente-isolado.js'
const { raiz: rootDir, banco: bancoTemporario } = isolar('a11y')
await plataformaDeMentira()

import fsp from 'node:fs/promises'
import path from 'node:path'

let chromium, AxeBuilder
try {
  ({ chromium } = await import('playwright'))
  AxeBuilder = (await import('@axe-core/playwright')).default
} catch {
  console.error(`
  Faltam dependências para a auditoria de acessibilidade:

      npm install --save-dev playwright @axe-core/playwright
      npx playwright install --with-deps chromium
`)
  process.exit(1)
}

await fsp.rm(bancoTemporario, { recursive: true, force: true })

const { migrar } = await import('../src/db/migrate.js')
const { createApp } = await import('../src/server.js')
const { closeDb, query } = await import('../src/db/index.js')
const { setConnection } = await import('../src/services/solana.js')
const { FakeConnection } = await import('../tests/fake-connection.js')

setConnection(new FakeConnection())
await migrar()

const servidor = createApp().listen(0)
await new Promise((r) => servidor.once('listening', r))
const base = `http://127.0.0.1:${servidor.address().port}`

// ─── um pouco de conteudo, para as telas nao serem auditadas vazias ──────────
const api = async (caminho, { method = 'GET', body, token } = {}) => {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const r = await fetch(base + caminho, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  })
  const t = await r.text()
  return t ? JSON.parse(t) : null
}

const marca = Date.now()
const empresa = await api('/api/signup', {
  method: 'POST', body: { nome: 'Produtora XPTO', email: `e.${marca}@x.br`, perfil: 'company' }
})
const estudante = await api('/api/signup', {
  method: 'POST', body: { nome: 'Marina Alves', email: `m.${marca}@usp.br`, perfil: 'student', universidade: 'USP', curso: 'Design' }
})

const vagasCriadas = []
for (const [titulo, categoria, modalidade, valor, horas] of [
  ['Staff de credenciamento no congresso de tecnologia', 'Eventos', 'presencial', 24000, 12],
  ['Tradução de artigo científico para o inglês', 'Tradução', 'remoto', 45000, 10],
  ['Monitoria de cálculo para engenharia', 'Monitoria', 'presencial', 60000, 20]
]) {
  const { vaga } = await api('/api/jobs', {
    method: 'POST', token: empresa.sessao.token,
    body: {
      titulo,
      descricao: `Descrição completa da atividade: ${titulo.toLowerCase()}, com contexto suficiente para a tela ficar realista.`,
      categoria, modalidade, local: modalidade === 'presencial' ? 'São Paulo, SP' : null,
      valorCentavos: valor, horas
    }
  })
  await api(`/api/jobs/${vaga.id}/fund`, { method: 'POST', token: empresa.sessao.token })
  await api(`/api/jobs/${vaga.id}/apply`, { method: 'POST', token: estudante.sessao.token, body: {} })
  vagasCriadas.push(vaga.id)
}

// Uma vaga levada ate o fim, para a auditoria ver a tela de certificado e a de
// verificacao publica com conteudo de verdade, e nao o estado vazio. Auditar o
// vazio esconde justamente o que aparece quando ha conteudo.
{
  const id = vagasCriadas[0]
  const detalhe = await api(`/api/jobs/${id}`, { token: empresa.sessao.token })
  await api(`/api/jobs/applications/${detalhe.vaga.candidaturas[0].id}/accept`, { method: 'POST', token: empresa.sessao.token })
  await api(`/api/jobs/${id}/start`, { method: 'POST', token: estudante.sessao.token })
  await api(`/api/jobs/${id}/deliver`, { method: 'POST', token: estudante.sessao.token, body: {} })
  await api(`/api/jobs/${id}/confirm`, { method: 'POST', token: empresa.sessao.token })
}

const navegador = await chromium.launch()
const contexto = await navegador.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR' })
const pagina = await contexto.newPage()

async function entrar (email) {
  // A sessao sobrevive ao recarregamento, entao entrar como outra pessoa
  // exige limpar antes: senao a tela de entrada nem aparece.
  await pagina.goto(base, { waitUntil: 'domcontentloaded' })
  await pagina.evaluate(() => { try { localStorage.clear() } catch { /* sem armazenamento */ } })
  await pagina.goto(base, { waitUntil: 'networkidle' })
  await pagina.waitForSelector('#form-entrar', { timeout: 15000 })
  await pagina.fill('#entrar-email', email)
  await pagina.click('#form-entrar button[type="submit"]')
  // O esqueleto fica montado com ou sem sessao: o sinal de que entrou e o
  // botao de sair, que so existe logado.
  await pagina.waitForSelector('#btn-sair', { timeout: 15000 })
}

const achados = { critical: [], serious: [], moderate: [], minor: [] }
const pulados = []

/**
 * Fecha o guia de primeira sessao, como um usuario faria.
 * Ele aparece depois do primeiro carregamento, e nao junto com a tela, entao
 * nao adianta so olhar se ele ja esta la: e preciso esperar um pouco por ele.
 */
async function fecharGuia () {
  await pagina.waitForSelector('.guia', { timeout: 3000 }).catch(() => null)
  const guia = pagina.locator('.guia')
  for (let i = 0; i < 4 && await guia.count() > 0; i += 1) {
    await pagina.click('[data-guia="proximo"]').catch(() => {})
    await pagina.waitForTimeout(200)
  }
  await pagina.waitForSelector('.guia', { state: 'detached', timeout: 3000 }).catch(() => null)
}

async function fecharModal () {
  if (await pagina.locator('.modal-fundo').count() === 0) return
  await pagina.click('.modal-topo [data-fechar]')
  await pagina.waitForSelector('.modal-fundo', { state: 'detached', timeout: 5000 })
}

async function passo (nome, fn) {
  try {
    await fn()
    await auditar(nome)
  } catch (err) {
    // Uma tela que nao abriu NAO conta como limpa. Contava, e a auditoria
    // chegou a anunciar zero violacoes tendo pulado metade das telas.
    const primeiraLinha = String(err.message).split(/\r?\n/)[0]
    pulados.push({ tela: nome, motivo: primeiraLinha })
    console.log(`  ${nome.padEnd(24)} NÃO AUDITADA: ${primeiraLinha}`)
  }
}

async function auditar (nome) {
  const resultado = await new AxeBuilder({ page: pagina })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()

  const porTela = resultado.violations
  const contagem = { critical: 0, serious: 0, moderate: 0, minor: 0 }
  for (const v of porTela) {
    contagem[v.impact] = (contagem[v.impact] ?? 0) + v.nodes.length
    achados[v.impact]?.push({
      tela: nome,
      regra: v.id,
      descricao: v.help,
      quantos: v.nodes.length,
      exemplo: v.nodes[0]?.html?.slice(0, 120)
    })
  }
  const total = porTela.reduce((s, v) => s + v.nodes.length, 0)
  const resumo = total === 0
    ? 'sem violações'
    : `${contagem.critical} críticas, ${contagem.serious} serias, ${contagem.moderate} moderadas, ${contagem.minor} leves`
  console.log(`  ${nome.padEnd(24)} ${resumo}`)
}

console.log('\n  auditoria de acessibilidade\n')

try {
  await passo('porta de entrada', async () => {
    await pagina.goto(base, { waitUntil: 'networkidle' })
    await pagina.waitForSelector('#form-entrar', { timeout: 15000 })
  })
  await passo('criar conta', async () => {
    await pagina.click('[data-criar="student"]')
    await pagina.waitForSelector('#form-criar', { timeout: 10000 })
  })

  await passo('vagas abertas', async () => {
    await entrar(`m.${marca}@usp.br`)
    // O guia de primeira sessao e uma tela como qualquer outra.
    await pagina.waitForTimeout(600)
    if (await pagina.locator('.guia').count() > 0) await auditar('guia de boas-vindas')
    await fecharGuia()
  })
  await passo('detalhe da vaga', async () => {
    await pagina.click('.vaga')
    await pagina.waitForSelector('.detalhe-grade', { timeout: 15000 })
  })
  await passo('certificados', async () => {
    await pagina.click('[data-view="certificados"]')
    await pagina.waitForTimeout(400)
  })
  await passo('minha conta', async () => {
    await pagina.click('[data-view="conta"]')
    await pagina.waitForTimeout(400)
  })
  await passo('notificacoes', async () => {
    await pagina.click('[data-view="notificacoes"]')
    await pagina.waitForTimeout(600)
  })
  await passo('perfil público', async () => {
    await pagina.click('[data-view="conta"]')
    await pagina.waitForTimeout(300)
    await pagina.click('[data-acao="meu-perfil"]')
    await pagina.waitForTimeout(600)
  })
  await passo('camada técnica', async () => {
    await pagina.click('#gaveta-puxador')
    await pagina.waitForTimeout(500)
  })
  await passo('publicar vaga (modal)', async () => {
    await entrar(`e.${marca}@x.br`)
    await pagina.waitForTimeout(600)
    await fecharGuia()
    // O atalho da barra lateral so vira "Publicar vaga" depois do primeiro
    // render com a conta carregada.
    await pagina.waitForSelector('#cta-rotulo:has-text("Publicar vaga")', { timeout: 20000 })
    await pagina.click('#cta-botao')
    await pagina.waitForSelector('#form-vaga')
  })
  // O modal de publicar ficou aberto no passo anterior: sem fechar, ele
  // intercepta todo clique e as telas seguintes nunca abrem.
  await passo('painel do ecossistema', async () => {
    await fecharModal()
    await pagina.click('.nav-item[data-view="painel"]')
    await pagina.waitForSelector('.metricas', { timeout: 15000 })
  })
  await passo('verificar certificado', async () => {
    await pagina.click('.nav-item[data-view="verificar"]')
    await pagina.waitForSelector('#form-codigo', { timeout: 15000 })
  })
  await passo('verificação pública', async () => {
    const cert = await query('select code from certificates limit 1')
    await pagina.goto(`${base}/verificar/${cert.rows[0]?.code ?? 'UNI-AAAA-BBBB'}`, { waitUntil: 'networkidle' })
  })
} finally {
  await navegador.close()
  servidor.close()
  await closeDb().catch(() => {})
  await fsp.rm(bancoTemporario, { recursive: true, force: true })
}

// ─── relatorio ───────────────────────────────────────────────────────────────
const graves = [...achados.critical, ...achados.serious]
const leves = [...achados.moderate, ...achados.minor]

if (graves.length) {
  console.log('\n  críticas e serias:\n')
  for (const a of graves) {
    console.log(`  X  [${a.tela}] ${a.regra}: ${a.descricao} (${a.quantos})`)
    if (a.exemplo) console.log(`       ${a.exemplo}`)
  }
}

if (leves.length) {
  console.log('\n  moderadas e leves:\n')
  for (const a of leves) {
    console.log(`  !  [${a.tela}] ${a.regra}: ${a.descricao} (${a.quantos})`)
    if (a.exemplo) console.log(`       ${a.exemplo}`)
  }
}

const relatorio = path.join(rootDir, 'test-results', 'acessibilidade.json')
await fsp.mkdir(path.dirname(relatorio), { recursive: true })
await fsp.writeFile(relatorio, `${JSON.stringify(achados, null, 2)}\n`)

console.log(`
  ${graves.length} grave(s), ${leves.length} de menor impacto${pulados.length ? `, ${pulados.length} tela(s) NÃO auditada(s)` : ''}
  relatório em test-results/acessibilidade.json
`)

if (pulados.length) {
  console.log('  telas que não foram auditadas:\n')
  for (const p of pulados) console.log(`  X  ${p.tela}: ${p.motivo}`)
  console.log('\n  Uma tela que não abriu não e uma tela aprovada.\n')
  process.exitCode = 1
}

if (graves.length) {
  console.log('  A fase 10 exige zero críticas e serias.\n')
  process.exitCode = 1
}
