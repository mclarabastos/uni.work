# Uni.work

Marketplace de trampos curtos para universitarios. O contratante publica uma
vaga e reserva o valor no ato: o dinheiro sai da conta dele e fica travado. O
estudante ve que o pagamento esta garantido antes de aceitar. Quando o
contratante confirma a entrega, duas coisas acontecem no mesmo instante: o valor
e liberado para o estudante e um certificado verificavel e emitido com a carga
horaria daquela atividade.

Escrow e certificado vivem na Solana. **Nenhuma tela do produto fala de
carteira, chave, taxa de rede ou blockchain**, e isso e verificado por teste
automatizado.

> Hackathon Superteam Brasil, Track 01 · Vida Universitaria
> Devnet sempre, nunca mainnet. O mecanismo e real; o valor movimentado e ficticio.

---

## Comecar

```bash
npm install
npm run setup     # deixa tudo no ar em um comando
npm run dev       # http://localhost:4000
```

O `setup` e idempotente: rodar de novo so completa o que faltou. Ele instala
dependencias, cria o `.env`, gera a chave mestra, prepara o ambiente de devnet,
compila e deploya o programa Anchor se o toolchain estiver instalado, migra o
banco, popula o ecossistema de exemplo e roda o diagnostico.

### Todos os comandos

| comando | o que faz |
|---|---|
| `npm run setup` | tudo abaixo, na ordem certa, de forma idempotente |
| `npm run dev` | sobe a API e a interface em http://localhost:4000 |
| `npm test` | suite completa, sem tocar a rede |
| `npm run test:pg` | a mesma suite contra um Postgres de verdade em container |
| `npm run test:anchor` | a mesma suite com `ESCROW_DRIVER=anchor` |
| `npm run test:e2e` | o fluxo inteiro num navegador, com captura em cada passo |
| `npm run test:a11y` | auditoria de acessibilidade (axe, WCAG 2.1 AA) em doze telas |
| `npm run lint` | sintaxe, import quebrado, console solto e segredo commitado |
| `npm run build:artifact` | prova que um clone limpo sobe e responde |
| `npm run admin -- email` | promove uma conta a mediadora |
| `anchor test` | testes do programa em Rust, contra um validador (precisa do toolchain Anchor) |
| `npm run migrate` | aplica as migrations pendentes |
| `npm run migrate:status` | mostra o que ja aplicou e o que falta |
| `npm run bootstrap` | prepara o ambiente de devnet |
| `npm run seed` | popula o ecossistema de exemplo |
| `npm run doctor` | diagnostico do ambiente em vinte segundos |
| `npm run demo` | o fluxo completo no terminal, do cadastro ao certificado |
| `npm run reset` | apaga o banco local (use `-- --tudo` para apagar tambem o estado de devnet) |

---

## O que voce precisa configurar

O sistema sobe sem configuracao nenhuma, em modo reduzido. Duas coisas valem o
minuto que levam:

**1. Uma chave do Helius (gratuita).** Sem ela nao ha confirmacao independente
do certificado, e o faucet publico de devnet costuma recusar por limite de IP.
Pegue em https://dashboard.helius.dev e coloque no `.env`:

```
HELIUS_API_KEY=sua-chave-aqui
```

**2. SOL de teste na conta da plataforma.** O `bootstrap` tenta o faucet do RPC,
depois o do Helius, e por ultimo imprime o endereco. Se os dois recusarem, cole
o endereco em https://faucet.solana.com e rode `npm run bootstrap` de novo.

A plataforma paga a taxa de rede de todo mundo: estudante e contratante nunca
precisam ter SOL. Por isso a conta da plataforma precisa ter saldo, e so ela.

---

## Banco de dados

Sem `DATABASE_URL`, o sistema usa **PGlite embarcado**: Postgres de verdade
compilado para WASM, rodando dentro do processo, sem instalar nada. E o padrao
para desenvolvimento e demonstracao.

Com `DATABASE_URL`, usa **Postgres gerenciado**. O SQL e identico nos dois, e a
suite roda verde contra os dois (`npm test` e `npm run test:pg`).

### Migrar para Supabase

1. **Crie o projeto** em https://supabase.com/dashboard. Escolha a regiao mais
   perto de quem vai usar (para o Brasil, `sa-east-1`).

2. **Copie a connection string do pooler**, nao a direta. No painel:
   *Project Settings* → *Database* → *Connection string* → aba **Transaction
   pooler** (porta `6543`). O pooler aguenta muito mais conexao simultanea, que
   e o que um servico HTTP precisa.

   ```
   DATABASE_URL=postgresql://postgres.SEUPROJETO:SUASENHA@aws-0-sa-east-1.pooler.supabase.com:6543/postgres
   ```

   Coloque isso no `.env`. A senha e a que voce definiu ao criar o projeto; se
   perdeu, gere outra em *Database* → *Reset database password*.

3. **Aplique o schema:**

   ```bash
   npm run migrate
   ```

   O runner cria a tabela `schema_migrations`, aplica o que falta em transacao e
   nao repete o que ja rodou. Rodar duas vezes nao quebra nada.

4. **Popule, se quiser dado de exemplo:**

   ```bash
   npm run seed
   ```

5. **Confira:**

   ```bash
   npm run doctor
   ```

Observacoes que economizam tempo:

- O pooler em modo *transaction* nao suporta statement prepared entre
  transacoes. O driver aqui nao usa, entao funciona; se voce trocar de driver,
  lembre disso.
- `DB_POOL_MAX` limita as conexoes por instancia (padrao 10). Se voce rodar
  varias instancias, some antes de comparar com o limite do seu plano.
- `DB_STATEMENT_TIMEOUT_MS` e `DB_IDLE_TX_TIMEOUT_MS` cortam consulta travada e
  transacao esquecida aberta. Os padroes (15s e 30s) sao conservadores.
- Backup: no plano pago o Supabase faz diario automatico. No gratuito, use
  `pg_dump` contra a connection string direta (porta 5432, nao a do pooler).

### Escrever uma migration nova

Crie `migrations/0003_o_que_muda.sql`. O runner aplica em ordem de nome.

Nunca edite uma migration que ja rodou: o banco de producao nao vai ter o que o
arquivo diz que tem. O runner guarda o checksum de cada uma e avisa alto quando
detecta edicao, mas ele nao conserta, porque nao da para adivinhar o que voce
queria. Crie uma migration nova.

---

## Arquitetura

```
FRONTEND   o que o usuario ve
           Conta, saldo, garantia, certificado, comprovante.
           Nada de carteira, chave, taxa de rede ou blockchain.
                          |  REST + SSE
BACKEND    logica de negocio comum
           Cadastro, vagas, candidaturas, conversa, avaliacoes, notificacoes.
           Postgres. Rapido e barato. Nada disso precisa de rede publica.
                          |  RPC
REDE       a camada de confianca
           Escrow do pagamento e certificado.
           So o que precisa ser inviolavel e verificavel por terceiros.
```

A regra que decide o que vai para a rede: tudo que nao precisa de confianca
publica fica fora dela. Perfil, descricao de vaga, conversa e avaliacao em texto
vao para o banco comum. So o dinheiro em transito e o certificado emitido vao
para a rede.

### Estrutura

```
migrations/              schema versionado, aplicado por npm run migrate
src/
  config.js              toda a configuracao em um lugar
  server.js              express: API e interface no mesmo processo
  db/index.js            driver duplo: PGlite embarcado ou Postgres gerenciado
  db/migrate.js          runner idempotente, transacional, com checksum
  domain/jobs.js         maquina de estados do trampo, trilha de seis etapas
  domain/auth.js         cadastro, sessao, resumo de conta
  domain/events.js       barramento de eventos (timeline, metricas, SSE)
  lib/                   ids, dinheiro, erros
  services/wallet.js     conta embutida (keypair real, AES-256-GCM + scrypt)
  services/solana.js     conexao, envio de transacao, saldos, faucet
  services/escrow.js     dois drivers: cofre custodial e programa Anchor
  services/certificate.js  cNFT via Bubblegum, hash canonico, cartao em SVG
  services/das.js        leitura pela DAS API, a segunda testemunha
  routes/                auth, jobs, certificates, metrics, chain, stream
programs/uniwork-escrow/ programa Anchor em Rust
public/                  interface, sem build
scripts/                 setup, bootstrap, migrate, seed, doctor, reset, demo
tests/                   suite que roda offline
```

---

## A trilha de seis etapas

```
aberta -> garantida -> aceita -> em_andamento -> entregue -> concluida
   \__________\__________\____________\_____________/
                     cancelada
```

A ordem nao e decorativa. O estudante so consegue aceitar depois de
**garantida**, porque a promessa do produto e que ele ve o pagamento reservado
antes de dizer sim. Ha teste provando que o sistema recusa pular essa etapa.

---

## Escrow: dois drivers

| | `vault` | `anchor` |
|---|---|---|
| precisa de deploy | nao | sim |
| autoridade sobre o cofre | a plataforma | o programa |
| o contratante consegue sacar? | nao | nao |
| a plataforma consegue sacar? | **sim** | nao |

O `vault` existe para o projeto rodar sem toolchain de Rust. O alvo e `anchor`,
onde nem o contratante nem o Uni.work conseguem tirar o valor fora das duas
saidas previstas (liberar para o estudante, devolver para o contratante).

O `doctor` avisa quando voce esta no `vault`.

---

## Certificado

Emitido no mesmo instante em que o pagamento e liberado. Por padrao vira um
compressed NFT via Bubblegum, na conta do estudante. A merkle tree criada pelo
bootstrap tem profundidade 14: cabem 16.384 certificados nela.

Se a rede recusar, o certificado cai num registro de memo e a operacao entra na
fila para virar cNFT de verdade depois. O fallback nunca e o estado final.

O JSON servido em `/api/certificates/:codigo/metadata.json` e gravado no banco
no momento da emissao e servido de la para sempre. Um certificado que muda de
conteudo depois de emitido nao e um certificado.

A verificacao publica (`/verificar/:codigo`) funciona sem conta e faz duas
conferencias independentes: recalcula o hash canonico do conteudo, e pergunta ao
indexador se o ativo existe e quem e o dono. A segunda so funciona com
`HELIUS_API_KEY`; sem ela, a tela diz que a confirmacao independente nao esta
disponivel, em vez de fingir que confirmou.

---

## Testes

```bash
npm test          # suite completa, offline
npm run test:pg   # a mesma suite contra Postgres de verdade em container
```

Cobertura em cinco camadas, e as cinco pegam coisas diferentes:

- `npm test` prova a logica de produto e a montagem das transacoes, offline.
- `npm run test:anchor` prova que o mesmo fluxo passa pelo driver do programa,
  e nao so pelo cofre custodial.
- `anchor test` compila o programa em Rust e o roda contra um validador de
  verdade. E o unico que prova o que o programa recusa: terceiro tentando
  liberar, liberacao em dobro, devolucao depois de pago, disputa atropelada.
  Precisa do toolchain Anchor instalado.
- `npm run test:e2e` roda o fluxo inteiro em Chromium. Ele pega o que nenhum
  teste de logica pega: a tela realmente montando, os cliques ligados, e
  qualquer erro que so acontece quando o navegador executa o arquivo. Achou
  cinco defeitos reais que a suite offline nao via.
- `npm run test:a11y` audita doze telas com o axe, incluindo modal aberto e
  gaveta tecnica. Zero violacao critica ou seria e requisito, e uma tela que
  nao abriu conta como reprovada, nao como aprovada.

A suite nao toca a rede. Os testes de escrow decodificam a transacao byte a byte
e provam que a instrucao e `TransferChecked`, com o valor certo, saindo da conta
certa, autorizada por quem deve autorizar. Um teste le todos os arquivos de
`public/` e falha se jargao de rede aparecer fora da gaveta "camada tecnica".

---

## A regra de ouro

**O usuario nunca ve blockchain.**

O produto fala em: conta, saldo, garantia, pagamento, certificado, comprovante,
registro publico. Vale para mensagem de erro tambem: se uma transacao falhar, o
usuario le "nao conseguimos concluir agora, ja estamos tentando de novo", nunca
o erro cru.

A unica excecao e a gaveta **camada tecnica**, no rodape, que existe para
demonstracao e mostra cada operacao com instrucoes e assinatura. Ela e marcada
com `data-camada-tecnica` no HTML e com um par de comentarios no JavaScript, e o
teste de vocabulario usa essas marcas para saber onde a excecao comeca e termina.

---

## Escopo

Devnet sempre. O "USDC" e um SPL Token de teste criado pelo proprio bootstrap,
com o mesmo comportamento tecnico e zero valor financeiro. Os contratantes de
exemplo sao ficticios. O check-in e um botao, nao geolocalizacao.

O criterio: **o mecanismo e real e demonstravel; o valor movimentado e
ficticio.** Migrar para mainnet e uma decisao separada, com os requisitos de
compliance que ela implica.

Fora do escopo agora, mas no radar: integracao com MoneyGram Ramps, para o
freela de trabalho presencial sacar em dinheiro numa agencia parceira sem
precisar entender USDC. A infraestrutura de saque fisico ja existe; falta a
integracao.

---

## Documentos

- [`docs/estrutura_tecnica_mvp.md`](docs/estrutura_tecnica_mvp.md) — arquitetura e stack
- [`docs/pitch_certificado_freela.md`](docs/pitch_certificado_freela.md) — o pitch
- [`docs/dados_fontes_pitch.md`](docs/dados_fontes_pitch.md) — pesquisa e fontes
