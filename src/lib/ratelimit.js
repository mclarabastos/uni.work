// Rate limit em janela fixa, guardado no banco.
//
// No banco e nao em memoria por dois motivos: sobrevive a restart, e vale entre
// instancias. Um limite que zera quando o processo reinicia nao limita nada.
//
// Janela fixa e nao deslizante de proposito: e uma linha de SQL, o custo e um
// upsert, e a imprecisao de borda (ate o dobro do limite na virada) nao importa
// para o que estamos protegendo.

import { query } from '../db/index.js'
import { tooMany } from './errors.js'

/** Os limites do produto, em um lugar so. */
export const LIMITES = {
  magicLinkPorEmail: { limite: 5, janelaSegundos: 3600 },
  magicLinkPorIp: { limite: 10, janelaSegundos: 3600 },
  escrita: { limite: 30, janelaSegundos: 60 },
  leitura: { limite: 300, janelaSegundos: 60 },
  // Rotas que movem dinheiro sao mais raras e mais caras: limite proprio.
  dinheiro: { limite: 10, janelaSegundos: 60 }
}

function inicioDaJanela (janelaSegundos, agora = Date.now()) {
  const ms = janelaSegundos * 1000
  return new Date(Math.floor(agora / ms) * ms)
}

/**
 * Conta mais uma tentativa e diz se ainda cabe.
 * Nunca lanca por erro de banco: se o contador falhar, deixamos passar. Um
 * limite indisponivel nao pode virar uma recusa de servico para todo mundo.
 */
export async function consumir (bucket, { limite, janelaSegundos }) {
  const janela = inicioDaJanela(janelaSegundos)
  try {
    const { rows } = await query(
      `insert into rate_limits (bucket, window_at, hits) values ($1, $2, 1)
       on conflict (bucket, window_at) do update set hits = rate_limits.hits + 1
       returning hits`,
      [bucket, janela]
    )
    const usados = Number(rows[0].hits)
    return {
      permitido: usados <= limite,
      usados,
      restante: Math.max(0, limite - usados),
      resetEm: new Date(janela.getTime() + janelaSegundos * 1000)
    }
  } catch {
    return { permitido: true, usados: 0, restante: limite, resetEm: null, indisponivel: true }
  }
}

/** Igual a consumir, mas lanca o erro de produto quando estoura. */
export async function exigir (bucket, config, mensagem) {
  const resultado = await consumir(bucket, config)
  if (!resultado.permitido) {
    const segundos = resultado.resetEm ? Math.ceil((resultado.resetEm - Date.now()) / 1000) : 60
    const erro = tooMany(mensagem ?? `Muitas tentativas em pouco tempo. Tente de novo em ${
      segundos > 90 ? `${Math.ceil(segundos / 60)} minutos` : `${segundos} segundos`
    }.`)
    erro.detalhes = { tentarEm: resultado.resetEm?.toISOString() ?? null }
    throw erro
  }
  return resultado
}

/**
 * Middleware por metodo: leitura e escrita tem limites diferentes, e rota que
 * move dinheiro tem o seu.
 */
export function limitePorRequisicao () {
  return async function (req, res, next) {
    try {
      const identidade = req.user?.id ?? req.ip ?? 'desconhecido'
      const ehLeitura = req.method === 'GET' || req.method === 'HEAD'
      const moveDinheiro = /\/(fund|confirm|cancel|resolve)$/.test(req.path)

      const config = moveDinheiro ? LIMITES.dinheiro : ehLeitura ? LIMITES.leitura : LIMITES.escrita
      const prefixo = moveDinheiro ? 'dinheiro' : ehLeitura ? 'leitura' : 'escrita'

      const resultado = await consumir(`${prefixo}:${identidade}`, config)
      res.set('x-ratelimit-limit', String(config.limite))
      res.set('x-ratelimit-remaining', String(resultado.restante))
      if (resultado.resetEm) res.set('x-ratelimit-reset', String(Math.floor(resultado.resetEm.getTime() / 1000)))

      if (!resultado.permitido) {
        const segundos = Math.ceil((resultado.resetEm - Date.now()) / 1000)
        res.set('retry-after', String(segundos))
        return res.status(429).json({
          error: `Muitas ações em pouco tempo. Espere ${segundos} segundos e tente de novo.`,
          codigo: 'excesso_de_tentativas',
          detalhes: { tentarEm: resultado.resetEm.toISOString() }
        })
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}

/** Limpa janelas velhas. Chamado pelo worker, nao pelo caminho da requisicao. */
export async function limparJanelasAntigas () {
  const { rowCount } = await query(
    "delete from rate_limits where window_at < now() - interval '2 hours'"
  )
  return rowCount
}
