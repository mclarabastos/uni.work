// Integracao pela porta da frente: sobe o servidor de verdade contra um banco
// em memoria e exercita o ciclo que nao depende da rede.
//
// Reservar o valor e confirmar a entrega ficam de fora de proposito: essas duas
// tocam a rede, e a regra da suite e rodar offline. O que da para provar aqui
// e que o produto recusa aceitar um estudante antes do pagamento reservado.

import { fakePlatform, prepararBanco } from './helpers.js'
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { closeDb, one } from '../src/db/index.js'

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

test('do cadastro a candidatura: o ciclo completo que nao depende da rede', async () => {
  // 1. Cadastro do estudante. A conta de rede nasce junto, sem passo extra.
  const cadastro = await pedir('/api/signup', {
    method: 'POST',
    body: { nome: 'Marina Alves', email: 'marina@usp.br', perfil: 'student', universidade: 'USP', curso: 'Design' }
  })
  assert.equal(cadastro.status, 201)
  const estudante = cadastro.corpo
  assert.equal(estudante.usuario.perfil, 'student')
  assert.ok(estudante.sessao.token)

  // A conta de rede existe no banco, cifrada, sem o usuario ter pedido nada.
  const conta = await one('select public_key, secret_cipher from accounts where user_id = $1', [estudante.usuario.id])
  assert.ok(conta, 'a conta de rede precisa nascer com o cadastro')
  assert.match(conta.public_key, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  assert.ok(conta.secret_cipher.startsWith('v1.'), 'o segredo fica cifrado')

  // A resposta do cadastro nao vaza a conta de rede para a tela.
  assert.equal(JSON.stringify(estudante).includes(conta.public_key), false)
  assert.equal(JSON.stringify(estudante).includes(conta.secret_cipher), false)

  // 2. E-mail repetido e recusado com mensagem de produto.
  const repetido = await pedir('/api/signup', {
    method: 'POST', body: { nome: 'Outra Pessoa', email: 'marina@usp.br', perfil: 'student' }
  })
  assert.equal(repetido.status, 409)
  assert.equal(repetido.corpo.codigo, 'email_ja_cadastrado')

  // 3. Cadastro do contratante e publicacao de uma vaga.
  const contratante = (await pedir('/api/signup', {
    method: 'POST', body: { nome: 'Produtora XPTO', email: 'contato@xpto.com.br', perfil: 'company' }
  })).corpo

  const publicacao = await pedir('/api/jobs', {
    method: 'POST', token: contratante.sessao.token,
    body: {
      titulo: 'Staff de credenciamento no congresso',
      descricao: 'Recepcao e credenciamento dos participantes durante dois dias de evento.',
      categoria: 'Eventos', modalidade: 'presencial', local: 'Sao Paulo, SP',
      valorCentavos: 24000, horas: 12
    }
  })
  assert.equal(publicacao.status, 201)
  const vaga = publicacao.corpo.vaga
  assert.equal(vaga.status, 'aberta')
  assert.equal(vaga.pagamentoGarantido, false, 'recem publicada ainda nao tem garantia')
  assert.deepEqual(vaga.trilha, { etapa: 1, total: 6, cancelada: false })

  // 4. Um estudante nao consegue publicar vaga.
  const tentativa = await pedir('/api/jobs', {
    method: 'POST', token: estudante.sessao.token,
    body: { titulo: 'Tentativa invalida', descricao: 'x'.repeat(30), categoria: 'Teste', modalidade: 'remoto', valorCentavos: 100, horas: 1 }
  })
  assert.equal(tentativa.status, 403)

  // 5. Vaga presencial sem local e recusada, com o campo apontado.
  const semLocal = await pedir('/api/jobs', {
    method: 'POST', token: contratante.sessao.token,
    body: { titulo: 'Vaga sem local definido', descricao: 'y'.repeat(30), categoria: 'Eventos', modalidade: 'presencial', valorCentavos: 100, horas: 1 }
  })
  assert.equal(semLocal.status, 400)
  assert.equal(semLocal.corpo.detalhes.campo, 'local')

  // 6. A vaga aparece na listagem publica, sem precisar de sessao.
  const lista = await pedir('/api/jobs')
  assert.equal(lista.status, 200)
  assert.ok(lista.corpo.vagas.some((v) => v.id === vaga.id))

  // 7. Candidatura do estudante.
  const candidatura = await pedir(`/api/jobs/${vaga.id}/apply`, {
    method: 'POST', token: estudante.sessao.token,
    body: { apresentacao: 'Ja trabalhei em tres congressos de tecnologia.' }
  })
  assert.equal(candidatura.status, 201)

  // Candidatar duas vezes e recusado.
  const duplicada = await pedir(`/api/jobs/${vaga.id}/apply`, {
    method: 'POST', token: estudante.sessao.token, body: {}
  })
  assert.equal(duplicada.status, 409)
  assert.equal(duplicada.corpo.codigo, 'candidatura_duplicada')

  // 8. A REGRA DO PRODUTO: escolher o estudante antes de reservar o valor e
  //    recusado. O estudante so e escolhido depois da garantia existir.
  const detalhe = await pedir(`/api/jobs/${vaga.id}`, { token: contratante.sessao.token })
  const idCandidatura = detalhe.corpo.vaga.candidaturas[0].id
  const cedoDemais = await pedir(`/api/jobs/applications/${idCandidatura}/accept`, {
    method: 'POST', token: contratante.sessao.token
  })
  assert.equal(cedoDemais.status, 409)
  assert.equal(cedoDemais.corpo.codigo, 'pagamento_nao_reservado')
  assert.match(cedoDemais.corpo.error, /Reserve o pagamento/)

  // 9. Conversa entre as partes. Quem nao e parte nao entra.
  const mensagem = await pedir(`/api/jobs/${vaga.id}/messages`, {
    method: 'POST', token: contratante.sessao.token, body: { texto: 'Oi, tudo bem?' }
  })
  assert.equal(mensagem.status, 201)

  const intrusa = (await pedir('/api/signup', {
    method: 'POST', body: { nome: 'Pessoa Aleatoria', email: 'intrusa@teste.br', perfil: 'student' }
  })).corpo
  const bisbilhotando = await pedir(`/api/jobs/${vaga.id}/messages`, { token: intrusa.sessao.token })
  assert.equal(bisbilhotando.status, 403)

  // 10. Sessao: /me responde com token, recusa sem token, e o logout encerra.
  assert.equal((await pedir('/api/me', { token: estudante.sessao.token })).status, 200)
  assert.equal((await pedir('/api/me')).status, 401)
  await pedir('/api/logout', { method: 'POST', token: estudante.sessao.token })
  assert.equal((await pedir('/api/me', { token: estudante.sessao.token })).status, 401)

  // 11. As metricas enxergam o que aconteceu.
  const metricas = await pedir('/api/metrics')
  assert.equal(metricas.corpo.totais.vagas, 1)
  assert.equal(metricas.corpo.totais.estudantes, 2)
  assert.equal(metricas.corpo.totais.contratantes, 1)
})

test('todo erro da API sai no formato de produto, em portugues, sem vazar detalhe tecnico', async () => {
  const naoExiste = await pedir('/api/jobs/job_que_nao_existe')
  assert.equal(naoExiste.status, 404)
  assert.deepEqual(Object.keys(naoExiste.corpo).sort(), ['codigo', 'detalhes', 'error'])
  assert.equal(naoExiste.corpo.codigo, 'nao_encontrado')

  const rotaErrada = await pedir('/api/nao-existe')
  assert.equal(rotaErrada.status, 404)
  assert.equal(rotaErrada.corpo.codigo, 'rota_nao_encontrada')

  const invalido = await pedir('/api/signup', { method: 'POST', body: { nome: 'x', email: 'nao-e-email', perfil: 'marciano' } })
  assert.equal(invalido.status, 400)
  assert.equal(invalido.corpo.codigo, 'campos_invalidos')
  assert.ok(Array.isArray(invalido.corpo.detalhes))
  assert.ok(invalido.corpo.detalhes.length >= 3)

  // Nenhuma mensagem de erro pode conter jargao de rede nem texto em ingles.
  const todasAsMensagens = [naoExiste, rotaErrada, invalido]
    .flatMap((r) => [r.corpo.error, ...(Array.isArray(r.corpo.detalhes) ? r.corpo.detalhes.map((d) => d.mensagem) : [])])
    .join(' ')
    .toLowerCase()
  for (const palavra of ['wallet', 'blockchain', 'transaction', 'failed', 'error:', 'undefined', 'null']) {
    assert.ok(!todasAsMensagens.includes(palavra), `mensagem de erro contem "${palavra}"`)
  }

  const certificadoInexistente = await pedir('/api/verify/UNI-XXXX-XXXX')
  assert.equal(certificadoInexistente.status, 404)
  assert.match(certificadoInexistente.corpo.error, /certificado/i)
})
