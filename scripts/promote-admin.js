#!/usr/bin/env node
// npm run admin -- email@exemplo.br
// Marca uma conta como mediadora. E a unica forma de entrar no painel de
// mediacao: nao existe rota que promove ninguem, de proposito.

import { query, one, closeDb } from '../src/db/index.js'
import { registrarAuditoria } from '../src/domain/audit.js'

const email = process.argv[2]?.trim().toLowerCase()
if (!email) {
  console.error('\n  uso: npm run admin -- email@exemplo.br\n')
  process.exit(1)
}

const usuario = await one('select id, name, is_admin from users where email = $1', [email])
if (!usuario) {
  console.error(`\n  não encontrei uma conta com ${email}\n`)
  process.exitCode = 1
} else if (usuario.is_admin) {
  console.log(`\n  ${usuario.name} já e mediador.\n`)
} else {
  await query('update users set is_admin = true where id = $1', [usuario.id])
  await registrarAuditoria({
    actorId: null, action: 'usuario.promovido_a_mediador', entity: 'user', entityId: usuario.id,
    after: { email }
  })
  console.log(`\n  ${usuario.name} agora e mediador.\n`)
}
await closeDb()
