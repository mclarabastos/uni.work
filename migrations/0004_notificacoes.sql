-- Inscricoes de push do navegador.
-- Uma por dispositivo, e nao por usuario: a mesma pessoa recebe no celular e
-- no computador, e revogar um nao derruba o outro.
create table if not exists push_subscriptions (
  id          text primary key,
  user_id     text not null references users(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  failures    integer not null default 0,
  created_at  timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists push_subscriptions_user_idx on push_subscriptions (user_id);

-- Quando o digest diario foi enviado pela ultima vez, por pessoa.
-- Sem isso, um restart do worker mandaria o resumo de novo.
alter table notification_preferences add column if not exists last_digest_at timestamptz;

-- A notificacao guarda a chave de deduplicacao que a gerou, para o painel
-- conseguir explicar de onde ela veio.
alter table notifications add column if not exists dedupe_key text;
alter table notifications add column if not exists job_id text references jobs(id) on delete cascade;
create index if not exists notifications_job_idx on notifications (job_id) where job_id is not null;

-- A fila de envio precisa achar rapido o que ainda nao saiu.
create index if not exists notifications_pendentes_idx on notifications (created_at)
  where sent_at is null;
