// Verificacao da fase 2: o ciclo completo de autenticacao por link no e-mail,
// incluindo os caminhos que precisam falhar (token vencido, token reusado,
// refresh rotacionado, sessao revogada, conta suspensa) e o rate limit.

import { fakePlatform, prepararBanco } from './helpers.js'
import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createApp } from '../src/server.js'
import { closeDb, query, one } from '../src/db/index.js'
import { MINUTOS_DO_LINK } from '../src/domain/sessions.js'

fakePlatform()

let servidor
let base

before(async () => {
  await prepararBanco()
  servidor = createApp().listen(0)
  await new Promise((r) => servidor.once('listening', r))
  base = `http://127.0.0.1:${servidor.address().port}`
})

after(async () => {
  servidor?.close()
  await closeDb()
})

// O rate limit e por janela e guardado no banco, entao cada teste comeca limpo.
beforeEach(async () => { await query('delete from rate_limits') })

async function pedir (caminho, { method = 'GET', body, token } = {}) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const resposta = await fetch(base + caminho, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  })
  const texto = await resposta.text()
  return { status: resposta.status, corpo: texto ? JSON.parse(texto) : null }
}

let contador = 0
async function criarConta (perfil = 'student') {
  contador += 1
  const email = `pessoa${contador}.${Date.now()}@universidade.br`
  const out = await pedir('/api/signup', {
    method: 'POST', body: { nome: `Pessoa ${contador}`, email, perfil }
  })
  assert.equal(out.status, 201)
  return { email, ...out.corpo }
}

/** O link chega por e-mail; no teste pegamos direto da resposta de desenvolvimento. */
function tokenDoLink (resposta) {
  const link = resposta.corpo.linkParaDesenvolvimento
  assert.ok(link, 'em desenvolvimento a resposta traz o link, para o fluxo não travar')
  return new URL(link).searchParams.get('token')
}

test('o ciclo completo do link: pedir, entrar, renovar e sair', async () => {
  const conta = await criarConta()

  // Antes de entrar pelo link, o e-mail ainda nao esta verificado.
  const antes = await one('select verified_email from users where email = $1', [conta.email])
  assert.equal(antes.verified_email, false)

  // 1. Pedir o link.
  const pedido = await pedir('/api/auth/magic-link', { method: 'POST', body: { email: conta.email } })
  assert.equal(pedido.status, 200)
  assert.equal(pedido.corpo.expiraEmMinutos, MINUTOS_DO_LINK)

  // Sem servico de e-mail configurado, a resposta diz isso em vez de fingir.
  assert.equal(pedido.corpo.entregaConfigurada, false)
  assert.equal(pedido.corpo.entregue, false)
  assert.equal(pedido.corpo.motivo, 'email_nao_configurado')

  // O que fica no banco e o hash do token, nao o token.
  const token = tokenDoLink(pedido)
  const guardado = await one('select token from login_tokens where email = $1', [conta.email])
  assert.notEqual(guardado.token, token, 'o token não pode ser guardado em claro')
  assert.equal(guardado.token, crypto.createHash('sha256').update(token).digest('hex'))

  // 2. Trocar o token por sessao.
  const entrada = await pedir('/api/auth/verify', { method: 'POST', body: { token } })
  assert.equal(entrada.status, 200)
  assert.equal(entrada.corpo.usuario.email, conta.email)
  assert.ok(entrada.corpo.sessao.token)
  assert.ok(entrada.corpo.sessao.refresh)
  assert.notEqual(entrada.corpo.sessao.token, entrada.corpo.sessao.refresh)

  // Entrar pelo link prova que o e-mail e da pessoa.
  assert.equal(entrada.corpo.usuario.emailVerificado, true)
  const depois = await one('select verified_email from users where email = $1', [conta.email])
  assert.equal(depois.verified_email, true)

  // 3. A sessao funciona.
  const eu = await pedir('/api/me', { token: entrada.corpo.sessao.token })
  assert.equal(eu.status, 200)
  assert.equal(eu.corpo.usuario.email, conta.email)

  // 4. Renovar pelo refresh: o par muda inteiro.
  const renovada = await pedir('/api/auth/refresh', {
    method: 'POST', body: { refresh: entrada.corpo.sessao.refresh }
  })
  assert.equal(renovada.status, 200)
  assert.notEqual(renovada.corpo.sessao.token, entrada.corpo.sessao.token)
  assert.notEqual(renovada.corpo.sessao.refresh, entrada.corpo.sessao.refresh)

  // O acesso novo vale.
  assert.equal((await pedir('/api/me', { token: renovada.corpo.sessao.token })).status, 200)
  // O acesso antigo nao vale mais: a renovacao substitui, nao acumula.
  assert.equal((await pedir('/api/me', { token: entrada.corpo.sessao.token })).status, 401)

  // 5. O refresh e rotacionado: usar o antigo de novo e recusado.
  const reusoDoRefresh = await pedir('/api/auth/refresh', {
    method: 'POST', body: { refresh: entrada.corpo.sessao.refresh }
  })
  assert.equal(reusoDoRefresh.status, 401)

  // 6. Sair encerra.
  await pedir('/api/logout', { method: 'POST', token: renovada.corpo.sessao.token })
  assert.equal((await pedir('/api/me', { token: renovada.corpo.sessao.token })).status, 401)
})

test('o link vale uma vez só, vence, e não existe para quem não existe', async () => {
  const conta = await criarConta()

  // Reuso: o segundo uso do mesmo token e recusado.
  const pedido = await pedir('/api/auth/magic-link', { method: 'POST', body: { email: conta.email } })
  const token = tokenDoLink(pedido)

  assert.equal((await pedir('/api/auth/verify', { method: 'POST', body: { token } })).status, 200)

  const segundoUso = await pedir('/api/auth/verify', { method: 'POST', body: { token } })
  assert.equal(segundoUso.status, 400)
  assert.equal(segundoUso.corpo.codigo, 'link_ja_usado')
  assert.match(segundoUso.corpo.error, /já foi usado/i)

  // Vencimento: envelhecemos o token no banco e tentamos usar.
  const outro = await pedir('/api/auth/magic-link', { method: 'POST', body: { email: conta.email } })
  const tokenVelho = tokenDoLink(outro)
  const hash = crypto.createHash('sha256').update(tokenVelho).digest('hex')
  await query("update login_tokens set expires_at = now() - interval '1 minute' where token = $1", [hash])

  const vencido = await pedir('/api/auth/verify', { method: 'POST', body: { token: tokenVelho } })
  assert.equal(vencido.status, 400)
  assert.equal(vencido.corpo.codigo, 'link_vencido')
  assert.match(vencido.corpo.error, /venceu/i)

  // Token inventado.
  const inventado = await pedir('/api/auth/verify', {
    method: 'POST', body: { token: 'a'.repeat(43) }
  })
  assert.equal(inventado.status, 400)
  assert.equal(inventado.corpo.codigo, 'link_invalido')

  // Token curto demais nem passa pela validacao.
  const curto = await pedir('/api/auth/verify', { method: 'POST', body: { token: 'abc' } })
  assert.equal(curto.status, 400)
  assert.equal(curto.corpo.codigo, 'campos_invalidos')
})

test('pedir link para um e-mail sem conta responde igual a pedir para um com conta', async () => {
  // Se a resposta mudasse, a rota viraria um verificador de quem tem conta aqui.
  const conta = await criarConta()

  const existente = await pedir('/api/auth/magic-link', { method: 'POST', body: { email: conta.email } })
  const inexistente = await pedir('/api/auth/magic-link', {
    method: 'POST', body: { email: `ninguem.${Date.now()}@lugar-nenhum.br` }
  })

  assert.equal(existente.status, inexistente.status)
  assert.equal(existente.corpo.mensagem.replace(conta.email, 'X'),
    inexistente.corpo.mensagem.replace(/\S+@\S+/, 'X'))
  assert.equal(existente.corpo.expiraEmMinutos, inexistente.corpo.expiraEmMinutos)
  assert.equal(existente.corpo.entregaConfigurada, inexistente.corpo.entregaConfigurada)
  assert.equal(existente.corpo.entregue, inexistente.corpo.entregue)
  assert.equal(existente.corpo.motivo, inexistente.corpo.motivo)

  // A unica diferenca permitida e o link de desenvolvimento, que so existe
  // fora de producao e serve para o fluxo local nao depender de caixa de email.
  const semLinkDeDev = (corpo) => {
    const copia = { ...corpo }
    delete copia.linkParaDesenvolvimento
    return copia
  }
  assert.deepEqual(
    Object.keys(semLinkDeDev(existente.corpo)).sort(),
    Object.keys(semLinkDeDev(inexistente.corpo)).sort(),
    'as duas respostas precisam ter exatamente os mesmos campos'
  )

  // E nenhum token foi criado para o e-mail que nao existe.
  const criados = await one('select count(*)::int as n from login_tokens where email like $1', ['ninguem.%'])
  assert.equal(criados.n, 0)
})

test('sessões podem ser listadas e revogadas, uma a uma ou todas as outras', async () => {
  const conta = await criarConta()

  // Tres sessoes, como se fossem tres dispositivos.
  const sessoes = []
  for (let i = 0; i < 3; i += 1) {
    const pedido = await pedir('/api/auth/magic-link', { method: 'POST', body: { email: conta.email } })
    const entrada = await pedir('/api/auth/verify', { method: 'POST', body: { token: tokenDoLink(pedido) } })
    sessoes.push(entrada.corpo.sessao)
  }

  const lista = await pedir('/api/auth/sessions', { token: sessoes[2].token })
  assert.equal(lista.status, 200)
  assert.ok(lista.corpo.sessoes.length >= 3)
  assert.equal(lista.corpo.sessoes.filter((s) => s.atual).length, 1, 'a sessão atual e marcada')

  // A lista nunca devolve o token inteiro.
  for (const s of lista.corpo.sessoes) {
    assert.equal(s.id.length, 12)
    assert.ok(!sessoes.some((viva) => viva.token === s.id))
  }

  // Revogar uma especifica.
  const alvo = lista.corpo.sessoes.find((s) => !s.atual)
  const revogada = await pedir(`/api/auth/sessions/${alvo.id}`, { method: 'DELETE', token: sessoes[2].token })
  assert.equal(revogada.status, 200)

  const tokenRevogado = sessoes.find((s) => s.token.startsWith(alvo.id)).token
  assert.equal((await pedir('/api/me', { token: tokenRevogado })).status, 401)
  assert.equal((await pedir('/api/me', { token: sessoes[2].token })).status, 200, 'a atual continua viva')

  // Uma sessao revogada tambem nao renova.
  const refreshRevogado = sessoes.find((s) => s.token.startsWith(alvo.id)).refresh
  assert.equal((await pedir('/api/auth/refresh', { method: 'POST', body: { refresh: refreshRevogado } })).status, 401)

  // Encerrar todas as outras.
  const todas = await pedir('/api/auth/sessions/revoke-others', { method: 'POST', token: sessoes[2].token })
  assert.equal(todas.status, 200)
  assert.equal((await pedir('/api/me', { token: sessoes[0].token })).status, 401)
  assert.equal((await pedir('/api/me', { token: sessoes[1].token })).status, 401)
  assert.equal((await pedir('/api/me', { token: sessoes[2].token })).status, 200)
})

test('conta suspensa não entra, não renova e não recebe link', async () => {
  const conta = await criarConta()
  const pedido = await pedir('/api/auth/magic-link', { method: 'POST', body: { email: conta.email } })
  const entrada = await pedir('/api/auth/verify', { method: 'POST', body: { token: tokenDoLink(pedido) } })
  const sessao = entrada.corpo.sessao

  await query('update users set blocked_at = now() where email = $1', [conta.email])

  const comSessaoViva = await pedir('/api/me', { token: sessao.token })
  assert.equal(comSessaoViva.status, 403)
  assert.equal(comSessaoViva.corpo.codigo, 'conta_suspensa')

  const renovando = await pedir('/api/auth/refresh', { method: 'POST', body: { refresh: sessao.refresh } })
  assert.equal(renovando.status, 403)

  // Pedir link continua respondendo igual, mas nao gera token nenhum.
  const antes = await one('select count(*)::int as n from login_tokens where email = $1', [conta.email])
  const novoPedido = await pedir('/api/auth/magic-link', { method: 'POST', body: { email: conta.email } })
  assert.equal(novoPedido.status, 200, 'o bloqueio não se anuncia')
  const depois = await one('select count(*)::int as n from login_tokens where email = $1', [conta.email])
  assert.equal(depois.n, antes.n, 'nenhum link novo foi criado para a conta suspensa')
})

test('o rate limit corta o excesso de pedidos de link e volta a liberar na janela seguinte', async () => {
  const conta = await criarConta()

  // O limite e cinco por hora por e-mail.
  const respostas = []
  for (let i = 0; i < 7; i += 1) {
    respostas.push(await pedir('/api/auth/magic-link', { method: 'POST', body: { email: conta.email } }))
  }

  const aceitas = respostas.filter((r) => r.status === 200).length
  const cortadas = respostas.filter((r) => r.status === 429)

  assert.equal(aceitas, 5, 'cinco pedidos passam')
  assert.equal(cortadas.length, 2, 'o resto e cortado')
  assert.equal(cortadas[0].corpo.codigo, 'excesso_de_tentativas')
  assert.match(cortadas[0].corpo.error, /Espere|hora|tente/i)
  assert.ok(cortadas[0].corpo.detalhes.tentarEm, 'a resposta diz quando tentar de novo')

  // Limpar a janela e como esperar ela virar: volta a passar.
  await query('delete from rate_limits')
  const depois = await pedir('/api/auth/magic-link', { method: 'POST', body: { email: conta.email } })
  assert.equal(depois.status, 200)
})

test('o limite de escrita por conta protege as rotas que mudam estado', async () => {
  const contratante = await criarConta('company')
  const token = contratante.sessao.token

  const corpo = {
    titulo: 'Vaga de teste para o limite',
    descricao: 'Descrição com tamanho suficiente para passar na validação de campo.',
    categoria: 'Teste',
    modalidade: 'remoto',
    valorCentavos: 1000,
    horas: 1
  }

  // A janela do limitador e fixa e alinhada ao relogio. Se ela virar no meio
  // do laco, o contador zera e mais de trinta passam: o teste falhava de vez
  // em quando por causa do horario, e nao do codigo. Esperar a borda passar,
  // quando ela esta perto, custa menos do que afrouxar a asserção.
  const restanteNaJanela = 60000 - (Date.now() % 60000)
  if (restanteNaJanela < 15000) await new Promise((r) => setTimeout(r, restanteNaJanela + 50))

  const respostas = []
  for (let i = 0; i < 33; i += 1) {
    respostas.push(await pedir('/api/jobs', { method: 'POST', token, body: corpo }))
  }

  const cortadas = respostas.filter((r) => r.status === 429)
  assert.ok(cortadas.length >= 1, 'o limite de 30 escritas por minuto precisa cortar em algum momento')
  assert.equal(cortadas[0].corpo.codigo, 'excesso_de_tentativas')
  assert.equal(respostas.filter((r) => r.status === 201).length, 30, 'trinta passam')
})
