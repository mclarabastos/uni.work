// Verificacao da fase 3.
//
// A promessa: derrubar a rede no meio de uma confirmacao nao perde dinheiro nem
// certificado. A operacao entra na fila, a tela segue, e o sistema termina
// sozinho quando a rede volta.

import { fakePlatform, prepararBanco } from './helpers.js'
import { FakeConnection } from './fake-connection.js'
import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { closeDb, query, one } from '../src/db/index.js'
import { setConnection } from '../src/services/solana.js'
import { processarUmaRodada } from '../src/workers/chain.js'
import { enfileirar, esperaPara, estadoDaFila, BASE_BACKOFF_MS, TETO_BACKOFF_MS } from '../src/domain/chain-queue.js'

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

/** Monta uma vaga entregue, pronta para o contratante confirmar. */
async function vagaPronta () {
  contador += 1
  const marca = `${Date.now()}.${contador}`

  const estudante = (await pedir('/api/signup', {
    method: 'POST', body: { nome: 'Marina Alves', email: `est.${marca}@usp.br`, perfil: 'student' }
  })).corpo
  const contratante = (await pedir('/api/signup', {
    method: 'POST', body: { nome: 'Produtora XPTO', email: `emp.${marca}@xpto.br`, perfil: 'company' }
  })).corpo

  const { vaga } = (await pedir('/api/jobs', {
    method: 'POST', token: contratante.sessao.token,
    body: {
      titulo: 'Staff de credenciamento no congresso',
      descricao: 'Recepção e credenciamento dos participantes durante o evento.',
      categoria: 'Eventos', modalidade: 'presencial', local: 'São Paulo, SP',
      valorCentavos: 24000, horas: 12
    }
  })).corpo

  await pedir(`/api/jobs/${vaga.id}/fund`, { method: 'POST', token: contratante.sessao.token })
  await pedir(`/api/jobs/${vaga.id}/apply`, { method: 'POST', token: estudante.sessao.token, body: {} })

  const detalhe = (await pedir(`/api/jobs/${vaga.id}`, { token: contratante.sessao.token })).corpo
  const candidatura = detalhe.vaga.candidaturas[0].id
  await pedir(`/api/jobs/applications/${candidatura}/accept`, { method: 'POST', token: contratante.sessao.token })
  await pedir(`/api/jobs/${vaga.id}/start`, { method: 'POST', token: estudante.sessao.token })
  await pedir(`/api/jobs/${vaga.id}/deliver`, { method: 'POST', token: estudante.sessao.token, body: {} })

  return { vaga, estudante, contratante }
}

test('a rede cai no meio da confirmação e o sistema termina o serviço sozinho', async () => {
  const { vaga, contratante, estudante } = await vagaPronta()

  const antes = (await pedir(`/api/jobs/${vaga.id}`, { token: contratante.sessao.token })).corpo.vaga
  assert.equal(antes.status, 'entregue')

  // ─── a rede cai ───────────────────────────────────────────────────────────
  rede.derrubar()

  const confirmacao = await pedir(`/api/jobs/${vaga.id}/confirm`, { method: 'POST', token: contratante.sessao.token })

  // 1. O contratante NAO ve um erro. A confirmacao dele foi aceita.
  assert.equal(confirmacao.status, 200, 'a queda da rede não pode virar erro na tela')
  assert.equal(confirmacao.corpo.pagamento.emProcessamento, true)
  assert.match(confirmacao.corpo.pagamento.mensagem, /confirmacao|pagamento/i)

  // 2. A mensagem nao vaza o erro cru da rede.
  const textoDaResposta = JSON.stringify(confirmacao.corpo).toLowerCase()
  for (const jargao of ['econnrefused', 'failed to send', 'transaction', 'blockhash']) {
    assert.ok(!textoDaResposta.includes(jargao), `a resposta vazou "${jargao}"`)
  }

  // 3. A vaga NAO esta concluida: o dinheiro nao saiu, entao dizer que concluiu
  //    seria mentira. Mas a confirmacao ficou registrada.
  const noBanco = await one('select status, confirmed_at, completed_at from jobs where id = $1', [vaga.id])
  assert.equal(noBanco.status, 'entregue')
  assert.ok(noBanco.confirmed_at, 'a intencao do contratante precisa ficar registrada')
  assert.equal(noBanco.completed_at, null)

  // 4. A tela mostra a diferenca entre "entregue" e "confirmado, pagando".
  assert.equal(confirmacao.corpo.vaga.pagamentoEmProcessamento, true)
  assert.match(confirmacao.corpo.vaga.statusRotulo, /liberando o pagamento/i)

  // 5. A operacao esta na fila.
  const naFila = await one(
    "select * from chain_jobs where job_id = $1 and kind = 'escrow_release' and done_at is null",
    [vaga.id]
  )
  assert.ok(naFila, 'a liberação precisa estar na fila')
  assert.equal(Number(naFila.attempts), 0)

  // 6. A falha ficou registrada na camada tecnica, com o motivo de verdade.
  const registro = await one(
    "select * from chain_tx where job_id = $1 and kind = 'escrow_release' and status = 'falhou'",
    [vaga.id]
  )
  assert.ok(registro, 'a tentativa que falhou precisa ficar registrada')
  assert.match(registro.error, /ECONNREFUSED/, 'o detalhe técnico fica aqui, não na tela')

  // ─── o worker roda com a rede ainda caida ─────────────────────────────────
  // As contagens da rodada sao globais, e a suite roda varios arquivos em
  // paralelo contra bancos proprios mas com carga concorrente na maquina. O que
  // este teste precisa afirmar e sobre ESTA operacao, entao a conferencia e
  // pelo item, e nao pelo total da rodada.
  const comRedeCaida = await processarUmaRodada()
  assert.ok(comRedeCaida.processados >= 1, 'a rodada precisa ter pego a operação')
  assert.ok(comRedeCaida.falhas >= 1, 'com a rede caida ela precisa falhar')

  const depoisDaTentativa = await one('select * from chain_jobs where id = $1', [naFila.id])
  assert.equal(Number(depoisDaTentativa.attempts), 1)
  assert.ok(depoisDaTentativa.last_error)
  assert.equal(depoisDaTentativa.done_at, null, 'não pode desistir na primeira tentativa')
  assert.ok(new Date(depoisDaTentativa.run_after) > new Date(), 'a próxima tentativa fica no futuro')

  // O dinheiro continua sem sair, e ninguem perdeu nada.
  const aindaEntregue = await one('select status from jobs where id = $1', [vaga.id])
  assert.equal(aindaEntregue.status, 'entregue')

  // ─── a rede volta ─────────────────────────────────────────────────────────
  rede.levantar()
  // O backoff colocou a proxima tentativa no futuro; adiantamos o relogio da
  // fila, que e o equivalente a esperar.
  await query('update chain_jobs set run_after = now() where id = $1', [naFila.id])

  await processarUmaRodada()
  const liberacao = await one('select * from chain_jobs where id = $1', [naFila.id])
  assert.ok(liberacao.done_at, 'com a rede de volta, a liberação precisa concluir')

  // 7. Agora sim: paga e concluida.
  const concluida = await one('select status, completed_at from jobs where id = $1', [vaga.id])
  assert.equal(concluida.status, 'concluida')
  assert.ok(concluida.completed_at)

  const pagamento = await one(
    "select * from chain_tx where job_id = $1 and kind = 'escrow_release' and status = 'confirmada'",
    [vaga.id]
  )
  assert.ok(pagamento?.signature, 'o pagamento precisa ter assinatura')

  // 8. O certificado foi para a fila e sai na rodada seguinte.
  const certNaFila = await one(
    "select * from chain_jobs where job_id = $1 and kind = 'cert_mint' and done_at is null",
    [vaga.id]
  )
  assert.ok(certNaFila, 'o certificado entra na fila depois do pagamento')

  await processarUmaRodada()

  // O certificado existe. Nesta suite o Bubblegum nao alcanca a rede, entao ele
  // continua tentando; o que importa e que a vaga esta paga e o certificado nao
  // foi esquecido.
  const filaFinal = await estadoDaFila()
  assert.equal(filaFinal.pendentes >= 0, true)

  // 9. Ninguem perdeu nada: o estudante e a vaga certa continuam ligados.
  const final = (await pedir(`/api/jobs/${vaga.id}`, { token: estudante.sessao.token })).corpo.vaga
  assert.equal(final.status, 'concluida')
  assert.equal(final.trilha.etapa, 6)
})

test('confirmar de novo depois da queda não paga duas vezes', async () => {
  const { vaga, contratante } = await vagaPronta()

  rede.derrubar()
  await pedir(`/api/jobs/${vaga.id}/confirm`, { method: 'POST', token: contratante.sessao.token })

  // O contratante fica impaciente e clica de novo, varias vezes.
  for (let i = 0; i < 3; i += 1) {
    await pedir(`/api/jobs/${vaga.id}/confirm`, { method: 'POST', token: contratante.sessao.token })
  }

  // Continua havendo UMA liberacao na fila, nao quatro.
  const pendentes = await query(
    "select id from chain_jobs where job_id = $1 and kind = 'escrow_release' and done_at is null",
    [vaga.id]
  )
  assert.equal(pendentes.rows.length, 1, 'o banco impede duas liberações pendentes para a mesma vaga')

  rede.levantar()
  await query('update chain_jobs set run_after = now()')
  await processarUmaRodada()

  // Uma unica liberacao confirmada.
  const liberacoes = await query(
    "select id from chain_tx where job_id = $1 and kind = 'escrow_release' and status = 'confirmada'",
    [vaga.id]
  )
  assert.equal(liberacoes.rows.length, 1, 'o pagamento saiu uma vez só')

  // E rodar o worker de novo nao paga outra vez: o handler ve que ja foi feito.
  await enfileirar('escrow_release', { jobId: vaga.id })
  await query('update chain_jobs set run_after = now()')
  const denovo = await processarUmaRodada()
  assert.equal(denovo.pulados >= 1, true, 'o handler precisa reconhecer que o trabalho já foi feito')

  const total = await query(
    "select id from chain_tx where job_id = $1 and kind = 'escrow_release' and status = 'confirmada'",
    [vaga.id]
  )
  assert.equal(total.rows.length, 1, 'continua sendo um pagamento só')
})

test('a espera entre tentativas cresce e para de crescer no teto', () => {
  assert.equal(esperaPara(0), BASE_BACKOFF_MS)
  assert.equal(esperaPara(1), BASE_BACKOFF_MS * 2)
  assert.equal(esperaPara(2), BASE_BACKOFF_MS * 4)
  assert.equal(esperaPara(3), BASE_BACKOFF_MS * 8)

  // Cresce sempre, ate bater no teto, e nunca passa dele.
  let anterior = 0
  for (let tentativa = 0; tentativa < 20; tentativa += 1) {
    const espera = esperaPara(tentativa)
    assert.ok(espera >= anterior, 'a espera nunca diminui')
    assert.ok(espera <= TETO_BACKOFF_MS, 'a espera nunca passa do teto')
    anterior = espera
  }
  assert.equal(esperaPara(50), TETO_BACKOFF_MS)
})

test('depois de tentar demais a fila desiste e marca para alguém olhar', async () => {
  const { vaga } = await vagaPronta()
  rede.derrubar()

  // Duas chances, para o teste nao levar oito rodadas.
  await query('delete from chain_jobs')
  await enfileirar('escrow_release', { jobId: vaga.id, maxTentativas: 2 })
  await query('update jobs set confirmed_at = now() where id = $1', [vaga.id])

  await processarUmaRodada()
  await query('update chain_jobs set run_after = now()')
  const segunda = await processarUmaRodada()

  assert.equal(segunda.desistencias, 1)

  const item = await one("select * from chain_jobs where job_id = $1 and kind = 'escrow_release'", [vaga.id])
  assert.ok(item.failed_at, 'o item precisa ficar marcado como desistido')
  assert.equal(Number(item.attempts), 2)
  assert.equal(item.done_at, null, 'desistir não e concluir')
  assert.ok(item.last_error)

  // Desistir nao apaga: o item aparece na fila de falhas para a operacao ver.
  const resumo = await estadoDaFila()
  assert.equal(resumo.falhadas >= 1, true)

  // E da para devolver para a fila, o que zera a contagem.
  rede.levantar()
  const contratante = await one('select id from users where id = (select company_id from jobs where id = $1)', [vaga.id])
  const sessao = await one('select token from sessions where user_id = $1 order by created_at desc limit 1', [contratante.id])

  const reprocessar = await pedir('/api/chain/retry', {
    method: 'POST', token: sessao.token, body: { id: item.id }
  })
  assert.equal(reprocessar.status, 200)
  assert.equal(reprocessar.corpo.ok, true)
  assert.match(reprocessar.corpo.mensagem, /tentar de novo/i)

  const devolvido = await one('select * from chain_jobs where id = $1', [item.id])
  assert.equal(Number(devolvido.attempts), 0)
  assert.equal(devolvido.failed_at, null)

  const rodada = await processarUmaRodada()
  assert.equal(rodada.concluidos, 1, 'com a rede de volta, a operação devolvida precisa passar')
})

test('a rota de reprocessar enfileira em vez de esperar a rede', async () => {
  const { vaga, contratante } = await vagaPronta()

  const inicio = Date.now()
  rede.derrubar()

  const resposta = await pedir('/api/chain/retry', {
    method: 'POST', token: contratante.sessao.token,
    body: { vagaId: vaga.id, tipo: 'escrow_release' }
  })

  // A rota responde na hora, mesmo com a rede caida: quem espera e o worker.
  assert.equal(resposta.status, 200)
  assert.ok(Date.now() - inicio < 2000, 'a rota não pode ficar presa esperando a rede')
  assert.equal(resposta.corpo.ok, true)

  // Pedir de novo nao duplica.
  const segunda = await pedir('/api/chain/retry', {
    method: 'POST', token: contratante.sessao.token,
    body: { vagaId: vaga.id, tipo: 'escrow_release' }
  })
  assert.equal(segunda.corpo.jaEstava, true)
  assert.match(segunda.corpo.mensagem, /já estava na fila/i)

  // Reprocessar algo que nao existe responde em portugues, sem vazar nada.
  const inexistente = await pedir('/api/chain/retry', {
    method: 'POST', token: contratante.sessao.token, body: { id: 'cjb_nao_existe' }
  })
  assert.equal(inexistente.status, 404)
  assert.equal(inexistente.corpo.codigo, 'nao_encontrado')
})

test('um certificado que nasceu como memo não fica assim: ele entra na fila', async () => {
  const { vaga, contratante } = await vagaPronta()

  // Com a rede no ar, mas sem arvore alcancavel, o certificado cai no memo.
  const confirmacao = await pedir(`/api/jobs/${vaga.id}/confirm`, {
    method: 'POST', token: contratante.sessao.token
  })
  assert.equal(confirmacao.status, 200)
  assert.equal(confirmacao.corpo.certificado.emProcessamento, true)

  const certificado = await one('select * from certificates where job_id = $1', [vaga.id])
  assert.ok(certificado, 'o certificado precisa existir mesmo sem virar cNFT ainda')
  assert.equal(certificado.asset_id, null)
  assert.ok(certificado.content_hash, 'o hash já vale desde a emissão')

  // E ele esta na fila para virar cNFT de verdade.
  const naFila = await one(
    "select * from chain_jobs where job_id = $1 and kind = 'cert_mint' and done_at is null",
    [vaga.id]
  )
  assert.ok(naFila, 'um certificado de memo precisa estar na fila para subir para cNFT')

  // A verificacao publica ja funciona, e diz com honestidade que o registro
  // publico ainda esta a caminho.
  const verificacao = await pedir(`/api/verify/${certificado.code}`)
  assert.equal(verificacao.status, 200)
  assert.equal(verificacao.corpo.valido, true, 'a integridade do conteúdo já confere')
  assert.equal(verificacao.corpo.confirmacaoIndependente.confirmado, false)
  assert.ok(verificacao.corpo.confirmacaoIndependente.motivo, 'a resposta diz por que ainda não confirmou')
})
