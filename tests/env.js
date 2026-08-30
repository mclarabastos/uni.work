// Ambiente da suite.
//
// Este arquivo nao importa nada de proposito. Em ESM as importacoes sao
// avaliadas antes de qualquer statement do modulo, entao se estas atribuicoes
// morassem em helpers.js elas rodariam DEPOIS de config.js ja ter lido o
// ambiente. Isolando aqui e importando este arquivo primeiro, a ordem fecha.

process.env.NODE_ENV = 'test'
process.env.PGLITE_DIR = 'memory://'
process.env.WALLET_MASTER_KEY = process.env.WALLET_MASTER_KEY ?? 'chave-de-teste-fixa-para-a-suite-0123456789'
process.env.PUBLIC_BASE_URL = 'https://uniwork.test'
process.env.SOLANA_CLUSTER = 'devnet'
process.env.ESCROW_DRIVER = 'vault'
process.env.PLATFORM_FEE_BPS = '500'
delete process.env.DATABASE_URL
delete process.env.HELIUS_API_KEY
