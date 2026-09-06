// Autenticacao de verdade: magic link, sessao com refresh e revogacao.
//
// Como funciona, do inicio ao fim:
//
//   1. a pessoa pede um link informando o e-mail
//   2. gravamos um token de uso unico, com prazo curto, e mandamos por e-mail
//   3. ela abre o link; trocamos o token por um par (acesso + refresh)
//   4. o token de login e queimado na hora, dentro da transacao
//   5. o acesso vence rapido; o refresh renova sem novo e-mail
//   6. revogar mata a sessao dos dois lados
//
// Duas decisoes que valem explicar:
//
// O token de login viaja na URL, entao guardamos o hash dele e nao o valor.
// Se alguem ler o banco, nao consegue entrar com o que encontrou la.
//
// Pedir link para um e-mail que nao existe devolve a MESMA resposta que pedir
// para um que existe. Caso contrario a rota vira um verificador de quem tem
// conta na plataforma.

import crypto from 'node:crypto'
import { z } from 'zod'
import { query, one, transaction } from '../db/index.js'
import { newToken } from '../lib/ids.js'
import { config } from '../config.js'
import { AppError, badRequest, notFound, unauthorized } from '../lib/errors.js'
import { exigir, LIMITES } from '../lib/ratelimit.js'
import { enviarEmail, modeloMagicLink, emailConfigurado } from '../services/mailer.js'
import { publicUser } from './auth.js'
import { emitEvent } from './events.js'

/** Prazos. Curto para o link, moderado para o acesso, longo para o refresh. */
export const MINUTOS_DO_LINK = 15
export const HORAS_DO_ACESSO = 12
export const DIAS_DO_REFRESH = 30

export const magicLinkSchema = z.object({
  email: z.string().trim().toLowerCase().email('Escreva um e-mail valido.'),
  redirecionarPara: z.string().trim().max(300).optional().nullable()
})

export const verificarSchema = z.object({
  token: z.string().trim().min(20, 'Este link não parece completo.').max(200)
})

export const refreshSchema = z.object({
  refresh: z.string().trim().min(20).max(200)
})

/** O que gravamos e o hash; o que viaja no e-mail e o valor. */
function hashDoToken (valor) {
  return crypto.createHash('sha256').update(valor).digest('hex')
}

function linkDeAcesso (token, redirecionarPara) {
  const url = new URL('/entrar', config.publicBaseUrl)
  url.searchParams.set('token', token)
  if (redirecionarPara) url.searchParams.set('para', redirecionarPara)
  return url.toString()
}

/**
 * Envia o link. A resposta e sempre a mesma, exista a conta ou nao.
 * O unico caso em que ela muda e quando o proprio envio nao esta configurado:
 * ai ela diz isso, porque fingir entrega seria mock silencioso.
 */
export async function pedirMagicLink (input, { ip = null } = {}) {
  const dados = magicLinkSchema.parse(input)

  await exigir(`magic:email:${dados.email}`, LIMITES.magicLinkPorEmail,
    'Você já pediu vários links para este e-mail. Espere uma hora e tente de novo.')
  if (ip) {
    await exigir(`magic:ip:${ip}`, LIMITES.magicLinkPorIp,
      'Muitos pedidos de link deste dispositivo. Espere uma hora e tente de novo.')
  }

  const usuario = await one('select id, name, email, blocked_at from users where email = $1', [dados.email])

  // A resposta e montada ANTES de saber se a conta existe, e o estado do envio
  // e uma propriedade do ambiente, nao da conta. Se so o caminho "a conta
  // existe" contasse que o e-mail nao esta configurado, a diferenca entre as
  // duas respostas viraria um verificador de quem tem conta aqui.
  const configurado = emailConfigurado()
  const resposta = configurado
    ? {
        ok: true,
        mensagem: `Se existir uma conta com ${dados.email}, o link de acesso chegou na caixa de entrada.`,
        expiraEmMinutos: MINUTOS_DO_LINK,
        entregaConfigurada: true,
        entregue: true
      }
    : {
        ok: true,
        mensagem: 'O envio de e-mail não está configurado neste ambiente. O link está no terminal do servidor.',
        expiraEmMinutos: MINUTOS_DO_LINK,
        entregaConfigurada: false,
        entregue: false,
        motivo: 'email_nao_configurado'
      }

  // Conta bloqueada: mesma resposta, nenhum link. O bloqueio nao se anuncia.
  if (!usuario || usuario.blocked_at) return resposta

  const token = newToken(32)
  const expiraEm = new Date(Date.now() + MINUTOS_DO_LINK * 60_000)

  await query(
    'insert into login_tokens (token, email, expires_at, ip) values ($1, $2, $3, $4)',
    [hashDoToken(token), dados.email, expiraEm, ip]
  )

  const link = linkDeAcesso(token, dados.redirecionarPara)
  const modelo = modeloMagicLink({ nome: usuario.name?.split(' ')[0], link, minutos: MINUTOS_DO_LINK })
  const envio = await enviarEmail({ para: dados.email, ...modelo })

  if (!envio.entregue) {
    resposta.entregue = false
    resposta.motivo = envio.motivo
    // Falha de envio com o servico configurado e diferente de servico ausente:
    // a primeira e transitoria e vale pedir de novo.
    if (envio.motivo !== 'email_nao_configurado') {
      resposta.mensagem = 'Não conseguimos enviar o e-mail agora. Tente de novo em alguns instantes.'
    }
  }

  // Fora de producao o link volta na resposta, para o desenvolvimento nao
  // depender de caixa de e-mail. Isto revela que a conta existe, e por isso
  // so acontece fora de producao.
  if (!config.isProduction) resposta.linkParaDesenvolvimento = link

  return resposta
}

/** Cria o par acesso + refresh. */
async function abrirSessao (userId, { ip = null, userAgent = null, executor = null } = {}) {
  const acesso = newToken(32)
  const refresh = newToken(32)
  const agora = Date.now()
  const rodar = executor
    ? (sql, params) => executor.query(sql, params)
    : (sql, params) => query(sql, params)

  await rodar(
    `insert into sessions (token, user_id, expires_at, refresh_token, refresh_expires_at, ip, user_agent, last_used_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())`,
    [
      acesso, userId,
      new Date(agora + HORAS_DO_ACESSO * 3600_000),
      refresh,
      new Date(agora + DIAS_DO_REFRESH * 86400_000),
      ip, userAgent?.slice(0, 300) ?? null
    ]
  )

  return {
    token: acesso,
    refresh,
    expiraEm: new Date(agora + HORAS_DO_ACESSO * 3600_000).toISOString(),
    refreshExpiraEm: new Date(agora + DIAS_DO_REFRESH * 86400_000).toISOString()
  }
}

/**
 * Troca o token do link por uma sessao.
 * A queima do token e a criacao da sessao acontecem na mesma transacao, e a
 * queima e condicional: se duas requisicoes chegarem com o mesmo token, so uma
 * atualiza a linha, e a outra nao cria sessao nenhuma.
 */
export async function verificarMagicLink (input, { ip = null, userAgent = null } = {}) {
  const dados = verificarSchema.parse(input)
  const hash = hashDoToken(dados.token)

  const registro = await one('select token, email, expires_at, used_at from login_tokens where token = $1', [hash])
  if (!registro) {
    throw new AppError('Este link não vale mais. Peca um novo para entrar.', {
      status: 400, codigo: 'link_invalido'
    })
  }
  if (registro.used_at) {
    throw new AppError('Este link já foi usado. Peca um novo para entrar.', {
      status: 400, codigo: 'link_ja_usado'
    })
  }
  if (new Date(registro.expires_at).getTime() < Date.now()) {
    throw new AppError('Este link venceu. Peca um novo para entrar.', {
      status: 400, codigo: 'link_vencido'
    })
  }

  const usuario = await one('select * from users where email = $1', [registro.email])
  if (!usuario) throw notFound('Não encontramos uma conta com esse e-mail.')
  if (usuario.blocked_at) {
    throw new AppError('Esta conta está suspensa. Fale com o suporte.', { status: 403, codigo: 'conta_suspensa' })
  }

  const sessao = await transaction(async (tx) => {
    const queimou = await tx.query(
      'update login_tokens set used_at = now() where token = $1 and used_at is null returning token',
      [hash]
    )
    if (queimou.rowCount === 0) {
      // Outra requisicao chegou primeiro com o mesmo token.
      throw new AppError('Este link já foi usado. Peca um novo para entrar.', {
        status: 400, codigo: 'link_ja_usado'
      })
    }
    // Entrar pelo link prova que o e-mail e da pessoa.
    await tx.query('update users set verified_email = true where id = $1', [usuario.id])
    return abrirSessao(usuario.id, { ip, userAgent, executor: tx })
  })

  await emitEvent('conta.entrou', { actorId: usuario.id, payload: { via: 'magic_link' } })
  return { usuario: publicUser({ ...usuario, verified_email: true }), sessao }
}

/**
 * Renova a sessao pelo refresh.
 * O refresh e rotacionado a cada uso: o valor antigo para de funcionar na hora.
 * Assim um refresh vazado tem validade curta na pratica, e o uso do valor
 * antigo depois da rotacao e detectavel.
 */
export async function renovarSessao (input, { ip = null } = {}) {
  const dados = refreshSchema.parse(input)

  const sessao = await one(
    `select s.*, u.blocked_at from sessions s join users u on u.id = s.user_id
      where s.refresh_token = $1`,
    [dados.refresh]
  )
  if (!sessao) throw unauthorized('Sua sessão expirou. Entre de novo.')
  if (sessao.revoked_at) throw unauthorized('Esta sessão foi encerrada. Entre de novo.')
  if (sessao.blocked_at) {
    throw new AppError('Esta conta está suspensa. Fale com o suporte.', { status: 403, codigo: 'conta_suspensa' })
  }
  if (new Date(sessao.refresh_expires_at).getTime() < Date.now()) {
    await query('delete from sessions where token = $1', [sessao.token])
    throw unauthorized('Sua sessão expirou. Entre de novo.')
  }

  const novoAcesso = newToken(32)
  const novoRefresh = newToken(32)
  const agora = Date.now()

  const atualizou = await query(
    `update sessions
        set token = $1, refresh_token = $2,
            expires_at = $3, refresh_expires_at = $4,
            last_used_at = now(), ip = coalesce($5, ip)
      where token = $6 and refresh_token = $7 and revoked_at is null
      returning token`,
    [
      novoAcesso, novoRefresh,
      new Date(agora + HORAS_DO_ACESSO * 3600_000),
      new Date(agora + DIAS_DO_REFRESH * 86400_000),
      ip, sessao.token, dados.refresh
    ]
  )
  if (atualizou.rowCount === 0) throw unauthorized('Sua sessão expirou. Entre de novo.')

  return {
    token: novoAcesso,
    refresh: novoRefresh,
    expiraEm: new Date(agora + HORAS_DO_ACESSO * 3600_000).toISOString(),
    refreshExpiraEm: new Date(agora + DIAS_DO_REFRESH * 86400_000).toISOString()
  }
}

/** Sessoes abertas da conta, para a pessoa ver e encerrar o que nao reconhece. */
export async function listarSessoes (userId, tokenAtual = null) {
  const linhas = await query(
    `select token, ip, user_agent, created_at, last_used_at, expires_at
       from sessions
      where user_id = $1 and revoked_at is null and refresh_expires_at > now()
      order by last_used_at desc nulls last, created_at desc`,
    [userId]
  )
  return linhas.rows.map((s) => ({
    // Nunca devolvemos o token inteiro: um id curto basta para revogar.
    id: s.token.slice(0, 12),
    atual: tokenAtual ? s.token === tokenAtual : false,
    dispositivo: descreverDispositivo(s.user_agent),
    ip: s.ip,
    criadaEm: s.created_at,
    ultimoUso: s.last_used_at
  }))
}

function descreverDispositivo (userAgent) {
  if (!userAgent) return 'Dispositivo desconhecido'
  const ua = userAgent.toLowerCase()
  const sistema = ua.includes('windows') ? 'Windows'
    : ua.includes('android') ? 'Android'
      : ua.includes('iphone') || ua.includes('ipad') ? 'iOS'
        : ua.includes('mac os') ? 'macOS'
          : ua.includes('linux') ? 'Linux' : 'Sistema desconhecido'
  const navegador = ua.includes('edg/') ? 'Edge'
    : ua.includes('chrome') ? 'Chrome'
      : ua.includes('firefox') ? 'Firefox'
        : ua.includes('safari') ? 'Safari' : 'Navegador desconhecido'
  return `${navegador} em ${sistema}`
}

/** Revoga uma sessao pelo id curto. */
export async function revogarSessao (userId, idCurto) {
  if (!idCurto || idCurto.length < 8) throw badRequest('Sessão inválida.')
  const { rowCount } = await query(
    `update sessions set revoked_at = now()
      where user_id = $1 and revoked_at is null and left(token, 12) = $2`,
    [userId, idCurto.slice(0, 12)]
  )
  if (rowCount === 0) throw notFound('Não encontramos essa sessão.')
  return { ok: true, encerradas: rowCount }
}

/** Encerra todas as outras sessoes. O botao de "perdi meu celular". */
export async function revogarOutrasSessoes (userId, tokenAtual) {
  const { rowCount } = await query(
    'update sessions set revoked_at = now() where user_id = $1 and token <> $2 and revoked_at is null',
    [userId, tokenAtual ?? '']
  )
  return { ok: true, encerradas: rowCount }
}

/** Faxina de tokens vencidos e sessoes mortas. Chamada pelo worker. */
export async function limparSessoesVencidas () {
  const tokens = await query("delete from login_tokens where expires_at < now() - interval '1 day'")
  const sessoes = await query(
    "delete from sessions where refresh_expires_at < now() or (revoked_at is not null and revoked_at < now() - interval '7 days')"
  )
  return { tokens: tokens.rowCount, sessoes: sessoes.rowCount }
}

export { abrirSessao }
