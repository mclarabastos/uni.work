// Estado da plataforma: o que o processo em pe sabe sobre o ambiente.
//
// Este arquivo existe por causa de um erro real, e do pior tipo: o produto dava
// a instrucao certa e ela nao funcionava. O bootstrap roda em outro processo e
// escreve o arquivo de estado; o servidor que ja estava no ar guardava a versao
// velha em memoria para sempre. A pessoa via "Token de pagamento ainda nao
// existe. Rode: npm run bootstrap", rodava o bootstrap, ele terminava certo — e
// a tela continuava falhando a mesma coisa, porque ninguem releu o arquivo.
//
// Só builtins entram como import estatico. Em ESM as importacoes sao avaliadas
// antes de qualquer statement, e este teste precisa apontar
// PLATFORM_STATE_FILE para um arquivo temporario ANTES de config.js ler o
// ambiente — a mesma razao pela qual env.js nao importa nada.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uniwork-plataforma-'))
const arquivo = path.join(dir, 'platform.json')

process.env.PLATFORM_STATE_FILE = arquivo
// O caminho em arquivo e justamente o que este teste exercita, entao a saida de
// emergencia por variavel de ambiente nao pode estar no caminho.
delete process.env.UNIWORK_PLATFORM_STATE

await import('./env.js')
const { Keypair } = await import('@solana/web3.js')
const plataforma = await import('../src/services/platform.js')

/** Um estado de plataforma em disco, como o bootstrap escreve. */
function escreverEstado (extra = {}) {
  const chave = Keypair.generate()
  const estado = {
    cluster: 'devnet',
    publicKey: chave.publicKey.toBase58(),
    secretKey: [...chave.secretKey],
    schemaVersion: 1,
    ...extra
  }
  fs.writeFileSync(arquivo, JSON.stringify(estado, null, 2) + '\n')
  return estado
}

test('o estado e relido quando o bootstrap escreve o arquivo com o processo em pe', (t) => {
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  // 1. Antes do bootstrap: nao existe estado nenhum.
  assert.equal(plataforma.readPlatformState(), null, 'sem arquivo, o estado e nulo')
  assert.equal(plataforma.platformSummary().ready, false)

  // 2. O bootstrap cria a conta, mas ainda sem o token de pagamento.
  escreverEstado()
  assert.ok(plataforma.readPlatformState()?.publicKey, 'a conta apareceu sem reiniciar o processo')
  assert.equal(plataforma.platformSummary().ready, false, 'sem token de pagamento, o ambiente nao esta pronto')

  // 3. O bootstrap termina e grava o token. E aqui que o defeito aparecia: o
  //    processo em pe seguia dizendo que o token nao existia.
  const mint = Keypair.generate().publicKey.toBase58()
  escreverEstado({ usdcMint: mint, merkleTree: Keypair.generate().publicKey.toBase58() })

  assert.equal(plataforma.readPlatformState().usdcMint, mint,
    'o token de pagamento tem de aparecer sem reiniciar o servidor')
  assert.equal(plataforma.platformSummary().ready, true, 'com token, o ambiente esta pronto')

  // 4. E o contrario tambem: reset --tudo apaga o arquivo, e o que ficou em
  //    memoria nao pode sobreviver ao apagamento.
  fs.rmSync(arquivo)
  assert.equal(plataforma.readPlatformState(), null, 'apagar o estado tem de esquecer o que estava em memoria')
})

test('o resumo distingue variavel ausente de variavel mal colada', (t) => {
  t.after(() => {
    delete process.env.UNIWORK_PLATFORM_STATE
    plataforma.clearPlatformStateCache()
  })

  // 1. Nada configurado, e nenhum arquivo no caminho: falta rodar o bootstrap.
  delete process.env.UNIWORK_PLATFORM_STATE
  plataforma.clearPlatformStateCache()
  const ausente = plataforma.platformSummary()
  assert.equal(ausente.ready, false)
  assert.equal(ausente.reason, 'bootstrap_pendente')
  assert.equal(ausente.fonte, 'ausente')

  // 2. Variavel presente e ilegivel. Este e o caso que mais custa tempo: uma
  //    variavel de ambiente atravessa painel e area de transferencia, e chega
  //    com quebra de linha no meio. Antes, o JSON.parse estourava dentro da
  //    checagem de saude — o endpoint devolvia erro em vez de dizer o motivo.
  process.env.UNIWORK_PLATFORM_STATE = '{"cluster":"devnet", isto nao e json'
  plataforma.clearPlatformStateCache()
  const invalido = plataforma.platformSummary()
  assert.equal(invalido.ready, false)
  assert.equal(invalido.reason, 'estado_invalido', 'nao pode dizer bootstrap_pendente: o valor chegou')
  assert.equal(invalido.fonte, 'variavel_invalida')
  assert.ok(invalido.erro, 'o motivo do parse vai no resumo, para o log')
  assert.equal(plataforma.readPlatformState(), null, 'estado ilegivel nao vira estado pela metade')

  // 3. Variavel correta: pronto, e dizendo de onde veio.
  process.env.UNIWORK_PLATFORM_STATE = JSON.stringify({
    cluster: 'devnet',
    publicKey: Keypair.generate().publicKey.toBase58(),
    usdcMint: Keypair.generate().publicKey.toBase58(),
    merkleTree: Keypair.generate().publicKey.toBase58()
  })
  plataforma.clearPlatformStateCache()
  const pronto = plataforma.platformSummary()
  assert.equal(pronto.ready, true)
  assert.equal(pronto.fonte, 'variavel', 'o resumo diz que o estado veio do ambiente, e nao do disco')
})

test('falta de ambiente preparado e erro permanente, e nao ganha oito tentativas', async () => {
  const { ambienteIncompleto, networkTrouble } = await import('../src/lib/errors.js')

  const permanente = ambienteIncompleto('Token de pagamento ainda nao existe. Rode: npm run bootstrap')
  assert.equal(permanente.permanente, true)
  assert.equal(permanente.codigo, 'ambiente_incompleto')
  assert.equal(permanente.status, 409)

  // O comando fica no detalhe tecnico; a tela recebe frase de produto.
  assert.match(permanente.message, /ambiente de demonstração ainda não foi preparado/i)
  assert.ok(permanente.technicalDetail.includes('npm run bootstrap'))
  assert.ok(!JSON.stringify(permanente.toJSON()).includes('bootstrap'), 'o comando nao vai para a tela')

  // Falha de rede continua transitoria: essa merece as oito tentativas.
  assert.notEqual(networkTrouble('timeout').permanente, true)

  const { migrar } = await import('../src/db/migrate.js')
  const { closeDb, one } = await import('../src/db/index.js')
  const { enfileirar, marcarFalha, MAX_TENTATIVAS } = await import('../src/domain/chain-queue.js')
  await migrar()

  const item = await enfileirar('escrow_fund', { payload: { teste: true } })
  const saida = await marcarFalha({ id: item.id, attempts: 0, max_attempts: MAX_TENTATIVAS }, permanente)

  assert.equal(saida.desistiu, true, 'desiste na primeira tentativa')
  assert.equal(saida.permanente, true)
  assert.equal(saida.tentativas, 1, `desistiu com 1 de ${MAX_TENTATIVAS} tentativas`)

  // Desistir nao apaga: operacao de dinheiro que nao completou fica visivel.
  const linha = await one('select attempts, failed_at, last_error from chain_jobs where id = $1', [item.id])
  assert.equal(Number(linha.attempts), 1)
  assert.ok(linha.failed_at, 'a falha fica registrada com data')
  assert.match(linha.last_error, /ambiente de demonstração/i)

  await closeDb()
})
