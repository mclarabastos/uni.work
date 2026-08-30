// Cadastro, sessao e resumo de conta.
//
// A conta de rede nasce junto com o cadastro, no mesmo passo, sem o usuario
// pedir e sem tela intermediaria. Do ponto de vista de quem se cadastra,
// aconteceu uma coisa so: criar uma conta.

import { z } from 'zod'
import { query, one, transaction } from '../db/index.js'
import { newId } from '../lib/ids.js'
import { AppError, conflict, notFound, unauthorized } from '../lib/errors.js'
import { createAccount } from '../services/wallet.js'
import { emitEvent } from './events.js'

export const ACCENTS = ['violeta', 'laranja', 'verde', 'azul', 'rosa']

export const signupSchema = z.object({
  nome: z.string().trim().min(2, 'Escreva seu nome completo.').max(80),
  email: z.string().trim().toLowerCase().email('Escreva um e-mail valido.'),
  perfil: z.enum(['student', 'company'], { errorMap: () => ({ message: 'Escolha estudante ou contratante.' }) }),
  universidade: z.string().trim().max(120).optional().nullable(),
  curso: z.string().trim().max(120).optional().nullable(),
  headline: z.string().trim().max(140).optional().nullable(),
  bio: z.string().trim().max(600).optional().nullable()
})

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Escreva um e-mail valido.')
})

function accentFor (id) {
  let sum = 0
  for (const ch of id) sum += ch.charCodeAt(0)
  return ACCENTS[sum % ACCENTS.length]
}

export function publicUser (row) {
  if (!row) return null
  return {
    id: row.id,
    nome: row.name,
    email: row.email,
    perfil: row.role,
    headline: row.headline ?? null,
    bio: row.bio ?? null,
    universidade: row.university ?? null,
    curso: row.course ?? null,
    cor: row.accent ?? 'violeta',
    emailVerificado: Boolean(row.verified_email),
    mediador: Boolean(row.is_admin),
    criadoEm: row.created_at
  }
}

/** Cria usuario e conta de rede na mesma transacao: um passo so, ou nenhum. */
export async function signup (input) {
  const data = signupSchema.parse(input)
  const existing = await one('select id from users where email = $1', [data.email])
  if (existing) {
    throw conflict('Ja existe uma conta com esse e-mail. Entre em vez de cadastrar.', 'email_ja_cadastrado')
  }

  const id = newId('usr')
  const account = await createAccount()

  await transaction(async (tx) => {
    await tx.query(
      `insert into users (id, role, name, email, headline, bio, university, course, accent)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, data.perfil, data.nome, data.email, data.headline ?? null, data.bio ?? null,
        data.universidade ?? null, data.curso ?? null, accentFor(id)]
    )
    await tx.query(
      'insert into accounts (user_id, public_key, secret_cipher) values ($1, $2, $3)',
      [id, account.publicKey, account.secretCipher]
    )
  })

  await emitEvent('conta.criada', { actorId: id, payload: { perfil: data.perfil } })
  const user = await one('select * from users where id = $1', [id])
  const session = await createSession(id)
  return { usuario: publicUser(user), sessao: session }
}

export async function login (input) {
  const data = loginSchema.parse(input)
  const user = await one('select * from users where email = $1', [data.email])
  if (!user) {
    throw notFound('Nao encontramos uma conta com esse e-mail.')
  }
  const session = await createSession(user.id)
  return { usuario: publicUser(user), sessao: session }
}

/**
 * Abre sessao. Delega para sessions.js, que e quem sabe sobre refresh e
 * revogacao. O import e dinamico porque sessions.js importa publicUser daqui:
 * carregar sob demanda quebra o ciclo sem precisar mover codigo de lugar.
 */
export async function createSession (userId, opcoes = {}) {
  const { abrirSessao } = await import('./sessions.js')
  return abrirSessao(userId, opcoes)
}

export async function logout (token) {
  if (!token) return
  await query('delete from sessions where token = $1', [token])
}

/**
 * Resolve o portador do token.
 * Devolve null para sessao inexistente, vencida ou revogada, e lanca para
 * conta suspensa: sao situacoes diferentes e merecem respostas diferentes.
 */
export async function userForToken (token) {
  if (!token) return null
  const row = await one(
    `select u.*, s.expires_at as session_expires, s.revoked_at as session_revoked
       from sessions s join users u on u.id = s.user_id
      where s.token = $1`,
    [token]
  )
  if (!row) return null

  // A suspensao e conferida antes da sessao, de proposito. Suspender uma conta
  // encerra as sessoes dela, e sem esta ordem a pessoa receberia "voce nao esta
  // logado" em vez de saber que a conta foi suspensa e por que procurar alguem.
  if (row.blocked_at) {
    throw new AppError('Esta conta esta suspensa. Fale com o suporte.', {
      status: 403, codigo: 'conta_suspensa'
    })
  }
  if (row.session_revoked) return null
  if (new Date(row.session_expires).getTime() < Date.now()) return null
  // Marcar uso serve para a pessoa reconhecer as proprias sessoes na lista.
  // Sem await de proposito: nao vale atrasar toda requisicao por causa disso.
  query('update sessions set last_used_at = now() where token = $1', [token]).catch(() => {})
  return row
}

export async function requireUser (token) {
  const user = await userForToken(token)
  if (!user) throw unauthorized()
  return user
}

/** Chave publica da conta de rede do usuario. Uso interno: nunca vai para a tela. */
export async function accountKeyFor (userId) {
  const row = await one('select public_key, secret_cipher from accounts where user_id = $1', [userId])
  if (!row) throw new AppError('Conta de rede ausente para este usuario.', { status: 500, codigo: 'conta_ausente' })
  return row
}

/**
 * Resumo que a tela inicial mostra.
 * Numeros de produto: quanto entrou, quanto esta reservado, quantas horas
 * certificadas. Nada aqui fala de rede.
 */
export async function accountSummary (user) {
  const isStudent = user.role === 'student'

  const [certs] = await query(
    'select count(*)::int as total, coalesce(sum(hours), 0)::float as horas from certificates where student_id = $1',
    [user.id]
  ).then((r) => r.rows)

  const jobsFilter = isStudent ? 'student_id' : 'company_id'
  const { rows: byStatus } = await query(
    `select status, count(*)::int as total from jobs where ${jobsFilter} = $1 group by status`,
    [user.id]
  )

  const { rows: money } = await query(
    isStudent
      ? `select coalesce(sum(amount_cents), 0)::bigint as recebido
           from jobs where student_id = $1 and status = 'concluida'`
      : `select coalesce(sum(amount_cents), 0)::bigint as recebido
           from jobs where company_id = $1 and status = 'concluida'`,
    [user.id]
  )

  const { rows: reserved } = await query(
    `select coalesce(sum(amount_cents), 0)::bigint as reservado
       from jobs where ${jobsFilter} = $1 and status in ('garantida','aceita','em_andamento','entregue')`,
    [user.id]
  )

  const { rows: rating } = await query(
    'select coalesce(avg(rating), 0)::float as media, count(*)::int as total from reviews where target_id = $1',
    [user.id]
  )

  return {
    usuario: publicUser(user),
    certificados: { total: certs?.total ?? 0, horas: Number(certs?.horas ?? 0) },
    vagasPorStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.total])),
    valores: {
      movimentadoCentavos: Number(money[0]?.recebido ?? 0),
      reservadoCentavos: Number(reserved[0]?.reservado ?? 0)
    },
    avaliacao: { media: Number(rating[0]?.media ?? 0), total: rating[0]?.total ?? 0 }
  }
}
