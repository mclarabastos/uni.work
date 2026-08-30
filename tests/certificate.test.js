import './helpers.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalize, contentHash, buildContent, buildMetadata, renderSvg } from '../src/services/certificate.js'

const base = {
  code: 'UNI-7K2M-9QX4',
  title: 'Staff de credenciamento no congresso',
  hours: 12,
  studentName: 'Marina Alves',
  issuerName: 'Produtora XPTO',
  category: 'Eventos',
  modality: 'presencial',
  completedAt: '2026-08-20T15:00:00.000Z'
}

test('o hash do certificado e canonico: mesma informacao, mesmo hash, em qualquer ordem', () => {
  // Duas maquinas diferentes precisam chegar no mesmo byte, senao o hash nao
  // serve para verificar nada.
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(contentHash({ b: 1, a: 2 }), contentHash({ a: 2, b: 1 }))
  assert.equal(contentHash({ x: [1, { c: 3, b: 2 }] }), contentHash({ x: [1, { b: 2, c: 3 }] }))

  // Campos indefinidos nao entram no hash, entao acrescentar um campo vazio
  // depois nao invalida um certificado ja emitido.
  assert.equal(contentHash({ a: 1 }), contentHash({ a: 1, extra: undefined }))

  const conteudo = buildContent(base)
  const hash = contentHash(conteudo)
  assert.match(hash, /^[0-9a-f]{64}$/)

  // Reconstruir o mesmo conteudo devolve o mesmo hash: e assim que a
  // verificacao publica confere que nada mudou.
  assert.equal(contentHash(buildContent(base)), hash)

  // Qualquer alteracao no conteudo muda o hash.
  assert.notEqual(contentHash(buildContent({ ...base, hours: 13 })), hash)
  assert.notEqual(contentHash(buildContent({ ...base, studentName: 'Outra Pessoa' })), hash)
  assert.notEqual(contentHash(buildContent({ ...base, title: 'Outra atividade' })), hash)
})

test('os metadados e o cartao carregam os dados da atividade e nada de jargao', () => {
  const conteudo = buildContent(base)
  const hash = contentHash(conteudo)
  const metadados = buildMetadata({ content: conteudo, hash, code: base.code })

  // O nome cabe no limite de 32 caracteres do padrao de metadados.
  assert.ok(metadados.name.length <= 32, `nome tem ${metadados.name.length} caracteres`)

  // O hash e o conteudo integral viajam junto: quem le os metadados consegue
  // recalcular o hash sozinho, sem consultar a nossa API.
  assert.equal(metadados.properties.uniwork.hash, hash)
  assert.deepEqual(metadados.properties.uniwork.conteudo, conteudo)
  assert.equal(contentHash(metadados.properties.uniwork.conteudo), hash)

  // Os atributos descrevem a atividade em portugues.
  const atributos = Object.fromEntries(metadados.attributes.map((a) => [a.trait_type, a.value]))
  assert.equal(atributos['Carga horaria'], '12h')
  assert.equal(atributos.Contratante, 'Produtora XPTO')
  assert.equal(atributos.Codigo, base.code)
  assert.equal(atributos.Hash, hash)

  // A URI dos metadados nao pode apontar para localhost: um indexador externo
  // precisa conseguir alcancar esse endereco.
  assert.ok(!metadados.image.includes('localhost'), 'a imagem nao pode apontar para localhost')
  assert.ok(!metadados.external_url.includes('localhost'))
  assert.ok(metadados.external_url.endsWith(`/verificar/${base.code}`))

  const svg = renderSvg({ content: conteudo, hash, code: base.code })
  assert.ok(svg.startsWith('<svg'), 'o cartao precisa ser um SVG valido')
  assert.ok(svg.includes('Marina Alves'))
  assert.ok(svg.includes('12h'))
  assert.ok(svg.includes(base.code))
  assert.ok(svg.includes('20/08/2026'), 'a data aparece no formato brasileiro')

  // O cartao e mostrado ao usuario, entao ele tambem segue a regra de vocabulario.
  const proibidas = ['wallet', 'blockchain', 'chave privada', 'assinar transacao']
  for (const palavra of proibidas) {
    assert.ok(!svg.toLowerCase().includes(palavra), `o cartao nao pode conter "${palavra}"`)
  }

  // Escapa conteudo perigoso em vez de injetar no SVG.
  const comAspas = renderSvg({
    content: buildContent({ ...base, studentName: 'Ana <script>alert(1)</script>' }),
    hash, code: base.code
  })
  assert.ok(!comAspas.includes('<script>'), 'o conteudo precisa ser escapado')
  assert.ok(comAspas.includes('&lt;script&gt;'))
})
