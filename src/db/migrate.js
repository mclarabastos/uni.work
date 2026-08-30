// Runner de migrations.
//
// Tres garantias:
//   idempotente   rodar duas vezes nao faz nada na segunda
//   transacional  cada migration aplica inteira ou nao aplica
//   verificavel   guarda o checksum, entao editar uma migration ja aplicada
//                 e detectado em vez de passar batido
//
// Funciona igual nos dois drivers, porque o SQL e o mesmo.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { rootDir } from '../config.js'
import { query, transaction, dbInfo } from './index.js'

export const MIGRATIONS_DIR = path.join(rootDir, 'migrations')

const CONTROLE = `
  create table if not exists schema_migrations (
    version     text primary key,
    checksum    text not null,
    applied_at  timestamptz not null default now(),
    duration_ms integer
  )`

function checksum (conteudo) {
  // Normaliza fim de linha para o checksum nao mudar so por causa de CRLF.
  return crypto.createHash('sha256').update(conteudo.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

/** Lista os arquivos de migration em ordem de versao. */
export function listarMigrations () {
  if (!fs.existsSync(MIGRATIONS_DIR)) return []
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((nome) => /^\d{4}_.+\.sql$/.test(nome))
    .sort()
    .map((nome) => {
      const conteudo = fs.readFileSync(path.join(MIGRATIONS_DIR, nome), 'utf8')
      return { version: nome.replace(/\.sql$/, ''), arquivo: nome, conteudo, checksum: checksum(conteudo) }
    })
}

export async function migrationsAplicadas () {
  await query(CONTROLE)
  const { rows } = await query('select version, checksum, applied_at from schema_migrations order by version')
  return rows
}

/**
 * Aplica o que falta. Devolve o que fez, para o setup e o doctor mostrarem.
 * Nunca aplica de novo o que ja rodou.
 */
export async function migrar ({ log = () => {} } = {}) {
  const info = await dbInfo()
  await query(CONTROLE)

  const disponiveis = listarMigrations()
  const aplicadas = new Map((await migrationsAplicadas()).map((r) => [r.version, r]))

  // Uma migration ja aplicada que mudou de conteudo e um problema: o banco de
  // producao nao tem o que o arquivo diz que tem. Avisa alto, nao corrige.
  const alteradas = disponiveis
    .filter((m) => aplicadas.has(m.version) && aplicadas.get(m.version).checksum !== m.checksum)
    .map((m) => m.version)

  const pendentes = disponiveis.filter((m) => !aplicadas.has(m.version))

  if (!pendentes.length) {
    log(`banco em dia: ${aplicadas.size} migration${aplicadas.size === 1 ? '' : 's'} aplicada${aplicadas.size === 1 ? '' : 's'} (${info.driver})`)
    return { aplicadas: [], jaEstavam: [...aplicadas.keys()], alteradas, driver: info.driver }
  }

  const feitas = []
  for (const migration of pendentes) {
    const inicio = Date.now()
    log(`aplicando ${migration.version}…`)
    try {
      await transaction(async (tx) => {
        await tx.exec(migration.conteudo)
        await tx.query(
          'insert into schema_migrations (version, checksum, duration_ms) values ($1, $2, $3)',
          [migration.version, migration.checksum, Date.now() - inicio]
        )
      })
    } catch (err) {
      throw new Error(`migration ${migration.version} falhou e foi revertida inteira: ${err.message}`)
    }
    feitas.push(migration.version)
    log(`  ${migration.version} aplicada em ${Date.now() - inicio}ms`)
  }

  return { aplicadas: feitas, jaEstavam: [...aplicadas.keys()], alteradas, driver: info.driver }
}

/** Versao atual do schema, para o doctor comparar com o esperado. */
export async function versaoDoSchema () {
  try {
    const { rows } = await query('select version from schema_migrations order by version desc limit 1')
    return rows[0]?.version ?? null
  } catch {
    return null
  }
}

export async function statusDasMigrations () {
  const disponiveis = listarMigrations()
  let aplicadas = []
  try {
    aplicadas = await migrationsAplicadas()
  } catch {
    return { inicializado: false, disponiveis: disponiveis.map((m) => m.version), aplicadas: [], pendentes: disponiveis.map((m) => m.version), alteradas: [] }
  }
  const porVersao = new Map(aplicadas.map((r) => [r.version, r]))
  return {
    inicializado: true,
    disponiveis: disponiveis.map((m) => m.version),
    aplicadas: aplicadas.map((r) => r.version),
    pendentes: disponiveis.filter((m) => !porVersao.has(m.version)).map((m) => m.version),
    alteradas: disponiveis
      .filter((m) => porVersao.has(m.version) && porVersao.get(m.version).checksum !== m.checksum)
      .map((m) => m.version)
  }
}
