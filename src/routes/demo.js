// Contas de exemplo para a tela de entrada.
//
// Existe porque o produto e avaliado em minutos: quem abre a demonstracao
// precisa entrar como estudante e como contratante sem inventar dois cadastros
// antes de ver a primeira tela.
//
// Isto e uma facilidade de demonstracao, e nao um recurso do produto:
//
//   - em producao a rota responde disponivel: false e lista vazia, sempre;
//   - so lista as personas ficticias do brief, casadas por e-mail contra a
//     lista fixa em src/domain/personas.js. Uma conta de verdade criada neste
//     ambiente nunca aparece aqui;
//   - nunca devolve nada que sirva de credencial: o login por e-mail ja e
//     aberto neste ambiente, e a lista apenas evita digitar o endereco.

import { Router } from 'express'
import { many } from '../db/index.js'
import { config } from '../config.js'
import { EMAILS_DE_EXEMPLO } from '../domain/personas.js'
import { asyncRoute } from './helpers.js'

export const demoRouter = Router()

const POR_PERFIL = 3

demoRouter.get('/contas', asyncRoute(async (_req, res) => {
  if (config.isProduction) {
    return res.json({
      disponivel: false,
      motivo: 'As contas de exemplo existem apenas no ambiente de demonstracao.',
      estudantes: [],
      contratantes: []
    })
  }

  const linhas = await many(
    `select id, role, name, email, university, course, headline
       from users
      where blocked_at is null
        and email = any($1)
      order by role, created_at`,
    [[...EMAILS_DE_EXEMPLO]]
  )

  const mapear = (papel) => linhas
    .filter((u) => u.role === papel)
    .slice(0, POR_PERFIL)
    .map((u) => ({
      id: u.id,
      nome: u.name,
      email: u.email,
      detalhe: papel === 'student'
        ? ([u.course, u.university].filter(Boolean).join(' · ') || 'Estudante')
        : (u.headline || 'Contratante')
    }))

  const estudantes = mapear('student')
  const contratantes = mapear('company')

  res.json({
    disponivel: estudantes.length > 0 || contratantes.length > 0,
    motivo: estudantes.length || contratantes.length
      ? null
      : 'Nenhuma conta de exemplo neste ambiente. Rode npm run seed para criar as personas.',
    estudantes,
    contratantes
  })
}))
