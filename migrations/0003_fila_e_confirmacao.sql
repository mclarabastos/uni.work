-- A confirmacao da entrega e a liberacao do pagamento deixam de ser a mesma
-- coisa no tempo.
--
-- Antes: confirmar chamava a rede e, se a rede recusasse, a operacao inteira
-- falhava e o contratante via um erro.
--
-- Agora: confirmar registra a intencao aqui, na hora, e a liberacao do valor
-- vai para a fila. A tela segue. A vaga so vira "concluida" quando o dinheiro
-- realmente saiu, porque dizer "concluida" antes disso seria mentira.
alter table jobs add column if not exists confirmed_at timestamptz;

-- Quantas vezes uma operacao pode falhar antes de virar problema de gente.
-- Guardado por item, e nao so na configuracao, para o admin conseguir dar mais
-- chances a um caso especifico sem mexer no resto.
alter table chain_jobs add column if not exists max_attempts integer not null default 8;
alter table chain_jobs add column if not exists failed_at timestamptz;

-- A fila e varrida por run_after entre os itens ainda vivos.
create index if not exists chain_jobs_fila_idx
  on chain_jobs (run_after asc)
  where done_at is null and failed_at is null;

-- Um certificado que caiu no memo nao esta pronto: ele e provisorio ate virar
-- cNFT. Esta coluna diz se ele ainda esta a caminho disso.
alter table certificates add column if not exists upgraded_at timestamptz;
