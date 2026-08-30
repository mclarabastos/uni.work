// Utilidades compartilhadas pelas rotas: autenticacao, wrapper de async e
// traducao de erro para o formato { error, codigo, detalhes }.

import { ZodError } from 'zod'
import { AppError, unauthorized } from '../lib/errors.js'
import { userForToken } from '../domain/auth.js'
import { log, contextoAtual } from '../lib/logger.js'

export function bearerToken (req) {
  const header = req.get('authorization') ?? ''
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  return null
}

/** Anexa req.user quando ha sessao valida. Nao exige nada. */
export async function attachUser (req, _res, next) {
  try {
    req.token = bearerToken(req)
    req.user = req.token ? await userForToken(req.token) : null
    next()
  } catch (err) {
    next(err)
  }
}

/** Exige sessao. */
export function requireAuth (req, _res, next) {
  if (!req.user) return next(unauthorized())
  next()
}

/** Envolve handler async para que rejeicao vire next(err) em vez de travar. */
export function asyncRoute (handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
}

/** Traduz ZodError para detalhes por campo, em portugues. */
function zodDetails (err) {
  return err.issues.map((issue) => ({
    campo: issue.path.join('.') || '(corpo)',
    mensagem: issue.message
  }))
}

export function errorHandler (err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Confira os campos destacados.',
      codigo: 'campos_invalidos',
      detalhes: zodDetails(err)
    })
  }
  if (err instanceof AppError) {
    if (err.technicalDetail) {
      log.warn('falha_traduzida', { codigo: err.codigo, detalhe: err.technicalDetail, rota: req.path })
    }
    return res.status(err.status).json(err.toJSON())
  }

  log.error('erro_nao_tratado', {
    rota: req.path,
    detalhe: err?.message,
    pilha: err?.stack?.split('\n').slice(0, 4).join(' | ')
  })

  // O usuario nunca le o erro cru. Nem quando o erro cru veio da rede.
  // O requestId vai junto: e o que liga a queixa dele a linha do log.
  return res.status(500).json({
    error: 'Nao conseguimos concluir agora, ja estamos tentando de novo.',
    codigo: 'tentando_novamente',
    detalhes: contextoAtual().requestId ? { referencia: contextoAtual().requestId } : null
  })
}
