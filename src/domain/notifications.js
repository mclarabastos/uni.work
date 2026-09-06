// Notificacoes.
//
// Um evento de dominio vira no maximo uma notificacao por pessoa. "No maximo"
// e "uma" sao as duas partes dificeis:
//
//   uma       -> cada notificacao tem uma chave de deduplicacao gravada com
//                restricao de unicidade no banco. Se o worker reprocessar o
//                mesmo evento, o insert falha e nada e enviado de novo.
//   no maximo -> a pessoa escolhe os canais. Quem desligou o e-mail recebe so
//                no aplicativo; quem escolheu o resumo diario nao recebe nada
//                na hora.
//
// O canal "app" nunca e desligavel: e o historico dentro do produto, e sem ele
// a pessoa nao teria como saber o que perdeu.

import { z } from 'zod'
import { query, one, many } from '../db/index.js'
import { newId } from '../lib/ids.js'
import { config } from '../config.js'
import { notFound } from '../lib/errors.js'
import { enviarEmail, modeloGenerico, modeloPagamentoLiberado, emailConfigurado } from '../services/mailer.js'
import { enviarPush, pushConfigurado } from '../services/push.js'
import { formatBRL } from '../lib/money.js'
import { onEvent } from './events.js'
import { log } from '../lib/logger.js'

export const preferenciasSchema = z.object({
  email: z.boolean().optional(),
  push: z.boolean().optional(),
  digest: z.enum(['instant', 'daily', 'off'], {
    errorMap: () => ({ message: 'Escolha entre na hora, resumo diário ou desligado.' })
  }).optional()
})

/**
 * O que cada evento de dominio vira, e para quem.
 * Devolve null quando o evento nao merece notificacao: nem todo acontecimento
 * precisa interromper alguem.
 */
export async function notificacaoPara (evento) {
  const { type, job_id: jobId, actor_id: actorId, payload = {} } = evento
  if (!jobId && !['conta.criada'].includes(type)) return null

  const vaga = jobId
    ? await one(
      `select j.*, c.name as company_name, s.name as student_name
         from jobs j join users c on c.id = j.company_id
         left join users s on s.id = j.student_id
        where j.id = $1`, [jobId]
    )
    : null

  const link = jobId ? `/vaga/${jobId}` : '/'
  const titulo = vaga?.title ?? 'sua vaga'

  switch (type) {
    case 'vaga.candidatura':
      if (!vaga) return null
      return {
        para: [vaga.company_id],
        tipo: type,
        titulo: 'Nova candidatura',
        corpo: `Alguém se candidatou a "${titulo}". Veja o perfil e escolha quando quiser.`,
        link
      }

    case 'vaga.garantida':
      if (!vaga) return null
      return {
        para: [vaga.company_id],
        tipo: type,
        titulo: 'Valor reservado',
        corpo: `O valor de ${formatBRL(vaga.amount_cents)} saiu da sua conta e está separado para "${titulo}". Agora você pode escolher o estudante.`,
        link
      }

    case 'vaga.aceita':
      if (!vaga?.student_id) return null
      return {
        para: [vaga.student_id],
        tipo: type,
        titulo: 'Você foi escolhido',
        corpo: `Você foi escolhido para "${titulo}". O pagamento de ${formatBRL(vaga.amount_cents)} já está reservado.`,
        link
      }

    case 'vaga.entregue':
      if (!vaga) return null
      return {
        para: [vaga.company_id],
        tipo: type,
        titulo: 'Entrega recebida',
        corpo: `A entrega de "${titulo}" chegou. Confira e confirme para liberar o pagamento.`,
        link
      }

    case 'vaga.concluida':
      if (!vaga?.student_id) return null
      return {
        para: [vaga.student_id],
        tipo: type,
        titulo: 'Pagamento liberado',
        corpo: `O contratante confirmou "${titulo}". Você recebeu ${formatBRL(payload.recebidoCentavos ?? vaga.amount_cents)} e o certificado de ${Number(vaga.hours)}h foi emitido.`,
        link,
        modeloEspecial: 'pagamento'
      }

    case 'vaga.cancelada':
      if (!vaga) return null
      return {
        para: [vaga.student_id, vaga.company_id].filter(Boolean),
        tipo: type,
        titulo: 'Vaga cancelada',
        corpo: `"${titulo}" foi cancelada. O valor reservado voltou para quem reservou.`,
        link
      }

    case 'vaga.auto_confirmada':
      if (!vaga) return null
      return {
        para: [vaga.company_id, vaga.student_id].filter(Boolean),
        tipo: type,
        titulo: 'Confirmada por prazo',
        corpo: `"${titulo}" passou do prazo de confirmação e foi confirmada automaticamente. O pagamento está sendo liberado.`,
        link
      }

    case 'disputa.aberta': {
      if (!vaga) return null
      // Quem abriu ja sabe. Avisamos a outra parte.
      const outra = actorId === vaga.company_id ? vaga.student_id : vaga.company_id
      if (!outra) return null
      return {
        para: [outra],
        tipo: type,
        titulo: 'Contestação aberta',
        corpo: `Uma contestação foi aberta em "${titulo}". O valor fica parado até a análise terminar. Você pode responder pela página da vaga.`,
        link
      }
    }

    case 'disputa.resolvida':
      if (!vaga) return null
      return {
        para: [vaga.company_id, vaga.student_id].filter(Boolean),
        tipo: type,
        titulo: 'Contestação resolvida',
        corpo: `A contestação de "${titulo}" foi analisada e decidida. Veja o resultado na página da vaga.`,
        link
      }

    case 'certificado.emitido':
      if (!vaga?.student_id) return null
      return {
        para: [vaga.student_id],
        tipo: type,
        titulo: 'Certificado pronto',
        corpo: `Seu certificado de ${Number(vaga.hours)}h por "${titulo}" está pronto e pode ser verificado por qualquer pessoa.`,
        link: payload.codigo ? `/verificar/${payload.codigo}` : link
      }

    case 'mensagem.enviada': {
      if (!vaga) return null
      const destinatario = actorId === vaga.company_id ? vaga.student_id : vaga.company_id
      if (!destinatario) return null
      return {
        para: [destinatario],
        tipo: type,
        titulo: 'Nova mensagem',
        corpo: `Você recebeu uma mensagem sobre "${titulo}".`,
        link,
        // Conversa gera muita notificacao. Uma por vaga por hora basta.
        janelaDeDeduplicacao: 3600_000
      }
    }

    default:
      return null
  }
}

/**
 * Cria a notificacao, uma vez so.
 * A unicidade e do banco, nao de uma checagem em JavaScript: duas requisicoes
 * simultaneas passariam por qualquer verificacao feita antes do insert.
 */
export async function criar ({ userId, tipo, titulo, corpo, link = null, jobId = null, chave, canais = ['app'] }) {
  try {
    await query('insert into notification_keys (dedupe_key) values ($1)', [chave])
  } catch {
    return { criada: false, motivo: 'ja_existia' }
  }

  const id = newId('not')
  await query(
    `insert into notifications (id, user_id, type, title, body, link, channels, job_id, dedupe_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, userId, tipo, titulo, corpo, link, JSON.stringify(canais), jobId, chave]
  )
  return { criada: true, id }
}

export async function preferenciasDe (userId) {
  let linha = await one('select * from notification_preferences where user_id = $1', [userId])
  if (!linha) {
    await query('insert into notification_preferences (user_id) values ($1) on conflict do nothing', [userId])
    linha = await one('select * from notification_preferences where user_id = $1', [userId])
  }
  return {
    email: linha?.email ?? true,
    push: linha?.push ?? false,
    digest: linha?.digest ?? 'instant',
    ultimoResumo: linha?.last_digest_at ?? null
  }
}

export async function atualizarPreferencias (userId, input) {
  const dados = preferenciasSchema.parse(input)
  await preferenciasDe(userId) // garante que a linha existe
  const campos = []
  const valores = [userId]
  for (const [chave, coluna] of [['email', 'email'], ['push', 'push'], ['digest', 'digest']]) {
    if (dados[chave] !== undefined) {
      valores.push(dados[chave])
      campos.push(`${coluna} = $${valores.length}`)
    }
  }
  if (campos.length) {
    await query(`update notification_preferences set ${campos.join(', ')} where user_id = $1`, valores)
  }
  return preferenciasDe(userId)
}

/**
 * Entrega pelos canais que a pessoa escolheu.
 * Nunca lanca: uma notificacao que nao saiu nao pode derrubar a operacao que a
 * gerou. O que nao saiu fica com sent_at nulo e aparece como pendente.
 */
export async function entregar (notificacaoId) {
  const n = await one(
    `select n.*, u.email as user_email, u.name as user_name
       from notifications n join users u on u.id = n.user_id
      where n.id = $1`,
    [notificacaoId]
  )
  if (!n || n.sent_at) return { entregue: false, motivo: 'ja_enviada_ou_inexistente' }

  const prefs = await preferenciasDe(n.user_id)
  const canais = ['app']
  const link = n.link ? `${config.publicBaseUrl}${n.link}` : config.publicBaseUrl

  // O resumo diario junta tudo depois. Na hora, so o aplicativo.
  const naHora = prefs.digest === 'instant'

  if (naHora && prefs.email && emailConfigurado()) {
    const modelo = modeloGenerico({ titulo: n.title, corpo: n.body, link })
    const envio = await enviarEmail({ para: n.user_email, ...modelo })
    if (envio.entregue) canais.push('email')
  }

  if (naHora && prefs.push && pushConfigurado()) {
    const enviados = await enviarPush(n.user_id, {
      title: n.title, body: n.body, url: link, tag: n.type
    })
    if (enviados > 0) canais.push('push')
  }

  await query(
    'update notifications set sent_at = now(), channels = $2 where id = $1',
    [n.id, JSON.stringify(canais)]
  )
  return { entregue: true, canais }
}

/** Reage a um evento de dominio: cria e entrega. */
export async function processarEvento (evento) {
  const spec = await notificacaoPara(evento)
  if (!spec) return { criadas: 0 }

  let criadas = 0
  for (const userId of spec.para) {
    // Quem causou o evento nao precisa ser avisado do proprio ato.
    if (userId === evento.actor_id) continue

    const janela = spec.janelaDeDeduplicacao
    const sufixo = janela ? `:${Math.floor(Date.now() / janela)}` : ''
    const chave = `${spec.tipo}:${evento.job_id ?? 'sem-vaga'}:${userId}${sufixo}`

    const resultado = await criar({
      userId,
      tipo: spec.tipo,
      titulo: spec.titulo,
      corpo: spec.corpo,
      link: spec.link,
      jobId: evento.job_id ?? null,
      chave
    })
    if (resultado.criada) {
      criadas += 1
      await entregar(resultado.id)
    }
  }
  return { criadas }
}

/** Liga o barramento de eventos ao envio de notificacoes. */
let desligar = null
export function ligarNotificacoes () {
  if (desligar) return { jaEstava: true }
  desligar = onEvent((evento) => {
    processarEvento(evento).catch((err) => {
      log.error('notificacao_falhou', { tipo: evento.type, detalhe: err.message })
    })
  })
  return { jaEstava: false }
}

export function desligarNotificacoes () {
  desligar?.()
  desligar = null
}

// ─── leitura ─────────────────────────────────────────────────────────────────

export async function listar (userId, { apenasNaoLidas = false, limite = 50 } = {}) {
  const linhas = await many(
    `select id, type, title, body, link, channels, read_at, sent_at, created_at, job_id
       from notifications
      where user_id = $1 ${apenasNaoLidas ? 'and read_at is null' : ''}
      order by created_at desc
      limit $2`,
    [userId, Math.min(Number(limite) || 50, 200)]
  )
  return linhas.map((n) => ({
    id: n.id,
    tipo: n.type,
    titulo: n.title,
    corpo: n.body,
    link: n.link,
    lida: Boolean(n.read_at),
    quando: n.created_at,
    vagaId: n.job_id
  }))
}

export async function contarNaoLidas (userId) {
  const linha = await one(
    'select count(*)::int as total from notifications where user_id = $1 and read_at is null',
    [userId]
  )
  return linha?.total ?? 0
}

export async function marcarComoLidas (userId, ids = null) {
  if (Array.isArray(ids) && ids.length) {
    const { rowCount } = await query(
      'update notifications set read_at = now() where user_id = $1 and id = any($2) and read_at is null',
      [userId, ids]
    )
    return { lidas: rowCount }
  }
  const { rowCount } = await query(
    'update notifications set read_at = now() where user_id = $1 and read_at is null',
    [userId]
  )
  return { lidas: rowCount }
}

export async function removerNotificacao (userId, id) {
  const { rowCount } = await query('delete from notifications where user_id = $1 and id = $2', [userId, id])
  if (rowCount === 0) throw notFound('Não encontramos essa notificação.')
  return { ok: true }
}

// ─── resumo diario ───────────────────────────────────────────────────────────

/**
 * Junta o que aconteceu e manda um e-mail so.
 * Para quem recebe muita coisa, um resumo por dia e a diferenca entre continuar
 * usando o produto e desligar as notificacoes de vez.
 */
export async function enviarResumosDiarios () {
  if (!emailConfigurado()) return { enviados: 0, motivo: 'email_nao_configurado' }

  const pessoas = await many(
    `select p.user_id, u.email, u.name
       from notification_preferences p join users u on u.id = p.user_id
      where p.digest = 'daily'
        and p.email = true
        and u.blocked_at is null
        and (p.last_digest_at is null or p.last_digest_at < now() - interval '20 hours')`
  )

  let enviados = 0
  for (const pessoa of pessoas) {
    const pendentes = await many(
      `select title, body, link from notifications
        where user_id = $1 and read_at is null
          and created_at > coalesce(
            (select last_digest_at from notification_preferences where user_id = $1),
            now() - interval '1 day')
        order by created_at asc limit 25`,
      [pessoa.user_id]
    )
    if (!pendentes.length) continue

    const linhas = pendentes.map((n) => `- ${n.title}: ${n.body}`).join('\n')
    const modelo = modeloGenerico({
      titulo: `Seu resumo: ${pendentes.length} novidade${pendentes.length === 1 ? '' : 's'}`,
      corpo: linhas.replace(/\n/g, '<br>'),
      link: config.publicBaseUrl,
      textoDoBotao: 'Abrir o Uni.work'
    })
    const envio = await enviarEmail({ para: pessoa.email, ...modelo })
    if (envio.entregue) {
      await query('update notification_preferences set last_digest_at = now() where user_id = $1', [pessoa.user_id])
      enviados += 1
    }
  }
  return { enviados }
}

export { modeloPagamentoLiberado }
