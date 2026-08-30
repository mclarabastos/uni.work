// Paginacao por cursor.
//
// Por que nao offset: com offset, uma vaga publicada enquanto a pessoa rola a
// lista empurra tudo para baixo, e a pagina 2 repete o ultimo item da pagina 1.
// Pior, "limit 20 offset 10000" faz o banco varrer e descartar dez mil linhas.
//
// O cursor guarda os valores de ordenacao da ultima linha entregue. A proxima
// pagina pergunta "o que vem depois disto", que o indice responde direto.
//
// Toda ordenacao termina em id, para a ordem ser total: dois registros com o
// mesmo instante de criacao precisam ter uma ordem definida entre si, senao o
// cursor pula ou repete linha.

import crypto from 'node:crypto'
import { config } from '../config.js'
import { badRequest } from './errors.js'

/**
 * O cursor e assinado. Nao porque o conteudo seja secreto, mas porque ele
 * entra direto na clausula where: um cursor adulterado seria uma forma de
 * injetar valor de comparacao arbitrario.
 */
export function codificarCursor (valores) {
  const corpo = Buffer.from(JSON.stringify(valores)).toString('base64url')
  const assinatura = crypto
    .createHmac('sha256', config.security.masterKey)
    .update(corpo)
    .digest('base64url')
    .slice(0, 16)
  return `${corpo}.${assinatura}`
}

export function decodificarCursor (cursor) {
  if (!cursor) return null
  const [corpo, assinatura] = String(cursor).split('.')
  if (!corpo || !assinatura) throw badRequest('Cursor invalido.', { campo: 'cursor' })

  const esperada = crypto
    .createHmac('sha256', config.security.masterKey)
    .update(corpo)
    .digest('base64url')
    .slice(0, 16)
  if (assinatura !== esperada) throw badRequest('Cursor invalido.', { campo: 'cursor' })

  try {
    return JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'))
  } catch {
    throw badRequest('Cursor invalido.', { campo: 'cursor' })
  }
}

export const LIMITE_PADRAO = 20
export const LIMITE_MAXIMO = 100

export function normalizarLimite (valor) {
  const n = Number.parseInt(valor ?? '', 10)
  if (!Number.isFinite(n) || n <= 0) return LIMITE_PADRAO
  return Math.min(n, LIMITE_MAXIMO)
}

/**
 * Monta a resposta paginada.
 * Pede-se uma linha a mais do que o limite; se ela vier, sabemos que ha proxima
 * pagina sem precisar de um count separado, que seria a consulta mais cara da
 * tela.
 */
export function montarPagina (linhas, limite, extrairCursor) {
  const temMais = linhas.length > limite
  const pagina = temMais ? linhas.slice(0, limite) : linhas
  return {
    itens: pagina,
    proximoCursor: temMais && pagina.length ? codificarCursor(extrairCursor(pagina[pagina.length - 1])) : null,
    temMais
  }
}
