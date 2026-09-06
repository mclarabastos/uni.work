#!/usr/bin/env node
// npm run reset — apaga o banco local e volta ao ponto de partida.
//
// Por padrao preserva o estado de devnet (.uniwork/platform.json), porque
// recriar conta, token e merkle tree custa tempo e SOL de faucet. Para apagar
// isso tambem: npm run reset -- --tudo

import fs from 'node:fs'
import path from 'node:path'
import { config } from '../src/config.js'
import { platformStatePath } from '../src/services/platform.js'

const tudo = process.argv.includes('--tudo')

console.log('\n  reset\n')

if (config.db.url) {
  console.log('  DATABASE_URL está configurada, então o banco e gerenciado e não vou apaga-lo daqui.')
  console.log('  Para recomecar num banco gerenciado, apague o schema pelo painel do provedor')
  console.log('  e rode npm run migrate.\n')
} else {
  const dir = config.db.pgliteDir
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
    console.log(`  ok   banco local apagado (${path.relative(process.cwd(), dir)})`)
  } else {
    console.log('  ok   não havia banco local para apagar')
  }
}

const estado = platformStatePath()
if (tudo) {
  if (fs.existsSync(estado)) {
    fs.rmSync(estado, { force: true })
    console.log('  ok   estado de devnet apagado: a conta da plataforma, o token de teste e a')
    console.log('       merkle tree vão ser recriados no próximo bootstrap')
  } else {
    console.log('  ok   não havia estado de devnet para apagar')
  }
} else if (fs.existsSync(estado)) {
  console.log('  ok   estado de devnet preservado (use --tudo para apagar também)')
}

console.log('\n  próximo passo: npm run setup\n')
