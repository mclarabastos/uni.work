// Cabecalhos de seguranca.
//
// Escritos a mao, e nao com helmet, por um motivo concreto: a CSP deste produto
// precisa ser exata, e uma CSP herdada de configuracao padrao costuma ser
// permissiva demais ou quebrar a pagina em silencio. Aqui da para ler o que
// cada diretiva permite e por que.

import { config } from '../config.js'

/**
 * A interface nao tem build, entao o CSS e o JavaScript de estrutura moram no
 * proprio HTML. Isso obriga 'unsafe-inline' no style-src. Nao no script-src: o
 * unico script e /app.js, servido do mesmo lugar.
 */
function politicaDeConteudo () {
  const diretivas = [
    "default-src 'self'",
    // Script so do proprio dominio. Sem inline, sem eval, sem CDN.
    "script-src 'self'",
    // O estilo mora no HTML, entao inline aqui e necessario. As fontes vem do
    // Google Fonts, que e a unica origem externa do produto.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    // Imagens de certificado sao SVG servido por nos; data: cobre placeholders.
    "img-src 'self' data: blob:",
    // A tela fala com a propria API e com o SSE. Nada mais.
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "worker-src 'self'",
    "manifest-src 'self'"
  ]
  if (config.isProduction) diretivas.push('upgrade-insecure-requests')
  return diretivas.join('; ')
}

export function cabecalhosDeSeguranca () {
  const csp = politicaDeConteudo()

  return function (req, res, next) {
    // O navegador nao adivinha tipo de conteudo. Vale principalmente para os
    // arquivos que usuarios enviam.
    res.set('x-content-type-options', 'nosniff')
    res.set('x-frame-options', 'DENY')
    res.set('referrer-policy', 'strict-origin-when-cross-origin')
    res.set('cross-origin-opener-policy', 'same-origin')
    res.set('cross-origin-resource-policy', 'same-origin')
    // Nenhuma tela precisa de camera, microfone, localizacao ou pagamento do
    // navegador. Negar por padrao evita que uma dependencia futura peca.
    res.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
    res.set('content-security-policy', csp)

    // HSTS so faz sentido sob https, e prometer https em ambiente local
    // trancaria o navegador do desenvolvedor fora do proprio localhost.
    if (config.isProduction) {
      res.set('strict-transport-security', 'max-age=31536000; includeSubDomains')
    }

    // A verificacao publica do certificado e feita para ser incorporada em
    // outro lugar; o resto do produto, nao.
    if (req.path.startsWith('/api/verify/') || req.path.startsWith('/api/certificates/')) {
      res.set('cross-origin-resource-policy', 'cross-origin')
      res.set('access-control-allow-origin', '*')
    }
    next()
  }
}

/**
 * Idempotencia nas rotas que movem dinheiro.
 *
 * Com o cabecalho Idempotency-Key, a mesma chave devolve a mesma resposta por
 * 24 horas em vez de executar de novo. E o que impede o duplo clique, o retry
 * automatico do cliente e a reconexao de rede de virarem dois pagamentos.
 */
export function idempotencia () {
  return async function (req, res, next) {
    const chave = req.get('idempotency-key')
    if (!chave || !['POST', 'PUT', 'PATCH'].includes(req.method)) return next()
    if (chave.length < 8 || chave.length > 200) {
      return res.status(400).json({
        error: 'A chave de idempotência precisa ter entre 8 e 200 caracteres.',
        codigo: 'chave_invalida',
        detalhes: null
      })
    }

    const crypto = await import('node:crypto')
    const { query, one } = await import('../db/index.js')
    const hashDoPedido = crypto
      .createHash('sha256')
      .update(`${req.method} ${req.originalUrl} ${JSON.stringify(req.body ?? {})}`)
      .digest('hex')

    const guardada = await one('select * from idempotency_keys where key = $1 and expires_at > now()', [chave])

    if (guardada) {
      // A mesma chave com corpo diferente e erro de quem chamou, nao repeticao.
      if (guardada.request_hash !== hashDoPedido) {
        return res.status(409).json({
          error: 'Esta chave já foi usada para outra operação.',
          codigo: 'chave_reutilizada',
          detalhes: null
        })
      }
      if (guardada.completed_at) {
        res.set('idempotent-replay', 'true')
        return res.status(guardada.status_code).json(
          typeof guardada.response === 'string' ? JSON.parse(guardada.response) : guardada.response
        )
      }
      // Existe mas nao terminou: a primeira ainda esta rodando.
      return res.status(409).json({
        error: 'Esta operação ainda está sendo processada. Aguarde um instante.',
        codigo: 'em_processamento',
        detalhes: null
      })
    }

    try {
      await query(
        `insert into idempotency_keys (key, user_id, route, request_hash, expires_at)
         values ($1, $2, $3, $4, now() + interval '24 hours')`,
        [chave, req.user?.id ?? null, req.originalUrl, hashDoPedido]
      )
    } catch {
      // Outra requisicao inseriu no mesmo instante.
      return res.status(409).json({
        error: 'Esta operação ainda está sendo processada. Aguarde um instante.',
        codigo: 'em_processamento',
        detalhes: null
      })
    }

    // Grava a resposta quando ela sair, para a proxima chamada com a mesma
    // chave devolver exatamente isto.
    const jsonOriginal = res.json.bind(res)
    res.json = (corpo) => {
      query(
        'update idempotency_keys set status_code = $2, response = $3, completed_at = now() where key = $1',
        [chave, res.statusCode, JSON.stringify(corpo)]
      ).catch(() => {})
      return jsonOriginal(corpo)
    }
    next()
  }
}
