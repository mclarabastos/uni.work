-- Tabelas e colunas da versao completa: anexos, disputas, notificacoes,
-- magic link, fila on-chain, auditoria e busca full-text em portugues.

-- ─── anexos ──────────────────────────────────────────────────────────────────
-- portfolio do estudante, comprovante de entrega, foto de perfil, contrato
create table if not exists attachments (
  id           text primary key,
  owner_id     text not null references users(id) on delete cascade,
  job_id       text references jobs(id) on delete cascade,
  kind         text not null check (kind in ('avatar','portfolio','delivery','contract')),
  filename     text not null,
  mime         text not null,
  bytes        bigint not null,
  storage_key  text not null,
  created_at   timestamptz not null default now()
);
create index if not exists attachments_owner_idx on attachments (owner_id, created_at desc);
create index if not exists attachments_job_idx   on attachments (job_id) where job_id is not null;

-- ─── disputas ────────────────────────────────────────────────────────────────
-- o que acontece quando as partes discordam
create table if not exists disputes (
  id            text primary key,
  job_id        text not null unique references jobs(id) on delete cascade,
  opened_by     text not null references users(id),
  reason        text not null,
  detail        text,
  status        text not null default 'open'
                check (status in ('open','in_review','resolved_student','resolved_company','split')),
  resolution    text,
  split_bps     integer check (split_bps is null or (split_bps >= 0 and split_bps <= 10000)),
  deadline_at   timestamptz not null,
  resolved_by   text references users(id),
  resolved_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists disputes_status_idx on disputes (status, deadline_at);

-- ─── notificacoes ────────────────────────────────────────────────────────────
create table if not exists notifications (
  id          text primary key,
  user_id     text not null references users(id) on delete cascade,
  type        text not null,
  title       text not null,
  body        text not null,
  link        text,
  channels    jsonb not null default '["app"]'::jsonb,
  read_at     timestamptz,
  sent_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists notifications_user_idx   on notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx on notifications (user_id) where read_at is null;

-- Uma chave de deduplicacao por evento: o mesmo acontecimento nao pode gerar
-- duas notificacoes, nem quando o worker reprocessa.
create table if not exists notification_keys (
  dedupe_key  text primary key,
  created_at  timestamptz not null default now()
);

create table if not exists notification_preferences (
  user_id     text primary key references users(id) on delete cascade,
  email       boolean not null default true,
  push        boolean not null default false,
  digest      text not null default 'instant' check (digest in ('instant','daily','off'))
);

-- ─── autenticacao de verdade ─────────────────────────────────────────────────
-- token de uso unico enviado por e-mail
create table if not exists login_tokens (
  token       text primary key,
  email       text not null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  ip          text,
  created_at  timestamptz not null default now()
);
create index if not exists login_tokens_email_idx on login_tokens (email, created_at desc);

-- Sessao com refresh e revogacao. A tabela sessions do 0001 ganha as colunas
-- em vez de ser trocada: sessao viva nao pode cair por causa de migration.
alter table sessions add column if not exists refresh_token text;
alter table sessions add column if not exists refresh_expires_at timestamptz;
alter table sessions add column if not exists revoked_at timestamptz;
alter table sessions add column if not exists user_agent text;
alter table sessions add column if not exists ip text;
alter table sessions add column if not exists last_used_at timestamptz;
create unique index if not exists sessions_refresh_idx on sessions (refresh_token) where refresh_token is not null;

-- Contador de tentativas por chave e janela, para o rate limit sobreviver a
-- restart e valer entre instancias.
create table if not exists rate_limits (
  bucket      text not null,
  window_at   timestamptz not null,
  hits        integer not null default 0,
  primary key (bucket, window_at)
);
create index if not exists rate_limits_window_idx on rate_limits (window_at);

-- Idempotencia das rotas que movem dinheiro: a mesma chave devolve a mesma
-- resposta por 24 horas, em vez de mover o valor duas vezes.
create table if not exists idempotency_keys (
  key         text primary key,
  user_id     text references users(id) on delete cascade,
  route       text not null,
  request_hash text not null,
  status_code integer,
  response    jsonb,
  completed_at timestamptz,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists idempotency_expira_idx on idempotency_keys (expires_at);

-- ─── fila de operacoes on-chain ──────────────────────────────────────────────
-- Erro de rede nunca bloqueia o fluxo de produto: a operacao entra aqui e a
-- tela segue.
create table if not exists chain_jobs (
  id          text primary key,
  kind        text not null check (kind in ('escrow_fund','escrow_release','escrow_refund','cert_mint','cert_sync')),
  job_id      text references jobs(id) on delete cascade,
  payload     jsonb not null default '{}'::jsonb,
  attempts    integer not null default 0,
  last_error  text,
  run_after   timestamptz not null default now(),
  locked_at   timestamptz,
  locked_by   text,
  done_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists chain_jobs_pending_idx on chain_jobs (run_after) where done_at is null;

-- Uma operacao pendente por tipo e por vaga: reprocessar nao pode virar
-- duas liberacoes de pagamento.
create unique index if not exists chain_jobs_unicidade_idx
  on chain_jobs (kind, job_id) where done_at is null and job_id is not null;

-- ─── auditoria ───────────────────────────────────────────────────────────────
-- toda acao que move dinheiro ou muda estado entra aqui
create table if not exists audit_log (
  id          text primary key,
  actor_id    text references users(id),
  action      text not null,
  entity      text not null,
  entity_id   text not null,
  before      jsonb,
  after       jsonb,
  ip          text,
  created_at  timestamptz not null default now()
);
create index if not exists audit_log_entity_idx on audit_log (entity, entity_id, created_at desc);
create index if not exists audit_log_actor_idx  on audit_log (actor_id, created_at desc);

-- ─── alteracoes nas tabelas existentes ───────────────────────────────────────

-- prazos e cancelamento
alter table jobs add column if not exists auto_confirm_at  timestamptz;
alter table jobs add column if not exists cancelled_reason text;
alter table jobs add column if not exists disputed_at      timestamptz;

-- perfil mais completo
alter table users add column if not exists phone          text;
alter table users add column if not exists links          jsonb   not null default '[]'::jsonb;
alter table users add column if not exists skills         jsonb   not null default '[]'::jsonb;
alter table users add column if not exists verified_email boolean not null default false;
alter table users add column if not exists blocked_at     timestamptz;
alter table users add column if not exists is_admin       boolean not null default false;
alter table users add column if not exists avatar_key     text;

-- busca full-text em portugues.
-- A coluna e gerada e armazenada: o indice fica sempre coerente com o texto,
-- sem trigger para manter. Pesos: titulo A, descricao B, categoria C.
alter table jobs add column if not exists search tsvector
  generated always as (
    setweight(to_tsvector('portuguese', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('portuguese', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('portuguese', coalesce(category, '')), 'C')
  ) stored;
create index if not exists jobs_search_idx on jobs using gin (search);

-- Paginacao por cursor precisa de uma ordem total e estavel.
create index if not exists jobs_cursor_idx  on jobs (created_at desc, id desc);
create index if not exists jobs_valor_idx   on jobs (amount_cents desc, id desc);
create index if not exists jobs_abertas_idx on jobs (created_at desc, id desc)
  where status in ('aberta','garantida');
