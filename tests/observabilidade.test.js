// Verificacao da fase 9: log estruturado sem segredo, saude que distingue
// vivo de pronto, cabecalhos de seguranca, idempotencia no dinheiro e painel
// de operacao fechado para quem nao e da operacao.

import { fakePlatform, prepararBanco } from './helpers.js'
import { FakeConnection } from './fake-connection.js'
import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { closeDb, query, one } from '../src/db/index.js'
import { setConnection } from '../src/services/solana.js'
import { limpar, contar, registrarDuracao, lerContadores, zerarContadores } from '../src/lib/logger.js'

fakePlatform()

let servidor
let base
let rede

before(async () => {
  await prepararBanco()
  rede = new FakeConnection()
  setConnection(rede)
  servidor = createApp().listen(0)
  await new Promise((r) => servidor.once('listening', r))
  base = `http://127.0.0.1:${servidor.address().port}`
})

after(async () => {
  servidor?.close()
  await closeDb()
})

beforeEach(async () => {
  await query('delete from rate_limits')
  rede.levantar()
})

async function pedir (caminho, { method = 'GET', body, token, headers = {} } = {}) {
  const cabecalhos = { ...headers }
  if (body !== undefined) cabecalhos['content-type'] = 'application/json'
  if (token) cabecalhos.authorization = `Bearer ${token}`
  const resposta = await fetch(base + caminho, {
    method, headers: cabecalhos, body: body === undefined ? undefined : JSON.stringify(body)
  })
  const texto = await resposta.text()
  return {
    status: resposta.status,
    corpo: texto ? JSON.parse(texto) : null,
    cabecalhos: Object.fromEntries(resposta.headers)
  }
}

let contador = 0
async function conta (perfil = 'student') {
  contador += 1
  const out = await pedir('/api/signup', {
    method: 'POST',
    body: { nome: `Pessoa ${contador}`, email: `p${contador}.${Date.now()}@usp.br`, perfil }
  })
  return out.corpo
}

async function mediador () {
  const c = await conta('company')
  await query('update users set is_admin = true where id = $1', [c.usuario.id])
  return c
}

test('o log nunca deixa passar segredo, chave ou conteudo de mensagem', () => {
  // lint-permitido: segredo de mentira. Os valores abaixo existem para provar
  // que sao removidos. Nenhum deles vale nada em lugar nenhum.
  const sujo = {
    userId: 'usr_123',
    token: 'abc.def.ghi',
    refresh_token: 'segredissimo',
    secretKey: [1, 2, 3, 4],
    secret_cipher: 'v1.aaa.bbb',
    WALLET_MASTER_KEY: 'nao pode sair',
    authorization: 'Bearer xyz',
    senha: '123456',
    apiKey: 'sk_ao_vivo',
    body: 'o texto inteiro da mensagem que uma pessoa escreveu',
    mensagem: 'oi, tudo bem?',
    aninhado: { password: 'p', vapidPrivateKey: 'v', ok: 'isto pode' },
    valorNormal: 42,
    lista: [{ token: 'x' }]
  }

  const limpo = limpar(sujo)
  const texto = JSON.stringify(limpo)

  for (const proibido of ['abc.def.ghi', 'segredissimo', 'v1.aaa.bbb', 'nao pode sair',
    'Bearer xyz', '123456', 'sk_ao_vivo', 'o texto inteiro', 'oi, tudo bem']) {
    assert.ok(!texto.includes(proibido), `o log vazou "${proibido}"`)
  }

  // O que nao e segredo continua legivel, senao o log nao serve para nada.
  assert.equal(limpo.userId, 'usr_123')
  assert.equal(limpo.valorNormal, 42)
  assert.equal(limpo.aninhado.ok, 'isto pode')
  assert.equal(limpo.aninhado.password, '[removido]')
  assert.equal(limpo.lista[0].token, '[removido]')

  // Texto muito longo e cortado, para uma linha de log nao virar um romance.
  assert.ok(limpar({ descricao: 'x'.repeat(2000) }).descricao.length < 600)
})

test('cada resposta carrega um requestId, e ele volta no erro para referencia', async () => {
  const primeira = await pedir('/api/health/live')
  assert.ok(primeira.cabecalhos['x-request-id'], 'toda resposta precisa de requestId')

  const segunda = await pedir('/api/health/live')
  assert.notEqual(primeira.cabecalhos['x-request-id'], segunda.cabecalhos['x-request-id'])

  // Um requestId vindo de fora e respeitado: e assim que se acompanha uma
  // requisicao que atravessa mais de um servico.
  const meu = await pedir('/api/health/live', { headers: { 'x-request-id': 'meu-id-de-teste' } })
  assert.equal(meu.cabecalhos['x-request-id'], 'meu-id-de-teste')
})

test('vivo e pronto respondem perguntas diferentes', async () => {
  const vivo = await pedir('/api/health/live')
  assert.equal(vivo.status, 200)
  assert.equal(vivo.corpo.ok, true)
  assert.ok(typeof vivo.corpo.desdeSegundos === 'number')

  const pronto = await pedir('/api/health/ready')
  assert.equal(pronto.status, 200)
  assert.equal(pronto.corpo.checagens.banco.ok, true)
  assert.equal(pronto.corpo.checagens.banco.migrationsPendentes, 0)
  assert.ok(pronto.corpo.checagens.banco.schema)

  // A rede fora NAO derruba a prontidao: a fila absorve, e reiniciar a
  // instancia nao traria a rede de volta.
  rede.derrubar()
  const comRedeFora = await pedir('/api/health/ready')
  assert.equal(comRedeFora.status, 200, 'rede fora e degradacao, nao indisponibilidade')
  assert.equal(comRedeFora.corpo.ok, true)
  assert.equal(comRedeFora.corpo.checagens.rede.ok, false)
  assert.equal(comRedeFora.corpo.checagens.rede.degradado, true)

  // O processo continua vivo mesmo com a rede fora.
  assert.equal((await pedir('/api/health/live')).status, 200)
  rede.levantar()
})

test('os contadores contam o que aconteceu de verdade', async () => {
  zerarContadores()
  contar('teste.coisa')
  contar('teste.coisa', 4)
  registrarDuracao('teste.tempo', 100)
  registrarDuracao('teste.tempo', 300)

  const lidos = lerContadores()
  assert.equal(lidos.contagens['teste.coisa'], 5)
  assert.equal(lidos.duracoes['teste.tempo'].media, 200)
  assert.equal(lidos.duracoes['teste.tempo'].maximo, 300)
  assert.equal(lidos.duracoes['teste.tempo'].amostras, 2)

  // As requisicoes HTTP tambem sao contadas.
  await pedir('/api/health/live')
  await pedir('/api/rota-que-nao-existe')
  const metricas = await pedir('/api/health/metrics')
  assert.equal(metricas.status, 200)
  assert.ok(metricas.corpo.contagens['http.ok'] >= 1)
  assert.ok(metricas.corpo.contagens['http.4xx'] >= 1)
  assert.ok(metricas.corpo.duracoes.http.amostras >= 2)
  assert.ok(metricas.corpo.processo.memoriaMb > 0)
})

test('os cabecalhos de seguranca chegam em toda resposta', async () => {
  const r = await pedir('/api/health/live')

  assert.equal(r.cabecalhos['x-content-type-options'], 'nosniff')
  assert.equal(r.cabecalhos['x-frame-options'], 'DENY')
  assert.equal(r.cabecalhos['referrer-policy'], 'strict-origin-when-cross-origin')
  assert.match(r.cabecalhos['permissions-policy'], /camera=\(\)/)

  const csp = r.cabecalhos['content-security-policy']
  assert.ok(csp, 'precisa haver CSP')
  assert.match(csp, /script-src 'self'/)
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'script inline nao pode ser permitido')
  assert.ok(!/script-src[^;]*unsafe-eval/.test(csp), 'eval nao pode ser permitido')
  assert.match(csp, /frame-ancestors 'none'/)
  assert.match(csp, /object-src 'none'/)

  // O estilo mora no HTML, entao inline no style-src e necessario e consciente.
  assert.match(csp, /style-src[^;]*unsafe-inline/)

  // Fora de producao nao se promete https, senao o navegador tranca o
  // desenvolvedor fora do proprio localhost.
  assert.equal(r.cabecalhos['strict-transport-security'], undefined)

  // A verificacao publica e feita para ser lida de fora.
  const verificacao = await pedir('/api/verify/UNI-NAO-EXISTE')
  assert.equal(verificacao.cabecalhos['access-control-allow-origin'], '*')
  assert.equal(verificacao.cabecalhos['cross-origin-resource-policy'], 'cross-origin')

  // O resto do produto, nao.
  assert.equal(r.cabecalhos['cross-origin-resource-policy'], 'same-origin')
})

test('a mesma chave de idempotencia nao move dinheiro duas vezes', async () => {
  const contratante = await conta('company')
  const token = contratante.sessao.token

  const { vaga } = (await pedir('/api/jobs', {
    method: 'POST', token,
    body: {
      titulo: 'Staff de credenciamento no congresso',
      descricao: 'Recepcao e credenciamento dos participantes durante o evento.',
      categoria: 'Eventos', modalidade: 'presencial', local: 'Sao Paulo, SP',
      valorCentavos: 24000, horas: 12
    }
  })).corpo

  const chave = `reserva-${vaga.id}`

  const primeira = await pedir(`/api/jobs/${vaga.id}/fund`, {
    method: 'POST', token, headers: { 'idempotency-key': chave }
  })
  assert.equal(primeira.status, 200)
  assert.equal(primeira.cabecalhos['idempotent-replay'], undefined)

  // O duplo clique, o retry do cliente, a reconexao de rede: tudo isso chega
  // aqui como a mesma chave, e nao pode virar duas reservas.
  const segunda = await pedir(`/api/jobs/${vaga.id}/fund`, {
    method: 'POST', token, headers: { 'idempotency-key': chave }
  })
  assert.equal(segunda.status, 200)
  assert.equal(segunda.cabecalhos['idempotent-replay'], 'true', 'a segunda precisa ser repeticao')
  assert.deepEqual(segunda.corpo, primeira.corpo, 'a resposta repetida e identica')

  // Uma reserva so foi para a rede.
  const reservas = await query(
    "select id from chain_tx where job_id = $1 and kind = 'escrow_fund'", [vaga.id]
  )
  assert.equal(reservas.rows.length, 1, 'o valor saiu uma vez so')

  // A mesma chave com outro corpo e erro de quem chamou, nao repeticao.
  const outraOperacao = await pedir('/api/jobs/qualquer/confirm', {
    method: 'POST', token, headers: { 'idempotency-key': chave }, body: { diferente: true }
  })
  assert.equal(outraOperacao.status, 409)
  assert.equal(outraOperacao.corpo.codigo, 'chave_reutilizada')

  // Chave curta demais e recusada.
  const curta = await pedir(`/api/jobs/${vaga.id}/cancel`, {
    method: 'POST', token, headers: { 'idempotency-key': 'abc' }, body: {}
  })
  assert.equal(curta.status, 400)
  assert.equal(curta.corpo.codigo, 'chave_invalida')
})

test('o painel de operacao e so da operacao', async () => {
  const comum = await conta()
  const operacao = await mediador()

  for (const rota of ['/api/admin/overview', '/api/admin/users', '/api/admin/chain-jobs']) {
    assert.equal((await pedir(rota)).status, 401, `${rota} sem sessao`)
    assert.equal((await pedir(rota, { token: comum.sessao.token })).status, 403, `${rota} para conta comum`)
    assert.equal((await pedir(rota, { token: operacao.sessao.token })).status, 200, `${rota} para a operacao`)
  }

  const visao = await pedir('/api/admin/overview', { token: operacao.sessao.token })
  assert.ok(visao.corpo.totais.contas >= 2)
  assert.ok(Array.isArray(visao.corpo.atencao), 'o painel diz o que precisa de olho humano')
  assert.ok(Array.isArray(visao.corpo.ultimasAcoes))
})

test('suspender uma conta encerra as sessoes dela na hora e fica registrado', async () => {
  const alvo = await conta()
  const operacao = await mediador()

  // Antes: a sessao funciona.
  assert.equal((await pedir('/api/me', { token: alvo.sessao.token })).status, 200)

  // Suspender exige motivo escrito: uma suspensao sem motivo e uma decisao sem
  // dono, e a auditoria nao teria o que registrar.
  const semMotivo = await pedir(`/api/admin/users/${alvo.usuario.id}/block`, {
    method: 'POST', token: operacao.sessao.token, body: { motivo: 'nao' }
  })
  assert.equal(semMotivo.status, 400)

  const suspensa = await pedir(`/api/admin/users/${alvo.usuario.id}/block`, {
    method: 'POST', token: operacao.sessao.token,
    body: { motivo: 'Uso indevido da plataforma, relatado por dois contratantes.' }
  })
  assert.equal(suspensa.status, 200)

  // A sessao que ja existia para de valer na hora, e nao so no proximo login.
  const depois = await pedir('/api/me', { token: alvo.sessao.token })
  assert.equal(depois.status, 403)
  assert.equal(depois.corpo.codigo, 'conta_suspensa')

  const registro = await one(
    "select * from audit_log where action = 'conta.suspensa' and entity_id = $1", [alvo.usuario.id]
  )
  assert.ok(registro, 'a suspensao precisa estar na auditoria')
  assert.equal(registro.actor_id, operacao.usuario.id)
  const depoisDoRegistro = typeof registro.after === 'string' ? JSON.parse(registro.after) : registro.after
  assert.match(depoisDoRegistro.motivo, /Uso indevido/)

  // A operacao nao suspende a si mesma nem outra conta de mediacao.
  const euMesmo = await pedir(`/api/admin/users/${operacao.usuario.id}/block`, {
    method: 'POST', token: operacao.sessao.token, body: { motivo: 'Motivo suficientemente longo aqui.' }
  })
  assert.equal(euMesmo.status, 400)

  // Reativar volta tudo.
  const reativada = await pedir(`/api/admin/users/${alvo.usuario.id}/unblock`, {
    method: 'POST', token: operacao.sessao.token
  })
  assert.equal(reativada.status, 200)
  assert.ok(await one("select id from audit_log where action = 'conta.reativada' and entity_id = $1", [alvo.usuario.id]))
})

test('o historico de auditoria conta quem fez o que, sem expor segredo', async () => {
  const operacao = await mediador()
  const alvo = await conta()

  await pedir(`/api/admin/users/${alvo.usuario.id}/block`, {
    method: 'POST', token: operacao.sessao.token,
    body: { motivo: 'Motivo suficientemente detalhado para o registro.' }
  })

  const historico = await pedir(`/api/admin/audit/user/${alvo.usuario.id}`, { token: operacao.sessao.token })
  assert.equal(historico.status, 200)
  assert.ok(historico.corpo.historico.length >= 1)

  const evento = historico.corpo.historico[0]
  assert.equal(evento.acao, 'conta.suspensa')
  assert.equal(evento.quem, operacao.usuario.nome)
  assert.ok(evento.quando)

  const texto = JSON.stringify(historico.corpo).toLowerCase()
  for (const proibido of ['secret_cipher', 'refresh_token', 'wallet_master']) {
    assert.ok(!texto.includes(proibido), `a auditoria vazou "${proibido}"`)
  }
})
