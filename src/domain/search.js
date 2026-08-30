// Busca de vagas.
//
// Full-text em portugues pela coluna gerada `search`, que ja vem com peso por
// campo (titulo A, descricao B, categoria C) e indice GIN. Filtros combinam
// entre si, a ordenacao e escolhida por quem busca, e a paginacao e por cursor.
//
// Nenhuma consulta aqui usa offset, e nenhuma faz count do total. As duas
// coisas ficam caras exatamente quando a base cresce, que e quando a busca
// precisa continuar rapida.

import { z } from 'zod'
import { many } from '../db/index.js'
import { badRequest } from '../lib/errors.js'
import { decodificarCursor, normalizarLimite, montarPagina } from '../lib/cursor.js'

export const ORDENACOES = {
  relevancia: { rotulo: 'Mais relevantes', precisaDeTermo: true },
  recentes: { rotulo: 'Mais recentes', precisaDeTermo: false },
  maior_valor: { rotulo: 'Maior valor', precisaDeTermo: false },
  menor_valor: { rotulo: 'Menor valor', precisaDeTermo: false },
  menos_horas: { rotulo: 'Menos horas', precisaDeTermo: false }
}

export const buscaSchema = z.object({
  termo: z.string().trim().max(120).optional().nullable(),
  modalidade: z.enum(['presencial', 'remoto']).optional().nullable(),
  categoria: z.string().trim().max(60).optional().nullable(),
  status: z.enum(['aberta', 'garantida', 'aceita', 'em_andamento', 'entregue', 'concluida', 'cancelada']).optional().nullable(),
  local: z.string().trim().max(120).optional().nullable(),
  valorMin: z.coerce.number().int().min(0).optional().nullable(),
  valorMax: z.coerce.number().int().min(0).optional().nullable(),
  horasMax: z.coerce.number().min(0).optional().nullable(),
  garantidas: z.coerce.boolean().optional().nullable(),
  contratante: z.string().trim().max(40).optional().nullable(),
  estudante: z.string().trim().max(40).optional().nullable(),
  ordem: z.enum(Object.keys(ORDENACOES)).optional().nullable(),
  cursor: z.string().trim().max(400).optional().nullable(),
  // Sem teto aqui de proposito: quem limita e normalizarLimite, para o teto
  // morar num lugar so. Pedir mais do que o maximo nao e erro, e so recebe o
  // maximo.
  limite: z.coerce.number().int().min(1).optional().nullable()
})

/**
 * Cada ordenacao define as colunas de ordem e como o cursor compara.
 * Todas terminam em id para a ordem ser total.
 */
const ORDEM_SQL = {
  relevancia: {
    colunas: 'relevancia desc, j.id desc',
    comparar: (p) => `(ts_rank(j.search, consulta.q), j.id) < ($${p}, $${p + 1})`,
    valores: (linha) => [linha.relevancia, linha.id]
  },
  recentes: {
    colunas: 'j.created_at desc, j.id desc',
    comparar: (p) => `(j.created_at, j.id) < ($${p}, $${p + 1})`,
    valores: (linha) => [linha.created_at, linha.id]
  },
  maior_valor: {
    colunas: 'j.amount_cents desc, j.id desc',
    comparar: (p) => `(j.amount_cents, j.id) < ($${p}, $${p + 1})`,
    valores: (linha) => [linha.amount_cents, linha.id]
  },
  menor_valor: {
    colunas: 'j.amount_cents asc, j.id asc',
    comparar: (p) => `(j.amount_cents, j.id) > ($${p}, $${p + 1})`,
    valores: (linha) => [linha.amount_cents, linha.id]
  },
  menos_horas: {
    colunas: 'j.hours asc, j.id asc',
    comparar: (p) => `(j.hours, j.id) > ($${p}, $${p + 1})`,
    valores: (linha) => [linha.hours, linha.id]
  }
}

export async function buscarVagas (entrada = {}) {
  const dados = buscaSchema.parse(entrada)
  const limite = normalizarLimite(dados.limite)
  const termo = dados.termo?.trim() || null

  // Ordenar por relevancia sem termo de busca nao quer dizer nada.
  const ordem = (!termo && dados.ordem === 'relevancia') ? 'recentes' : (dados.ordem ?? (termo ? 'relevancia' : 'recentes'))
  const config = ORDEM_SQL[ordem]
  if (!config) throw badRequest('Ordenacao desconhecida.', { campo: 'ordem' })

  if (dados.valorMin != null && dados.valorMax != null && dados.valorMin > dados.valorMax) {
    throw badRequest('O valor minimo esta acima do maximo.', { campo: 'valorMin' })
  }

  const params = []
  const where = []
  const add = (valor) => { params.push(valor); return `$${params.length}` }

  // A consulta full-text entra como CTE para o rank ser calculado uma vez so.
  const comTermo = Boolean(termo)
  if (comTermo) {
    where.push(`j.search @@ consulta.q`)
  }

  if (dados.modalidade) where.push(`j.modality = ${add(dados.modalidade)}`)
  if (dados.categoria) where.push(`lower(j.category) = lower(${add(dados.categoria)})`)
  if (dados.local) where.push(`j.location ilike ${add(`%${dados.local}%`)}`)
  if (dados.valorMin != null) where.push(`j.amount_cents >= ${add(dados.valorMin)}`)
  if (dados.valorMax != null) where.push(`j.amount_cents <= ${add(dados.valorMax)}`)
  if (dados.horasMax != null) where.push(`j.hours <= ${add(dados.horasMax)}`)
  if (dados.contratante) where.push(`j.company_id = ${add(dados.contratante)}`)
  if (dados.estudante) where.push(`j.student_id = ${add(dados.estudante)}`)

  if (dados.status) {
    where.push(`j.status = ${add(dados.status)}`)
  } else if (dados.garantidas) {
    where.push(`j.status = 'garantida'`)
  } else {
    // Por padrao a busca mostra o que da para pegar.
    where.push(`j.status in ('aberta','garantida')`)
  }

  const posicao = decodificarCursor(dados.cursor)
  if (posicao) {
    if (posicao.o !== ordem) {
      throw badRequest('O cursor e de outra ordenacao. Comece a lista de novo.', { campo: 'cursor' })
    }
    const inicio = params.length + 1
    params.push(...posicao.v)
    where.push(config.comparar(inicio))
  }

  params.push(limite + 1)
  const parametroLimite = `$${params.length}`

  const sql = `
    ${comTermo ? `with consulta as (select plainto_tsquery('portuguese', ${add(termo)}) as q)` : ''}
    select j.*, c.name as company_name, s.name as student_name
           ${comTermo ? ', ts_rank(j.search, consulta.q) as relevancia' : ''}
      from jobs j
      join users c on c.id = j.company_id
      left join users s on s.id = j.student_id
      ${comTermo ? ', consulta' : ''}
     where ${where.join(' and ')}
     order by ${config.colunas}
     limit ${parametroLimite}`

  const linhas = await many(sql, params)
  const { publicJob } = await import('./jobs.js')
  const pagina = montarPagina(linhas, limite, (linha) => ({ o: ordem, v: config.valores(linha) }))

  return {
    vagas: pagina.itens.map((linha) => ({
      ...publicJob(linha),
      relevancia: linha.relevancia !== undefined ? Number(linha.relevancia) : undefined
    })),
    proximoCursor: pagina.proximoCursor,
    temMais: pagina.temMais,
    ordem,
    ordensDisponiveis: Object.entries(ORDENACOES)
      .filter(([, meta]) => !meta.precisaDeTermo || comTermo)
      .map(([valor, meta]) => ({ valor, rotulo: meta.rotulo }))
  }
}

/**
 * Sugestoes para a barra de busca: as categorias que existem de verdade, com
 * quantas vagas abertas cada uma tem.
 */
export async function facetas () {
  const [categorias, modalidades, faixa] = await Promise.all([
    many(`select category, count(*)::int as total
            from jobs where status in ('aberta','garantida')
           group by category order by total desc limit 12`),
    many(`select modality, count(*)::int as total
            from jobs where status in ('aberta','garantida')
           group by modality`),
    many(`select coalesce(min(amount_cents), 0)::int as minimo,
                 coalesce(max(amount_cents), 0)::int as maximo
            from jobs where status in ('aberta','garantida')`)
  ])
  return {
    categorias: categorias.map((c) => ({ nome: c.category, total: c.total })),
    modalidades: Object.fromEntries(modalidades.map((m) => [m.modality, m.total])),
    faixaDeValor: { minimoCentavos: faixa[0]?.minimo ?? 0, maximoCentavos: faixa[0]?.maximo ?? 0 }
  }
}

// ─── listagens paginadas por cursor ──────────────────────────────────────────

/** As vagas da pessoa, como estudante ou como contratante. */
export async function minhasVagas (usuario, { cursor = null, limite = null } = {}) {
  const tamanho = normalizarLimite(limite)
  const coluna = usuario.role === 'student' ? 'student_id' : 'company_id'
  const params = [usuario.id]
  const where = [`j.${coluna} = $1`]

  const posicao = decodificarCursor(cursor)
  if (posicao) {
    params.push(posicao.v[0], posicao.v[1])
    where.push(`(j.created_at, j.id) < ($${params.length - 1}, $${params.length})`)
  }
  params.push(tamanho + 1)

  const linhas = await many(
    `select j.*, c.name as company_name, s.name as student_name
       from jobs j join users c on c.id = j.company_id
       left join users s on s.id = j.student_id
      where ${where.join(' and ')}
      order by j.created_at desc, j.id desc
      limit $${params.length}`,
    params
  )
  const { publicJob } = await import('./jobs.js')
  const pagina = montarPagina(linhas, tamanho, (l) => ({ o: 'recentes', v: [l.created_at, l.id] }))
  return { vagas: pagina.itens.map((l) => publicJob(l)), proximoCursor: pagina.proximoCursor, temMais: pagina.temMais }
}

/** Certificados do estudante, tambem por cursor. */
export async function meusCertificados (usuario, { cursor = null, limite = null } = {}) {
  const tamanho = normalizarLimite(limite)
  const params = [usuario.id]
  const where = ['c.student_id = $1']

  const posicao = decodificarCursor(cursor)
  if (posicao) {
    params.push(posicao.v[0], posicao.v[1])
    where.push(`(c.issued_at, c.id) < ($${params.length - 1}, $${params.length})`)
  }
  params.push(tamanho + 1)

  const linhas = await many(
    `select c.*, j.category, j.modality
       from certificates c join jobs j on j.id = c.job_id
      where ${where.join(' and ')}
      order by c.issued_at desc, c.id desc
      limit $${params.length}`,
    params
  )
  const pagina = montarPagina(linhas, tamanho, (l) => ({ o: 'recentes', v: [l.issued_at, l.id] }))
  return {
    certificados: pagina.itens.map((r) => ({
      codigo: r.code,
      titulo: r.title,
      horas: Number(r.hours),
      contratante: r.issuer_name,
      categoria: r.category,
      modalidade: r.modality,
      emitidoEm: r.issued_at,
      registrado: Boolean(r.asset_id),
      emProcessamento: !r.asset_id,
      hash: r.content_hash,
      links: {
        verificacao: `/verificar/${r.code}`,
        imagem: `/api/certificates/${r.code}/image.svg`
      }
    })),
    proximoCursor: pagina.proximoCursor,
    temMais: pagina.temMais
  }
}
