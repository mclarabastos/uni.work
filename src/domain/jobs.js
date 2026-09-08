// Maquina de estados do trampo.
//
// A trilha tem seis etapas e uma saida lateral:
//
//   aberta -> garantida -> aceita -> em_andamento -> entregue -> concluida
//      \___________\__________\___________\____________/
//                         cancelada
//
// A ordem nao e decorativa. O estudante so consegue aceitar depois de
// "garantida", porque a promessa do produto e que ele ve o pagamento reservado
// antes de dizer sim. Trocar essa ordem quebra o produto, nao so o codigo.

import { z } from 'zod'
import { query, one, many, transaction } from '../db/index.js'
import { newId, newVerificationCode } from '../lib/ids.js'
import { config } from '../config.js'
import { badRequest, conflict, forbidden, notFound, networkTrouble } from '../lib/errors.js'
import { splitFee } from '../lib/money.js'
import { emitEvent } from './events.js'
import { enfileirar } from './chain-queue.js'
import { accountKeyFor, publicUser } from './auth.js'
import { openAccount } from '../services/wallet.js'
import { fundEscrow, releaseEscrow, refundEscrow } from '../services/escrow.js'
import { buildContent, buildMetadata, contentHash, issueCertificate } from '../services/certificate.js'

export const STATUSES = ['aberta', 'garantida', 'aceita', 'em_andamento', 'entregue', 'concluida', 'cancelada']

/** As seis etapas visiveis no cartao da vaga, em ordem. */
export const TRAIL = ['aberta', 'garantida', 'aceita', 'em_andamento', 'entregue', 'concluida']

export const STATUS_LABELS = {
  aberta: 'Aberta',
  garantida: 'Pagamento reservado',
  aceita: 'Estudante escolhido',
  em_andamento: 'Em andamento',
  entregue: 'Entrega enviada',
  concluida: 'Concluída',
  cancelada: 'Cancelada'
}

/** Transicoes permitidas. Qualquer par fora daqui e recusado. */
export const TRANSITIONS = {
  aberta: ['garantida', 'cancelada'],
  garantida: ['aceita', 'cancelada'],
  aceita: ['em_andamento', 'cancelada'],
  em_andamento: ['entregue', 'cancelada'],
  entregue: ['concluida', 'em_andamento', 'cancelada'],
  concluida: [],
  cancelada: []
}

export function canTransition (from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to))
}

export function assertTransition (from, to) {
  if (!canTransition(from, to)) {
    throw conflict(
      `Esta vaga está em "${STATUS_LABELS[from] ?? from}" e não pode ir para "${STATUS_LABELS[to] ?? to}" agora.`,
      'transicao_invalida'
    )
  }
}

/** Quanto da trilha ja foi percorrido, para a barra de seis etapas. */
export function trailProgress (status) {
  if (status === 'cancelada') return { etapa: 0, total: TRAIL.length, cancelada: true }
  const index = TRAIL.indexOf(status)
  return { etapa: index + 1, total: TRAIL.length, cancelada: false }
}

// ─── validacao de entrada ────────────────────────────────────────────────────

export const createJobSchema = z.object({
  titulo: z.string().trim().min(6, 'O título precisa de pelo menos 6 caracteres.').max(120),
  descricao: z.string().trim().min(20, 'Descreva o trampo com pelo menos 20 caracteres.').max(4000),
  categoria: z.string().trim().min(2).max(60),
  modalidade: z.enum(['presencial', 'remoto'], { errorMap: () => ({ message: 'Escolha presencial ou remoto.' }) }),
  local: z.string().trim().max(160).optional().nullable(),
  valorCentavos: z.number().int().positive('O valor precisa ser maior que zero.').max(100_000_00),
  horas: z.number().positive('A carga horária precisa ser maior que zero.').max(999),
  comecaEm: z.string().datetime().optional().nullable(),
  prazoEm: z.string().datetime().optional().nullable()
})

export const applySchema = z.object({
  apresentacao: z.string().trim().max(1000).optional().nullable()
})

export const deliverSchema = z.object({
  observacao: z.string().trim().max(1000).optional().nullable()
})

export const reviewSchema = z.object({
  nota: z.number().int().min(1, 'A nota vai de 1 a 5.').max(5, 'A nota vai de 1 a 5.'),
  comentario: z.string().trim().max(1000).optional().nullable()
})

export const messageSchema = z.object({
  texto: z.string().trim().min(1, 'Escreva alguma coisa.').max(2000)
})

// ─── leitura ─────────────────────────────────────────────────────────────────

/**
 * Rotulo do status para a tela.
 * "Entregue" e "entregue e ja confirmado, esperando o pagamento sair" sao
 * momentos diferentes para quem esta olhando, mesmo sendo o mesmo status.
 */
export function rotuloDe (row) {
  if (row.disputed_at) return 'Em contestação'
  if (row.confirmed_at && row.status !== 'concluida' && row.status !== 'cancelada') {
    return 'Confirmada, liberando o pagamento'
  }
  return STATUS_LABELS[row.status] ?? row.status
}

export function publicJob (row, extras = {}) {
  if (!row) return null
  return {
    id: row.id,
    titulo: row.title,
    descricao: row.description,
    categoria: row.category,
    modalidade: row.modality,
    local: row.location ?? null,
    valorCentavos: Number(row.amount_cents),
    horas: Number(row.hours),
    status: row.status,
    statusRotulo: rotuloDe(row),
    // Confirmada mas ainda nao paga: o contratante ja disse sim e a liberacao
    // esta na fila. A tela precisa saber a diferenca.
    pagamentoEmProcessamento: Boolean(row.confirmed_at) && row.status !== 'concluida' && row.status !== 'cancelada',
    trilha: trailProgress(row.status),
    pagamentoGarantido: ['garantida', 'aceita', 'em_andamento', 'entregue', 'concluida'].includes(row.status),
    contratante: row.company_name ? { id: row.company_id, nome: row.company_name } : { id: row.company_id },
    estudante: row.student_id ? { id: row.student_id, nome: row.student_name ?? null } : null,
    comecaEm: row.starts_at ?? null,
    prazoEm: row.deadline_at ?? null,
    entregaObservacao: row.delivery_note ?? null,
    emContestacao: Boolean(row.disputed_at),
    autoConfirmaEm: row.auto_confirm_at ?? null,
    criadoEm: row.created_at,
    concluidoEm: row.completed_at ?? null,
    candidaturas: extras.candidaturas,
    candidaturasPendentes: extras.candidaturasPendentes,
    timeline: extras.timeline,
    certificado: extras.certificado,
    contestacao: extras.contestacao,
    anexos: extras.anexos,
    minhaCandidatura: extras.minhaCandidatura
  }
}

const JOB_SELECT = `
  select j.*, c.name as company_name, s.name as student_name
    from jobs j
    join users c on c.id = j.company_id
    left join users s on s.id = j.student_id`

export async function listJobs ({ status, modalidade, categoria, busca, autor, estudante, limit = 40 } = {}) {
  const where = []
  const params = []
  const add = (clause, value) => { params.push(value); where.push(clause.replace('?', `$${params.length}`)) }

  if (status) add('j.status = ?', status)
  if (modalidade) add('j.modality = ?', modalidade)
  if (categoria) add('j.category = ?', categoria)
  if (autor) add('j.company_id = ?', autor)
  if (estudante) add('j.student_id = ?', estudante)
  if (busca) {
    params.push(`%${busca}%`)
    where.push(`(j.title ilike $${params.length} or j.description ilike $${params.length} or j.category ilike $${params.length})`)
  }

  params.push(Math.min(Number(limit) || 40, 100))
  const sql = `${JOB_SELECT}
    ${where.length ? `where ${where.join(' and ')}` : ''}
    order by j.created_at desc
    limit $${params.length}`
  const rows = await many(sql, params)
  return rows.map((r) => publicJob(r))
}

export async function getJob (jobId) {
  return one(`${JOB_SELECT} where j.id = $1`, [jobId])
}

export async function getJobDetail (jobId, viewer = null) {
  const row = await getJob(jobId)
  if (!row) throw notFound('Não encontramos essa vaga.')

  const { timelineForJob } = await import('./events.js')
  const isCompany = viewer?.id === row.company_id
  const isStudent = viewer?.id === row.student_id

  // A candidatura vem com o que decide a escolha: curso, universidade, quantos
  // trampos a pessoa ja fez e quantas horas ela tem certificadas. Sem isso,
  // escolher entre dois nomes e chute.
  const candidaturas = isCompany
    ? (await many(
        `select a.*, u.name, u.university, u.course, u.headline,
                (select count(*)::int from jobs t
                  where t.student_id = a.student_id and t.status = 'concluida') as trampos,
                (select coalesce(sum(hours), 0)::float from certificates c
                  where c.student_id = a.student_id) as horas
           from applications a join users u on u.id = a.student_id
          where a.job_id = $1 order by a.created_at desc`, [jobId]
      )).map((a) => ({
        id: a.id,
        status: a.status,
        apresentacao: a.pitch,
        criadoEm: a.created_at,
        estudante: {
          id: a.student_id,
          nome: a.name,
          universidade: a.university,
          curso: a.course,
          headline: a.headline,
          trabalhosConcluidos: a.trampos ?? 0,
          horasCertificadas: Number(a.horas ?? 0)
        }
      }))
    : undefined

  const minhaCandidatura = viewer && viewer.role === 'student'
    ? await one('select id, status, pitch, created_at from applications where job_id = $1 and student_id = $2', [jobId, viewer.id])
    : null

  const certificado = await one(
    'select code, hours, issued_at, asset_id, driver, signature from certificates where job_id = $1', [jobId]
  )

  const { disputaDaVaga } = await import('./disputes.js')
  const contestacao = await disputaDaVaga(jobId, viewer)

  const { listarDaVaga } = await import('./attachments.js')
  const anexos = (isCompany || isStudent) ? await listarDaVaga(jobId) : undefined

  return publicJob(row, {
    contestacao,
    anexos,
    candidaturas,
    candidaturasPendentes: candidaturas?.filter((c) => c.status === 'pendente').length,
    timeline: (isCompany || isStudent) ? await timelineForJob(jobId) : undefined,
    minhaCandidatura: minhaCandidatura
      ? { id: minhaCandidatura.id, status: minhaCandidatura.status, apresentacao: minhaCandidatura.pitch }
      : null,
    certificado: certificado
      ? {
          codigo: certificado.code,
          horas: Number(certificado.hours),
          emitidoEm: certificado.issued_at,
          registrado: Boolean(certificado.asset_id),
          emProcessamento: !certificado.asset_id
        }
      : null
  })
}

// ─── registro do que foi para a rede ─────────────────────────────────────────

async function recordChainTx ({ jobId, kind, signature, instructions = [], detail = {}, status = 'confirmada', error = null }) {
  const id = newId('ctx')
  await query(
    `insert into chain_tx (id, job_id, kind, status, cluster, signature, instructions, detail, error, confirmed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, jobId, kind, status, config.solana.cluster, signature,
      JSON.stringify(instructions), JSON.stringify(detail), error,
      status === 'confirmada' ? new Date() : null]
  )
  return id
}

// ─── acoes ───────────────────────────────────────────────────────────────────

export async function createJob (company, input) {
  if (company.role !== 'company') throw forbidden('Só contratantes publicam vagas.')
  const data = createJobSchema.parse(input)
  if (data.modalidade === 'presencial' && !data.local) {
    throw badRequest('Vaga presencial precisa de local.', { campo: 'local' })
  }

  const id = newId('job')
  await query(
    `insert into jobs (id, company_id, title, description, category, modality, location,
                       amount_cents, hours, status, fee_bps, starts_at, deadline_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'aberta', $10, $11, $12)`,
    [id, company.id, data.titulo, data.descricao, data.categoria, data.modalidade,
      data.local ?? null, data.valorCentavos, data.horas, config.escrow.feeBps,
      data.comecaEm ?? null, data.prazoEm ?? null]
  )
  await emitEvent('vaga.publicada', { jobId: id, actorId: company.id, payload: { titulo: data.titulo } })
  return getJobDetail(id, company)
}

/**
 * Reserva o valor: sai da conta do contratante e fica preso no cofre da vaga.
 * Esta e a operacao que transforma uma promessa em garantia.
 */
export async function fundJob (company, jobId) {
  const job = await getJob(jobId)
  if (!job) throw notFound('Não encontramos essa vaga.')
  if (job.company_id !== company.id) throw forbidden('Você não publicou esta vaga.')
  assertTransition(job.status, 'garantida')

  const account = await accountKeyFor(company.id)
  const keypair = await openAccount(account.secret_cipher)

  let result
  try {
    result = await fundEscrow({
      jobId,
      companyPubkey: account.public_key,
      companyKeypair: keypair,
      amountCents: Number(job.amount_cents),
      feeBps: Number(job.fee_bps),
      deadlineUnix: job.deadline_at ? Math.floor(new Date(job.deadline_at).getTime() / 1000) : 0
    })
  } catch (err) {
    // Ambiente incompleto nao vai para a fila: nao ha o que tentar de novo
    // enquanto o token de pagamento nao existir, e enfileirar so produziria a
    // mesma falha repetida. A vaga fica aberta, e quem clicou recebe a frase
    // que diz o que aconteceu em vez de "estamos tentando".
    if (err?.permanente) {
      await recordChainTx({
        jobId, kind: 'escrow_fund', signature: null, status: 'falhou',
        error: String(err.technicalDetail ?? err.message).slice(0, 500),
        detail: { enfileirado: false, permanente: true }
      })
      throw err
    }

    await recordChainTx({
      jobId, kind: 'escrow_fund', signature: null, status: 'falhou',
      error: String(err.message).slice(0, 500), detail: { enfileirado: true }
    })
    await enfileirar('escrow_fund', { jobId })
    await emitEvent('rede.enfileirada', { jobId, actorId: company.id, payload: { tipo: 'escrow_fund' } })
    throw networkTrouble(err.message)
  }

  await query(
    "update jobs set status = 'garantida', funded_at = now(), escrow_address = $2 where id = $1",
    [jobId, result.escrow]
  )
  await recordChainTx({
    jobId, kind: 'escrow_fund', signature: result.signature,
    instructions: result.instructionsDescribed,
    detail: { cofre: result.escrow, driver: result.driver }
  })
  await emitEvent('vaga.garantida', {
    jobId, actorId: company.id,
    payload: { valorCentavos: Number(job.amount_cents) }
  })
  return getJobDetail(jobId, company)
}

export async function applyToJob (student, jobId, input) {
  if (student.role !== 'student') throw forbidden('Só estudantes se candidatam.')
  const data = applySchema.parse(input ?? {})
  const job = await getJob(jobId)
  if (!job) throw notFound('Não encontramos essa vaga.')
  if (!['aberta', 'garantida'].includes(job.status)) {
    throw conflict('Esta vaga não está mais recebendo candidaturas.', 'candidatura_encerrada')
  }
  const existing = await one('select id from applications where job_id = $1 and student_id = $2', [jobId, student.id])
  if (existing) throw conflict('Você já se candidatou a esta vaga.', 'candidatura_duplicada')

  const id = newId('app')
  await query(
    'insert into applications (id, job_id, student_id, pitch) values ($1, $2, $3, $4)',
    [id, jobId, student.id, data.apresentacao ?? null]
  )
  await emitEvent('vaga.candidatura', { jobId, actorId: student.id, payload: {} })
  return { id, status: 'pendente' }
}

/** O contratante escolhe. So depois de garantida: e a regra do produto. */
export async function acceptApplication (company, applicationId) {
  const app = await one(
    `select a.*, j.company_id, j.status as job_status, j.id as job_id
       from applications a join jobs j on j.id = a.job_id
      where a.id = $1`, [applicationId]
  )
  if (!app) throw notFound('Não encontramos essa candidatura.')
  if (app.company_id !== company.id) throw forbidden('Você não publicou esta vaga.')
  if (app.job_status === 'aberta') {
    throw conflict('Reserve o pagamento antes de escolher o estudante.', 'pagamento_nao_reservado')
  }
  assertTransition(app.job_status, 'aceita')

  await transaction(async (tx) => {
    await tx.query("update applications set status = 'aceita' where id = $1", [applicationId])
    await tx.query("update applications set status = 'recusada' where job_id = $1 and id <> $2 and status = 'pendente'", [app.job_id, applicationId])
    await tx.query("update jobs set status = 'aceita', student_id = $2, accepted_at = now() where id = $1", [app.job_id, app.student_id])
  })
  await emitEvent('vaga.aceita', { jobId: app.job_id, actorId: company.id, payload: { estudanteId: app.student_id } })
  return getJobDetail(app.job_id, company)
}

export async function startJob (actor, jobId) {
  const job = await getJob(jobId)
  if (!job) throw notFound('Não encontramos essa vaga.')
  if (job.student_id !== actor.id && job.company_id !== actor.id) throw forbidden('Esta vaga não e sua.')
  assertTransition(job.status, 'em_andamento')
  await query("update jobs set status = 'em_andamento', started_at = now() where id = $1", [jobId])
  await emitEvent('vaga.iniciada', { jobId, actorId: actor.id, payload: {} })
  return getJobDetail(jobId, actor)
}

export async function deliverJob (student, jobId, input) {
  const data = deliverSchema.parse(input ?? {})
  const job = await getJob(jobId)
  if (!job) throw notFound('Não encontramos essa vaga.')
  if (job.student_id !== student.id) throw forbidden('Esta vaga não e sua.')
  assertTransition(job.status, 'entregue')
  // O relogio da auto confirmacao comeca aqui. Se o contratante nao confirmar
  // nem contestar dentro do prazo, o sistema confirma por ele: o estudante nao
  // pode ficar esperando para sempre por causa de inercia.
  const { DIAS_ATE_AUTO_CONFIRMAR } = await import('./disputes.js')
  await query(
    `update jobs
        set status = 'entregue', delivered_at = now(), delivery_note = $2,
            auto_confirm_at = now() + make_interval(days => $3)
      where id = $1`,
    [jobId, data.observacao ?? null, DIAS_ATE_AUTO_CONFIRMAR]
  )
  await emitEvent('vaga.entregue', { jobId, actorId: student.id, payload: {} })
  return getJobDetail(jobId, student)
}

/**
 * Confirmar a entrega faz duas coisas no mesmo fluxo: libera o pagamento e
 * emite o certificado. E o momento central do produto.
 *
 * O pagamento vem primeiro porque e o que nao pode falhar em silencio. Se o
 * certificado falhar, a vaga ainda conclui e o certificado entra na fila: o
 * estudante recebe o dinheiro hoje e o certificado assim que a rede deixar.
 */
export async function confirmJob (company, jobId) {
  const job = await getJob(jobId)
  if (!job) throw notFound('Não encontramos essa vaga.')
  if (job.company_id !== company.id) throw forbidden('Você não publicou esta vaga.')
  assertTransition(job.status, 'concluida')
  if (!job.student_id) throw conflict('Esta vaga ainda não tem estudante.', 'sem_estudante')
  if (job.disputed_at) {
    throw conflict(
      'Esta vaga está em contestação. A liberação fica travada até a mediação decidir.',
      'vaga_em_contestacao'
    )
  }

  // A intencao do contratante e registrada antes de qualquer chamada de rede.
  // Se a rede recusar, essa marca e o que permite a fila terminar o servico
  // depois sem precisar pedir nada de novo para ninguem.
  await query('update jobs set confirmed_at = now() where id = $1', [jobId])

  const companyAccount = await accountKeyFor(company.id)
  const studentAccount = await accountKeyFor(job.student_id)
  const companyKeypair = await openAccount(companyAccount.secret_cipher)

  let payment
  try {
    payment = await releaseEscrow({
      jobId,
      studentPubkey: studentAccount.public_key,
      companyPubkey: companyAccount.public_key,
      companyKeypair,
      amountCents: Number(job.amount_cents),
      feeBps: Number(job.fee_bps)
    })
  } catch (err) {
    // Erro de rede nao bloqueia o fluxo de produto: a operacao entra na fila e
    // a tela segue. O contratante nao precisa clicar de novo, e o estudante nao
    // perde nem o pagamento nem o certificado.
    await recordChainTx({
      jobId, kind: 'escrow_release', signature: null, status: 'falhou',
      error: String(err.message).slice(0, 500), detail: { enfileirado: true }
    })
    await enfileirar('escrow_release', { jobId })
    await emitEvent('rede.enfileirada', { jobId, actorId: company.id, payload: { tipo: 'escrow_release' } })

    return {
      vaga: await getJobDetail(jobId, company),
      pagamento: {
        emProcessamento: true,
        mensagem: 'Recebemos a sua confirmação. O pagamento está sendo liberado e o certificado sai em seguida.'
      },
      certificado: null
    }
  }

  await query("update jobs set status = 'concluida', completed_at = now() where id = $1", [jobId])
  await recordChainTx({
    jobId, kind: 'escrow_release', signature: payment.signature,
    instructions: payment.instructionsDescribed,
    detail: { divisao: payment.split, driver: payment.driver }
  })
  await emitEvent('vaga.concluida', {
    jobId, actorId: company.id,
    payload: { estudanteId: job.student_id, recebidoCentavos: payment.split.studentCents }
  })

  const certificate = await issueCertificateForJob({ job, studentPubkey: studentAccount.public_key })
  return {
    vaga: await getJobDetail(jobId, company),
    pagamento: { emProcessamento: false, recebidoCentavos: payment.split.studentCents },
    certificado: certificate
  }
}

/** Emite o certificado da vaga. Idempotente: uma vaga tem um certificado so. */
export async function issueCertificateForJob ({ job, studentPubkey }) {
  const existing = await one('select code from certificates where job_id = $1', [job.id])
  if (existing) return { codigo: existing.code, jaExistia: true }

  const student = await one('select name from users where id = $1', [job.student_id])
  const company = await one('select name from users where id = $1', [job.company_id])
  const code = newVerificationCode()

  const content = buildContent({
    code,
    title: job.title,
    hours: Number(job.hours),
    studentName: student?.name ?? 'Estudante',
    issuerName: company?.name ?? 'Contratante',
    category: job.category,
    modality: job.modality,
    completedAt: new Date()
  })
  const hash = contentHash(content)
  const metadata = buildMetadata({ content, hash, code })

  const issued = await issueCertificate({ code, content, hash, metadata, studentPubkey })

  await query(
    `insert into certificates (id, code, job_id, student_id, title, hours, issuer_name,
                               content_hash, metadata, driver, asset_id, signature)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [newId('cer'), code, job.id, job.student_id, job.title, Number(job.hours),
      company?.name ?? 'Contratante', hash, JSON.stringify(metadata),
      issued.driver, issued.assetId ?? null, issued.signature ?? null]
  )

  if (issued.signature) {
    await recordChainTx({
      jobId: job.id, kind: 'cert_mint', signature: issued.signature,
      instructions: issued.instructionsDescribed ?? [],
      detail: { driver: issued.driver, assetId: issued.assetId, fallback: Boolean(issued.fallback) }
    })
  }

  await emitEvent(issued.pending ? 'certificado.pendente' : 'certificado.emitido', {
    jobId: job.id, actorId: job.student_id,
    payload: { codigo: code, horas: Number(job.hours) }
  })

  // Um certificado que nao virou cNFT ainda nao terminou de nascer. A fila
  // termina o servico, com espera crescente entre as tentativas.
  if (issued.pending) await enfileirar('cert_mint', { jobId: job.id })

  return {
    codigo: code,
    horas: Number(job.hours),
    hash,
    emProcessamento: Boolean(issued.pending),
    jaExistia: false
  }
}

export async function cancelJob (company, jobId, motivo = null) {
  const job = await getJob(jobId)
  if (!job) throw notFound('Não encontramos essa vaga.')
  if (job.company_id !== company.id) throw forbidden('Você não publicou esta vaga.')
  assertTransition(job.status, 'cancelada')
  if (job.disputed_at) {
    throw conflict(
      'Esta vaga está em contestação e não pode ser cancelada até a mediação decidir.',
      'vaga_em_contestacao'
    )
  }

  // A vaga e cancelada de qualquer jeito. A devolucao do valor pode demorar,
  // mas nao pode ficar dependendo de o contratante clicar de novo: se a rede
  // recusar agora, a fila devolve depois.
  await query(
    "update jobs set status = 'cancelada', cancelled_at = now(), cancelled_reason = $2 where id = $1",
    [jobId, motivo]
  )

  let refund = null
  if (job.funded_at) {
    const account = await accountKeyFor(company.id)
    const keypair = await openAccount(account.secret_cipher)
    try {
      refund = await refundEscrow({
        jobId,
        companyPubkey: account.public_key,
        companyKeypair: keypair,
        amountCents: Number(job.amount_cents)
      })
      await recordChainTx({
        jobId, kind: 'escrow_refund', signature: refund.signature,
        instructions: refund.instructionsDescribed, detail: { driver: refund.driver }
      })
    } catch (err) {
      await recordChainTx({
        jobId, kind: 'escrow_refund', signature: null, status: 'falhou',
        error: String(err.message).slice(0, 500), detail: { enfileirado: true }
      })
      await enfileirar('escrow_refund', { jobId })
      await emitEvent('rede.enfileirada', { jobId, actorId: company.id, payload: { tipo: 'escrow_refund' } })
    }
  }
  await emitEvent('vaga.cancelada', { jobId, actorId: company.id, payload: { motivo } })
  return getJobDetail(jobId, company)
}

// ─── conversa e avaliacao ────────────────────────────────────────────────────

async function assertParticipant (jobId, user) {
  const job = await getJob(jobId)
  if (!job) throw notFound('Não encontramos essa vaga.')
  if (job.company_id !== user.id && job.student_id !== user.id) {
    throw forbidden('Esta conversa é só entre o contratante e o estudante da vaga.')
  }
  return job
}

export async function listMessages (user, jobId) {
  await assertParticipant(jobId, user)
  const rows = await many(
    `select m.id, m.body, m.created_at, m.sender_id, u.name
       from messages m join users u on u.id = m.sender_id
      where m.job_id = $1 order by m.created_at asc`, [jobId]
  )
  return rows.map((r) => ({
    id: r.id, texto: r.body, quando: r.created_at,
    autor: { id: r.sender_id, nome: r.name }, meu: r.sender_id === user.id
  }))
}

export async function sendMessage (user, jobId, input) {
  const data = messageSchema.parse(input)
  await assertParticipant(jobId, user)
  const id = newId('msg')
  await query('insert into messages (id, job_id, sender_id, body) values ($1, $2, $3, $4)', [id, jobId, user.id, data.texto])
  await emitEvent('mensagem.enviada', { jobId, actorId: user.id, payload: {} })
  return { id, texto: data.texto, quando: new Date().toISOString(), autor: { id: user.id, nome: user.name }, meu: true }
}

export async function reviewJob (user, jobId, input) {
  const data = reviewSchema.parse(input)
  const job = await assertParticipant(jobId, user)
  if (job.status !== 'concluida') {
    throw conflict('A avaliação abre quando a vaga é concluída.', 'vaga_nao_concluida')
  }
  const targetId = job.company_id === user.id ? job.student_id : job.company_id
  const existing = await one('select id from reviews where job_id = $1 and author_id = $2', [jobId, user.id])
  if (existing) throw conflict('Você já avaliou esta vaga.', 'avaliacao_duplicada')

  const id = newId('rev')
  await query(
    'insert into reviews (id, job_id, author_id, target_id, rating, comment) values ($1, $2, $3, $4, $5, $6)',
    [id, jobId, user.id, targetId, data.nota, data.comentario ?? null]
  )
  await emitEvent('avaliacao.registrada', { jobId, actorId: user.id, payload: { nota: data.nota } })
  return { id, nota: data.nota, comentario: data.comentario ?? null }
}

export { splitFee, publicUser }
