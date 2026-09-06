#!/usr/bin/env node
// npm run migrate — aplica o que falta no banco configurado.

import { migrar, statusDasMigrations } from '../src/db/migrate.js'
import { closeDb, dbInfo } from '../src/db/index.js'

const apenasStatus = process.argv.includes('--status')

try {
  const info = await dbInfo()
  console.log(`\n  banco: ${info.label}\n`)

  if (apenasStatus) {
    const status = await statusDasMigrations()
    console.log(`  aplicadas: ${status.aplicadas.join(', ') || 'nenhuma'}`)
    console.log(`  pendentes: ${status.pendentes.join(', ') || 'nenhuma'}`)
    if (status.alteradas.length) {
      console.log(`\n  ATENÇÃO: migration já aplicada foi editada: ${status.alteradas.join(', ')}`)
      console.log('  O banco não tem o que o arquivo diz que tem. Crie uma migration nova em vez de editar.')
    }
  } else {
    const resultado = await migrar({ log: (m) => console.log(`  ${m}`) })
    if (resultado.alteradas.length) {
      console.log(`\n  ATENÇÃO: migration já aplicada foi editada: ${resultado.alteradas.join(', ')}`)
      console.log('  Crie uma migration nova em vez de editar uma que já rodou.')
    }
    if (resultado.aplicadas.length) {
      console.log(`\n  ${resultado.aplicadas.length} migration(s) aplicada(s).`)
    }
  }
  console.log('')
  await closeDb()
} catch (err) {
  console.error(`\n  falhou: ${err.message}\n`)
  await closeDb().catch(() => {})
  process.exit(1)
}
