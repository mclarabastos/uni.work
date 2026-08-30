// Perfil publico.
//
// A pagina do estudante e o que ele manda para um contratante: horas
// certificadas, certificados, avaliacoes e portfolio, tudo verificavel.
// A pagina do contratante e o outro lado da mesma moeda: quantas vagas ele
// publicou, quantas ele confirmou, e quanto tempo costuma levar para confirmar.
//
// Reputacao dos dois lados, e nao so do estudante, porque quem contrata mal
// tambem precisa aparecer.

import { z } from 'zod'
import { query, one, many } from '../db/index.js'
import { notFound } from '../lib/errors.js'
import { listarDe } from './attachments.js'

export const perfilSchema = z.object({
  nome: z.string().trim().min(2, 'Escreva seu nome completo.').max(80).optional(),
  headline: z.string().trim().max(140).optional().nullable(),
  bio: z.string().trim().max(600).optional().nullable(),
  universidade: z.string().trim().max(120).optional().nullable(),
  curso: z.string().trim().max(120).optional().nullable(),
  telefone: z.string().trim().max(30).optional().nullable(),
  links: z.array(
    z.object({
      rotulo: z.string().trim().min(1).max(40),
      url: z.string().trim().url('Escreva um endereco completo, comecando com https://').max(300)
    })
  ).max(6, 'No maximo seis links.').optional(),
  habilidades: z.array(z.string().trim().min(1).max(40)).max(20, 'No maximo vinte habilidades.').optional()
})

export async function atualizarPerfil (usuario, input) {
  const dados = perfilSchema.parse(input)
  const campos = []
  const valores = [usuario.id]

  const mapa = [
    ['nome', 'name'], ['headline', 'headline'], ['bio', 'bio'],
    ['universidade', 'university'], ['curso', 'course'], ['telefone', 'phone']
  ]
  for (const [chave, coluna] of mapa) {
    if (dados[chave] !== undefined) {
      valores.push(dados[chave])
      campos.push(`${coluna} = $${valores.length}`)
    }
  }
  if (dados.links !== undefined) {
    valores.push(JSON.stringify(dados.links))
    campos.push(`links = $${valores.length}`)
  }
  if (dados.habilidades !== undefined) {
    valores.push(JSON.stringify(dados.habilidades))
    campos.push(`skills = $${valores.length}`)
  }

  if (campos.length) {
    await query(`update users set ${campos.join(', ')} where id = $1`, valores)
  }
  return perfilPublico(usuario.id, usuario)
}

function comoLista (valor) {
  if (Array.isArray(valor)) return valor
  if (typeof valor === 'string') {
    try { return JSON.parse(valor) } catch { return [] }
  }
  return []
}

/**
 * O perfil que qualquer pessoa ve, com ou sem conta.
 * Nada aqui depende de confianca em nos: os certificados listados tem codigo
 * publico, e quem quiser confere um por um sem passar pela nossa palavra.
 */
export async function perfilPublico (userId, visitante = null) {
  const pessoa = await one(
    'select id, role, name, headline, bio, university, course, accent, skills, links, avatar_key, created_at, blocked_at from users where id = $1',
    [userId]
  )
  if (!pessoa || pessoa.blocked_at) throw notFound('Nao encontramos esse perfil.')

  const ehEstudante = pessoa.role === 'student'
  const eu = visitante?.id === userId

  const avaliacoes = await many(
    `select r.rating, r.comment, r.created_at, u.name as autor, j.title as vaga
       from reviews r
       join users u on u.id = r.author_id
       join jobs j on j.id = r.job_id
      where r.target_id = $1
      order by r.created_at desc limit 20`,
    [userId]
  )

  const media = await one(
    'select coalesce(avg(rating), 0)::float as media, count(*)::int as total from reviews where target_id = $1',
    [userId]
  )

  const base = {
    id: pessoa.id,
    nome: pessoa.name,
    perfil: pessoa.role,
    headline: pessoa.headline,
    bio: pessoa.bio,
    cor: pessoa.accent,
    foto: pessoa.avatar_key ? `/api/perfis/${pessoa.id}/foto` : null,
    membroDesde: pessoa.created_at,
    links: comoLista(pessoa.links),
    avaliacao: { media: Number(media.media), total: media.total },
    avaliacoes: avaliacoes.map((a) => ({
      nota: a.rating, comentario: a.comment, autor: a.autor, vaga: a.vaga, quando: a.created_at
    })),
    souEu: eu
  }

  if (ehEstudante) {
    const certificados = await many(
      `select c.code, c.title, c.hours, c.issuer_name, c.issued_at, c.asset_id, j.category, j.modality
         from certificates c join jobs j on j.id = c.job_id
        where c.student_id = $1 order by c.issued_at desc`,
      [userId]
    )
    const trabalhos = await one(
      `select count(*)::int as concluidos,
              coalesce(sum(hours), 0)::float as horas
         from jobs where student_id = $1 and status = 'concluida'`,
      [userId]
    )
    return {
      ...base,
      universidade: pessoa.university,
      curso: pessoa.course,
      habilidades: comoLista(pessoa.skills),
      horasCertificadas: certificados.reduce((s, c) => s + Number(c.hours), 0),
      trabalhosConcluidos: trabalhos.concluidos,
      certificados: certificados.map((c) => ({
        codigo: c.code,
        titulo: c.title,
        horas: Number(c.hours),
        contratante: c.issuer_name,
        categoria: c.category,
        modalidade: c.modality,
        emitidoEm: c.issued_at,
        registrado: Boolean(c.asset_id),
        verificacao: `/verificar/${c.code}`
      })),
      portfolio: await listarDe(userId, 'portfolio')
    }
  }

  // Contratante: reputacao medida pelo que ele faz depois de receber a entrega.
  const numeros = await one(
    `select
       count(*)::int                                                as publicadas,
       count(*) filter (where status = 'concluida')::int            as concluidas,
       count(*) filter (where status = 'cancelada')::int            as canceladas,
       coalesce(sum(amount_cents) filter (where status = 'concluida'), 0)::bigint as pagoCentavos
     from jobs where company_id = $1`,
    [userId]
  )

  // Tempo entre a entrega chegar e o contratante confirmar. E o numero que o
  // estudante quer saber antes de aceitar.
  const tempo = await one(
    `select coalesce(avg(extract(epoch from (completed_at - delivered_at))), 0)::float as segundos
       from jobs
      where company_id = $1 and status = 'concluida'
        and delivered_at is not null and completed_at is not null`,
    [userId]
  )

  const entregues = numeros.concluidas + numeros.canceladas
  return {
    ...base,
    vagasPublicadas: numeros.publicadas,
    vagasConcluidas: numeros.concluidas,
    taxaDeConfirmacao: entregues ? Math.round((numeros.concluidas / entregues) * 100) : null,
    tempoMedioAteConfirmarHoras: tempo.segundos ? Math.round((tempo.segundos / 3600) * 10) / 10 : null,
    totalPagoCentavos: Number(numeros.pagocentavos ?? numeros.pagoCentavos ?? 0)
  }
}

/** Vagas abertas do contratante, para quem chega pelo perfil dele. */
export async function vagasDoPerfil (userId) {
  const linhas = await many(
    `select j.*, c.name as company_name, s.name as student_name
       from jobs j join users c on c.id = j.company_id
       left join users s on s.id = j.student_id
      where j.company_id = $1 and j.status in ('aberta','garantida')
      order by j.created_at desc limit 12`,
    [userId]
  )
  const { publicJob } = await import('./jobs.js')
  return linhas.map((r) => publicJob(r))
}
