// Verificacao da fase 7: o arquivo e julgado pelos bytes, nunca pela extensao.
//
// A extensao e uma sugestao de quem enviou. Um executavel renomeado para .png
// continua sendo um executavel, e um .txt com um PNG dentro continua sendo um
// PNG. So o conteudo diz a verdade.

import { fakePlatform, prepararBanco } from './helpers.js'
import { FakeConnection } from './fake-connection.js'
import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createApp } from '../src/server.js'
import { closeDb, query, one } from '../src/db/index.js'
import { setConnection } from '../src/services/solana.js'
import { detectarMime, validarArquivo, LIMITES, DIR_LOCAL } from '../src/services/storage.js'

fakePlatform()

let servidor
let base

before(async () => {
  await prepararBanco()
  setConnection(new FakeConnection())
  servidor = createApp().listen(0)
  await new Promise((r) => servidor.once('listening', r))
  base = `http://127.0.0.1:${servidor.address().port}`
})

after(async () => {
  servidor?.close()
  await closeDb()
  // A suite nao deixa lixo em disco.
  fs.rmSync(DIR_LOCAL, { recursive: true, force: true })
})

beforeEach(async () => { await query('delete from rate_limits') })

async function pedir (caminho, { method = 'GET', body, token, headers = {}, cru = false } = {}) {
  const cabecalhos = { ...headers }
  if (body !== undefined && !cru) cabecalhos['content-type'] = 'application/json'
  if (token) cabecalhos.authorization = `Bearer ${token}`
  const resposta = await fetch(base + caminho, {
    method,
    headers: cabecalhos,
    body: body === undefined ? undefined : (cru ? body : JSON.stringify(body))
  })
  const texto = await resposta.text()
  let corpo = null
  try { corpo = texto ? JSON.parse(texto) : null } catch { corpo = texto }
  return { status: resposta.status, corpo, bruto: texto }
}

let contador = 0
async function conta (perfil = 'student') {
  contador += 1
  const email = `pessoa${contador}.${Date.now()}@usp.br`
  const out = await pedir('/api/signup', {
    method: 'POST', body: { nome: `Pessoa ${contador}`, email, perfil }
  })
  return out.corpo
}

// ─── arquivos de mentira, com os bytes de verdade ────────────────────────────

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(200, 7)
])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 3)])
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 32)])
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100, 0)])
// Um executavel do Windows. O byte de entrada e "MZ".
const EXECUTAVEL = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300, 0x90)])
const TEXTO = Buffer.from('isto aqui e só um texto comum, sem assinatura de formato nenhum')

test('o tipo do arquivo sai dos bytes, e nada mais', () => {
  assert.equal(detectarMime(PNG), 'image/png')
  assert.equal(detectarMime(JPEG), 'image/jpeg')
  assert.equal(detectarMime(PDF), 'application/pdf')
  assert.equal(detectarMime(ZIP), 'application/zip')

  // O que nao tem assinatura conhecida nao vira nada.
  assert.equal(detectarMime(EXECUTAVEL), null)
  assert.equal(detectarMime(TEXTO), null)
  assert.equal(detectarMime(Buffer.alloc(0)), null)
  assert.equal(detectarMime(Buffer.from([0x89])), null, 'assinatura truncada não conta')

  // WEBP precisa dos dois pedacos: RIFF no inicio e WEBP no deslocamento 8.
  const riffFalso = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI '), Buffer.alloc(50)])
  assert.notEqual(detectarMime(riffFalso), 'image/webp', 'RIFF sozinho não e WEBP')
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(50)])
  assert.equal(detectarMime(webp), 'image/webp')
})

test('renomear a extensão não engana ninguém', () => {
  // Um executavel chamado de foto, com content-type de foto. Tudo mente, menos
  // os bytes.
  const disfarcado = validarArquivo({
    buffer: EXECUTAVEL,
    kind: 'avatar',
    nomeInformado: 'minha-foto.png',
    mimeInformado: 'image/png'
  })
  assert.equal(disfarcado.ok, false)
  assert.equal(disfarcado.motivo, 'formato_nao_reconhecido')
  assert.match(disfarcado.mensagem, /formato/i)

  // Um PDF de verdade, mas mandado para o espaco de foto de perfil.
  const lugarErrado = validarArquivo({
    buffer: PDF, kind: 'avatar', nomeInformado: 'documento.png', mimeInformado: 'image/png'
  })
  assert.equal(lugarErrado.ok, false)
  assert.equal(lugarErrado.motivo, 'formato_nao_aceito')
  assert.equal(lugarErrado.mimeDetectado, 'application/pdf')
  assert.match(lugarErrado.mensagem, /JPG|PNG|WEBP/)

  // Um PNG de verdade chamado de .txt passa: o nome nao importa.
  const nomeErradoMasValido = validarArquivo({
    buffer: PNG, kind: 'avatar', nomeInformado: 'sem-extensao.txt', mimeInformado: 'text/plain'
  })
  assert.equal(nomeErradoMasValido.ok, true)
  assert.equal(nomeErradoMasValido.mime, 'image/png')
  assert.equal(nomeErradoMasValido.divergente, true, 'a divergencia e registrada, mesmo aceitando')

  // Tamanho.
  const gigante = validarArquivo({
    buffer: Buffer.concat([PNG, Buffer.alloc(LIMITES.avatar)]), kind: 'avatar'
  })
  assert.equal(gigante.ok, false)
  assert.equal(gigante.motivo, 'arquivo_grande_demais')
  assert.match(gigante.mensagem, /MB/)

  assert.equal(validarArquivo({ buffer: Buffer.alloc(0), kind: 'avatar' }).motivo, 'arquivo_vazio')
})

test('o envio pela API recusa o arquivo disfarcado, e aceita o legitimo', async () => {
  const estudante = await conta()
  const token = estudante.sessao.token

  // 1. Pedir permissao devolve um bilhete e as regras.
  const permissao = await pedir('/api/uploads', {
    method: 'POST', token, body: { tipo: 'portfolio' }
  })
  assert.equal(permissao.status, 200)
  assert.ok(permissao.corpo.bilhete)
  assert.ok(permissao.corpo.regras.limiteBytes > 0)
  assert.ok(permissao.corpo.regras.formatos.includes('image/png'))

  // 2. Enviar um executavel disfarcado de PNG: recusado pelos bytes.
  const disfarcado = await pedir(`/api/uploads/${permissao.corpo.bilhete}`, {
    method: 'PUT', cru: true, body: EXECUTAVEL,
    headers: { 'content-type': 'image/png', 'x-nome-do-arquivo': 'foto.png' }
  })
  assert.equal(disfarcado.status, 400)
  assert.equal(disfarcado.corpo.codigo, 'formato_nao_reconhecido')

  // Nada foi gravado.
  assert.equal((await one('select count(*)::int as n from attachments')).n, 0)

  // 3. O mesmo bilhete ainda vale para o arquivo certo.
  const legitimo = await pedir(`/api/uploads/${permissao.corpo.bilhete}`, {
    method: 'PUT', cru: true, body: PNG,
    headers: { 'content-type': 'image/png', 'x-nome-do-arquivo': 'trabalho.png' }
  })
  assert.equal(legitimo.status, 201)
  assert.equal(legitimo.corpo.anexo.formato, 'image/png')
  assert.equal(legitimo.corpo.anexo.tipo, 'portfolio')
  assert.equal(legitimo.corpo.anexo.ehImagem, true)

  // 4. O conteudo volta com o tipo certo e sem deixar o navegador adivinhar.
  const conteudo = await fetch(base + legitimo.corpo.anexo.url)
  assert.equal(conteudo.status, 200)
  assert.equal(conteudo.headers.get('content-type'), 'image/png')
  assert.equal(conteudo.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(Buffer.from(await conteudo.arrayBuffer()).length, PNG.length)

  // 5. A divergencia entre o que foi dito e o que era ficou na auditoria.
  const auditoria = await one(
    "select * from audit_log where action = 'anexo.enviado' order by created_at desc limit 1"
  )
  assert.ok(auditoria)
  const depois = typeof auditoria.after === 'string' ? JSON.parse(auditoria.after) : auditoria.after
  assert.equal(depois.formato, 'image/png')
})

test('sem bilhete valido não entra arquivo nenhum', async () => {
  const inventado = await pedir('/api/uploads/bilhete.inventado', {
    method: 'PUT', cru: true, body: PNG, headers: { 'content-type': 'image/png' }
  })
  assert.equal(inventado.status, 403)

  // Bilhete com a assinatura mexida.
  const estudante = await conta()
  const permissao = await pedir('/api/uploads', {
    method: 'POST', token: estudante.sessao.token, body: { tipo: 'portfolio' }
  })
  const [corpo] = permissao.corpo.bilhete.split('.')
  const adulterado = `${corpo}.assinaturafalsa`
  const comFalsa = await pedir(`/api/uploads/${adulterado}`, {
    method: 'PUT', cru: true, body: PNG, headers: { 'content-type': 'image/png' }
  })
  assert.equal(comFalsa.status, 403)
  assert.equal(comFalsa.corpo.codigo, 'assinatura_invalida')

  // Pedir permissao sem sessao.
  const semSessao = await pedir('/api/uploads', { method: 'POST', body: { tipo: 'portfolio' } })
  assert.equal(semSessao.status, 401)

  // Tipo de anexo que nao existe.
  const tipoInvalido = await pedir('/api/uploads', {
    method: 'POST', token: estudante.sessao.token, body: { tipo: 'qualquer_coisa' }
  })
  assert.equal(tipoInvalido.status, 400)
})

test('comprovante de entrega e das partes da vaga, e de mais ninguém', async () => {
  const estudante = await conta()
  const contratante = await conta('company')
  const intruso = await conta()

  const { vaga } = (await pedir('/api/jobs', {
    method: 'POST', token: contratante.sessao.token,
    body: {
      titulo: 'Tradução de artigo científico',
      descricao: 'Traduzir um artigo de quatro mil palavras do português para o inglês.',
      categoria: 'Tradução', modalidade: 'remoto', valorCentavos: 45000, horas: 10
    }
  })).corpo

  // Um estranho nao consegue nem pedir permissao para anexar nessa vaga.
  const deFora = await pedir('/api/uploads', {
    method: 'POST', token: intruso.sessao.token, body: { tipo: 'delivery', vagaId: vaga.id }
  })
  assert.equal(deFora.status, 403)

  // O contratante precisa dizer de qual vaga e o comprovante.
  const semVaga = await pedir('/api/uploads', {
    method: 'POST', token: contratante.sessao.token, body: { tipo: 'delivery' }
  })
  assert.equal(semVaga.status, 400)
  assert.equal(semVaga.corpo.detalhes.campo, 'vagaId')

  // O contratante anexa um contrato.
  const permissao = await pedir('/api/uploads', {
    method: 'POST', token: contratante.sessao.token, body: { tipo: 'contract', vagaId: vaga.id }
  })
  assert.equal(permissao.status, 200)
  const enviado = await pedir(`/api/uploads/${permissao.corpo.bilhete}`, {
    method: 'PUT', cru: true, body: PDF,
    headers: { 'content-type': 'application/pdf', 'x-nome-do-arquivo': 'contrato.pdf' }
  })
  assert.equal(enviado.status, 201)
  assert.equal(enviado.corpo.anexo.formato, 'application/pdf')

  const url = enviado.corpo.anexo.url

  // Sem sessao: recusado.
  assert.equal((await fetch(base + url)).status, 403)

  // Um estranho logado: recusado.
  const comoIntruso = await fetch(base + url, {
    headers: { authorization: `Bearer ${intruso.sessao.token}` }
  })
  assert.equal(comoIntruso.status, 403)

  // O dono: liberado, e vem como anexo, nao inline.
  const comoDono = await fetch(base + url, {
    headers: { authorization: `Bearer ${contratante.sessao.token}` }
  })
  assert.equal(comoDono.status, 200)
  assert.match(comoDono.headers.get('content-disposition'), /^attachment/)

  // Um estranho tambem nao apaga.
  const apagando = await pedir(`/api/uploads/${enviado.corpo.anexo.id}`, {
    method: 'DELETE', token: intruso.sessao.token
  })
  assert.equal(apagando.status, 403)

  // O dono apaga, e o arquivo some do disco tambem.
  const removido = await pedir(`/api/uploads/${enviado.corpo.anexo.id}`, {
    method: 'DELETE', token: contratante.sessao.token
  })
  assert.equal(removido.status, 200)
  assert.equal(
    (await one('select count(*)::int as n from attachments where owner_id = $1', [contratante.usuario.id])).n,
    0
  )

  const chave = path.join(DIR_LOCAL, 'contract', contratante.usuario.id)
  const restou = fs.existsSync(chave) ? fs.readdirSync(chave) : []
  assert.deepEqual(restou, [], 'apagar do banco precisa apagar do disco')
})

test('a foto de perfil substitui a anterior em vez de acumular', async () => {
  const estudante = await conta()
  const token = estudante.sessao.token

  const enviarFoto = async (buffer, tipoInformado) => {
    const p = await pedir('/api/uploads', { method: 'POST', token, body: { tipo: 'avatar' } })
    assert.equal(p.status, 200, JSON.stringify(p.corpo))
    return pedir(`/api/uploads/${p.corpo.bilhete}`, {
      method: 'PUT', cru: true, body: buffer,
      headers: { 'content-type': tipoInformado, 'x-nome-do-arquivo': 'perfil' }
    })
  }

  const primeira = await enviarFoto(PNG, 'image/png')
  assert.equal(primeira.status, 201)

  const segunda = await enviarFoto(JPEG, 'image/jpeg')
  assert.equal(segunda.status, 201)

  const quantas = await one(
    "select count(*)::int as n from attachments where owner_id = $1 and kind = 'avatar'",
    [estudante.usuario.id]
  )
  assert.equal(quantas.n, 1, 'só pode existir uma foto de perfil')

  // E a que ficou e a nova.
  const atual = await one(
    "select mime from attachments where owner_id = $1 and kind = 'avatar'", [estudante.usuario.id]
  )
  assert.equal(atual.mime, 'image/jpeg')

  // A foto aparece no perfil publico, sem precisar de conta.
  const perfil = await pedir(`/api/perfis/${estudante.usuario.id}`)
  assert.equal(perfil.status, 200)
  assert.ok(perfil.corpo.perfil.foto, 'o perfil público precisa apontar para a foto')

  const imagem = await fetch(base + perfil.corpo.perfil.foto)
  assert.equal(imagem.status, 200)
})

test('o perfil público do estudante mostra horas, certificados e avaliações', async () => {
  const estudante = await conta()
  const contratante = await conta('company')

  // O perfil abre sem conta nenhuma: e a pagina que a pessoa manda por link.
  const vazio = await pedir(`/api/perfis/${estudante.usuario.id}`)
  assert.equal(vazio.status, 200)
  assert.equal(vazio.corpo.perfil.perfil, 'student')
  assert.equal(vazio.corpo.perfil.horasCertificadas, 0)
  assert.deepEqual(vazio.corpo.perfil.certificados, [])
  assert.equal(vazio.corpo.perfil.avaliacao.total, 0)

  // Editar o proprio perfil.
  const atualizado = await pedir('/api/me/perfil', {
    method: 'PUT', token: estudante.sessao.token,
    body: {
      headline: 'Design de produto e pesquisa com usuário',
      bio: 'Estudo design na USP e trabalho com pesquisa qualitativa.',
      habilidades: ['Figma', 'Pesquisa', 'Prototipagem'],
      links: [{ rotulo: 'Portfolio', url: 'https://exemplo.com.br/marina' }]
    }
  })
  assert.equal(atualizado.status, 200)
  assert.deepEqual(atualizado.corpo.perfil.habilidades, ['Figma', 'Pesquisa', 'Prototipagem'])
  assert.equal(atualizado.corpo.perfil.links[0].rotulo, 'Portfolio')

  // Link invalido e recusado com mensagem util.
  const linkRuim = await pedir('/api/me/perfil', {
    method: 'PUT', token: estudante.sessao.token,
    body: { links: [{ rotulo: 'Site', url: 'nao-e-um-endereco' }] }
  })
  assert.equal(linkRuim.status, 400)
  assert.match(linkRuim.corpo.detalhes[0].mensagem, /https/)

  // O perfil do contratante mostra a reputacao dele, nao a do estudante.
  const doContratante = await pedir(`/api/perfis/${contratante.usuario.id}`)
  assert.equal(doContratante.corpo.perfil.perfil, 'company')
  assert.equal(doContratante.corpo.perfil.vagasPublicadas, 0)
  assert.equal(doContratante.corpo.perfil.taxaDeConfirmacao, null, 'sem entregas ainda, não há taxa')
  assert.ok(Array.isArray(doContratante.corpo.vagas))

  // Perfil que nao existe.
  assert.equal((await pedir('/api/perfis/usr_nao_existe')).status, 404)

  // Conta suspensa some do perfil publico.
  await query('update users set blocked_at = now() where id = $1', [estudante.usuario.id])
  assert.equal((await pedir(`/api/perfis/${estudante.usuario.id}`)).status, 404)
})
