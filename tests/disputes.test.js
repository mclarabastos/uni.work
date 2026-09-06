// Verificacao da fase 5: o fluxo de contestacao, das duas partes, ate a
// resolucao com divisao do valor, batendo centavo por centavo.

import { fakePlatform, prepararBanco } from './helpers.js'
import { FakeConnection } from './fake-connection.js'
import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { closeDb, query, one } from '../src/db/index.js'
import { setConnection } from '../src/services/solana.js'
import { processarUmaRodada } from '../src/workers/chain.js'
import { splitFee } from '../src/lib/money.js'
import { DIAS_ATE_AUTO_CONFIRMAR } from '../src/domain/disputes.js'

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
const VALOR = 24000 // R$ 240,00

/** Vaga entregue, com as duas partes, pronta para contestar. */
async function vagaEntregue () {
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
      valorCentavos: VALOR, horas: 12
    }
  })).corpo

  await pedir(`/api/jobs/${vaga.id}/fund`, { method: 'POST', token: contratante.sessao.token })
  await pedir(`/api/jobs/${vaga.id}/apply`, { method: 'POST', token: estudante.sessao.token, body: {} })
  const detalhe = (await pedir(`/api/jobs/${vaga.id}`, { token: contratante.sessao.token })).corpo
  await pedir(`/api/jobs/applications/${detalhe.vaga.candidaturas[0].id}/accept`, {
    method: 'POST', token: contratante.sessao.token
  })
  await pedir(`/api/jobs/${vaga.id}/start`, { method: 'POST', token: estudante.sessao.token })
  await pedir(`/api/jobs/${vaga.id}/deliver`, {
    method: 'POST', token: estudante.sessao.token,
    body: { observacao: 'Credenciamento concluído nos dois dias.' }
  })

  return { vaga, estudante, contratante }
}

async function criarMediador () {
  contador += 1
  const conta = (await pedir('/api/signup', {
    method: 'POST',
    body: { nome: 'Mediação Uni.work', email: `med.${Date.now()}.${contador}@uniwork.br`, perfil: 'company' }
  })).corpo
  await query('update users set is_admin = true where id = $1', [conta.usuario.id])
  return conta
}

test('o contratante contesta, a mediação divide, e a divisão bate centavo por centavo', async () => {
  const { vaga, contratante, estudante } = await vagaEntregue()
  const mediador = await criarMediador()

  // ─── o contratante contesta a entrega ─────────────────────────────────────
  const abertura = await pedir(`/api/jobs/${vaga.id}/dispute`, {
    method: 'POST', token: contratante.sessao.token,
    body: {
      motivo: 'fora_do_combinado',
      detalhe: 'Combinamos dois dias de credenciamento e só houve cobertura no primeiro dia.'
    }
  })
  assert.equal(abertura.status, 201)
  const contestacao = abertura.corpo.contestacao
  assert.equal(contestacao.status, 'open')
  assert.equal(contestacao.motivoRotulo, 'A entrega não corresponde ao combinado')
  assert.ok(contestacao.prazoEm, 'a contestação nasce com prazo visível')
  assert.equal(contestacao.atrasada, false)

  // ─── enquanto ha contestacao, o valor nao vai para lado nenhum ────────────
  const tentandoConfirmar = await pedir(`/api/jobs/${vaga.id}/confirm`, {
    method: 'POST', token: contratante.sessao.token
  })
  assert.equal(tentandoConfirmar.status, 409)
  assert.equal(tentandoConfirmar.corpo.codigo, 'vaga_em_contestacao')

  const tentandoCancelar = await pedir(`/api/jobs/${vaga.id}/cancel`, {
    method: 'POST', token: contratante.sessao.token, body: {}
  })
  assert.equal(tentandoCancelar.status, 409)
  assert.equal(tentandoCancelar.corpo.codigo, 'vaga_em_contestacao')

  // As duas partes veem a contestacao, e a tela mostra o estado.
  for (const quem of [contratante, estudante]) {
    const visao = (await pedir(`/api/jobs/${vaga.id}`, { token: quem.sessao.token })).corpo.vaga
    assert.equal(visao.emContestacao, true)
    assert.equal(visao.statusRotulo, 'Em contestação')
    assert.equal(visao.contestacao.id, contestacao.id)
    assert.ok(visao.contestacao.prazoEm)
  }

  // ─── quem nao e da vaga nao ve nem abre ───────────────────────────────────
  const estranho = (await pedir('/api/signup', {
    method: 'POST', body: { nome: 'Alguém', email: `x.${Date.now()}@teste.br`, perfil: 'student' }
  })).corpo
  const visaoDeFora = (await pedir(`/api/jobs/${vaga.id}`, { token: estranho.sessao.token })).corpo.vaga
  assert.equal(visaoDeFora.contestacao, null, 'quem não e parte não ve o conteúdo da contestação')

  // ─── so a mediacao ve a fila e resolve ────────────────────────────────────
  const filaNegada = await pedir('/api/disputes', { token: contratante.sessao.token })
  assert.equal(filaNegada.status, 403)

  const fila = await pedir('/api/disputes?status=abertas', { token: mediador.sessao.token })
  assert.equal(fila.status, 200)
  assert.ok(fila.corpo.contestacoes.some((c) => c.id === contestacao.id))

  const resolucaoNegada = await pedir(`/api/disputes/${contestacao.id}/resolve`, {
    method: 'POST', token: contratante.sessao.token,
    body: { resultado: 'resolved_company', resolucao: 'Quero meu dinheiro de volta agora mesmo.' }
  })
  assert.equal(resolucaoNegada.status, 403, 'a parte interessada não decide a própria contestação')

  // ─── a mediacao assume e divide meio a meio ───────────────────────────────
  const assumida = await pedir(`/api/disputes/${contestacao.id}/assumir`, {
    method: 'POST', token: mediador.sessao.token
  })
  assert.equal(assumida.status, 200)
  assert.equal(assumida.corpo.contestacao.status, 'in_review')

  // Uma divisao de 0% ou 100% nao e divisao: o produto pede o resultado integral.
  const divisaoBoba = await pedir(`/api/disputes/${contestacao.id}/resolve`, {
    method: 'POST', token: mediador.sessao.token,
    body: { resultado: 'split', divisaoBps: 10000, resolucao: 'Metade para cada lado, na verdade tudo.' }
  })
  assert.equal(divisaoBoba.status, 400)

  const resolucao = await pedir(`/api/disputes/${contestacao.id}/resolve`, {
    method: 'POST', token: mediador.sessao.token,
    body: {
      resultado: 'split',
      divisaoBps: 5000,
      resolucao: 'Houve trabalho no primeiro dia e não houve no segundo. Metade para cada lado.'
    }
  })
  assert.equal(resolucao.status, 200)
  assert.equal(resolucao.corpo.disputa.status, 'split')
  assert.equal(resolucao.corpo.disputa.statusRotulo, 'Resolvida: valor dividido')
  assert.equal(resolucao.corpo.disputa.divisaoBps, 5000)

  // ─── a conta fecha ────────────────────────────────────────────────────────
  const divisao = resolucao.corpo.divisao
  assert.ok(divisao, 'a resolução precisa dizer para onde cada centavo foi')

  const brutoEstudante = VALOR / 2
  const { studentCents: liquidoEsperado, feeCents: taxaEsperada } = splitFee(brutoEstudante, 500)

  assert.equal(divisao.studentCents, liquidoEsperado, 'R$ 114,00 para o estudante')
  assert.equal(divisao.feeCents, taxaEsperada, 'R$ 6,00 de taxa sobre a parte do estudante')
  assert.equal(divisao.companyCents, VALOR - brutoEstudante, 'R$ 120,00 de volta para o contratante')

  // Nenhum centavo se perdeu nem foi inventado.
  assert.equal(
    divisao.studentCents + divisao.feeCents + divisao.companyCents,
    VALOR,
    'a soma das três partes precisa ser exatamente o valor da vaga'
  )

  // ─── o resultado bate com o que foi para a rede ───────────────────────────
  const naRede = await one(
    `select * from chain_tx where job_id = $1 and kind = 'escrow_release' and status = 'confirmada'`,
    [vaga.id]
  )
  assert.ok(naRede, 'a movimentação precisa estar registrada')
  const detalheDaRede = typeof naRede.detail === 'string' ? JSON.parse(naRede.detail) : naRede.detail
  assert.equal(detalheDaRede.resolucaoDeDisputa, true)
  assert.deepEqual(detalheDaRede.divisao, divisao, 'o registro da rede bate com a resposta da API')

  // Como o valor se divide na rede depende do driver, e os dois estao certos:
  //   vault  -> tres transferencias, uma para cada destino, montadas aqui
  //   anchor -> uma instrucao so, e a divisao acontece dentro do programa
  // O que precisa bater nos dois casos e o valor de cada parte, ja conferido
  // acima. Aqui so se confirma que a forma corresponde ao driver em uso.
  const instrucoes = typeof naRede.instructions === 'string'
    ? JSON.parse(naRede.instructions) : naRede.instructions
  const { escrowDriverName } = await import('../src/services/escrow.js')
  const transferencias = instrucoes.filter((i) => i.dataLength > 1)

  if (escrowDriverName() === 'anchor') {
    assert.equal(transferencias.length, 1, 'no programa, a divisão e uma instrução só')
  } else {
    assert.equal(transferencias.length, 3, 'no cofre, uma transferência por destino')
  }

  // ─── a vaga fecha e sai da contestacao ────────────────────────────────────
  const final = await one('select status, disputed_at, completed_at from jobs where id = $1', [vaga.id])
  assert.equal(final.status, 'concluida')
  assert.equal(final.disputed_at, null, 'a vaga sai da contestação')
  assert.ok(final.completed_at)

  // ─── ficou registrado quem decidiu o que ──────────────────────────────────
  const auditoria = await one(
    "select * from audit_log where entity = 'dispute' and entity_id = $1 and action = 'disputa.resolvida'",
    [contestacao.id]
  )
  assert.ok(auditoria, 'a decisão precisa estar na trilha de auditoria')
  assert.equal(auditoria.actor_id, mediador.usuario.id)

  // ─── resolver duas vezes e recusado ───────────────────────────────────────
  const denovo = await pedir(`/api/disputes/${contestacao.id}/resolve`, {
    method: 'POST', token: mediador.sessao.token,
    body: { resultado: 'resolved_student', resolucao: 'Mudei de ideia sobre a decisão anterior.' }
  })
  assert.equal(denovo.status, 409)
  assert.equal(denovo.corpo.codigo, 'contestacao_ja_resolvida')
})

test('o estudante contesta quando o pagamento não sai, e a mediação pode dar tudo a ele', async () => {
  const { vaga, estudante } = await vagaEntregue()
  const mediador = await criarMediador()

  const abertura = await pedir(`/api/jobs/${vaga.id}/dispute`, {
    method: 'POST', token: estudante.sessao.token,
    body: {
      motivo: 'pagamento_travado',
      detalhe: 'Entreguei há duas semanas e o contratante não responde nem confirma a entrega.'
    }
  })
  assert.equal(abertura.status, 201)
  assert.equal(abertura.corpo.contestacao.abertaPor.perfil, 'student')

  const resolucao = await pedir(`/api/disputes/${abertura.corpo.contestacao.id}/resolve`, {
    method: 'POST', token: mediador.sessao.token,
    body: {
      resultado: 'resolved_student',
      resolucao: 'A entrega esta documentada e o contratante não se manifestou dentro do prazo.'
    }
  })
  assert.equal(resolucao.status, 200)
  assert.equal(resolucao.corpo.disputa.divisaoBps, 10000, 'integral para o estudante')

  const divisao = resolucao.corpo.divisao
  const { studentCents, feeCents } = splitFee(VALOR, 500)
  assert.equal(divisao.studentCents, studentCents)
  assert.equal(divisao.feeCents, feeCents)
  assert.equal(divisao.companyCents, 0)
  assert.equal(divisao.studentCents + divisao.feeCents + divisao.companyCents, VALOR)

  // Houve trabalho reconhecido, entao o certificado entra na fila.
  const cert = await one(
    "select * from chain_jobs where job_id = $1 and kind = 'cert_mint'", [vaga.id]
  )
  assert.ok(cert, 'quem teve o trabalho reconhecido recebe certificado')
})

test('contestação duplicada, fora de hora, ou de quem não e parte, e recusada', async () => {
  const { vaga, contratante, estudante } = await vagaEntregue()

  const primeira = await pedir(`/api/jobs/${vaga.id}/dispute`, {
    method: 'POST', token: contratante.sessao.token,
    body: { motivo: 'atrasado', detalhe: 'A entrega passou muito do prazo que combinamos no inicio.' }
  })
  assert.equal(primeira.status, 201)

  // A outra parte tambem nao abre uma segunda.
  const segunda = await pedir(`/api/jobs/${vaga.id}/dispute`, {
    method: 'POST', token: estudante.sessao.token,
    body: { motivo: 'pagamento_travado', detalhe: 'Na verdade quem esta errado aqui e o contratante.' }
  })
  assert.equal(segunda.status, 409)
  assert.equal(segunda.corpo.codigo, 'contestacao_duplicada')

  // Detalhe curto demais e recusado: contestar sem explicar nao ajuda ninguem.
  const outra = await vagaEntregue()
  const semExplicacao = await pedir(`/api/jobs/${outra.vaga.id}/dispute`, {
    method: 'POST', token: outra.contratante.sessao.token,
    body: { motivo: 'outro', detalhe: 'não gostei' }
  })
  assert.equal(semExplicacao.status, 400)
  assert.equal(semExplicacao.corpo.codigo, 'campos_invalidos')

  // Motivo fora da lista.
  const motivoInvalido = await pedir(`/api/jobs/${outra.vaga.id}/dispute`, {
    method: 'POST', token: outra.contratante.sessao.token,
    body: { motivo: 'porque_sim', detalhe: 'Um detalhe suficientemente longo para passar na validação.' }
  })
  assert.equal(motivoInvalido.status, 400)

  // Quem nao e parte da vaga.
  const estranho = (await pedir('/api/signup', {
    method: 'POST', body: { nome: 'Alguém', email: `y.${Date.now()}@teste.br`, perfil: 'student' }
  })).corpo
  const deFora = await pedir(`/api/jobs/${outra.vaga.id}/dispute`, {
    method: 'POST', token: estranho.sessao.token,
    body: { motivo: 'conduta', detalhe: 'Não tenho nada a ver com esta vaga mas quero contestar.' }
  })
  assert.equal(deFora.status, 403)

  // Vaga ja concluida nao aceita contestacao pela via normal.
  const terceira = await vagaEntregue()
  await pedir(`/api/jobs/${terceira.vaga.id}/confirm`, {
    method: 'POST', token: terceira.contratante.sessao.token
  })
  const tardeDemais = await pedir(`/api/jobs/${terceira.vaga.id}/dispute`, {
    method: 'POST', token: terceira.contratante.sessao.token,
    body: { motivo: 'outro', detalhe: 'Descobri o problema depois que já tinha confirmado a entrega.' }
  })
  assert.equal(tardeDemais.status, 409)
  assert.match(tardeDemais.corpo.error, /suporte/i, 'a mensagem precisa dizer para onde ir')
})

test('a entrega que ninguém confirma nem contesta se confirma sozinha depois do prazo', async () => {
  const { vaga } = await vagaEntregue()

  // A entrega nasce com prazo de auto confirmacao.
  const comPrazo = await one('select auto_confirm_at, confirmed_at from jobs where id = $1', [vaga.id])
  assert.ok(comPrazo.auto_confirm_at, 'entregar precisa marcar o prazo de confirmação automática')
  assert.equal(comPrazo.confirmed_at, null)

  const diasDeDiferenca = (new Date(comPrazo.auto_confirm_at) - Date.now()) / 86400_000
  assert.ok(Math.abs(diasDeDiferenca - DIAS_ATE_AUTO_CONFIRMAR) < 0.1, `o prazo e de ${DIAS_ATE_AUTO_CONFIRMAR} dias`)

  // Dentro do prazo, nada acontece.
  await processarUmaRodada()
  assert.equal((await one('select confirmed_at from jobs where id = $1', [vaga.id])).confirmed_at, null)

  // Passado o prazo, o sistema confirma por ele e o pagamento vai para a fila.
  await query("update jobs set auto_confirm_at = now() - interval '1 hour' where id = $1", [vaga.id])
  await processarUmaRodada()

  const confirmada = await one('select confirmed_at, status from jobs where id = $1', [vaga.id])
  assert.ok(confirmada.confirmed_at, 'o prazo vencido confirma a entrega')

  // Rodar de novo termina o servico.
  await query('update chain_jobs set run_after = now()')
  await processarUmaRodada()
  assert.equal((await one('select status from jobs where id = $1', [vaga.id])).status, 'concluida')

  // E ficou registrado que foi o sistema, nao uma pessoa.
  const auditoria = await one(
    "select * from audit_log where entity = 'job' and entity_id = $1 and action = 'vaga.auto_confirmada'",
    [vaga.id]
  )
  assert.ok(auditoria)
  assert.equal(auditoria.actor_id, null, 'nenhuma pessoa assinou essa confirmação')
})

test('uma contestação aberta impede a auto confirmação de atropelar a mediação', async () => {
  const { vaga, estudante } = await vagaEntregue()

  await pedir(`/api/jobs/${vaga.id}/dispute`, {
    method: 'POST', token: estudante.sessao.token,
    body: { motivo: 'pagamento_travado', detalhe: 'O contratante sumiu depois que eu entreguei o material.' }
  })

  // Abrir contestacao limpa o prazo de auto confirmacao.
  const semPrazo = await one('select auto_confirm_at, disputed_at from jobs where id = $1', [vaga.id])
  assert.equal(semPrazo.auto_confirm_at, null, 'a contestação cancela a confirmação automática')
  assert.ok(semPrazo.disputed_at)

  // Mesmo forcando um prazo vencido, a contestacao segura.
  await query("update jobs set auto_confirm_at = now() - interval '1 day' where id = $1", [vaga.id])
  await processarUmaRodada()

  const aindaEmDisputa = await one('select confirmed_at, status from jobs where id = $1', [vaga.id])
  assert.equal(aindaEmDisputa.confirmed_at, null, 'o prazo não pode atropelar a mediação')
  assert.equal(aindaEmDisputa.status, 'entregue')
})

test('se a rede recusar, a decisão da mediação vale e a movimentação vai para a fila', async () => {
  const { vaga, contratante } = await vagaEntregue()
  const mediador = await criarMediador()

  const abertura = await pedir(`/api/jobs/${vaga.id}/dispute`, {
    method: 'POST', token: contratante.sessao.token,
    body: { motivo: 'fora_do_combinado', detalhe: 'A entrega veio incompleta em relação ao combinado.' }
  })

  rede.derrubar()

  const resolucao = await pedir(`/api/disputes/${abertura.corpo.contestacao.id}/resolve`, {
    method: 'POST', token: mediador.sessao.token,
    body: { resultado: 'split', divisaoBps: 3000, resolucao: 'Parte do trabalho foi entregue e aceita.' }
  })

  // A decisao vale. Obrigar o mediador a decidir de novo porque a rede caiu
  // seria jogar fora o trabalho de analise dele.
  assert.equal(resolucao.status, 200)
  assert.equal(resolucao.corpo.disputa.status, 'split')
  assert.equal(resolucao.corpo.pagamentoEmProcessamento, true)

  const naFila = await one(
    "select * from chain_jobs where job_id = $1 and kind = 'escrow_release' and done_at is null",
    [vaga.id]
  )
  assert.ok(naFila, 'a movimentação precisa estar na fila')
  const payload = typeof naFila.payload === 'string' ? JSON.parse(naFila.payload) : naFila.payload
  assert.equal(payload.divisaoBps, 3000, 'a fila carrega a divisão decidida, não um pagamento integral')

  // Com a rede de volta, a fila executa exatamente a divisao decidida.
  rede.levantar()
  await query('update chain_jobs set run_after = now()')
  await processarUmaRodada()

  const executada = await one(
    "select * from chain_tx where job_id = $1 and kind = 'escrow_release' and status = 'confirmada'",
    [vaga.id]
  )
  assert.ok(executada)
  const detalhe = typeof executada.detail === 'string' ? JSON.parse(executada.detail) : executada.detail
  assert.equal(detalhe.resolucaoDeDisputa, true)

  const bruto = Math.floor((VALOR * 3000) / 10000)
  const { studentCents, feeCents } = splitFee(bruto, 500)
  assert.equal(detalhe.divisao.studentCents, studentCents)
  assert.equal(detalhe.divisao.companyCents, VALOR - bruto)
  assert.equal(detalhe.divisao.studentCents + detalhe.divisao.feeCents + detalhe.divisao.companyCents, VALOR)

  assert.equal((await one('select status from jobs where id = $1', [vaga.id])).status, 'concluida')
})
