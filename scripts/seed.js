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
import { ESTUDANTES, CONTRATANTES } from '../src/domain/personas.js'

const ok = (t) => console.log(`  ok   ${t}`)
const passo = (t) => console.log(`  ${t}`)
const aviso = (t) => console.log(`  !    ${t}`)

/**
 * Registra na camada tecnica o que o seed mandou para a rede.
 *
 * Sem isto, a gaveta tecnica mostraria vaga garantida sem nenhuma transacao
 * atras dela — e e justamente ali que alguem vai conferir se o valor entrou.
 */
async function registrarTxDoSeed (jobId, tipo, resultado) {
  await query(
    `insert into chain_tx (id, job_id, kind, status, cluster, signature, instructions, detail, confirmed_at)
     values ($1, $2, $3, 'confirmada', $4, $5, $6, $7, now())`,
    [newId('ctx'), jobId, tipo, config.solana.cluster, resultado.signature,
      JSON.stringify(resultado.instructionsDescribed ?? []),
      JSON.stringify({ driver: resultado.driver, peloSeed: true })]
  )
}


const VAGAS = [
  {
    contratante: 0, titulo: 'Staff de credenciamento no congresso de tecnologia',
    descricao: 'Recepção e credenciamento dos participantes durante dois dias de congresso. Você vai operar o balcão de entrada, conferir inscrições e entregar os kits. Procuramos gente comunicativa, pontual e confortável com fila grande.',
    categoria: 'Eventos', modalidade: 'presencial', local: 'São Paulo, SP',
    valorCentavos: 24000, horas: 12, estagio: 'garantida'
  },
  {
    contratante: 3, titulo: 'Redesenho da tela de assinatura de um aplicativo',
    descricao: 'Precisamos repensar o fluxo de assinatura do nosso aplicativo, hoje com desistência alta na terceira etapa. Entrega esperada: fluxo em Figma, com estados de erro e versão mobile.',
    categoria: 'Design', modalidade: 'remoto', local: null,
    valorCentavos: 90000, horas: 24, estagio: 'aceita'
  },
  {
    contratante: 1, titulo: 'Tradução de artigo científico de português para inglês',
    descricao: 'Artigo de aproximadamente 4000 palavras sobre energia renovável, para submissão internacional. Precisa de tradutor confortável com vocabulário técnico e norma de publicação acadêmica.',
    categoria: 'Tradução', modalidade: 'remoto', local: null,
    valorCentavos: 45000, horas: 10, estagio: 'entregue'
  },
  {
    contratante: 2, titulo: 'Monitoria de cálculo 1 para turma de engenharia',
    descricao: 'Duas sessões semanais de monitoria presencial ao longo do semestre, com preparação de lista de exercícios e plantão de dúvidas antes das provas.',
    categoria: 'Monitoria', modalidade: 'presencial', local: 'Campinas, SP',
    valorCentavos: 60000, horas: 20, estagio: 'concluida'
  },
  {
    contratante: 1, titulo: 'Pesquisa de campo sobre mobilidade urbana',
    descricao: 'Aplicação de questionário presencial em quatro pontos da cidade, ao longo de uma semana. Treinamento e material fornecidos. Ideal para quem estuda ciências sociais ou urbanismo.',
    categoria: 'Pesquisa', modalidade: 'presencial', local: 'Belo Horizonte, MG',
    valorCentavos: 36000, horas: 16, estagio: 'aberta'
  },
  {
    contratante: 3, titulo: 'Componente de calendário em React para o nosso produto',
    descricao: 'Implementar um seletor de intervalo de datas acessível, com navegação por teclado, em React e TypeScript. Testes inclusos na entrega. O design já existe.',
    categoria: 'Desenvolvimento', modalidade: 'remoto', local: null,
    valorCentavos: 120000, horas: 30, estagio: 'aberta'
  },
  {
    contratante: 0, titulo: 'Fotografia de formatura de engenharia',
    descricao: 'Cobertura fotográfica da colação de grau e da festa, com entrega de 200 fotos tratadas em até dez dias. Equipamento próprio necessário.',
    categoria: 'Fotografia', modalidade: 'presencial', local: 'São Paulo, SP',
    valorCentavos: 80000, horas: 8, estagio: 'aberta'
  },
  {
    contratante: 2, titulo: 'Produção de conteúdo para o blog institucional',
    descricao: 'Oito textos de 800 palavras sobre vida universitária, ao longo de um mês, com pauta definida em conjunto. Revisão inclusa.',
    categoria: 'Conteúdo', modalidade: 'remoto', local: null,
    valorCentavos: 64000, horas: 20, estagio: 'aberta'
  }
]

// Quanto cada conta de exemplo recebe do token de teste, em "reais".
const DOTACAO_CONTRATANTE = 500000

console.log('\n  seed do ecossistema de exemplo\n')
await migrar()

const jaTem = await one('select count(*)::int as n from users')
if (jaTem.n > 0 && !process.argv.includes('--forcar')) {
  aviso(`o banco já tem ${jaTem.n} conta(s). Nada a fazer.`)
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
        `Tenho experiência com ${vaga.categoria.toLowerCase()} e disponibilidade para o período.`,
        estudante ? 'recusada' : 'pendente']
    )
  }
  if (estudante) {
    await query(
      'insert into applications (id, job_id, student_id, pitch, status) values ($1, $2, $3, $4, $5) on conflict do nothing',
      [newId('app'), id, estudante.id, 'Já fiz um trabalho parecido no semestre passado.', 'aceita']
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
ok(`${vagasCriadas.length} vagas em estágios diferentes da trilha`)

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
    [newId('msg'), vaga.id, vaga.contratante.id, 'Oi! Obrigado por topar. Alguma dúvida sobre o combinado?'])
  await query('insert into messages (id, job_id, sender_id, body) values ($1, $2, $3, $4)',
    [newId('msg'), vaga.id, vaga.estudante.id, 'Oi! Tudo claro por aqui. Já comecei a me organizar.'])
}
for (const vaga of vagasCriadas.filter((v) => v.estagio === 'concluida')) {
  await query('insert into reviews (id, job_id, author_id, target_id, rating, comment) values ($1, $2, $3, $4, 5, $5)',
    [newId('rev'), vaga.id, vaga.contratante.id, vaga.estudante.id, 'Pontual e organizada. Contrataria de novo.'])
  await query('insert into reviews (id, job_id, author_id, target_id, rating, comment) values ($1, $2, $3, $4, 5, $5)',
    [newId('rev'), vaga.id, vaga.estudante.id, vaga.contratante.id, 'Combinado claro e pagamento na hora.'])
}
ok('mensagens e avaliações de exemplo')

// ─── distribuicao do token de teste, se a rede permitir ──────────────────────
const estado = readPlatformState()
if (!estado?.usdcMint) {
  aviso('bootstrap ainda não rodou, então não distribui o valor de teste.')
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
    aviso(`não consegui distribuir agora: ${err.message}`)
    passo('     as vagas continuam na tela; reservar valor vai falhar até a rede voltar.')
  }

  // ─── cofre de verdade para as vagas que já nascem adiantadas ───────────────
  //
  // As vagas de exemplo entram no banco com funded_at preenchido, para a tela
  // abrir com trampo em cada etapa. Sem reservar de fato, esse funded_at e uma
  // mentira que só aparece no pior momento: quem clica em "confirmar a entrega"
  // vê a liberação falhar, porque nunca houve valor no cofre.
  //
  // Aqui o dinheiro entra no cofre de verdade, com a chave do contratante de
  // exemplo, do mesmo jeito que a interface faria.
  const adiantadas = vagasCriadas.filter((v) => !['aberta', 'cancelada'].includes(v.estagio))
  if (adiantadas.length) {
    passo(`reservando o valor de ${adiantadas.length} vaga(s) adiantada(s) na rede…`)
    const { fundEscrow, releaseEscrow } = await import('../src/services/escrow.js')
    const { accountKeyFor } = await import('../src/domain/auth.js')
    const { openAccount } = await import('../src/services/wallet.js')

    let reservadas = 0
    let liberadas = 0
    for (const vaga of adiantadas) {
      try {
        const contaEmpresa = await accountKeyFor(vaga.contratante.id)
        const chaveEmpresa = await openAccount(contaEmpresa.secret_cipher)
        const reserva = await fundEscrow({
          jobId: vaga.id,
          companyPubkey: contaEmpresa.public_key,
          companyKeypair: chaveEmpresa,
          amountCents: vaga.valorCentavos,
          feeBps: config.escrow.feeBps
        })
        await registrarTxDoSeed(vaga.id, 'escrow_fund', reserva)
        reservadas += 1

        // A vaga concluida precisa do outro lado: o valor tem de ter saido do
        // cofre, senao ela mostra pagamento feito com o cofre ainda cheio.
        if (vaga.estagio === 'concluida') {
          const contaEstudante = await accountKeyFor(vaga.estudante.id)
          const liberacao = await releaseEscrow({
            jobId: vaga.id,
            studentPubkey: contaEstudante.public_key,
            companyPubkey: contaEmpresa.public_key,
            companyKeypair: chaveEmpresa,
            amountCents: vaga.valorCentavos,
            feeBps: config.escrow.feeBps
          })
          await registrarTxDoSeed(vaga.id, 'escrow_release', liberacao)
          liberadas += 1
        }
      } catch (err) {
        aviso(`a vaga "${vaga.titulo.slice(0, 40)}" ficou sem cofre: ${err.message.slice(0, 90)}`)
        passo('     confirmar a entrega dela vai falhar na liberação até isto ser resolvido.')
      }
    }
    ok(`${reservadas} cofre(s) com valor de verdade${liberadas ? ` e ${liberadas} já liberado(s)` : ''}`)
  }
}

console.log(`
  pronto

    entre com qualquer um destes e-mails (não há senha):

      estudante     ${ESTUDANTES[0].email}
      contratante   ${CONTRATANTES[0].email}

    npm run dev  e abra http://localhost:${config.port}
`)

await closeDb()
