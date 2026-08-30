// Verificacao publica do certificado. Sem conta, sem sessao, sem nada.
// Um terceiro precisa conseguir conferir, senao o certificado nao serve.

import { Router } from 'express'
import { one } from '../db/index.js'
import { notFound } from '../lib/errors.js'
import { renderSvg, contentHash, certificateLinks } from '../services/certificate.js'
import { confirmCertificate, indexerAvailable } from '../services/das.js'
import { asyncRoute } from './helpers.js'
import { config } from '../config.js'

export const certificatesRouter = Router()

async function loadCertificate (code) {
  const row = await one(
    `select c.*, u.name as student_name, a.public_key as student_key,
            j.category, j.modality, j.completed_at
       from certificates c
       join users u on u.id = c.student_id
       left join accounts a on a.user_id = c.student_id
       join jobs j on j.id = c.job_id
      where upper(c.code) = upper($1)`,
    [code]
  )
  if (!row) throw notFound('Nao encontramos um certificado com esse codigo.')
  return row
}

function metadataOf (row) {
  return typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
}

/**
 * Verificacao publica.
 * A confirmacao independente vem do indexador, nao do nosso banco: se ela
 * nao estiver disponivel, a resposta diz isso em vez de fingir que confirmou.
 */
certificatesRouter.get('/verify/:code', asyncRoute(async (req, res) => {
  const row = await loadCertificate(req.params.code)
  const metadata = metadataOf(row)
  const content = metadata.properties?.uniwork?.conteudo ?? null

  const recalculated = content ? contentHash(content) : null
  const integro = recalculated === row.content_hash

  const independente = await confirmCertificate({
    assetId: row.asset_id,
    expectedOwner: row.student_key,
    expectedUri: `${config.publicBaseUrl}/api/certificates/${row.code}/metadata.json`
  })

  res.json({
    valido: integro,
    certificado: {
      codigo: row.code,
      atividade: row.title,
      horas: Number(row.hours),
      estudante: row.student_name,
      contratante: row.issuer_name,
      categoria: row.category,
      modalidade: row.modality,
      emitidoEm: row.issued_at,
      hash: row.content_hash
    },
    integridade: {
      confere: integro,
      explicacao: integro
        ? 'O conteudo deste certificado e exatamente o que foi registrado na emissao.'
        : 'O conteudo nao bate com o registro original.'
    },
    confirmacaoIndependente: {
      disponivel: indexerAvailable(),
      ...independente
    },
    links: certificateLinks({ code: row.code, signature: row.signature, assetId: row.asset_id })
  })
}))

/**
 * Metadados. Imutaveis por contrato: servimos o JSON exato gravado na emissao,
 * nunca remontado. Se remontassemos, uma mudanca de codigo mudaria o passado.
 */
certificatesRouter.get('/certificates/:code/metadata.json', asyncRoute(async (req, res) => {
  const row = await loadCertificate(req.params.code)
  res.set('cache-control', 'public, max-age=31536000, immutable')
  res.type('application/json').send(JSON.stringify(metadataOf(row), null, 2))
}))

certificatesRouter.get('/certificates/:code/image.svg', asyncRoute(async (req, res) => {
  const row = await loadCertificate(req.params.code)
  const metadata = metadataOf(row)
  const content = metadata.properties?.uniwork?.conteudo
  res.set('cache-control', 'public, max-age=31536000, immutable')
  res.type('image/svg+xml').send(renderSvg({ content, hash: row.content_hash, code: row.code }))
}))
