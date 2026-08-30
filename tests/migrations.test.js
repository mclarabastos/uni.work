// Verificacao da fase 1: as migrations aplicam do zero e sobre um banco que
// ja existe, sem perder dado, e a busca full-text em portugues funciona.

import './helpers.js'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { query, closeDb, many, one } from '../src/db/index.js'
import { migrar, listarMigrations, statusDasMigrations, versaoDoSchema } from '../src/db/migrate.js'

after(async () => { await closeDb() })

test('as migrations aplicam do zero, sao idempotentes e detectam arquivo editado', async () => {
  const disponiveis = listarMigrations()
  assert.ok(disponiveis.length >= 2, 'precisa haver ao menos a inicial e a da versao completa')
  assert.equal(disponiveis[0].version, '0001_init')

  // Ordem por nome de arquivo precisa ser a ordem de aplicacao.
  const versoes = disponiveis.map((m) => m.version)
  assert.deepEqual(versoes, [...versoes].sort(), 'as versoes precisam estar em ordem')

  // Do zero: aplica todas.
  const primeira = await migrar()
  assert.deepEqual(primeira.aplicadas, versoes)

  // De novo: nao faz nada. Rodar migrate duas vezes nao pode quebrar.
  const segunda = await migrar()
  assert.deepEqual(segunda.aplicadas, [], 'a segunda passada nao aplica nada')
  assert.deepEqual(segunda.jaEstavam, versoes)

  const status = await statusDasMigrations()
  assert.deepEqual(status.pendentes, [])
  assert.deepEqual(status.alteradas, [], 'nenhuma migration foi editada depois de aplicada')
  assert.equal(await versaoDoSchema(), versoes[versoes.length - 1])

  // Editar uma migration ja aplicada precisa ser detectado, nao passar batido.
  await query("update schema_migrations set checksum = 'checksum-mentiroso' where version = '0001_init'")
  const comAlteracao = await migrar()
  assert.deepEqual(comAlteracao.alteradas, ['0001_init'])
  await query('update schema_migrations set checksum = $1 where version = $2', [disponiveis[0].checksum, '0001_init'])
})

test('as tabelas, colunas e indices da versao completa existem depois de migrar', async () => {
  await migrar()

  const tabelas = (await many(
    "select table_name from information_schema.tables where table_schema = current_schema()"
  )).map((r) => r.table_name)

  for (const esperada of [
    'users', 'accounts', 'sessions', 'jobs', 'applications', 'messages', 'reviews',
    'certificates', 'chain_tx', 'events',
    'attachments', 'disputes', 'notifications', 'notification_preferences',
    'login_tokens', 'chain_jobs', 'audit_log', 'rate_limits', 'idempotency_keys',
    'schema_migrations'
  ]) {
    assert.ok(tabelas.includes(esperada), `falta a tabela ${esperada}`)
  }

  const colunasJobs = (await many(
    "select column_name from information_schema.columns where table_name = 'jobs'"
  )).map((r) => r.column_name)
  for (const coluna of ['search', 'auto_confirm_at', 'cancelled_reason']) {
    assert.ok(colunasJobs.includes(coluna), `falta jobs.${coluna}`)
  }

  const colunasUsers = (await many(
    "select column_name from information_schema.columns where table_name = 'users'"
  )).map((r) => r.column_name)
  for (const coluna of ['phone', 'links', 'skills', 'verified_email', 'blocked_at']) {
    assert.ok(colunasUsers.includes(coluna), `falta users.${coluna}`)
  }

  const indices = (await many("select indexname from pg_indexes where schemaname = current_schema()"))
    .map((r) => r.indexname)
  for (const indice of ['jobs_search_idx', 'chain_jobs_pending_idx', 'jobs_cursor_idx']) {
    assert.ok(indices.includes(indice), `falta o indice ${indice}`)
  }

  // A fila on-chain nao pode aceitar duas operacoes pendentes do mesmo tipo
  // para a mesma vaga: reprocessar nao pode virar pagamento em dobro.
  assert.ok(indices.includes('chain_jobs_unicidade_idx'))
})

test('a busca full-text entende portugues, com peso por campo e radicalizacao', async () => {
  await migrar()
  await query("insert into users (id, role, name, email) values ('u_busca','company','Produtora XPTO','busca@teste.br') on conflict do nothing")

  const vagas = [
    ['jb1', 'Staff de credenciamento em congresso de tecnologia', 'Recepcao dos participantes no evento', 'Eventos'],
    ['jb2', 'Monitoria de calculo para engenharia', 'Acompanhamento de alunos em listas de exercicios', 'Monitoria'],
    ['jb3', 'Traducao de artigo cientifico', 'Traduzir um artigo do portugues para o ingles', 'Traducao']
  ]
  for (const [id, titulo, descricao, categoria] of vagas) {
    await query(
      `insert into jobs (id, company_id, title, description, category, modality, amount_cents, hours)
       values ($1, 'u_busca', $2, $3, $4, 'remoto', 10000, 5) on conflict (id) do nothing`,
      [id, titulo, descricao, categoria]
    )
  }

  const buscar = (termo) => many(
    `select id, ts_rank(search, plainto_tsquery('portuguese', $1)) as rank
       from jobs where search @@ plainto_tsquery('portuguese', $1)
      order by rank desc`,
    [termo]
  )

  // Radicalizacao: o plural acha o singular e vice-versa.
  assert.ok((await buscar('congressos')).some((r) => r.id === 'jb1'), 'plural precisa achar o singular')
  assert.ok((await buscar('participante')).some((r) => r.id === 'jb1'))
  assert.ok((await buscar('alunos')).some((r) => r.id === 'jb2'))
  assert.ok((await buscar('traduzir')).some((r) => r.id === 'jb3'))

  // Peso: um termo no titulo pontua mais do que o mesmo termo na descricao.
  const porTitulo = await buscar('credenciamento')
  const porDescricao = await buscar('recepcao')
  assert.ok(Number(porTitulo[0].rank) > Number(porDescricao[0].rank), 'o titulo pesa mais que a descricao')

  // Palavra sem relacao nao traz nada.
  assert.equal((await buscar('astronauta')).length, 0)

  // A coluna e gerada: mudar o titulo atualiza o indice sozinho, sem trigger.
  await query("update jobs set title = 'Fotografia de formatura' where id = 'jb1'")
  assert.equal((await buscar('credenciamento')).filter((r) => r.id === 'jb1').length, 0)
  assert.ok((await buscar('formatura')).some((r) => r.id === 'jb1'))
})

test('a fila on-chain recusa duas operacoes pendentes iguais para a mesma vaga', async () => {
  await migrar()
  await query("insert into users (id, role, name, email) values ('u_fila','company','Empresa','fila@teste.br') on conflict do nothing")
  await query(`insert into jobs (id, company_id, title, description, category, modality, amount_cents, hours)
               values ('j_fila','u_fila','Vaga de teste da fila','Descricao qualquer com tamanho suficiente','Teste','remoto',1000,1)
               on conflict (id) do nothing`)

  await query("insert into chain_jobs (id, kind, job_id) values ('cj1','escrow_release','j_fila')")

  await assert.rejects(
    () => query("insert into chain_jobs (id, kind, job_id) values ('cj2','escrow_release','j_fila')"),
    'duas liberacoes pendentes para a mesma vaga precisam ser recusadas pelo banco'
  )

  // Depois de concluida, uma nova pode entrar: e o caso do cert_sync.
  await query("update chain_jobs set done_at = now() where id = 'cj1'")
  await query("insert into chain_jobs (id, kind, job_id) values ('cj3','escrow_release','j_fila')")
  assert.equal((await one("select count(*)::int as n from chain_jobs where job_id = 'j_fila'")).n, 2)
})
