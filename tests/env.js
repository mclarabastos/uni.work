// Ambiente da suite.
//
// Nota sobre concorrencia: o package.json roda a suite com
// --test-concurrency=4 em vez do padrao (um processo por nucleo). Cada arquivo
// sobe um PGlite proprio, que e Postgres compilado para WASM, e um deles carrega
// dez mil vagas. Sem limite, a maquina fica sem folga e um arquivo qualquer
// morre por pressao de memoria, com "test failed" e nenhum teste individual
// falhando. Nao e defeito do produto, e o custo de subir onze bancos ao mesmo
// tempo.
//
// Este arquivo nao importa nada de proposito. Em ESM as importacoes sao
// avaliadas antes de qualquer statement do modulo, entao se estas atribuicoes
// morassem em helpers.js elas rodariam DEPOIS de config.js ja ter lido o
// ambiente. Isolando aqui e importando este arquivo primeiro, a ordem fecha.

process.env.NODE_ENV = 'test'
process.env.PGLITE_DIR = 'memory://'

// Por padrao a suite roda no PGlite em memoria, sem tocar disco nem rede.
// Com UNIWORK_FORCA_POSTGRES=1 (o que npm run test:pg faz) ela roda contra o
// Postgres apontado por DATABASE_URL, para provar que os dois drivers passam.
const contraPostgres = process.env.UNIWORK_FORCA_POSTGRES === '1' && process.env.DATABASE_URL
process.env.WALLET_MASTER_KEY = process.env.WALLET_MASTER_KEY ?? 'chave-de-teste-fixa-para-a-suite-0123456789'
process.env.PUBLIC_BASE_URL = 'https://uniwork.test'
process.env.SOLANA_CLUSTER = 'devnet'

// A suite roda offline. Um RPC que nao existe garante isso na marra: se algum
// codigo tentar sair para a rede sem passar por setConnection(), ele falha na
// hora em vez de esperar o timeout de um servidor de verdade. E o que faz o
// caminho de fallback do certificado ser exercitado rapido.
process.env.SOLANA_RPC_URL = 'http://127.0.0.1:1'
// Por padrao a suite roda no driver vault, que nao precisa de programa
// deployado. Com UNIWORK_TESTAR_ANCHOR=1 (npm run test:anchor) ela roda no
// driver anchor, com um program id de teste, para provar que o caminho do
// programa tambem esta de pe do lado do Node.
if (process.env.UNIWORK_TESTAR_ANCHOR === '1') {
  process.env.ESCROW_DRIVER = 'anchor'
  process.env.ESCROW_PROGRAM_ID = process.env.ESCROW_PROGRAM_ID || 'EscRoW1111111111111111111111111111111111111'
} else {
  process.env.ESCROW_DRIVER = 'vault'
}
process.env.PLATFORM_FEE_BPS = '500'
if (contraPostgres) {
  // Os arquivos de teste rodam em processos paralelos. Contra o PGlite cada um
  // ganha um banco proprio em memoria; contra um Postgres compartilhado eles
  // pisariam uns nos outros, entao cada processo ganha um schema so seu.
  process.env.UNIWORK_TEST_SCHEMA = `teste_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
} else {
  delete process.env.DATABASE_URL
}
delete process.env.HELIUS_API_KEY
