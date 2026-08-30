#!/usr/bin/env node
// npm run seed — popula o banco com o ecossistema de exemplo.
//
// Cria contas de estudante e de contratante, publica vagas nas duas
// modalidades e deixa algumas em estagios diferentes da trilha, para a tela
// nao abrir vazia numa demonstracao.
//
// Se a rede estiver no ar e o bootstrap tiver rodado, tambem distribui o token
// de teste para as contas de exemplo, para o contratante conseguir reservar
// valor de verdade. Se a rede nao estiver, o seed continua: ele diz o que
// deixou de fazer em vez de fingir que fez.

import { getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import { Keypair, PublicKey } from '@solana/web3.js'
import { migrar } from '../src/db/migrate.js'
import { query, one, closeDb } from '../src/db/index.js'
import { newId } from '../src/lib/ids.js'
import { createAccount } from '../src/services/wallet.js'
import { readPlatformState } from '../src/services/platform.js'
import { getConnection } from '../src/services/solana.js'
import { TOKEN_DECIMALS } from '../src/lib/money.js'
import { config } from '../src/config.js'

const ok = (t) => console.log(`  ok   ${t}`)
const passo = (t) => console.log(`  ${t}`)
const aviso = (t) => console.log(`  !    ${t}`)

const ESTUDANTES = [
  { nome: 'Marina Alves', email: 'marina@usp.br', universidade: 'USP', curso: 'Design', headline: 'Design de produto e pesquisa com usuario' },
  { nome: 'Rafael Souza', email: 'rafael@unicamp.br', universidade: 'Unicamp', curso: 'Engenharia de Computacao', headline: 'Desenvolvimento web e automacao' },
  { nome: 'Beatriz Lima', email: 'beatriz@ufmg.br', universidade: 'UFMG', curso: 'Letras', headline: 'Traducao PT/EN e revisao de texto' },
  { nome: 'Caio Mendes', email: 'caio@ufrj.br', universidade: 'UFRJ', curso: 'Publicidade', headline: 'Producao de evento e conteudo' },
  { nome: 'Larissa Prado', email: 'larissa@puc-rio.br', universidade: 'PUC-Rio', curso: 'Matematica', headline: 'Monitoria de calculo e estatistica' }
]

const CONTRATANTES = [
  { nome: 'Produtora XPTO', email: 'contato@xpto.com.br', headline: 'Producao de eventos corporativos' },
  { nome: 'Instituto Beta', email: 'projetos@institutobeta.org', headline: 'Pesquisa aplicada e extensao' },
  { nome: 'Faculdade Gama', email: 'coordenacao@gama.edu.br', headline: 'Ensino superior' },
  { nome: 'Estudio Delta', email: 'oi@estudiodelta.co', headline: 'Design e produto digital' }
]

const VAGAS = [
  {
    contratante: 0, titulo: 'Staff de credenciamento no congresso de tecnologia',
    descricao: 'Recepcao e credenciamento dos participantes durante dois dias de congresso. Voce vai operar o balcao de entrada, conferir inscricoes e entregar os kits. Procuramos gente comunicativa, pontual e confortavel com fila grande.',
    categoria: 'Eventos', modalidade: 'presencial', local: 'Sao Paulo, SP',
    valorCentavos: 24000, horas: 12, estagio: 'garantida'
  },
  {
    contratante: 3, titulo: 'Redesenho da tela de assinatura de um aplicativo',
    descricao: 'Precisamos repensar o fluxo de assinatura do nosso aplicativo, hoje com desistencia alta na terceira etapa. Entrega esperada: fluxo em Figma, com estados de erro e versao mobile.',
    categoria: 'Design', modalidade: 'remoto', local: null,
    valorCentavos: 90000, horas: 24, estagio: 'aceita'
  },
  {
    contratante: 1, titulo: 'Traducao de artigo cientifico de portugues para ingles',
    descricao: 'Artigo de aproximadamente 4000 palavras sobre energia renovavel, para submissao internacional. Precisa de tradutor confortavel com vocabulario tecnico e norma de publicacao academica.',
    categoria: 'Traducao', modalidade: 'remoto', local: null,
    valorCentavos: 45000, horas: 10, estagio: 'entregue'
  },
  {
    contratante: 2, titulo: 'Monitoria de calculo 1 para turma de engenharia',
    descricao: 'Duas sessoes semanais de monitoria presencial ao longo do semestre, com preparacao de lista de exercicios e plantao de duvidas antes das provas.',
    categoria: 'Monitoria', modalidade: 'presencial', local: 'Campinas, SP',
    valorCentavos: 60000, horas: 20, estagio: 'concluida'
  },
  {
    contratante: 1, titulo: 'Pesquisa de campo sobre mobilidade urbana',
    descricao: 'Aplicacao de questionario presencial em quatro pontos da cidade, ao longo de uma semana. Treinamento e material fornecidos. Ideal para quem estuda ciencias sociais ou urbanismo.',
    categoria: 'Pesquisa', modalidade: 'presencial', local: 'Belo Horizonte, MG',
    valorCentavos: 36000, horas: 16, estagio: 'aberta'
  },
  {
    contratante: 3, titulo: 'Componente de calendario em React para o nosso produto',
    descricao: 'Implementar um seletor de intervalo de datas acessivel, com navegacao por teclado, em React e TypeScript. Testes inclusos na entrega. O design ja existe.',
    categoria: 'Desenvolvimento', modalidade: 'remoto', local: null,
    valorCentavos: 120000, horas: 30, estagio: 'aberta'
  },
  {
    contratante: 0, titulo: 'Fotografia de formatura de engenharia',
    descricao: 'Cobertura fotografica da colacao de grau e da festa, com entrega de 200 fotos tratadas em ate dez dias. Equipamento proprio necessario.',
    categoria: 'Fotografia', modalidade: 'presencial', local: 'Sao Paulo, SP',
    valorCentavos: 80000, horas: 8, estagio: 'aberta'
  },
  {
    contratante: 2, titulo: 'Producao de conteudo para o blog institucional',
    descricao: 'Oito textos de 800 palavras sobre vida universitaria, ao longo de um mes, com pauta definida em conjunto. Revisao inclusa.',
    categoria: 'Conteudo', modalidade: 'remoto', local: null,
    valorCentavos: 64000, horas: 20, estagio: 'aberta'
  }
]

// Quanto cada conta de exemplo recebe do token de teste, em "reais".
const DOTACAO_CONTRATANTE = 500000

console.log('\n  seed do ecossistema de exemplo\n')
await migrar()

const jaTem = await one('select count(*)::int as n from users')
if (jaTem.n > 0 && !process.argv.includes('--forcar')) {
  aviso(`o banco ja tem ${jaTem.n} conta(s). Nada a fazer.`)
  console.log('  Para recomecar do zero: npm run reset && npm run seed\n')
  await closeDb()
  process.exit(0)
}

// ─── contas ──────────────────────────────────────────────────────────────────
const criados = { estudantes: [], contratantes: [] }

async function criarConta (dados, role) {
  const id = newId('usr')
  const conta = await createAccount()
  await query(
    `insert into users (id, role, name, email, headline, university, course, verified_email)
     values ($1, $2, $3, $4, $5, $6, $7, true)`,
    [id, role, dados.nome, dados.email, dados.headline ?? null, dados.universidade ?? null, dados.curso ?? null]
  )
  await query('insert into accounts (user_id, public_key, secret_cipher) values ($1, $2, $3)',
    [id, conta.publicKey, conta.secretCipher])
  await query('insert into notification_preferences (user_id) values ($1) on conflict do nothing', [id])
  return { id, ...dados, publicKey: conta.publicKey, role }
}

for (const dados of ESTUDANTES) criados.estudantes.push(await criarConta(dados, 'student'))
for (const dados of CONTRATANTES) criados.contratantes.push(await criarConta(dados, 'company'))
ok(`${criados.estudantes.length} estudantes e ${criados.contratantes.length} contratantes`)

// ─── vagas ───────────────────────────────────────────────────────────────────
// O seed grava o estagio direto no banco. Reservar valor e liberar pagamento
// de verdade e trabalho do fluxo do produto, nao do seed: quem quiser ver isso
// acontecendo roda npm run demo.
const ESTAGIOS = {
  aberta: {},
  garantida: { funded_at: 'now()' },
  aceita: { funded_at: 'now()', accepted_at: 'now()', comEstudante: true },
  em_andamento: { funded_at: 'now()', accepted_at: 'now()', started_at: 'now()', comEstudante: true },
  entregue: { funded_at: 'now()', accepted_at: 'now()', started_at: 'now()', delivered_at: 'now()', comEstudante: true },
  concluida: { funded_at: 'now()', accepted_at: 'now()', started_at: 'now()', delivered_at: 'now()', completed_at: 'now()', comEstudante: true }
}

const vagasCriadas = []
for (const [indice, vaga] of VAGAS.entries()) {
  const id = newId('job')
  const contratante = criados.contratantes[vaga.contratante]
  const estagio = ESTAGIOS[vaga.estagio]
  const estudante = estagio.comEstudante ? criados.estudantes[indice % criados.estudantes.length] : null

  const colunasData = Object.entries(estagio)
    .filter(([chave]) => chave !== 'comEstudante')
    .map(([chave]) => `, ${chave}`)
    .join('')
  const valoresData = Object.entries(estagio)
    .filter(([chave]) => chave !== 'comEstudante')
    .map(([, valor]) => `, ${valor}`)
    .join('')

  await query(
    `insert into jobs (id, company_id, student_id, title, description, category, modality,
                       location, amount_cents, hours, status, fee_bps${colunasData})
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12${valoresData})`,
    [id, contratante.id, estudante?.id ?? null, vaga.titulo, vaga.descricao, vaga.categoria,
      vaga.modalidade, vaga.local, vaga.valorCentavos, vaga.horas, vaga.estagio, config.escrow.feeBps]
  )
  vagasCriadas.push({ id, ...vaga, contratante, estudante })

  // Candidaturas: as vagas abertas recebem interesse, e a escolhida fica aceita.
  const candidatos = criados.estudantes.slice(0, 2 + (indice % 3))
  for (const candidato of candidatos) {
    if (estudante && candidato.id === estudante.id) continue
    await query(
      'insert into applications (id, job_id, student_id, pitch, status) values ($1, $2, $3, $4, $5) on conflict do nothing',
      [newId('app'), id, candidato.id,
        `Tenho experiencia com ${vaga.categoria.toLowerCase()} e disponibilidade para o periodo.`,
        estudante ? 'recusada' : 'pendente']
    )
  }
  if (estudante) {
    await query(
      'insert into applications (id, job_id, student_id, pitch, status) values ($1, $2, $3, $4, $5) on conflict do nothing',
      [newId('app'), id, estudante.id, 'Ja fiz um trabalho parecido no semestre passado.', 'aceita']
    )
  }

  // Eventos da timeline, para a vaga nao abrir sem historia.
  const trilha = ['vaga.publicada']
  if (estagio.funded_at) trilha.push('vaga.garantida')
  if (estagio.accepted_at) trilha.push('vaga.aceita')
  if (estagio.started_at) trilha.push('vaga.iniciada')
  if (estagio.delivered_at) trilha.push('vaga.entregue')
  if (estagio.completed_at) trilha.push('vaga.concluida', 'certificado.emitido')
  for (const [ordem, tipo] of trilha.entries()) {
    await query(
      'insert into events (id, type, job_id, actor_id, created_at) values ($1, $2, $3, $4, now() - make_interval(mins => $5))',
      [newId('evt'), tipo, id, contratante.id, (trilha.length - ordem) * 37]
    )
  }
}
ok(`${vagasCriadas.length} vagas em estagios diferentes da trilha`)

// ─── certificado da vaga concluida ───────────────────────────────────────────
const { buildContent, buildMetadata, contentHash } = await import('../src/services/certificate.js')
const { newVerificationCode } = await import('../src/lib/ids.js')

for (const vaga of vagasCriadas.filter((v) => v.estagio === 'concluida')) {
  const code = newVerificationCode()
  const conteudo = buildContent({
    code, title: vaga.titulo, hours: vaga.horas,
    studentName: vaga.estudante.nome, issuerName: vaga.contratante.nome,
    category: vaga.categoria, modality: vaga.modalidade, completedAt: new Date()
  })
  const hash = contentHash(conteudo)
  await query(
    `insert into certificates (id, code, job_id, student_id, title, hours, issuer_name,
                               content_hash, metadata, driver)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'memo')`,
    [newId('cer'), code, vaga.id, vaga.estudante.id, vaga.titulo, vaga.horas,
      vaga.contratante.nome, hash, JSON.stringify(buildMetadata({ content: conteudo, hash, code }))]
  )
  ok(`certificado de exemplo emitido: ${code} (${vaga.horas}h para ${vaga.estudante.nome})`)
}

// ─── mensagens e avaliacoes ──────────────────────────────────────────────────
for (const vaga of vagasCriadas.filter((v) => v.estudante)) {
  await query('insert into messages (id, job_id, sender_id, body) values ($1, $2, $3, $4)',
    [newId('msg'), vaga.id, vaga.contratante.id, 'Oi! Obrigado por topar. Alguma duvida sobre o combinado?'])
  await query('insert into messages (id, job_id, sender_id, body) values ($1, $2, $3, $4)',
    [newId('msg'), vaga.id, vaga.estudante.id, 'Oi! Tudo claro por aqui. Ja comecei a me organizar.'])
}
for (const vaga of vagasCriadas.filter((v) => v.estagio === 'concluida')) {
  await query('insert into reviews (id, job_id, author_id, target_id, rating, comment) values ($1, $2, $3, $4, 5, $5)',
    [newId('rev'), vaga.id, vaga.contratante.id, vaga.estudante.id, 'Pontual e organizada. Contrataria de novo.'])
  await query('insert into reviews (id, job_id, author_id, target_id, rating, comment) values ($1, $2, $3, $4, 5, $5)',
    [newId('rev'), vaga.id, vaga.estudante.id, vaga.contratante.id, 'Combinado claro e pagamento na hora.'])
}
ok('mensagens e avaliacoes de exemplo')

// ─── distribuicao do token de teste, se a rede permitir ──────────────────────
const estado = readPlatformState()
if (!estado?.usdcMint) {
  aviso('bootstrap ainda nao rodou, entao nao distribui o valor de teste.')
  passo('     rode: npm run bootstrap && npm run seed --forcar')
} else {
  passo('distribuindo o valor de teste para os contratantes de exemplo…')
  try {
    const conexao = getConnection()
    const plataforma = Keypair.fromSecretKey(Uint8Array.from(estado.secretKey))
    const mint = new PublicKey(estado.usdcMint)
    let distribuidos = 0
    for (const contratante of criados.contratantes) {
      const conta = await getOrCreateAssociatedTokenAccount(
        conexao, plataforma, mint, new PublicKey(contratante.publicKey)
      )
      await mintTo(
        conexao, plataforma, mint, conta.address, plataforma,
        BigInt(DOTACAO_CONTRATANTE) * BigInt(10 ** TOKEN_DECIMALS) / 100n
      )
      distribuidos += 1
    }
    ok(`${distribuidos} contratantes com saldo para reservar valor de verdade`)
  } catch (err) {
    aviso(`nao consegui distribuir agora: ${err.message}`)
    passo('     as vagas continuam na tela; reservar valor vai falhar ate a rede voltar.')
  }
}

console.log(`
  pronto

    entre com qualquer um destes e-mails (nao ha senha):

      estudante     ${ESTUDANTES[0].email}
      contratante   ${CONTRATANTES[0].email}

    npm run dev  e abra http://localhost:${config.port}
`)

await closeDb()
