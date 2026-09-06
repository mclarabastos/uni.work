#!/usr/bin/env node
// npm run doctor — diagnostico do ambiente em vinte segundos.
//
// Regra deste arquivo: nada de mock silencioso. Se uma integracao nao esta
// configurada, ele diz que nao esta e diz o que fazer. Ele nunca dá verde em
// algo que so funcionaria de mentira.

import fs from 'node:fs'
import path from 'node:path'
import { config, rootDir } from '../src/config.js'
import { dbInfo, query, closeDb } from '../src/db/index.js'
import { statusDasMigrations } from '../src/db/migrate.js'
import { platformSummary, SCHEMA_VERSION, platformStatePath } from '../src/services/platform.js'
import { getConnection, getSolBalance, getPaymentBalance } from '../src/services/solana.js'
import { indexerAvailable } from '../src/services/das.js'
import { driverDeEmail, emailConfigurado } from '../src/services/mailer.js'
import { pushConfigurado } from '../src/services/push.js'
import { driverDeArmazenamento, armazenamentoPronto } from '../src/services/storage.js'

const OK = 'ok  '
const AVISO = 'aviso'
const ERRO = 'erro'

const achados = []
function registrar (nivel, area, mensagem, comoResolver = null) {
  achados.push({ nivel, area, mensagem, comoResolver })
}

const comTempo = async (rotulo, fn, limiteMs = 8000) => {
  const inicio = Date.now()
  try {
    const valor = await Promise.race([
      fn(),
      new Promise((_, rejeitar) => setTimeout(() => rejeitar(new Error(`sem resposta em ${limiteMs}ms`)), limiteMs))
    ])
    return { ok: true, valor, ms: Date.now() - inicio }
  } catch (err) {
    return { ok: false, erro: err.message, ms: Date.now() - inicio, rotulo }
  }
}

console.log('\n  diagnóstico do Uni.work\n')

// ─── ambiente ────────────────────────────────────────────────────────────────
const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor >= 20) registrar(OK, 'node', `${process.version}`)
else registrar(ERRO, 'node', `${process.version} e antigo demais`, 'instale o Node 20 ou mais novo')

if (fs.existsSync(path.join(rootDir, '.env'))) registrar(OK, 'env', '.env encontrado')
else registrar(AVISO, 'env', '.env não existe, rodando só com os padroes', 'copie .env.example para .env')

if (config.security.masterKeyIsEphemeral) {
  registrar(AVISO, 'seguranca',
    'WALLET_MASTER_KEY não configurada: usando uma chave derivada do caminho do projeto',
    'gere uma: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" e coloque no .env')
} else {
  registrar(OK, 'seguranca', 'chave mestra configurada')
}

if (config.isProduction && config.publicBaseUrlIsLocal) {
  registrar(ERRO, 'seguranca', 'PUBLIC_BASE_URL aponta para localhost em produção',
    'aponte para o dominio público: o certificado emitido carrega essa URL para sempre')
} else if (config.publicBaseUrlIsLocal) {
  registrar(AVISO, 'certificado', 'PUBLIC_BASE_URL e localhost: um indexador externo não alcança os metadados',
    'para demonstrar a leitura de fora, use um tunel (cloudflared, ngrok) e coloque a URL no .env')
} else {
  registrar(OK, 'certificado', `metadados servidos de ${config.publicBaseUrl}`)
}

// ─── banco ───────────────────────────────────────────────────────────────────
const banco = await comTempo('banco', async () => {
  const info = await dbInfo()
  const status = await statusDasMigrations()
  const { rows } = await query(`
    select (select count(*)::int from users)        as usuarios,
           (select count(*)::int from jobs)         as vagas,
           (select count(*)::int from certificates) as certificados,
           (select count(*)::int from chain_jobs where done_at is null) as fila
  `)
  return { info, status, contagem: rows[0] }
}, 15000)

if (!banco.ok) {
  registrar(ERRO, 'banco', banco.erro, 'confira DATABASE_URL, ou remova para usar o PGlite embarcado')
} else {
  registrar(OK, 'banco', `${banco.valor.info.label} em ${banco.ms}ms`)
  const m = banco.valor.status
  if (!m.inicializado || m.pendentes.length) {
    registrar(ERRO, 'migrations', `${m.pendentes.length || 'todas as'} migration(s) pendente(s)`, 'npm run migrate')
  } else {
    registrar(OK, 'migrations', `${m.aplicadas.length} aplicadas, schema ${m.aplicadas.at(-1)}`)
  }
  if (m.alteradas?.length) {
    registrar(ERRO, 'migrations', `migration já aplicada foi editada: ${m.alteradas.join(', ')}`,
      'o banco não tem o que o arquivo diz que tem. Crie uma migration nova')
  }
  const c = banco.valor.contagem
  registrar(c.usuarios ? OK : AVISO, 'dados',
    `${c.usuarios} contas, ${c.vagas} vagas, ${c.certificados} certificados`,
    c.usuarios ? null : 'npm run seed')
  if (c.fila > 0) {
    registrar(AVISO, 'fila', `${c.fila} operação(oes) on-chain aguardando reprocessamento`,
      'o worker cuida sozinho; veja o detalhe em /api/chain/status')
  }
}

// ─── plataforma e rede ───────────────────────────────────────────────────────
const plataforma = platformSummary()
if (!plataforma.ready) {
  registrar(ERRO, 'plataforma', 'o ambiente de rede ainda não foi preparado', 'npm run bootstrap')
} else {
  registrar(OK, 'plataforma', `conta ${plataforma.publicKey}`)
  registrar(OK, 'pagamento', `token de teste ${plataforma.paymentMint}`)
  if (plataforma.merkleTree) {
    registrar(OK, 'certificado', `merkle tree ${plataforma.merkleTree} (${plataforma.treeCapacity} certificados)`)
  } else {
    registrar(AVISO, 'certificado', 'sem merkle tree: o certificado nasce como memo e e reprocessado',
      'npm run bootstrap')
  }
  if (plataforma.outdated) {
    registrar(AVISO, 'plataforma',
      `o estado de bootstrap e da versão ${plataforma.schemaVersion}, a atual e ${SCHEMA_VERSION}`,
      'npm run bootstrap para completar o que falta')
  }
  if (plataforma.bootstrappedAt) {
    const dias = Math.floor((Date.now() - new Date(plataforma.bootstrappedAt)) / 86400000)
    if (dias > 30) {
      registrar(AVISO, 'plataforma', `último bootstrap há ${dias} dias`,
        'devnet e limpa de tempos em tempos; rode npm run bootstrap se algo parar de responder')
    }
  }
  if (fs.existsSync(platformStatePath())) {
    const ignorado = fs.readFileSync(path.join(rootDir, '.gitignore'), 'utf8').includes('.uniwork')
    registrar(ignorado ? OK : ERRO, 'seguranca',
      ignorado ? 'o estado com a chave privada está fora do versionamento' : 'o estado com a chave privada NÃO está no .gitignore',
      ignorado ? null : 'adicione .uniwork/ ao .gitignore imediatamente')
  }
}

const rede = await comTempo('rede', async () => {
  const conexao = getConnection()
  const versao = await conexao.getVersion()
  return versao['solana-core']
})
if (rede.ok) {
  registrar(OK, 'rede', `${config.solana.cluster} respondeu em ${rede.ms}ms (solana-core ${rede.valor})`)
} else {
  registrar(ERRO, 'rede', `${config.solana.cluster} não respondeu: ${rede.erro}`,
    'confira SOLANA_RPC_URL, ou use uma chave do Helius para um RPC mais estável')
}

if (rede.ok && plataforma.ready) {
  const saldos = await comTempo('saldos', async () => ({
    sol: await getSolBalance(plataforma.publicKey),
    pagamento: await getPaymentBalance(plataforma.publicKey)
  }))
  if (saldos.ok) {
    const { sol, pagamento } = saldos.valor
    registrar(sol >= 0.2 ? OK : AVISO, 'taxas', `${sol.toFixed(3)} SOL na conta da plataforma`,
      sol >= 0.2 ? null : 'a plataforma paga a taxa de todo mundo: peca mais em https://faucet.solana.com')
    const emReais = Number(pagamento) / 10 ** 6
    registrar(pagamento > 0n ? OK : AVISO, 'suprimento',
      `${emReais.toLocaleString('pt-BR')} unidades de teste na conta da plataforma`,
      pagamento > 0n ? null : 'npm run bootstrap emite o suprimento de demonstração')
  } else {
    registrar(AVISO, 'saldos', `não consegui ler os saldos: ${saldos.erro}`)
  }
}

// ─── drivers ─────────────────────────────────────────────────────────────────
if (config.escrow.driver === 'anchor') {
  const programId = config.escrow.programId || plataforma.escrowProgramId
  if (!programId) {
    registrar(ERRO, 'escrow', 'driver anchor selecionado, mas não há ESCROW_PROGRAM_ID',
      'rode npm run setup com o toolchain Anchor instalado, ou volte para ESCROW_DRIVER=vault')
  } else {
    // O endereco declarado dentro do programa tem que ser o endereco onde ele
    // foi deployado. Quando os dois divergem o programa existe, esta executavel
    // e recusa toda instrucao com DeclaredProgramIdMismatch — a falha mais
    // traicoeira das tres, porque por fora parece um deploy bem-sucedido. Esta
    // conferencia nao depende da rede, entao roda antes dela.
    const fonte = path.join(rootDir, 'programs', 'uniwork-escrow', 'src', 'lib.rs')
    const declarado = fs.existsSync(fonte)
      ? fs.readFileSync(fonte, 'utf8').match(/declare_id!\(\s*"([^"]+)"\s*\)/)?.[1]
      : null

    if (declarado && declarado !== programId) {
      registrar(ERRO, 'escrow', `o programa declara ${declarado}, mas o deploy está em ${programId}`,
        'anchor keys sync, depois anchor build e anchor deploy (npm run setup faz os três)')
    }

    if (rede.ok) {
      const conta = await comTempo('programa', async () => {
        const { PublicKey } = await import('@solana/web3.js')
        return getConnection().getAccountInfo(new PublicKey(programId))
      })
      if (conta.ok && conta.valor?.executable) {
        registrar(OK, 'escrow', `programa Anchor deployado em ${programId}`)
      } else {
        registrar(ERRO, 'escrow', `não encontrei um programa executável em ${programId}`,
          'anchor deploy, ou volte para ESCROW_DRIVER=vault até o deploy sair')
      }
    }
  }
} else {
  registrar(AVISO, 'escrow', 'driver vault: o cofre e custodial, a autoridade e da plataforma',
    'o alvo e ESCROW_DRIVER=anchor, onde nem a plataforma consegue desviar o valor')
}

if (config.certificate.driver === 'bubblegum' && !plataforma.merkleTree) {
  registrar(AVISO, 'certificado', 'driver bubblegum sem árvore: vai cair no fallback de memo')
} else {
  registrar(OK, 'certificado', `driver ${config.certificate.driver}`)
}

if (emailConfigurado()) {
  registrar(OK, 'e-mail', `envio por ${driverDeEmail()}`)
} else {
  registrar(AVISO, 'e-mail', 'nenhum serviço de e-mail configurado: o link de acesso sai no terminal',
    'configure RESEND_API_KEY (https://resend.com) ou SMTP_URL no .env')
}

if (armazenamentoPronto()) {
  registrar(OK, 'arquivos', `armazenamento ${driverDeArmazenamento()}`)
} else {
  registrar(ERRO, 'arquivos', `armazenamento ${driverDeArmazenamento()} não está utilizável`,
    driverDeArmazenamento() === 's3'
      ? 'confira S3_BUCKET, S3_ACCESS_KEY_ID e S3_SECRET_ACCESS_KEY no .env'
      : 'confira a permissão de escrita em .uniwork/uploads')
}

if (pushConfigurado()) {
  registrar(OK, 'push', 'avisos no navegador configurados')
} else {
  registrar(AVISO, 'push', 'sem VAPID: os avisos no navegador ficam indisponíveis',
    'gere um par com npx web-push generate-vapid-keys e coloque VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY no .env')
}

if (indexerAvailable()) {
  registrar(OK, 'indexador', 'DAS API configurada: a confirmação do certificado vem de fora do nosso banco')
} else {
  registrar(AVISO, 'indexador', 'sem HELIUS_API_KEY: não há confirmação independente do certificado',
    'pegue uma chave gratuita em https://dashboard.helius.dev e coloque em HELIUS_API_KEY')
}

// ─── relatorio ───────────────────────────────────────────────────────────────
const larguraArea = Math.max(...achados.map((a) => a.area.length))
for (const achado of achados) {
  const marca = achado.nivel === OK ? '  ok  ' : achado.nivel === AVISO ? '  !   ' : '  X   '
  console.log(`${marca}${achado.area.padEnd(larguraArea)}  ${achado.mensagem}`)
  if (achado.comoResolver) console.log(`${' '.repeat(6 + larguraArea + 2)}  -> ${achado.comoResolver}`)
}

const erros = achados.filter((a) => a.nivel === ERRO).length
const avisos = achados.filter((a) => a.nivel === AVISO).length

console.log(`
  ${achados.length - erros - avisos} ok, ${avisos} aviso(s), ${erros} erro(s)
`)

if (erros) {
  console.log('  Com erro, o fluxo completo não roda. Resolva os itens marcados com X.\n')
} else if (avisos) {
  console.log('  Sem erro. Os avisos são coisas que funcionam em modo reduzido.\n')
} else {
  console.log('  Tudo pronto.\n')
}

// Fecha o banco e deixa o Node sair sozinho. Chamar process.exit() logo depois
// de fechar o PGlite derruba o processo com uma assercao do libuv no Windows,
// porque o worker dele ainda esta fechando.
process.exitCode = erros ? 1 : 0
await closeDb().catch(() => {})
