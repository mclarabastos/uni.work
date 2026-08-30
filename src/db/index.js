// Driver duplo de banco.
//   sem DATABASE_URL -> PGlite embarcado (nao precisa instalar nada)
//   com DATABASE_URL -> Postgres de verdade (Supabase, RDS, container)
// O SQL e identico nos dois. Quem chama nao sabe qual esta rodando.

import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'

let handle = null
let opening = null

// Postgres devolve bigint e numeric como string para nao perder precisao.
// Como nossos valores cabem tranquilamente em Number, normalizamos na borda
// para o resto do codigo nao precisar lembrar disso.
const NUMERIC_COLUMNS = new Set([
  'amount_cents', 'hours', 'fee_bps', 'rating', 'bytes', 'attempts',
  'split_bps', 'total', 'count', 'sum', 'avg'
])

function coerceRow (row) {
  if (!row || typeof row !== 'object') return row
  for (const key of Object.keys(row)) {
    const value = row[key]
    if (typeof value === 'string' && (NUMERIC_COLUMNS.has(key) || key.endsWith('_count') || key.endsWith('_cents') || key.endsWith('_total'))) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) row[key] = parsed
    } else if (typeof value === 'bigint') {
      row[key] = Number(value)
    }
  }
  return row
}

function normalize (result) {
  const rows = (result?.rows ?? []).map(coerceRow)
  const rowCount = result?.rowCount ?? result?.affectedRows ?? rows.length
  return { rows, rowCount }
}

async function openPglite () {
  const { PGlite } = await import('@electric-sql/pglite')
  // PGLITE_DIR=memory:// roda inteiramente em memoria. E o que a suite usa:
  // cada arquivo de teste sobe um banco proprio, sem tocar o disco.
  const emMemoria = config.db.pgliteDir.endsWith('memory:') || process.env.PGLITE_DIR === 'memory://'
  if (!emMemoria) fs.mkdirSync(path.dirname(config.db.pgliteDir), { recursive: true })
  const pg = emMemoria ? new PGlite() : new PGlite(config.db.pgliteDir)
  await pg.waitReady
  return {
    driver: 'pglite',
    label: emMemoria ? 'PGlite em memoria' : `PGlite embarcado (${path.relative(process.cwd(), config.db.pgliteDir)})`,
    async query (sql, params = []) {
      return normalize(await pg.query(sql, params))
    },
    async exec (sql) {
      await pg.exec(sql)
    },
    async transaction (fn) {
      return pg.transaction(async (t) => {
        return fn({
          query: async (sql, params = []) => normalize(await t.query(sql, params)),
          exec: async (sql) => { await t.exec(sql) }
        })
      })
    },
    async close () { await pg.close() }
  }
}

async function openPostgres () {
  const pgModule = await import('pg')
  const { Pool } = pgModule.default ?? pgModule
  const needsSsl = /supabase\.|neon\.|render\.com|amazonaws\.com/.test(config.db.url)

  // Isolamento por schema, usado so pela suite contra Postgres de verdade:
  // cada processo de teste trabalha no proprio schema e nao ve os outros.
  const schemaIsolado = process.env.UNIWORK_TEST_SCHEMA
  if (schemaIsolado) {
    if (!/^[a-z0-9_]{1,60}$/.test(schemaIsolado)) throw new Error('UNIWORK_TEST_SCHEMA invalido')
    const inicial = new Pool({ connectionString: config.db.url, max: 1, ssl: needsSsl ? { rejectUnauthorized: false } : undefined })
    await inicial.query(`create schema if not exists ${schemaIsolado}`)
    await inicial.end()
  }

  const pool = new Pool({
    connectionString: config.db.url,
    max: config.db.poolMax,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    options: schemaIsolado ? `-c search_path=${schemaIsolado},public` : undefined,
    statement_timeout: config.db.statementTimeoutMs,
    idle_in_transaction_session_timeout: config.db.idleTxTimeoutMs,
    connectionTimeoutMillis: 10000
  })
  // Um pool sem listener de error derruba o processo quando o Postgres fecha
  // uma conexao ociosa. Registramos para degradar em vez de morrer.
  pool.on('error', (err) => {
    console.error(JSON.stringify({ level: 'error', msg: 'pool_error', detail: err.message }))
  })
  const host = (() => {
    try { return new URL(config.db.url).host } catch { return 'postgres' }
  })()
  return {
    driver: 'postgres',
    label: `Postgres gerenciado (${host})`,
    async query (sql, params = []) {
      return normalize(await pool.query(sql, params))
    },
    async exec (sql) {
      await pool.query(sql)
    },
    async transaction (fn) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const out = await fn({
          query: async (sql, params = []) => normalize(await client.query(sql, params)),
          exec: async (sql) => { await client.query(sql) }
        })
        await client.query('commit')
        return out
      } catch (err) {
        try { await client.query('rollback') } catch { /* conexao ja perdida */ }
        throw err
      } finally {
        client.release()
      }
    },
    async close () { await pool.end() }
  }
}

export async function getDb () {
  if (handle) return handle
  if (!opening) {
    opening = (config.db.driver === 'postgres' ? openPostgres() : openPglite())
      .then((h) => { handle = h; return h })
      .catch((err) => { opening = null; throw err })
  }
  return opening
}

export async function query (sql, params = []) {
  const db = await getDb()
  return db.query(sql, params)
}

/** Primeira linha, ou null. */
export async function one (sql, params = []) {
  const { rows } = await query(sql, params)
  return rows[0] ?? null
}

/** Todas as linhas. */
export async function many (sql, params = []) {
  const { rows } = await query(sql, params)
  return rows
}

/** Executa varios comandos, sem parametros. Para schema e migrations. */
export async function exec (sql) {
  const db = await getDb()
  return db.exec(sql)
}

/** Roda fn dentro de uma transacao, com rollback automatico em erro. */
export async function transaction (fn) {
  const db = await getDb()
  return db.transaction(fn)
}

export async function closeDb () {
  if (!handle) return
  const current = handle
  handle = null
  opening = null
  await current.close()
}

export async function dbInfo () {
  const db = await getDb()
  return { driver: db.driver, label: db.label }
}

/**
 * Aplica o schema aplicando as migrations pendentes.
 * Mantido com o nome antigo porque e o ponto de entrada que o servidor e a
 * suite usam; o schema unico virou migrations/0001_init.sql.
 */
export async function applySchema () {
  const { migrar } = await import('./migrate.js')
  return migrar()
}
