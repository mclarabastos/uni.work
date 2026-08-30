// Cadastro, sessao e resumo de conta.
//
// A conta de rede nasce junto com o cadastro, no mesmo passo, sem o usuario
// pedir e sem tela intermediaria. Do ponto de vista de quem se cadastra,
// aconteceu uma coisa so: criar uma conta.

import { z } from 'zod'
import { query, one, transaction } from '../db/index.js'
import { newId, newToken } from '../lib/ids.js'
import { config } from '../config.js'
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

export async function createSession (userId, ttlHours = config.security.sessionTtlHours) {
  const token = newToken()
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000)
  await query('insert into sessions (token, user_id, expires_at) values ($1, $2, $3)', [token, userId, expiresAt])
  return { token, expiraEm: expiresAt.toISOString() }
}

export async function logout (token) {
  if (!token) return
  await query('delete from sessions where token = $1', [token])
}

/** Resolve o portador do token. Sessao vencida e apagada na hora. */
export async function userForToken (token) {
  if (!token) return null
  const row = await one(
    `select u.*, s.expires_at as session_expires
       from sessions s join users u on u.id = s.user_id
      where s.token = $1`,
    [token]
  )
  if (!row) return null
  if (new Date(row.session_expires).getTime() < Date.now()) {
    await query('delete from sessions where token = $1', [token])
    return null
  }
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
