// Anexos: portfolio do estudante, comprovante de entrega, foto de perfil.

import { query, one, many } from '../db/index.js'
import { newId } from '../lib/ids.js'
import { badRequest, forbidden, notFound, AppError } from '../lib/errors.js'
import {
  validarArquivo, novaChave, guardar, ler, apagar,
  conferirBilhete, assinarBilhete, LIMITES, TIPOS_ACEITOS
} from '../services/storage.js'
import { registrarAuditoria } from './audit.js'

export const TIPOS = ['avatar', 'portfolio', 'delivery', 'contract']

/** Quantos anexos cada pessoa pode ter, por tipo. */
const MAXIMOS = { avatar: 1, portfolio: 12, delivery: 8, contract: 4 }

export function publicAttachment (row) {
  if (!row) return null
  return {
    id: row.id,
    tipo: row.kind,
    nome: row.filename,
    formato: row.mime,
    tamanho: Number(row.bytes),
    url: `/api/uploads/${row.id}/conteudo`,
    ehImagem: String(row.mime).startsWith('image/'),
    vagaId: row.job_id ?? null,
    criadoEm: row.created_at
  }
}

/** Onde a tela pergunta o que pode enviar antes de abrir o seletor de arquivo. */
export function regrasDeEnvio () {
  return Object.fromEntries(TIPOS.map((tipo) => [tipo, {
    limiteBytes: LIMITES[tipo],
    limiteLegivel: `${Math.round(LIMITES[tipo] / 1024 / 1024)} MB`,
    formatos: TIPOS_ACEITOS[tipo],
    maximo: MAXIMOS[tipo]
  }]))
}

/**
 * Primeiro passo: pedir permissao para enviar.
 * O servidor confere quem e a pessoa e se ela ainda tem espaco, e devolve um
 * bilhete de validade curta. Sem isto, qualquer um poderia empurrar arquivo
 * para dentro so por saber o endereco.
 */
export async function pedirPermissao (usuario, { tipo, vagaId = null }) {
  if (!TIPOS.includes(tipo)) throw badRequest('Este tipo de anexo nao existe.', { campo: 'tipo' })

  if (tipo === 'delivery' || tipo === 'contract') {
    if (!vagaId) throw badRequest('Diga de qual vaga e este anexo.', { campo: 'vagaId' })
    const vaga = await one('select company_id, student_id from jobs where id = $1', [vagaId])
    if (!vaga) throw notFound('Nao encontramos essa vaga.')
    if (vaga.company_id !== usuario.id && vaga.student_id !== usuario.id) {
      throw forbidden('Esta vaga nao e sua.')
    }
  }

  // A foto de perfil e a unica que substitui em vez de acumular, entao o
  // limite de uma nao pode impedir a pessoa de trocar a propria foto.
  const jaTem = await one(
    'select count(*)::int as total from attachments where owner_id = $1 and kind = $2',
    [usuario.id, tipo]
  )
  if (tipo !== 'avatar' && jaTem.total >= MAXIMOS[tipo]) {
    throw badRequest(
      `Voce ja tem ${MAXIMOS[tipo]} ${tipo === 'avatar' ? 'foto' : 'arquivo(s)'} aqui. Apague um antes de enviar outro.`,
      { campo: 'tipo', maximo: MAXIMOS[tipo] }
    )
  }

  return {
    bilhete: assinarBilhete({ ownerId: usuario.id, kind: tipo, jobId: vagaId }),
    validoPorSegundos: 600,
    regras: regrasDeEnvio()[tipo]
  }
}

/**
 * Segundo passo: receber o arquivo.
 *
 * A validacao e pelos bytes. Um executavel renomeado para .png e recusado aqui,
 * porque o que decide e o conteudo, nao o nome.
 */
export async function receber ({ bilhete, buffer, nomeInformado, mimeInformado, ip = null }) {
  const permissao = conferirBilhete(bilhete)
  if (!permissao.ok) {
    throw new AppError(
      permissao.motivo === 'bilhete_vencido'
        ? 'O envio demorou demais. Tente de novo.'
        : 'Este envio nao foi autorizado.',
      { status: 403, codigo: permissao.motivo }
    )
  }

  const conferencia = validarArquivo({
    buffer, kind: permissao.kind, nomeInformado, mimeInformado
  })
  if (!conferencia.ok) {
    throw new AppError(conferencia.mensagem, {
      status: 400,
      codigo: conferencia.motivo,
      detalhes: conferencia.mimeDetectado ? { formatoRecebido: conferencia.mimeDetectado } : null
    })
  }

  const chave = novaChave({ ownerId: permissao.ownerId, kind: permissao.kind, mime: conferencia.mime })
  await guardar({ chave, buffer, mime: conferencia.mime })

  const id = newId('anx')
  const nomeLimpo = String(nomeInformado ?? 'arquivo')
    .replace(/[/\\]/g, '')
    .slice(0, 120) || 'arquivo'

  await query(
    `insert into attachments (id, owner_id, job_id, kind, filename, mime, bytes, storage_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, permissao.ownerId, permissao.jobId, permissao.kind, nomeLimpo,
      conferencia.mime, conferencia.bytes, chave]
  )

  // A foto de perfil substitui a anterior: so faz sentido ter uma.
  if (permissao.kind === 'avatar') {
    const antigas = await many(
      'select id, storage_key from attachments where owner_id = $1 and kind = $2 and id <> $3',
      [permissao.ownerId, 'avatar', id]
    )
    for (const antiga of antigas) {
      await apagar(antiga.storage_key)
      await query('delete from attachments where id = $1', [antiga.id])
    }
    await query('update users set avatar_key = $2 where id = $1', [permissao.ownerId, chave])
  }

  await registrarAuditoria({
    actorId: permissao.ownerId, action: 'anexo.enviado', entity: 'attachment', entityId: id,
    after: { tipo: permissao.kind, formato: conferencia.mime, bytes: conferencia.bytes, divergente: conferencia.divergente },
    ip
  })

  return publicAttachment(await one('select * from attachments where id = $1', [id]))
}

export async function conteudoDe (id, usuario = null) {
  const anexo = await one('select * from attachments where id = $1', [id])
  if (!anexo) throw notFound('Nao encontramos esse arquivo.')

  // Avatar e portfolio sao publicos: e o que a pessoa mostra. Comprovante de
  // entrega e contrato sao das partes da vaga.
  if (anexo.kind === 'delivery' || anexo.kind === 'contract') {
    const vaga = anexo.job_id
      ? await one('select company_id, student_id from jobs where id = $1', [anexo.job_id])
      : null
    const podeVer = usuario && (
      usuario.is_admin ||
      usuario.id === anexo.owner_id ||
      usuario.id === vaga?.company_id ||
      usuario.id === vaga?.student_id
    )
    if (!podeVer) throw forbidden('Este arquivo e das partes envolvidas na vaga.')
  }

  return { anexo, buffer: await ler(anexo.storage_key) }
}

export async function listarDe (ownerId, tipo = null) {
  const linhas = await many(
    `select * from attachments where owner_id = $1 ${tipo ? 'and kind = $2' : ''}
     order by created_at desc`,
    tipo ? [ownerId, tipo] : [ownerId]
  )
  return linhas.map(publicAttachment)
}

export async function listarDaVaga (jobId) {
  const linhas = await many(
    "select * from attachments where job_id = $1 and kind in ('delivery','contract') order by created_at desc",
    [jobId]
  )
  return linhas.map(publicAttachment)
}

export async function remover (usuario, id) {
  const anexo = await one('select * from attachments where id = $1', [id])
  if (!anexo) throw notFound('Nao encontramos esse arquivo.')
  if (anexo.owner_id !== usuario.id && !usuario.is_admin) {
    throw forbidden('Este arquivo nao e seu.')
  }
  await apagar(anexo.storage_key)
  await query('delete from attachments where id = $1', [id])
  if (anexo.kind === 'avatar') {
    await query('update users set avatar_key = null where id = $1', [anexo.owner_id])
  }
  await registrarAuditoria({
    actorId: usuario.id, action: 'anexo.removido', entity: 'attachment', entityId: id,
    before: { tipo: anexo.kind, nome: anexo.filename }
  })
  return { ok: true }
}
