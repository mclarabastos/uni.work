-- Schema do Uni.work.
-- Postgres puro: roda igual no PGlite embarcado e no Postgres gerenciado.

create table if not exists users (
  id            text primary key,
  role          text not null check (role in ('student','company')),
  name          text not null,
  email         text not null unique,
  headline      text,
  bio           text,
  university    text,
  course        text,
  accent        text not null default 'violeta',
  created_at    timestamptz not null default now()
);

-- Conta de rede de cada usuario. Nasce junto com o cadastro, sem passo extra.
-- secret_cipher guarda o segredo cifrado com AES-256-GCM derivado por scrypt.
create table if not exists accounts (
  user_id       text primary key references users(id) on delete cascade,
  public_key    text not null unique,
  secret_cipher text not null,
  created_at    timestamptz not null default now()
);

create table if not exists sessions (
  token         text primary key,
  user_id       text not null references users(id) on delete cascade,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);
create index if not exists sessions_user_idx on sessions (user_id);

create table if not exists jobs (
  id             text primary key,
  company_id     text not null references users(id) on delete cascade,
  student_id     text references users(id) on delete set null,
  title          text not null,
  description    text not null,
  category       text not null,
  modality       text not null check (modality in ('presencial','remoto')),
  location       text,
  amount_cents   bigint not null check (amount_cents > 0),
  hours          numeric(6,2) not null check (hours > 0),
  status         text not null default 'aberta'
                 check (status in ('aberta','garantida','aceita','em_andamento','entregue','concluida','cancelada')),
  fee_bps        integer not null default 500,
  escrow_address text,
  starts_at      timestamptz,
  deadline_at    timestamptz,
  funded_at      timestamptz,
  accepted_at    timestamptz,
  started_at     timestamptz,
  delivered_at   timestamptz,
  delivery_note  text,
  completed_at   timestamptz,
  cancelled_at   timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists jobs_status_idx  on jobs (status, created_at desc);
create index if not exists jobs_company_idx on jobs (company_id, created_at desc);
create index if not exists jobs_student_idx on jobs (student_id, created_at desc);

create table if not exists applications (
  id          text primary key,
  job_id      text not null references jobs(id) on delete cascade,
  student_id  text not null references users(id) on delete cascade,
  pitch       text,
  status      text not null default 'pendente' check (status in ('pendente','aceita','recusada')),
  created_at  timestamptz not null default now(),
  unique (job_id, student_id)
);
create index if not exists applications_job_idx on applications (job_id, created_at desc);

create table if not exists messages (
  id          text primary key,
  job_id      text not null references jobs(id) on delete cascade,
  sender_id   text not null references users(id) on delete cascade,
  body        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists messages_job_idx on messages (job_id, created_at);

create table if not exists reviews (
  id          text primary key,
  job_id      text not null references jobs(id) on delete cascade,
  author_id   text not null references users(id) on delete cascade,
  target_id   text not null references users(id) on delete cascade,
  rating      integer not null check (rating between 1 and 5),
  comment     text,
  created_at  timestamptz not null default now(),
  unique (job_id, author_id)
);
create index if not exists reviews_target_idx on reviews (target_id);

-- Certificado emitido. metadata guarda o JSON exato servido em metadata.json:
-- uma vez emitido o conteudo nao muda, entao servimos daqui e nunca remontamos.
create table if not exists certificates (
  id           text primary key,
  code         text not null unique,
  job_id       text not null unique references jobs(id) on delete cascade,
  student_id   text not null references users(id) on delete cascade,
  title        text not null,
  hours        numeric(6,2) not null,
  issuer_name  text not null,
  content_hash text not null,
  metadata     jsonb not null,
  driver       text not null default 'memo',
  asset_id     text,
  signature    text,
  issued_at    timestamptz not null default now()
);
create index if not exists certificates_student_idx on certificates (student_id, issued_at desc);

-- Registro de tudo que foi para a rede. Alimenta a gaveta "camada tecnica".
create table if not exists chain_tx (
  id           text primary key,
  job_id       text references jobs(id) on delete cascade,
  kind         text not null,
  status       text not null default 'enviada' check (status in ('enviada','confirmada','falhou')),
  cluster      text not null,
  signature    text,
  instructions jsonb not null default '[]'::jsonb,
  detail       jsonb not null default '{}'::jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  confirmed_at timestamptz
);
create index if not exists chain_tx_job_idx on chain_tx (job_id, created_at desc);

-- Barramento de eventos persistido: timeline da vaga, metricas e SSE.
create table if not exists events (
  id          text primary key,
  type        text not null,
  job_id      text references jobs(id) on delete cascade,
  actor_id    text references users(id) on delete set null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists events_job_idx  on events (job_id, created_at);
create index if not exists events_type_idx on events (type, created_at desc);
