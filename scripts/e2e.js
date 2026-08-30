#!/usr/bin/env node
// npm run test:e2e
//
// O fluxo inteiro num navegador de verdade, do cadastro ao certificado
// verificado publicamente, com uma captura de tela em cada passo.
//
// Isto pega o que a suite offline nao pega: a interface realmente montando, os
// eventos de clique ligados, o SSE chegando, e qualquer ReferenceError que so
// aparece quando o navegador executa o arquivo.
//
// Sem o Playwright instalado, este script diz isso e sai com erro. Ele nunca
// passa em silencio: um teste de navegador que nao abriu navegador nenhum
// e pior do que nao existir.

// Isolar o ambiente ANTES de qualquer import do projeto: o config le o
// ambiente no momento em que e carregado.
import { isolar, plataformaDeMentira } from './ambiente-isolado.js'
const { raiz: rootDir, banco: bancoTemporario } = isolar('e2e')
await plataformaDeMentira()

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const CAPTURAS = path.join(rootDir, 'test-results')

let chromium
try {
  ({ chromium } = await import('playwright'))
} catch {
  console.error(`
  O Playwright nao esta instalado, entao o teste de navegador nao rodou.

  Para instalar:

      npm install --save-dev playwright
      npx playwright install --with-deps chromium
      npm run test:e2e

  A suite offline (npm test) continua cobrindo a logica; o que falta aqui e a
  prova de que a interface monta e funciona num navegador de verdade.
`)
  process.exit(1)
}

// ─── ambiente ────────────────────────────────────────────────────────────────
await fsp.rm(bancoTemporario, { recursive: true, force: true })
await fsp.rm(CAPTURAS, { recursive: true, force: true })
await fsp.mkdir(CAPTURAS, { recursive: true })

const { migrar } = await import('../src/db/migrate.js')
const { createApp } = await import('../src/server.js')
const { closeDb, query } = await import('../src/db/index.js')
const { setConnection } = await import('../src/services/solana.js')
const { FakeConnection } = await import('../tests/fake-connection.js')

// A rede fica de mentira de proposito: este teste e sobre a interface, e
// depender da devnet estar no ar tornaria o resultado inutil como sinal.
setConnection(new FakeConnection())

await migrar()
const servidor = createApp().listen(0)
await new Promise((r) => servidor.once('listening', r))
const base = `http://127.0.0.1:${servidor.address().port}`

let passo = 0
const problemas = []
const marca = Date.now()

const navegador = await chromium.launch()
const contexto = await navegador.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'pt-BR'
})
const pagina = await contexto.newPage()

// Qualquer erro de JavaScript no navegador derruba o teste. E o motivo
// principal deste arquivo existir.
pagina.on('pageerror', (err) => problemas.push(`erro na pagina: ${err.message}`))
pagina.on('console', (msg) => {
  if (msg.type() !== 'error') return
  const texto = msg.text()
  if (texto.includes('127.0.0.1:1') || texto.includes('favicon')) return

  // Uma aplicacao de tela unica consulta rotas que respondem 401 ou 404 por
  // design (checar sessao, buscar preferencia que ainda nao existe). O que
  // nunca e normal e o servidor responder 5xx, ou a pagina lancar excecao.
  if (/status of 4\d\d/.test(texto)) return
  problemas.push(`console.error no navegador: ${texto.slice(0, 200)}`)
})

async function capturar (nome) {
  passo += 1
  const arquivo = path.join(CAPTURAS, `${String(passo).padStart(2, '0')}-${nome}.png`)
  await pagina.screenshot({ path: arquivo, fullPage: false })
  console.log(`  ${String(passo).padStart(2)}. ${nome}`)
}

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

/**
 * Espera a sessao abrir de verdade.
 * O esqueleto (#app.ativo) fica montado com ou sem sessao, entao ele nao serve
 * mais de sinal: o que so existe logado e o botao de sair.
 */
async function entrou () {
  await pagina.waitForSelector('#btn-sair', { timeout: 15000 })
  await fecharGuia()
}

async function sair () {
  await pagina.click('#btn-sair')
  await pagina.waitForSelector('#form-entrar', { timeout: 10000 })
}

async function entrarComo (email) {
  await pagina.fill('#entrar-email', email)
  await pagina.click('#form-entrar button[type="submit"]')
  await entrou()
}

/**
 * Abre o trampo do teste a partir de "Meus trampos".
 * A lista publica so mostra aberta e garantida; depois de aceita, o unico
 * caminho para as duas partes e a lista propria.
 */
async function abrirDoFeed () {
  await pagina.click('[data-view="feed"]')
  const cartao = '.vaga:has-text("Staff de credenciamento")'
  await pagina.waitForSelector(cartao, { timeout: 15000 })
  await pagina.click(cartao)
}

async function abrirOTrampo () {
  await pagina.click('[data-view="minhas"]')
  const cartao = '.vaga:has-text("Staff de credenciamento")'
  await pagina.waitForSelector(cartao, { timeout: 15000 })
  await pagina.click(cartao)
}

function conferir (condicao, mensagem) {
  if (!condicao) problemas.push(mensagem)
}

console.log('\n  fluxo completo no navegador\n')

try {
  // ─── 1. a porta de entrada ─────────────────────────────────────────────────
  await pagina.goto(base, { waitUntil: 'networkidle' })
  await pagina.waitForSelector('#app.ativo', { timeout: 15000 })
  await capturar('porta-de-entrada')
  conferir(await pagina.locator('text=Trabalhe hoje').isVisible(), 'a porta de entrada nao apareceu')

  // ─── 2. cadastro do contratante ────────────────────────────────────────────
  await pagina.click('[data-criar="company"]')
  await pagina.waitForSelector('#form-criar')
  await pagina.fill('#cc-nome', 'Produtora XPTO')
  await pagina.fill('#cc-email', `empresa.${marca}@xpto.com.br`)
  await capturar('cadastro-do-contratante')
  await pagina.click('#cc-ok')
  await entrou()
  await capturar('contratante-entrou')

  // ─── 3. publicar a vaga ────────────────────────────────────────────────────
  await pagina.click('#cta-botao')
  await pagina.waitForSelector('#form-vaga')
  await pagina.fill('#v-titulo', 'Staff de credenciamento no congresso de tecnologia')
  await pagina.fill('#v-descricao', 'Recepcao e credenciamento dos participantes durante dois dias de congresso, com entrega de kits.')
  await pagina.fill('#v-categoria', 'Eventos')
  await pagina.fill('#v-local', 'Sao Paulo, SP')
  await pagina.fill('#v-valor', '240')
  await pagina.fill('#v-horas', '12')
  await capturar('publicar-vaga')
  await pagina.click('#salvar-vaga')
  await pagina.waitForSelector('text=Trampo publicado', { timeout: 15000 })
  await capturar('vaga-publicada')

  // ─── 4. reservar o valor ───────────────────────────────────────────────────
  await abrirOTrampo()
  await pagina.waitForSelector('[data-acao-vaga="reservar"]', { timeout: 15000 })
  await capturar('detalhe-da-vaga')
  await pagina.click('[data-acao-vaga="reservar"]')
  await pagina.waitForSelector('text=Valor reservado', { timeout: 20000 })
  await capturar('valor-reservado')

  const garantida = await pagina.locator('text=Pagamento reservado').first().isVisible()
  conferir(garantida, 'a vaga nao mostrou o pagamento como garantido')

  await sair()

  // ─── 5. cadastro da estudante e candidatura ────────────────────────────────
  await pagina.click('[data-criar="student"]')
  await pagina.waitForSelector('#form-criar')
  await pagina.fill('#cc-nome', 'Marina Alves')
  await pagina.fill('#cc-email', `marina.${marca}@usp.br`)
  await pagina.fill('#cc-universidade', 'USP')
  await pagina.fill('#cc-curso', 'Design')
  await pagina.click('#cc-ok')
  await entrou()
  await capturar('estudante-entrou')

  // A estudante ve a garantia antes de aceitar. E a promessa do produto.
  // Aqui ela ainda nao se candidatou, entao o caminho e a lista publica.
  await abrirDoFeed()
  await pagina.waitForSelector('[data-acao-vaga="candidatar"]', { timeout: 15000 })
  const veGarantia = await pagina.locator('text=Pagamento reservado').first().isVisible()
  conferir(veGarantia, 'a estudante nao ve a garantia antes de aceitar')
  await capturar('estudante-ve-a-garantia')

  await pagina.click('[data-acao-vaga="candidatar"]')
  await pagina.waitForSelector('#m-texto')
  await pagina.fill('#m-texto', 'Ja trabalhei em tres congressos de tecnologia no ano passado.')
  await pagina.click('#m-ok')
  await pagina.waitForSelector('text=Candidatura enviada', { timeout: 15000 })
  await capturar('candidatura-enviada')

  await sair()

  // ─── 6. o contratante escolhe ──────────────────────────────────────────────
  await entrarComo(`empresa.${marca}@xpto.com.br`)
  await abrirOTrampo()
  await pagina.waitForSelector('[data-aceitar]', { timeout: 15000 })
  await capturar('candidatura-recebida')
  await pagina.click('[data-aceitar]')
  await pagina.waitForSelector('text=Estudante escolhido', { timeout: 15000 })
  await capturar('estudante-escolhido')

  await sair()

  // ─── 7. a estudante comeca e entrega ───────────────────────────────────────
  await entrarComo(`marina.${marca}@usp.br`)
  await abrirOTrampo()
  await pagina.waitForSelector('[data-acao-vaga="comecar"]', { timeout: 15000 })
  await pagina.click('[data-acao-vaga="comecar"]')
  await pagina.waitForSelector('[data-acao-vaga="entregar"]', { timeout: 15000 })
  await capturar('trabalho-em-andamento')

  await pagina.click('[data-acao-vaga="entregar"]')
  await pagina.waitForSelector('#m-texto')
  await pagina.fill('#m-texto', 'Credenciamento concluido nos dois dias, 480 participantes atendidos.')
  await pagina.click('#m-ok')
  await pagina.waitForSelector('text=Entrega enviada', { timeout: 15000 })
  await capturar('entrega-enviada')

  await sair()

  // ─── 8. confirmar: paga e certifica ────────────────────────────────────────
  await entrarComo(`empresa.${marca}@xpto.com.br`)
  await abrirOTrampo()
  await pagina.waitForSelector('[data-acao-vaga="confirmar"]', { timeout: 15000 })
  await capturar('pronto-para-confirmar')
  await pagina.click('[data-acao-vaga="confirmar"]')
  await pagina.waitForSelector('text=Tudo certo', { timeout: 30000 })
  await capturar('confirmado-e-pago')

  // ─── 9. o certificado ──────────────────────────────────────────────────────
  const certificado = await query(
    'select code, hours from certificates order by issued_at desc limit 1'
  )
  conferir(certificado.rows.length === 1, 'nenhum certificado foi emitido')
  const codigo = certificado.rows[0]?.code
  conferir(Number(certificado.rows[0]?.hours) === 12, 'o certificado nao tem as 12 horas da vaga')

  // ─── 10. verificacao publica, sem conta ────────────────────────────────────
  const anonimo = await contexto.browser().newContext({ viewport: { width: 1200, height: 1000 }, locale: 'pt-BR' })
  const paginaAnonima = await anonimo.newPage()
  paginaAnonima.on('pageerror', (err) => problemas.push(`erro na verificacao publica: ${err.message}`))
  await paginaAnonima.goto(`${base}/verificar/${codigo}`, { waitUntil: 'networkidle' })
  await paginaAnonima.waitForSelector('text=Marina Alves', { timeout: 15000 })

  const arquivo = path.join(CAPTURAS, `${String(++passo).padStart(2, '0')}-verificacao-publica.png`)
  await paginaAnonima.screenshot({ path: arquivo, fullPage: true })
  console.log(`  ${String(passo).padStart(2)}. verificacao-publica`)

  conferir(await paginaAnonima.locator('text=12 horas').isVisible(), 'a verificacao publica nao mostra a carga horaria')
  conferir(await paginaAnonima.locator('text=Certificado autentico').isVisible(), 'a verificacao publica nao confirmou o certificado')
  await anonimo.close()

  // ─── 11. a regra de ouro, no HTML renderizado ──────────────────────────────
  // Nao adianta o codigo-fonte estar limpo se a tela montada mostra jargao.
  await pagina.goto(base, { waitUntil: 'networkidle' })
  const textoDaTela = (await pagina.locator('body').innerText()).toLowerCase()
  for (const proibida of ['wallet', 'blockchain', 'carteira', 'chave privada', 'gas fee', 'cripto']) {
    conferir(!textoDaTela.includes(proibida), `a tela montada mostra "${proibida}"`)
  }
} catch (err) {
  problemas.push(`o fluxo parou: ${err.message}`)
  try {
    await pagina.screenshot({ path: path.join(CAPTURAS, `${String(++passo).padStart(2, '0')}-falha.png`) })
  } catch { /* a pagina pode ter morrido junto */ }
} finally {
  await navegador.close()
  servidor.close()
  await closeDb().catch(() => {})
  await fsp.rm(bancoTemporario, { recursive: true, force: true })
}

const capturas = fs.existsSync(CAPTURAS) ? fs.readdirSync(CAPTURAS).length : 0

if (problemas.length) {
  console.log('\n  problemas:\n')
  for (const problema of problemas) console.log(`  X  ${problema}`)
  console.log(`\n  ${capturas} capturas em test-results/\n`)
  process.exit(1)
}

console.log(`
  fluxo completo, do cadastro ao certificado verificado publicamente,
  sem nenhum erro de JavaScript e sem jargao de rede na tela.

  ${capturas} capturas em test-results/
`)
