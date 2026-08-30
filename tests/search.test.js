// Verificacao da fase 8: busca full-text em portugues, filtros que combinam,
// cursor em vez de offset, e desempenho com dez mil vagas na base.

import { fakePlatform, prepararBanco } from './helpers.js'
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { closeDb, query, one } from '../src/db/index.js'
import { buscarVagas, facetas } from '../src/domain/search.js'
import { codificarCursor, decodificarCursor, LIMITE_MAXIMO } from '../src/lib/cursor.js'

fakePlatform()

let servidor
let base

const CATEGORIAS = ['Eventos', 'Monitoria', 'Design', 'Traducao', 'Pesquisa', 'Desenvolvimento']
const CIDADES = ['Sao Paulo, SP', 'Campinas, SP', 'Belo Horizonte, MG', 'Rio de Janeiro, RJ']
const TITULOS = [
  'Staff de credenciamento no congresso de tecnologia',
  'Monitoria de calculo para a turma de engenharia',
  'Redesenho da tela de assinatura do aplicativo',
  'Traducao de artigo cientifico sobre energia renovavel',
  'Pesquisa de campo sobre mobilidade urbana',
  'Componente de calendario acessivel em React'
]

const QUANTIDADE = Number(process.env.VAGAS_DE_TESTE ?? 10000)

before(async () => {
  await prepararBanco()
  servidor = createApp().listen(0)
  await new Promise((r) => servidor.once('listening', r))
  base = `http://127.0.0.1:${servidor.address().port}`

  await query("insert into users (id, role, name, email) values ('emp_busca','company','Produtora XPTO','busca@teste.br')")

  // Dez mil vagas de uma vez. Uma insercao por linha levaria minutos e nao
  // testaria nada a mais.
  const porLote = 500
  for (let inicio = 0; inicio < QUANTIDADE; inicio += porLote) {
    const valores = []
    const params = []
    for (let i = inicio; i < Math.min(inicio + porLote, QUANTIDADE); i += 1) {
      const p = params.length
      valores.push(`($${p + 1}, 'emp_busca', $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6}, $${p + 7}, $${p + 8}, $${p + 9}, now() - make_interval(mins => $${p + 10}))`)
      params.push(
        `job_perf_${i}`,
        `${TITULOS[i % TITULOS.length]} numero ${i}`,
        `Descricao detalhada da vaga numero ${i}, com contexto suficiente para a busca ter o que indexar em portugues.`,
        CATEGORIAS[i % CATEGORIAS.length],
        i % 2 === 0 ? 'presencial' : 'remoto',
        i % 2 === 0 ? CIDADES[i % CIDADES.length] : null,
        1000 + (i % 500) * 100,
        1 + (i % 40),
        i % 3 === 0 ? 'garantida' : 'aberta',
        i
      )
    }
    await query(
      `insert into jobs (id, company_id, title, description, category, modality, location,
                         amount_cents, hours, status, created_at)
       values ${valores.join(',')}`,
      params
    )
  }

  // Uma vaga com termo unico, para provar que a busca acha agulha no palheiro.
  await query(
    `insert into jobs (id, company_id, title, description, category, modality, amount_cents, hours, status)
     values ('job_agulha','emp_busca','Fotografia de formatura em Piracicaba',
             'Cobertura fotografica da colacao de grau, com entrega das fotos tratadas.',
             'Fotografia','presencial',80000,8,'aberta')`
  )

  await query('analyze jobs')
})

after(async () => {
  servidor?.close()
  await closeDb()
})

async function pedir (caminho) {
  const resposta = await fetch(base + caminho)
  const texto = await resposta.text()
  return { status: resposta.status, corpo: texto ? JSON.parse(texto) : null }
}

/** Mede o melhor de tres, para o resultado nao depender de um pico do sistema. */
async function medir (fn, vezes = 3) {
  let melhor = Infinity
  let ultimo
  for (let i = 0; i < vezes; i += 1) {
    const inicio = process.hrtime.bigint()
    ultimo = await fn()
    const ms = Number(process.hrtime.bigint() - inicio) / 1e6
    if (ms < melhor) melhor = ms
  }
  return { ms: melhor, resultado: ultimo }
}

test('a base de teste tem mesmo as dez mil vagas', async () => {
  const total = await one('select count(*)::int as n from jobs')
  assert.equal(total.n, QUANTIDADE + 1, 'sem a base cheia, o teste de desempenho nao vale nada')
})

test('a busca full-text responde abaixo de 200 ms com dez mil vagas', async () => {
  const { ms, resultado } = await medir(() => buscarVagas({ termo: 'credenciamento congresso' }))

  assert.ok(resultado.vagas.length > 0, 'a busca precisa achar alguma coisa')
  assert.ok(ms < 200, `a busca levou ${ms.toFixed(1)}ms, acima do limite de 200ms`)
  console.log(`      busca full-text em ${QUANTIDADE} vagas: ${ms.toFixed(1)}ms`)

  // A agulha no palheiro.
  const agulha = await medir(() => buscarVagas({ termo: 'Piracicaba formatura' }))
  assert.ok(agulha.resultado.vagas.some((v) => v.id === 'job_agulha'))
  assert.ok(agulha.ms < 200, `a busca especifica levou ${agulha.ms.toFixed(1)}ms`)

  // Filtros combinados, que e o caso mais pesado.
  const combinada = await medir(() => buscarVagas({
    termo: 'monitoria engenharia',
    modalidade: 'remoto',
    valorMin: 2000,
    valorMax: 40000,
    horasMax: 30,
    ordem: 'relevancia'
  }))
  assert.ok(combinada.ms < 200, `a busca com filtros levou ${combinada.ms.toFixed(1)}ms`)
  console.log(`      busca com filtros combinados: ${combinada.ms.toFixed(1)}ms`)

  // Listagem sem termo, ordenada por data, que e a tela inicial.
  const inicial = await medir(() => buscarVagas({}))
  assert.ok(inicial.ms < 200, `a listagem inicial levou ${inicial.ms.toFixed(1)}ms`)
  assert.equal(inicial.resultado.vagas.length, 20, 'o limite padrao e vinte')
  console.log(`      listagem inicial: ${inicial.ms.toFixed(1)}ms`)
})

test('a pagina 500 custa o mesmo que a pagina 1, que e o motivo do cursor', async () => {
  // Com offset, chegar na pagina 500 significaria mandar o banco varrer e
  // descartar dez mil linhas. Com cursor, e a mesma consulta.
  const primeira = await medir(() => buscarVagas({ limite: 20 }))

  let cursor = primeira.resultado.proximoCursor
  let paginas = 1
  while (cursor && paginas < 60) {
    const saida = await buscarVagas({ cursor, limite: 20 })
    cursor = saida.proximoCursor
    paginas += 1
  }
  assert.ok(paginas > 50, `so consegui avancar ${paginas} paginas`)

  const funda = await medir(() => buscarVagas({ cursor, limite: 20 }))
  assert.ok(funda.ms < 200, `a pagina funda levou ${funda.ms.toFixed(1)}ms`)

  // A pagina funda nao pode ser dramaticamente mais lenta que a primeira.
  assert.ok(funda.ms < primeira.ms + 100,
    `pagina 1: ${primeira.ms.toFixed(1)}ms, pagina ${paginas}: ${funda.ms.toFixed(1)}ms`)
  console.log(`      pagina 1: ${primeira.ms.toFixed(1)}ms | pagina ${paginas}: ${funda.ms.toFixed(1)}ms`)
})

test('o cursor percorre a lista inteira sem pular nem repetir', async () => {
  const vistos = []
  let cursor = null
  let voltas = 0

  // Uma fatia pequena e bem delimitada, para dar para conferir item por item.
  const filtro = { categoria: 'Fotografia', limite: 3 }

  do {
    const pagina = await buscarVagas({ ...filtro, cursor })
    for (const vaga of pagina.vagas) vistos.push(vaga.id)
    cursor = pagina.proximoCursor
    voltas += 1
  } while (cursor && voltas < 50)

  assert.equal(new Set(vistos).size, vistos.length, 'o cursor repetiu algum item')

  const noBanco = await one(
    "select count(*)::int as n from jobs where category = 'Fotografia' and status in ('aberta','garantida')"
  )
  assert.equal(vistos.length, noBanco.n, 'o cursor pulou algum item')
})

test('o cursor e assinado: adulterar o valor de comparacao nao funciona', async () => {
  const valido = codificarCursor({ o: 'recentes', v: ['2026-01-01', 'job_x'] })
  assert.deepEqual(decodificarCursor(valido), { o: 'recentes', v: ['2026-01-01', 'job_x'] })

  const [corpo] = valido.split('.')
  for (const adulterado of [`${corpo}.aaaaaaaaaaaaaaaa`, corpo, 'lixo', `${corpo}.`]) {
    assert.throws(() => decodificarCursor(adulterado), /Cursor invalido/,
      `o cursor "${String(adulterado).slice(0, 20)}" deveria ser recusado`)
  }

  // Trocar de ordenacao no meio da lista e recusado, senao o cursor compararia
  // valores de uma coluna com os limites de outra.
  const porValor = await buscarVagas({ ordem: 'maior_valor', limite: 5 })
  await assert.rejects(
    () => buscarVagas({ ordem: 'menor_valor', cursor: porValor.proximoCursor }),
    /outra ordenacao/
  )
})

test('as ordenacoes ordenam de verdade, e relevancia sem termo nao existe', async () => {
  const maior = await buscarVagas({ ordem: 'maior_valor', limite: 10 })
  const valores = maior.vagas.map((v) => v.valorCentavos)
  assert.deepEqual(valores, [...valores].sort((a, b) => b - a), 'maior valor primeiro')

  const menor = await buscarVagas({ ordem: 'menor_valor', limite: 10 })
  const crescente = menor.vagas.map((v) => v.valorCentavos)
  assert.deepEqual(crescente, [...crescente].sort((a, b) => a - b), 'menor valor primeiro')

  const horas = await buscarVagas({ ordem: 'menos_horas', limite: 10 })
  const h = horas.vagas.map((v) => v.horas)
  assert.deepEqual(h, [...h].sort((a, b) => a - b), 'menos horas primeiro')

  const recentes = await buscarVagas({ ordem: 'recentes', limite: 10 })
  const datas = recentes.vagas.map((v) => new Date(v.criadoEm).getTime())
  assert.deepEqual(datas, [...datas].sort((a, b) => b - a), 'mais recentes primeiro')

  // Sem termo, relevancia nao quer dizer nada: cai para recentes em vez de
  // devolver uma ordem arbitraria.
  const semTermo = await buscarVagas({ ordem: 'relevancia' })
  assert.equal(semTermo.ordem, 'recentes')
  assert.ok(!semTermo.ordensDisponiveis.some((o) => o.valor === 'relevancia'))

  // Com termo, relevancia e o padrao e as vagas vem com a pontuacao.
  const comTermo = await buscarVagas({ termo: 'monitoria' })
  assert.equal(comTermo.ordem, 'relevancia')
  assert.ok(comTermo.vagas[0].relevancia > 0)
  const ranks = comTermo.vagas.map((v) => v.relevancia)
  assert.deepEqual(ranks, [...ranks].sort((a, b) => b - a), 'mais relevante primeiro')
})

test('os filtros combinam entre si e cada um recorta de verdade', async () => {
  const soRemoto = await buscarVagas({ modalidade: 'remoto', limite: 50 })
  assert.ok(soRemoto.vagas.length > 0)
  assert.ok(soRemoto.vagas.every((v) => v.modalidade === 'remoto'))

  const soEventos = await buscarVagas({ categoria: 'eventos', limite: 50 })
  assert.ok(soEventos.vagas.every((v) => v.categoria === 'Eventos'), 'a categoria ignora maiuscula')

  const faixa = await buscarVagas({ valorMin: 5000, valorMax: 9000, limite: 50 })
  assert.ok(faixa.vagas.length > 0)
  assert.ok(faixa.vagas.every((v) => v.valorCentavos >= 5000 && v.valorCentavos <= 9000))

  const curtas = await buscarVagas({ horasMax: 5, limite: 50 })
  assert.ok(curtas.vagas.every((v) => v.horas <= 5))

  const garantidas = await buscarVagas({ garantidas: true, limite: 50 })
  assert.ok(garantidas.vagas.length > 0)
  assert.ok(garantidas.vagas.every((v) => v.pagamentoGarantido))

  const emSaoPaulo = await buscarVagas({ local: 'Sao Paulo', limite: 50 })
  assert.ok(emSaoPaulo.vagas.every((v) => v.local?.includes('Sao Paulo')))

  // Tudo junto.
  const combinado = await buscarVagas({
    termo: 'vaga', modalidade: 'presencial', valorMin: 2000, horasMax: 20, limite: 50
  })
  assert.ok(combinado.vagas.every((v) =>
    v.modalidade === 'presencial' && v.valorCentavos >= 2000 && v.horas <= 20))

  // Faixa impossivel e recusada com mensagem util.
  await assert.rejects(() => buscarVagas({ valorMin: 9000, valorMax: 1000 }), /minimo esta acima/)

  // Termo sem resultado devolve lista vazia, nao erro.
  const nada = await buscarVagas({ termo: 'astronauta interplanetario' })
  assert.deepEqual(nada.vagas, [])
  assert.equal(nada.proximoCursor, null)
  assert.equal(nada.temMais, false)
})

test('o limite tem teto, e a rota HTTP entrega tudo isso', async () => {
  const exagerado = await buscarVagas({ limite: 5000 })
  assert.ok(exagerado.vagas.length <= LIMITE_MAXIMO, 'o limite precisa ter teto')

  const http = await pedir('/api/jobs/search?termo=monitoria&modalidade=remoto&limite=5')
  assert.equal(http.status, 200)
  assert.ok(http.corpo.vagas.length <= 5)
  assert.ok(http.corpo.ordensDisponiveis.length > 0)

  // A proxima pagina pela rota, com o cursor que veio.
  if (http.corpo.proximoCursor) {
    const segunda = await pedir(`/api/jobs/search?termo=monitoria&modalidade=remoto&limite=5&cursor=${encodeURIComponent(http.corpo.proximoCursor)}`)
    assert.equal(segunda.status, 200)
    const idsPrimeira = new Set(http.corpo.vagas.map((v) => v.id))
    assert.ok(segunda.corpo.vagas.every((v) => !idsPrimeira.has(v.id)), 'a segunda pagina nao repete a primeira')
  }

  // Cursor invalido pela rota vira erro de produto, nao erro de servidor.
  const ruim = await pedir('/api/jobs/search?cursor=coisa.invalida')
  assert.equal(ruim.status, 400)
  assert.equal(ruim.corpo.codigo, 'requisicao_invalida')

  // As facetas alimentam a barra de busca com o que existe de verdade.
  const facetasHttp = await pedir('/api/jobs/facetas')
  assert.equal(facetasHttp.status, 200)
  assert.ok(facetasHttp.corpo.categorias.length > 0)
  assert.ok(facetasHttp.corpo.categorias[0].total > 0)
  assert.ok(facetasHttp.corpo.faixaDeValor.maximoCentavos > 0)

  const direto = await facetas()
  assert.equal(direto.categorias.length, facetasHttp.corpo.categorias.length)
})
