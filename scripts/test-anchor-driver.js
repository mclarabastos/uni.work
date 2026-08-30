#!/usr/bin/env node
// npm run test:anchor — roda a suite inteira com ESCROW_DRIVER=anchor.
//
// Isto NAO substitui o `anchor test`, que compila o programa em Rust e o roda
// contra um validador. O que este script prova e o outro lado da ponte: que o
// codigo Node monta as instrucoes do programa, deriva os enderecos e conduz o
// fluxo inteiro sem depender do driver custodial.
//
// Os dois juntos cobrem a fase 4. Um sozinho nao cobre.

import { spawn } from 'node:child_process'

console.log('\n  suite com ESCROW_DRIVER=anchor\n')

const suite = spawn(process.execPath, ['--test', 'tests/**/*.test.js'], {
  stdio: 'inherit',
  env: { ...process.env, UNIWORK_TESTAR_ANCHOR: '1' }
})

suite.on('exit', (codigo) => {
  console.log(codigo === 0
    ? '\n  a suite passa no driver anchor.\n'
    : '\n  a suite falhou no driver anchor.\n')
  process.exit(codigo ?? 1)
})
