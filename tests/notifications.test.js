// Verificacao da fase 6: cada evento de dominio gera a notificacao certa, para
// a pessoa certa, uma vez so.

import { fakePlatform, prepararBanco } from './helpers.js'
import { FakeConnection } from './fake-connection.js'
import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { closeDb, query, one, many } from '../src/db/index.js'
import { setConnection } from '../src/services/solana.js'
import {
  processarEvento, criar, listar, contarNaoLidas, preferenciasDe,
  atualizarPreferencias, enviarResumosDiarios
} from '../src/domain/notifications.js'
import { pushConfigurado } from '../src/services/push.js'

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

async function duasPartes () {
  contador += 1
  const marca = `${Date.now()}.${contador}`
  const estudante = (await pedir('/api/signup', {
    method: 'POST', body: { nome: 'Marina Alves', email: `est.${marca}@usp.br`, perfil: 'student' }
  })).corpo
  const contratante = (await pedir('/api/signup', {
    method: 'POST', body: { nome: 'Produtora XPTO', email: `emp.${marca}@xpto.br`, perfil: 'company' }
  })).corpo
  return { estudante, contratante }
}

async function vagaGarantida (partes, { comEstudante = false } = {}) {
  const { vaga } = (await pedir('/api/jobs', {
    method: 'POST', token: partes.contratante.sessao.token,
    body: {
      titulo: 'Staff de credenciamento no congresso',
      descricao: 'Recepcao e credenciamento dos participantes durante o evento.',
      categoria: 'Eventos', modalidade: 'presencial', local: 'Sao Paulo, SP',
      valorCentavos: 24000, horas: 12
    }
  })).corpo
  await pedir(`/api/jobs/${vaga.id}/fund`, { method: 'POST', token: partes.contratante.sessao.token })

  // Varios eventos so tem a quem notificar depois que ha estudante escolhido.
  if (comEstudante) {
    await pedir(`/api/jobs/${vaga.id}/apply`, {
      method: 'POST', token: partes.estudante.sessao.token, body: {}
    })
    const detalhe = (await pedir(`/api/jobs/${vaga.id}`, { token: partes.contratante.sessao.token })).corpo
    await pedir(`/api/jobs/applications/${detalhe.vaga.candidaturas[0].id}/accept`, {
      method: 'POST', token: partes.contratante.sessao.token
    })
    await query('delete from notifications')
    await query('delete from notification_keys')
  }
  return vaga
}

const notificacoesDe = (userId) => many(
  'select * from notifications where user_id = $1 order by created_at asc', [userId]
)

test('o fluxo inteiro notifica a pessoa certa em cada etapa, e nunca a que causou o evento', async () => {
  const partes = await duasPartes()
  const vaga = await vagaGarantida(partes)
  const idEstudante = partes.estudante.usuario.id
  const idContratante = partes.contratante.usuario.id

  // Reservar o valor avisa o contratante. Foi ele quem fez, entao NAO avisa:
  // quem age nao precisa ser informado do proprio ato.
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(
    (await notificacoesDe(idContratante)).filter((n) => n.type === 'vaga.garantida').length,
    0,
    'quem reservou nao precisa ser avisado de que reservou'
  )

  // O estudante se candidata: o contratante e avisado.
  await pedir(`/api/jobs/${vaga.id}/apply`, {
    method: 'POST', token: partes.estudante.sessao.token, body: {}
  })
  await new Promise((r) => setTimeout(r, 200))

  const aposCandidatura = await notificacoesDe(idContratante)
  const candidatura = aposCandidatura.find((n) => n.type === 'vaga.candidatura')
  assert.ok(candidatura, 'o contratante precisa saber que alguem se candidatou')
  assert.equal(candidatura.title, 'Nova candidatura')
  assert.match(candidatura.body, /Staff de credenciamento/)
  assert.equal(candidatura.link, `/vaga/${vaga.id}`)
  assert.equal((await notificacoesDe(idEstudante)).filter((n) => n.type === 'vaga.candidatura').length, 0)

  // O contratante escolhe: o estudante e avisado, com o valor garantido.
  const detalhe = (await pedir(`/api/jobs/${vaga.id}`, { token: partes.contratante.sessao.token })).corpo
  await pedir(`/api/jobs/applications/${detalhe.vaga.candidaturas[0].id}/accept`, {
    method: 'POST', token: partes.contratante.sessao.token
  })
  await new Promise((r) => setTimeout(r, 200))

  const escolhido = (await notificacoesDe(idEstudante)).find((n) => n.type === 'vaga.aceita')
  assert.ok(escolhido, 'o estudante precisa saber que foi escolhido')
  assert.equal(escolhido.title, 'Voce foi escolhido')
  assert.match(escolhido.body, /R\$/, 'a notificacao diz quanto esta reservado')

  // O estudante entrega: o contratante e avisado.
  await pedir(`/api/jobs/${vaga.id}/start`, { method: 'POST', token: partes.estudante.sessao.token })
  await pedir(`/api/jobs/${vaga.id}/deliver`, {
    method: 'POST', token: partes.estudante.sessao.token, body: {}
  })
  await new Promise((r) => setTimeout(r, 200))

  const entrega = (await notificacoesDe(idContratante)).find((n) => n.type === 'vaga.entregue')
  assert.ok(entrega, 'o contratante precisa saber que a entrega chegou')
  assert.match(entrega.body, /confirme/i, 'a notificacao diz o que fazer em seguida')

  // O contratante confirma: o estudante e avisado do pagamento e do certificado.
  await pedir(`/api/jobs/${vaga.id}/confirm`, { method: 'POST', token: partes.contratante.sessao.token })
  await new Promise((r) => setTimeout(r, 300))

  const pagamento = (await notificacoesDe(idEstudante)).find((n) => n.type === 'vaga.concluida')
  assert.ok(pagamento, 'o estudante precisa saber que recebeu')
  assert.equal(pagamento.title, 'Pagamento liberado')
  assert.match(pagamento.body, /R\$/)
  assert.match(pagamento.body, /12h/, 'e quantas horas foram certificadas')

  // Nenhuma notificacao usa jargao de rede.
  const todas = [...(await notificacoesDe(idEstudante)), ...(await notificacoesDe(idContratante))]
  const texto = todas.map((n) => `${n.title} ${n.body}`).join(' ').toLowerCase()
  for (const jargao of ['wallet', 'blockchain', 'gas', 'transacao', 'token', 'cripto', 'assinar']) {
    assert.ok(!texto.includes(jargao), `a notificacao vazou "${jargao}"`)
  }
})

test('o mesmo evento reprocessado nao gera uma segunda notificacao', async () => {
  const partes = await duasPartes()
  const vaga = await vagaGarantida(partes)

  const evento = {
    id: 'evt_teste',
    type: 'vaga.entregue',
    job_id: vaga.id,
    actor_id: partes.estudante.usuario.id,
    payload: {}
  }

  const primeira = await processarEvento(evento)
  assert.equal(primeira.criadas, 1)

  // O worker reprocessa. Isso acontece de verdade quando a fila tenta de novo.
  for (let i = 0; i < 4; i += 1) {
    const repetida = await processarEvento(evento)
    assert.equal(repetida.criadas, 0, 'reprocessar o mesmo evento nao pode notificar de novo')
  }

  const total = (await notificacoesDe(partes.contratante.usuario.id))
    .filter((n) => n.type === 'vaga.entregue')
  assert.equal(total.length, 1, 'uma notificacao, e so uma')
})

test('a unicidade vem do banco, entao nem chamadas simultaneas duplicam', async () => {
  const partes = await duasPartes()
  const chave = `teste:simultaneo:${Date.now()}`

  // Dez tentativas ao mesmo tempo com a mesma chave.
  const resultados = await Promise.all(
    Array.from({ length: 10 }, () => criar({
      userId: partes.estudante.usuario.id,
      tipo: 'teste',
      titulo: 'Aviso de teste',
      corpo: 'Corpo de teste',
      chave
    }))
  )

  const criadas = resultados.filter((r) => r.criada)
  assert.equal(criadas.length, 1, 'so uma das dez chamadas simultaneas pode criar')

  const noBanco = await many('select id from notifications where dedupe_key = $1', [chave])
  assert.equal(noBanco.length, 1)
})

test('a conversa nao vira enxurrada: uma notificacao por vaga por janela', async () => {
  const partes = await duasPartes()
  const vaga = await vagaGarantida(partes, { comEstudante: true })

  // Cinco mensagens seguidas do contratante.
  for (let i = 0; i < 5; i += 1) {
    await processarEvento({
      id: `evt_${i}`,
      type: 'mensagem.enviada',
      job_id: vaga.id,
      actor_id: partes.contratante.usuario.id,
      payload: {}
    })
  }

  const avisos = (await notificacoesDe(partes.estudante.usuario.id))
    .filter((n) => n.type === 'mensagem.enviada')
  assert.equal(avisos.length, 1, 'cinco mensagens seguidas geram um aviso, nao cinco')
})

test('a contestacao avisa a outra parte, nunca quem abriu', async () => {
  const partes = await duasPartes()
  const vaga = await vagaGarantida(partes, { comEstudante: true })

  // O estudante abre: quem e avisado e o contratante.
  await processarEvento({
    id: 'evt_disputa',
    type: 'disputa.aberta',
    job_id: vaga.id,
    actor_id: partes.estudante.usuario.id,
    payload: { motivo: 'pagamento_travado' }
  })

  const paraContratante = (await notificacoesDe(partes.contratante.usuario.id))
    .filter((n) => n.type === 'disputa.aberta')
  const paraEstudante = (await notificacoesDe(partes.estudante.usuario.id))
    .filter((n) => n.type === 'disputa.aberta')

  assert.equal(paraContratante.length, 1)
  assert.equal(paraEstudante.length, 0, 'quem abriu ja sabe')
  assert.match(paraContratante[0].body, /valor fica parado/i, 'a notificacao explica a consequencia')

  // A resolucao avisa os dois: os dois precisam saber do resultado.
  await processarEvento({
    id: 'evt_resolvida',
    type: 'disputa.resolvida',
    job_id: vaga.id,
    actor_id: 'usr_mediador_qualquer',
    payload: { resultado: 'split' }
  })

  for (const id of [partes.contratante.usuario.id, partes.estudante.usuario.id]) {
    const resolvida = (await notificacoesDe(id)).filter((n) => n.type === 'disputa.resolvida')
    assert.equal(resolvida.length, 1, 'as duas partes sao avisadas do resultado')
  }
})

test('as preferencias mandam: quem desliga o e-mail continua vendo no aplicativo', async () => {
  const partes = await duasPartes()
  const token = partes.estudante.sessao.token

  const padrao = await pedir('/api/me/notification-preferences', { token })
  assert.equal(padrao.status, 200)
  assert.equal(padrao.corpo.preferencias.email, true)
  assert.equal(padrao.corpo.preferencias.push, false)
  assert.equal(padrao.corpo.preferencias.digest, 'instant')
  assert.equal(padrao.corpo.disponivel.push, pushConfigurado())

  const alterada = await pedir('/api/me/notification-preferences', {
    method: 'PUT', token, body: { email: false, digest: 'daily' }
  })
  assert.equal(alterada.status, 200)
  assert.equal(alterada.corpo.preferencias.email, false)
  assert.equal(alterada.corpo.preferencias.digest, 'daily')

  const noBanco = await preferenciasDe(partes.estudante.usuario.id)
  assert.equal(noBanco.email, false)

  // Mesmo com tudo desligado, a notificacao no aplicativo continua existindo:
  // sem ela a pessoa nao teria como saber o que perdeu.
  await atualizarPreferencias(partes.estudante.usuario.id, { email: false, push: false, digest: 'off' })
  await processarEvento({
    id: 'evt_app',
    type: 'vaga.aceita',
    job_id: (await vagaGarantida(partes, { comEstudante: true })).id,
    actor_id: partes.contratante.usuario.id,
    payload: {}
  })

  const noAplicativo = (await notificacoesDe(partes.estudante.usuario.id))
    .filter((n) => n.type === 'vaga.aceita')
  assert.equal(noAplicativo.length, 1, 'o canal do aplicativo nao e desligavel')

  const canais = typeof noAplicativo[0].channels === 'string'
    ? JSON.parse(noAplicativo[0].channels) : noAplicativo[0].channels
  assert.deepEqual(canais, ['app'], 'so o aplicativo, porque o resto foi desligado')

  // Valor invalido em digest e recusado com mensagem em portugues.
  const invalido = await pedir('/api/me/notification-preferences', {
    method: 'PUT', token, body: { digest: 'quando_der' }
  })
  assert.equal(invalido.status, 400)
  assert.match(invalido.corpo.detalhes[0].mensagem, /resumo diario|na hora|desligado/i)
})

test('a central de notificacoes lista, conta e marca como lidas', async () => {
  const partes = await duasPartes()
  const token = partes.estudante.sessao.token
  const id = partes.estudante.usuario.id

  for (let i = 0; i < 3; i += 1) {
    await criar({
      userId: id, tipo: 'teste', titulo: `Aviso ${i}`, corpo: 'Corpo',
      chave: `central:${Date.now()}:${i}`
    })
  }

  const lista = await pedir('/api/notifications', { token })
  assert.equal(lista.status, 200)
  assert.ok(lista.corpo.notificacoes.length >= 3)
  assert.equal(lista.corpo.naoLidas, await contarNaoLidas(id))
  assert.equal(lista.corpo.notificacoes[0].lida, false)

  // Marcar uma so.
  const primeira = lista.corpo.notificacoes[0].id
  const umaSo = await pedir('/api/notifications/read', { method: 'POST', token, body: { ids: [primeira] } })
  assert.equal(umaSo.corpo.lidas, 1)

  const restantes = await contarNaoLidas(id)
  assert.equal(restantes, lista.corpo.naoLidas - 1)

  // Marcar todas.
  const todas = await pedir('/api/notifications/read', { method: 'POST', token, body: {} })
  assert.equal(todas.corpo.lidas, restantes)
  assert.equal(await contarNaoLidas(id), 0)

  // So a propria pessoa ve as proprias notificacoes.
  const outra = await duasPartes()
  const deOutro = await pedir('/api/notifications', { token: outra.estudante.sessao.token })
  assert.equal(deOutro.corpo.notificacoes.length, 0)

  // Apagar uma que nao e sua nao funciona.
  const apagando = await pedir(`/api/notifications/${primeira}`, {
    method: 'DELETE', token: outra.estudante.sessao.token
  })
  assert.equal(apagando.status, 404)
})

test('o resumo diario nao sai sem servico de e-mail, e diz por que', async () => {
  const partes = await duasPartes()
  await atualizarPreferencias(partes.estudante.usuario.id, { digest: 'daily', email: true })
  await criar({
    userId: partes.estudante.usuario.id, tipo: 'teste',
    titulo: 'Algo aconteceu', corpo: 'Detalhe', chave: `resumo:${Date.now()}`
  })

  const resultado = await enviarResumosDiarios()
  assert.equal(resultado.enviados, 0)
  assert.equal(resultado.motivo, 'email_nao_configurado', 'ele diz por que nao enviou, em vez de fingir')

  // E a marca de ultimo resumo nao avanca: nada foi enviado.
  const prefs = await preferenciasDe(partes.estudante.usuario.id)
  assert.equal(prefs.ultimoResumo, null)
})

test('sem VAPID o push e recusado na inscricao, em vez de aceito e nunca enviado', async () => {
  const partes = await duasPartes()
  const token = partes.estudante.sessao.token

  const chave = await pedir('/api/push/key')
  const inscricao = await pedir('/api/push/subscribe', {
    method: 'POST', token,
    body: { inscricao: { endpoint: 'https://exemplo.push/abc', keys: { p256dh: 'x', auth: 'y' } } }
  })

  if (pushConfigurado()) {
    assert.equal(chave.status, 200)
    assert.equal(inscricao.status, 201)
  } else {
    assert.equal(chave.status, 503)
    assert.equal(chave.corpo.codigo, 'push_nao_configurado')
    assert.equal(inscricao.status, 503)
    assert.equal(inscricao.corpo.codigo, 'push_nao_configurado')
    // Nada foi guardado: aceitar e nao enviar seria pior do que recusar.
    const guardadas = await one('select count(*)::int as n from push_subscriptions')
    assert.equal(guardadas.n, 0)
  }
})
