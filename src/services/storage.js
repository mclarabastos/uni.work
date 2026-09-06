// Armazenamento de arquivo.
//
// Dois drivers:
//   local  grava em .uniwork/uploads. Padrao, e suficiente para demonstracao.
//   s3     qualquer servico compativel com S3 (Supabase Storage, R2, MinIO).
//
// O que NAO muda entre eles: o tipo do arquivo e decidido lendo os primeiros
// bytes, nunca a extensao do nome. Extensao e sugestao de quem enviou; bytes
// sao o que o arquivo e.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { config, rootDir } from '../config.js'

export const LIMITES = {
  avatar: 2 * 1024 * 1024,      // 2 MB
  portfolio: 10 * 1024 * 1024,  // 10 MB
  delivery: 25 * 1024 * 1024,   // 25 MB
  contract: 10 * 1024 * 1024
}

/**
 * Assinaturas de arquivo (magic numbers).
 * Cada entrada diz: nestes bytes, a partir deste deslocamento, este e o tipo.
 */
const ASSINATURAS = [
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], extra: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: 'video/mp4', offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }
]

/** O que cada tipo de anexo aceita. Lista fechada. */
export const TIPOS_ACEITOS = {
  avatar: ['image/jpeg', 'image/png', 'image/webp'],
  portfolio: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'],
  delivery: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/zip', 'video/mp4'],
  contract: ['application/pdf']
}

/**
 * Descobre o tipo lendo os bytes.
 * Devolve null quando nao reconhece: o que nao esta na lista nao entra.
 */
export function detectarMime (buffer) {
  for (const assinatura of ASSINATURAS) {
    const inicio = assinatura.offset ?? 0
    const esperado = Buffer.from(assinatura.bytes)
    if (buffer.length < inicio + esperado.length) continue
    if (!buffer.subarray(inicio, inicio + esperado.length).equals(esperado)) continue

    if (assinatura.extra) {
      const extraEsperado = Buffer.from(assinatura.extra.bytes)
      const fim = assinatura.extra.offset + extraEsperado.length
      if (buffer.length < fim) continue
      if (!buffer.subarray(assinatura.extra.offset, fim).equals(extraEsperado)) continue
    }
    return assinatura.mime
  }
  return null
}

/**
 * Confere o arquivo inteiro: tamanho, tipo real e coerencia com o que foi dito.
 * Devolve { ok, mime, motivo } e nunca lanca, para quem chama montar a resposta.
 */
export function validarArquivo ({ buffer, kind, nomeInformado = '', mimeInformado = '' }) {
  const limite = LIMITES[kind]
  const aceitos = TIPOS_ACEITOS[kind]
  if (!limite || !aceitos) {
    return { ok: false, motivo: 'tipo_de_anexo_desconhecido', mensagem: 'Este tipo de anexo não existe.' }
  }
  if (!buffer?.length) {
    return { ok: false, motivo: 'arquivo_vazio', mensagem: 'O arquivo chegou vazio.' }
  }
  if (buffer.length > limite) {
    return {
      ok: false,
      motivo: 'arquivo_grande_demais',
      mensagem: `O arquivo passa do limite de ${Math.round(limite / 1024 / 1024)} MB.`
    }
  }

  const mimeReal = detectarMime(buffer)
  if (!mimeReal) {
    return {
      ok: false,
      motivo: 'formato_nao_reconhecido',
      mensagem: 'Não reconhecemos este formato de arquivo. Envie imagem, PDF ou vídeo.'
    }
  }
  if (!aceitos.includes(mimeReal)) {
    return {
      ok: false,
      motivo: 'formato_nao_aceito',
      mensagem: `Este espaco aceita ${aceitos.map(nomeAmigavel).join(', ')}.`,
      mimeDetectado: mimeReal
    }
  }

  // A extensao e o content-type informados nao decidem nada, mas divergir do
  // conteudo real e sinal de algo errado e vale registrar.
  const divergente = Boolean(mimeInformado) && mimeInformado !== mimeReal

  return { ok: true, mime: mimeReal, bytes: buffer.length, divergente, nomeInformado }
}

function nomeAmigavel (mime) {
  return {
    'image/jpeg': 'JPG', 'image/png': 'PNG', 'image/webp': 'WEBP', 'image/gif': 'GIF',
    'application/pdf': 'PDF', 'application/zip': 'ZIP', 'video/mp4': 'MP4'
  }[mime] ?? mime
}

export function extensaoDe (mime) {
  return {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'application/pdf': 'pdf', 'application/zip': 'zip', 'video/mp4': 'mp4'
  }[mime] ?? 'bin'
}

// ─── drivers ─────────────────────────────────────────────────────────────────

export function driverDeArmazenamento () {
  return process.env.S3_BUCKET ? 's3' : 'local'
}

const DIR_LOCAL = path.resolve(rootDir, process.env.UPLOADS_DIR || '.uniwork/uploads')

/** A chave inclui o dono, o que facilita apagar tudo de alguem por pedido. */
export function novaChave ({ ownerId, kind, mime }) {
  const aleatorio = crypto.randomBytes(12).toString('hex')
  return `${kind}/${ownerId}/${Date.now()}-${aleatorio}.${extensaoDe(mime)}`
}

async function gravarLocal (chave, buffer) {
  const destino = path.join(DIR_LOCAL, chave)
  await fsp.mkdir(path.dirname(destino), { recursive: true })
  await fsp.writeFile(destino, buffer)
  return { chave, bytes: buffer.length }
}

async function lerLocal (chave) {
  const destino = path.join(DIR_LOCAL, chave)
  // Sem isto, uma chave com ".." leria qualquer arquivo do disco.
  if (!path.resolve(destino).startsWith(path.resolve(DIR_LOCAL))) {
    throw new Error('chave fora do diretório de uploads')
  }
  return fsp.readFile(destino)
}

async function apagarLocal (chave) {
  const destino = path.join(DIR_LOCAL, chave)
  if (!path.resolve(destino).startsWith(path.resolve(DIR_LOCAL))) return false
  try {
    await fsp.unlink(destino)
    return true
  } catch {
    return false
  }
}

async function s3 () {
  const { S3Client } = await import('@aws-sdk/client-s3')
  return new S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: Boolean(process.env.S3_ENDPOINT),
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
    }
  })
}

export async function guardar ({ chave, buffer, mime }) {
  if (driverDeArmazenamento() === 's3') {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3')
    const cliente = await s3()
    await cliente.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: chave,
      Body: buffer,
      ContentType: mime,
      // Nunca deixar o navegador adivinhar o tipo de um arquivo que veio de fora.
      ContentDisposition: mime.startsWith('image/') ? 'inline' : 'attachment'
    }))
    return { chave, bytes: buffer.length }
  }
  return gravarLocal(chave, buffer)
}

export async function ler (chave) {
  if (driverDeArmazenamento() === 's3') {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3')
    const cliente = await s3()
    const saida = await cliente.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: chave }))
    return Buffer.from(await saida.Body.transformToByteArray())
  }
  return lerLocal(chave)
}

export async function apagar (chave) {
  if (driverDeArmazenamento() === 's3') {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3')
    const cliente = await s3()
    await cliente.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: chave }))
    return true
  }
  return apagarLocal(chave)
}

// ─── permissao de envio ──────────────────────────────────────────────────────

/**
 * Bilhete de envio assinado.
 *
 * A tela pede um bilhete dizendo o que quer enviar, o servidor devolve um
 * assinado com validade curta, e o envio vem com ele. Assim o limite de tamanho
 * e de tipo e decidido antes de o arquivo comecar a subir, e o mesmo bilhete
 * nao serve para enviar outra coisa depois.
 *
 * No driver s3 este mesmo bilhete vira uma URL pre-assinada, e o arquivo nem
 * passa pelo nosso servidor.
 */
export function assinarBilhete ({ ownerId, kind, jobId = null, validadeSegundos = 600 }) {
  const conteudo = {
    ownerId,
    kind,
    jobId,
    expira: Math.floor(Date.now() / 1000) + validadeSegundos
  }
  const corpo = Buffer.from(JSON.stringify(conteudo)).toString('base64url')
  const assinatura = crypto
    .createHmac('sha256', config.security.masterKey)
    .update(corpo)
    .digest('base64url')
  return `${corpo}.${assinatura}`
}

export function conferirBilhete (bilhete) {
  const [corpo, assinatura] = String(bilhete ?? '').split('.')
  if (!corpo || !assinatura) return { ok: false, motivo: 'bilhete_invalido' }

  const esperada = crypto
    .createHmac('sha256', config.security.masterKey)
    .update(corpo)
    .digest('base64url')

  const a = Buffer.from(assinatura)
  const b = Buffer.from(esperada)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, motivo: 'assinatura_invalida' }
  }

  let conteudo
  try {
    conteudo = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, motivo: 'bilhete_invalido' }
  }
  if (conteudo.expira < Math.floor(Date.now() / 1000)) {
    return { ok: false, motivo: 'bilhete_vencido' }
  }
  return { ok: true, ...conteudo }
}

export function armazenamentoPronto () {
  if (driverDeArmazenamento() === 's3') {
    return Boolean(process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY)
  }
  try {
    fs.mkdirSync(DIR_LOCAL, { recursive: true })
    return true
  } catch {
    return false
  }
}

export { DIR_LOCAL }
