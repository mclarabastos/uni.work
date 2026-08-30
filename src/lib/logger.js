// Log estruturado.
//
// Uma linha de JSON por evento, sempre com o mesmo formato, sempre com o
// requestId de quem originou. Assim da para responder "o que aconteceu com
// aquela requisicao" filtrando por um campo, em vez de procurar texto solto.
//
// A regra que nao se negocia: nunca logar segredo, chave ou conteudo de
// mensagem. A limpeza abaixo e por chave e nao por valor, porque depender de
// reconhecer o formato de um segredo e depender de sorte.

import { AsyncLocalStorage } from 'node:async_hooks'
import crypto from 'node:crypto'
import { config } from '../config.js'

const contexto = new AsyncLocalStorage()

const NIVEIS = { debug: 10, info: 20, warn: 30, error: 40 }
const NIVEL_MINIMO = NIVEIS[process.env.LOG_LEVEL] ?? (config.isTest ? NIVEIS.error : NIVEIS.info)

/** Chaves cujo valor nunca sai daqui, nem truncado. */
const PROIBIDAS = [
  'secret', 'segredo', 'password', 'senha', 'token', 'refresh',
  'authorization', 'cookie', 'mnemonic', 'seed', 'cipher', 'vapid',
  'master', 'credential', 'assinatura', 'signature_secret',
  'body', 'corpo', 'mensagem', 'message', 'texto', 'detail_text'
]

/**
 * Qualquer chave terminada em "key" e tratada como segredo, com uma lista
 * curta de excecoes conhecidas.
 *
 * A regra e por sufixo e nao por nome completo porque a lista de nomes nunca
 * fica pronta: WALLET_MASTER_KEY passou batido numa primeira versao deste
 * arquivo justamente porque nao estava enumerada.
 */
const CHAVES_PUBLICAS = new Set([
  'publickey', 'public_key', 'idempotencykey', 'idempotency_key',
  'dedupekey', 'dedupe_key', 'storagekey', 'storage_key', 'chave_publica'
])

function ehProibida (chave) {
  const k = String(chave).toLowerCase()
  if (CHAVES_PUBLICAS.has(k)) return false
  if (k.endsWith('key') || k.endsWith('_key') || k.endsWith('chave')) return true
  return PROIBIDAS.some((p) => k.includes(p))
}

export function limpar (valor, profundidade = 0) {
  if (profundidade > 4) return '[fundo demais]'
  if (valor === null || valor === undefined) return valor
  if (typeof valor === 'bigint') return valor.toString()
  if (typeof valor !== 'object') {
    return typeof valor === 'string' && valor.length > 500 ? `${valor.slice(0, 500)}…` : valor
  }
  if (Array.isArray(valor)) return valor.slice(0, 20).map((v) => limpar(v, profundidade + 1))

  const saida = {}
  for (const [chave, v] of Object.entries(valor)) {
    saida[chave] = ehProibida(chave) ? '[removido]' : limpar(v, profundidade + 1)
  }
  return saida
}

function escrever (nivel, msg, dados = {}) {
  if (NIVEIS[nivel] < NIVEL_MINIMO) return
  const atual = contexto.getStore() ?? {}
  const linha = {
    t: new Date().toISOString(),
    level: nivel,
    msg,
    requestId: atual.requestId,
    userId: atual.userId,
    jobId: dados.jobId ?? atual.jobId,
    ...limpar(dados)
  }
  for (const chave of Object.keys(linha)) {
    if (linha[chave] === undefined) delete linha[chave]
  }
  const texto = JSON.stringify(linha)
  if (nivel === 'error') process.stderr.write(`${texto}\n`)
  else process.stdout.write(`${texto}\n`)
}

export const log = {
  debug: (msg, dados) => escrever('debug', msg, dados),
  info: (msg, dados) => escrever('info', msg, dados),
  warn: (msg, dados) => escrever('warn', msg, dados),
  error: (msg, dados) => escrever('error', msg, dados)
}

/** Roda fn com um contexto de log proprio. */
export function comContexto (valores, fn) {
  const anterior = contexto.getStore() ?? {}
  return contexto.run({ ...anterior, ...valores }, fn)
}

export function contextoAtual () {
  return contexto.getStore() ?? {}
}

/** Acrescenta informacao ao contexto ja aberto, sem criar outro. */
export function anotar (valores) {
  const atual = contexto.getStore()
  if (atual) Object.assign(atual, valores)
}

// ─── contadores ──────────────────────────────────────────────────────────────
// Numeros que interessam operacionalmente e que nao valem uma consulta ao banco
// a cada leitura: quantas transacoes sairam, quantas confirmaram, quanto
// demoraram. Zeram quando o processo reinicia, e tudo bem: sao para observar o
// agora, nao para relatorio.

const contadores = new Map()
const duracoes = new Map()

export function contar (nome, quanto = 1) {
  contadores.set(nome, (contadores.get(nome) ?? 0) + quanto)
}

export function registrarDuracao (nome, ms) {
  const atual = duracoes.get(nome) ?? { total: 0, n: 0, max: 0 }
  atual.total += ms
  atual.n += 1
  atual.max = Math.max(atual.max, ms)
  duracoes.set(nome, atual)
}

export function lerContadores () {
  return {
    contagens: Object.fromEntries(contadores),
    duracoes: Object.fromEntries(
      [...duracoes].map(([nome, d]) => [nome, {
        media: Math.round(d.total / d.n),
        maximo: Math.round(d.max),
        amostras: d.n
      }])
    )
  }
}

export function zerarContadores () {
  contadores.clear()
  duracoes.clear()
}

// ─── middleware ──────────────────────────────────────────────────────────────

/**
 * Abre um contexto por requisicao e registra o resultado.
 * O requestId volta no cabecalho: quando alguem relata um problema, o id da
 * resposta liga a queixa a linha exata do log.
 */
export function logDeRequisicao () {
  return function (req, res, next) {
    const requestId = req.get('x-request-id') || crypto.randomBytes(8).toString('hex')
    const inicio = process.hrtime.bigint()
    res.set('x-request-id', requestId)

    comContexto({ requestId }, () => {
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - inicio) / 1e6
        const rota = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path

        contar(`http.${res.statusCode >= 500 ? '5xx' : res.statusCode >= 400 ? '4xx' : 'ok'}`)
        registrarDuracao('http', ms)

        const nivel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'
        escrever(nivel, 'requisicao', {
          metodo: req.method,
          rota,
          status: res.statusCode,
          ms: Math.round(ms * 10) / 10,
          // O ip entra porque e operacionalmente util; o corpo, nunca.
          ip: req.ip,
          userId: req.user?.id
        })
      })
      next()
    })
  }
}
