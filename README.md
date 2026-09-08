# Uni.work

Marketplace de trampos curtos para universitários. O contratante publica uma
vaga e reserva o valor no ato: o dinheiro sai da conta dele e fica travado. O
estudante vê que o pagamento está garantido antes de aceitar. Quando o
contratante confirma a entrega, duas coisas acontecem no mesmo instante: o valor
é liberado para o estudante e um certificado verificável é emitido com a carga
horária daquela atividade.

Escrow e certificado vivem na Solana. **Nenhuma tela do produto fala de
carteira, chave, taxa de rede ou blockchain**, e isso é verificado por teste
automatizado.

> Hackathon Superteam Brasil, Track 01 · Vida Universitária
> Devnet sempre, nunca mainnet. O mecanismo é real; o valor movimentado é fictício.

No ar em **https://uni-work-eo0c.onrender.com** — a página de apresentação fica
na raiz e o produto em [`/app`](https://uni-work-eo0c.onrender.com/app).

---

## Começar

Precisa de **Node 22 ou mais novo**. No Node 20 o PGlite trava com *memory
access out of bounds*, então o piso não é uma preferência.

```bash
npm install
npm run setup     # deixa tudo no ar em um comando
npm run dev       # apresentação em / e o produto em /app
```

O `setup` é idempotente: rodar de novo só completa o que faltou. Ele instala
dependências, cria o `.env`, gera a chave mestra, prepara o ambiente de devnet,
compila e deploya o programa Anchor se o toolchain estiver instalado, migra o
banco, popula o ecossistema de exemplo e roda o diagnóstico.

### Todos os comandos

| comando | o que faz |
|---|---|
| `npm run setup` | tudo abaixo, na ordem certa, de forma idempotente |
| `npm run dev` | sobe a API, a apresentação em `/` e o produto em `/app` |
| `npm test` | suíte completa, sem tocar a rede |
| `npm run test:pg` | a mesma suíte contra um Postgres de verdade em container |
| `npm run test:anchor` | a mesma suíte com `ESCROW_DRIVER=anchor` |
| `npm run test:e2e` | o fluxo inteiro num navegador, com captura em cada passo |
| `npm run test:a11y` | auditoria de acessibilidade (axe, WCAG 2.1 AA) em treze telas |
| `npm run lint` | sintaxe, import quebrado, console solto e segredo commitado |
| `npm run build:artifact` | prova que um clone limpo sobe e responde |
| `npm run admin -- email` | promove uma conta a mediadora |
| `anchor test` | testes do programa em Rust, contra um validador (precisa do toolchain Anchor) |
| `npm run migrate` | aplica as migrations pendentes |
| `npm run migrate:status` | mostra o que já aplicou e o que falta |
| `npm run bootstrap` | prepara o ambiente de devnet |
| `npm run seed` | popula o ecossistema de exemplo **e reserva na rede** o valor das vagas que ele já cria adiantadas |
| `npm run doctor` | diagnóstico do ambiente em vinte segundos |
| `npm run demo` | o fluxo completo no terminal, do cadastro ao certificado |
| `npm run reset` | apaga o banco local (use `-- --tudo` para apagar também o estado de devnet) |

O `seed` toca a rede de propósito. Ele grava as vagas de exemplo em etapas
diferentes da trilha, e uma vaga marcada como "pagamento reservado" sem cofre de
verdade é uma mentira que só aparece no pior momento: quem clicar em confirmar a
entrega vê a liberação falhar. Se a rede estiver fora, ele diz qual vaga ficou
sem cofre em vez de fingir.

---

## O que você precisa configurar

O sistema sobe sem configuração nenhuma, em modo reduzido. Duas coisas valem o
minuto que levam:

**1. Uma chave do Helius (gratuita).** Sem ela não há confirmação independente
do certificado, e o faucet público de devnet costuma recusar por limite de IP.
Pegue em https://dashboard.helius.dev e coloque no `.env`:

```
HELIUS_API_KEY=sua-chave-aqui
```

**2. SOL de teste na conta da plataforma.** O `bootstrap` tenta o faucet do RPC,
depois o do Helius, e por último imprime o endereço. Se os dois recusarem, cole
o endereço em https://faucet.solana.com e rode `npm run bootstrap` de novo.

A plataforma paga a taxa de rede de todo mundo: estudante e contratante nunca
precisam ter SOL. Por isso a conta da plataforma precisa ter saldo, e só ela.

### Valor de teste para quem se cadastra

Um contratante que cria conta pela tela nasce com saldo do token de teste, em
devnet. Sem isso a ação principal dele — reservar o valor — falharia na rede por
saldo zero, e a tela não teria como explicar por quê. É comportamento de
ambiente de demonstração: em produção, com USDC de verdade, quem paga traz o
próprio saldo, e a porta é a existência do token de teste no estado da
plataforma.

### Cotação do real

A tela mostra o valor em real como número principal e o USDC embaixo, como
referência: um universitário não sabe quanto vale 800 USDC. A conversão é
ilustrativa e mora num lugar só, em `COTACAO_BRL_POR_USDC`, servida para a
interface pela rota de saúde. Sem ela, a tela volta a mostrar o USDC como número
principal em vez de inventar uma cotação.

---

## Deploy

O que está no ar roda em Render, e três variáveis decidem se o produto funciona
ou só parece funcionar:

| variável | por que ela não é opcional |
|---|---|
| `UNIWORK_PLATFORM_STATE` | o estado da plataforma (conta, token de pagamento, merkle tree) como JSON em uma linha. O `.uniwork/platform.json` está no `.gitignore` porque contém chave privada, e o disco do Render é efêmero: sem esta variável, o ambiente nasce sem bootstrap e **todo "reservar o valor" falha** |
| `DATABASE_URL` | sem ela o servidor usa PGlite, que grava no disco local. Em disco efêmero, cada deploy apaga contas, vagas e certificados — e um certificado que some quebra justamente a promessa de que qualquer pessoa confere depois |
| `PUBLIC_BASE_URL` | vai na URI dos metadados do certificado. Em `localhost`, nenhum indexador externo alcança, e a confirmação independente fica eternamente "aguardando" |

Confira o resultado sem abrir o navegador:

```bash
curl https://SEU-DOMINIO/api/health/ready
```

A resposta traz uma linha por dependência. `plataforma: bootstrap_pendente`
significa que falta a primeira variável da tabela.

---

## Banco de dados

Sem `DATABASE_URL`, o sistema usa **PGlite embarcado**: Postgres de verdade
compilado para WASM, rodando dentro do processo, sem instalar nada. É o padrão
para desenvolvimento e demonstração.

Com `DATABASE_URL`, usa **Postgres gerenciado**. O SQL é idêntico nos dois, e a
suíte roda verde contra os dois (`npm test` e `npm run test:pg`).

### Migrar para Supabase

1. **Crie o projeto** em https://supabase.com/dashboard. Escolha a região mais
   perto de quem vai usar (para o Brasil, `sa-east-1`).

2. **Copie a connection string do pooler**, não a direta. No painel:
   *Project Settings* → *Database* → *Connection string* → aba **Transaction
   pooler** (porta `6543`). O pooler aguenta muito mais conexão simultânea, que
   é o que um serviço HTTP precisa.

   ```
   DATABASE_URL=postgresql://postgres.SEUPROJETO:SUASENHA@aws-0-sa-east-1.pooler.supabase.com:6543/postgres
   ```

   Coloque isso no `.env`. A senha é a que você definiu ao criar o projeto; se
   perdeu, gere outra em *Database* → *Reset database password*.

3. **Aplique o schema:**

   ```bash
   npm run migrate
   ```

   O runner cria a tabela `schema_migrations`, aplica o que falta em transação e
   não repete o que já rodou. Rodar duas vezes não quebra nada.

4. **Popule, se quiser dado de exemplo:**

   ```bash
   npm run seed
   ```

5. **Confira:**

   ```bash
   npm run doctor
   ```

Observações que economizam tempo:

- O pooler em modo *transaction* não suporta statement prepared entre
  transações. O driver aqui não usa, então funciona; se você trocar de driver,
  lembre disso.
- `DB_POOL_MAX` limita as conexões por instância (padrão 10). Se você rodar
  várias instâncias, some antes de comparar com o limite do seu plano.
- `DB_STATEMENT_TIMEOUT_MS` e `DB_IDLE_TX_TIMEOUT_MS` cortam consulta travada e
  transação esquecida aberta. Os padrões (15s e 30s) são conservadores.
- Backup: no plano pago o Supabase faz diário automático. No gratuito, use
  `pg_dump` contra a connection string direta (porta 5432, não a do pooler).

### Escrever uma migration nova

Crie `migrations/0005_o_que_muda.sql`. O runner aplica em ordem de nome.

Nunca edite uma migration que já rodou: o banco de produção não vai ter o que o
arquivo diz que tem. O runner guarda o checksum de cada uma e avisa alto quando
detecta edição, mas ele não conserta, porque não dá para adivinhar o que você
queria. Crie uma migration nova.

---

## Arquitetura

```
FRONTEND   o que o usuário vê
           Conta, saldo, garantia, certificado, comprovante.
           Nada de carteira, chave, taxa de rede ou blockchain.
                          |  REST + SSE
BACKEND    lógica de negócio comum
           Cadastro, vagas, candidaturas, conversa, avaliações, notificações.
           Postgres. Rápido e barato. Nada disso precisa de rede pública.
                          |  RPC
REDE       a camada de confiança
           Escrow do pagamento e certificado.
           Só o que precisa ser inviolável e verificável por terceiros.
```

A regra que decide o que vai para a rede: tudo que não precisa de confiança
pública fica fora dela. Perfil, descrição de vaga, conversa e avaliação em texto
vão para o banco comum. Só o dinheiro em trânsito e o certificado emitido vão
para a rede.

### Estrutura

```
migrations/              schema versionado, aplicado por npm run migrate
src/
  config.js              toda a configuração em um lugar
  server.js              express: API, apresentação e produto no mesmo processo
  db/index.js            driver duplo: PGlite embarcado ou Postgres gerenciado
  db/migrate.js          runner idempotente, transacional, com checksum
  domain/jobs.js         máquina de estados do trampo, trilha de seis etapas
  domain/auth.js         cadastro, sessão, resumo de conta
  domain/events.js       barramento de eventos (timeline, métricas, SSE)
  domain/chain-queue.js  fila do que toca a rede, com repetição e desistência
  lib/                   ids, dinheiro, erros
  services/wallet.js     conta embutida (keypair real, AES-256-GCM + scrypt)
  services/solana.js     conexão, envio de transação, saldos, faucet
  services/platform.js   estado do bootstrap: conta, token de teste, merkle tree
  services/escrow.js     dois drivers: cofre custodial e programa Anchor
  services/certificate.js  cNFT via Bubblegum, hash canônico, cartão em SVG
  services/das.js        leitura pela DAS API, a segunda testemunha
  routes/                auth, jobs, certificates, metrics, chain, stream
  workers/chain.js       tira da fila e tenta de novo, com espera crescente
programs/uniwork-escrow/ programa Anchor em Rust
public/
  index.html             apresentação pública, servida na raiz
  landing.js             o pouco de comportamento que a apresentação precisa
  app.html              o produto, servido em /app
  app.js                 a aplicação de tela única, sem build
  tema.js                aplica o tema salvo antes da primeira pintura
scripts/                 setup, bootstrap, migrate, seed, doctor, reset, demo
tests/                   suíte que roda offline
```

---

## Interface

Três colunas: navegação à esquerda, conteúdo no meio, e à direita a resposta
para "onde está a minha grana" — quanto está esperando resposta, quanto está
reservado e quanto já foi recebido.

O contratante não cai na lista de trampos abertos, que são vagas de outras
empresas: a casa dele é **Minhas vagas**, com uma fila de decisões paradas no
topo — escolher estudante quando há candidatura, reservar o valor quando a vaga
está publicada sem garantia. As candidaturas mostram curso, universidade,
quantos trampos a pessoa já fez e quantas horas tem certificadas, porque
escolher entre dois nomes sem contexto é impossível.

Tema claro e escuro de verdade: o botão na barra de cima alterna, a escolha fica
salva, e quem nunca escolheu nada recebe o tema do sistema
(`prefers-color-scheme`). O tema é aplicado por `public/tema.js` antes da
primeira pintura — fazer isso no `app.js`, que carrega como módulo, faria a tela
piscar clara para quem escolheu escuro.

A trilha das seis etapas aparece em cada cartão com o rótulo do estado atual
("etapa 3 de 6, escolhendo quem faz") e diz explicitamente quando o valor ainda
não foi reservado, que é a informação que decide se vale se candidatar.

---

## A trilha de seis etapas

```
aberta -> garantida -> aceita -> em_andamento -> entregue -> concluida
   \__________\__________\____________\_____________/
                     cancelada
```

A ordem não é decorativa. O estudante só consegue aceitar depois de
**garantida**, porque a promessa do produto é que ele vê o pagamento reservado
antes de dizer sim. Há teste provando que o sistema recusa pular essa etapa.

---

## Escrow: dois drivers

| | `vault` | `anchor` |
|---|---|---|
| precisa de deploy | não | sim |
| autoridade sobre o cofre | a plataforma | o programa |
| o contratante consegue sacar? | não | não |
| a plataforma consegue sacar? | **sim** | não |

O `vault` existe para o projeto rodar sem toolchain de Rust. O alvo é `anchor`,
onde nem o contratante nem o Uni.work conseguem tirar o valor fora das duas
saídas previstas (liberar para o estudante, devolver para o contratante).

O `doctor` avisa quando você está no `vault`.

### Quando a rede falha

Erro de rede não bloqueia o fluxo de produto: a operação entra na fila e a tela
segue. O worker tenta de novo, com espera crescente de 15 segundos a 30 minutos,
até oito vezes.

Falta de ambiente preparado é tratada como erro **permanente**, e não como queda
de rede. Sem o token de pagamento, a décima tentativa falha igual à primeira, e
insistir só empilha a mesma falha no lugar da causa: a fila desiste na hora,
registra o motivo, e quem clicou lê que o ambiente de demonstração ainda não foi
preparado. O comando que resolve fica no log e na camada técnica, nunca na tela.

O estado da plataforma é relido quando o arquivo muda. O `bootstrap` roda em
outro processo, então um servidor que subiu antes dele guardaria para sempre a
versão sem o token — o erro mandaria rodar o bootstrap, a pessoa rodaria, e nada
mudaria até reiniciar. Com a releitura, a próxima operação já enxerga o ambiente
pronto.

---

## Certificado

Emitido no mesmo instante em que o pagamento é liberado. Por padrão vira um
compressed NFT via Bubblegum, na conta do estudante. A merkle tree criada pelo
bootstrap tem profundidade 14: cabem 16.384 certificados nela.

Se a rede recusar, o certificado cai num registro de memo e a operação entra na
fila para virar cNFT de verdade depois. O fallback nunca é o estado final.

O nome do certificado é cortado no limite de **bytes** do padrão de metadados, e
não de caracteres. Em português isso morde: "á" ocupa dois bytes, e um nome de 32
caracteres pode chegar a 40 — o programa recusa o mint com *"name in metadata is
too long"* e o certificado fica preso na fila.

O JSON servido em `/api/certificates/:codigo/metadata.json` é gravado no banco
no momento da emissão e servido de lá para sempre. Um certificado que muda de
conteúdo depois de emitido não é um certificado.

A verificação pública (`/verificar/:codigo`) funciona sem conta e faz duas
conferências independentes: recalcula o hash canônico do conteúdo, e pergunta ao
indexador se o ativo existe e quem é o dono. A segunda só funciona com
`HELIUS_API_KEY`; sem ela, a tela diz que a confirmação independente não está
disponível, em vez de fingir que confirmou.

---

## Testes

```bash
npm test          # suíte completa, offline
npm run test:pg   # a mesma suíte contra Postgres de verdade em container
```

Cobertura em cinco camadas, e as cinco pegam coisas diferentes:

- `npm test` prova a lógica de produto e a montagem das transações, offline.
- `npm run test:anchor` prova que o mesmo fluxo passa pelo driver do programa,
  e não só pelo cofre custodial.
- `anchor test` compila o programa em Rust e o roda contra um validador de
  verdade. É o único que prova o que o programa recusa: terceiro tentando
  liberar, liberação em dobro, devolução depois de pago, disputa atropelada.
  Precisa do toolchain Anchor instalado.
- `npm run test:e2e` roda o fluxo inteiro em Chromium. Ele pega o que nenhum
  teste de lógica pega: a tela realmente montando, os cliques ligados, e
  qualquer erro que só acontece quando o navegador executa o arquivo. Achou
  cinco defeitos reais que a suíte offline não via.
- `npm run test:a11y` audita treze telas com o axe, incluindo modal aberto,
  gaveta técnica e a verificação pública. Zero violação crítica ou séria é
  requisito, e uma tela que não abriu conta como reprovada, não como aprovada.

A suíte não toca a rede. Os testes de escrow decodificam a transação byte a byte
e provam que a instrução é `TransferChecked`, com o valor certo, saindo da conta
certa, autorizada por quem deve autorizar.

O `npm test` roda só o que está em `tests/`. Sem esse escopo, o runner do Node
varre o repositório pelo nome dos arquivos e recolhe `scripts/test-postgres.js`
e `scripts/test-anchor-driver.js`, que não são testes — o segundo roda a suíte
inteira dentro da suíte.

---

## A regra de ouro

**O usuário nunca vê blockchain.**

O produto fala em: conta, saldo, garantia, pagamento, certificado, comprovante,
registro público. Vale para mensagem de erro também: se uma transação falhar, o
usuário lê "não conseguimos concluir agora, já estamos tentando de novo", nunca
o erro cru.

Há duas exceções, e as duas são declaradas:

- A gaveta **camada técnica**, no fim da barra da direita, fechada por padrão.
  Ela existe para demonstração e mostra cada operação com instruções e
  assinatura. É marcada com `data-camada-tecnica` no HTML e com um par de
  comentários no JavaScript, e o teste de vocabulário usa essas marcas para
  saber onde a exceção começa e termina.
- A **página de apresentação** (`public/index.html` e `public/landing.js`), que
  é material de divulgação e não tela de produto. Ela nomeia a Solana como
  credencial e usa o vocabulário para negá-lo — "sem carteira, sem chave, sem
  taxa de rede" —, então o teste de vocabulário a exclui por nome.

Fora dessas duas, um teste lê todo arquivo servido em `public/` e falha se o
jargão de rede aparecer.

---

## Escopo

Devnet sempre. O "USDC" é um SPL Token de teste criado pelo próprio bootstrap,
com o mesmo comportamento técnico e zero valor financeiro. Os contratantes de
exemplo são fictícios. O check-in é um botão, não geolocalização.

O critério: **o mecanismo é real e demonstrável; o valor movimentado é
fictício.** Migrar para mainnet é uma decisão separada, com os requisitos de
compliance que ela implica.

Fora do escopo agora, mas no radar: integração com MoneyGram Ramps, para o
freela de trabalho presencial sacar em dinheiro numa agência parceira sem
precisar entender USDC. A infraestrutura de saque físico já existe; falta a
integração.

---

## Documentos

- [`docs/estrutura_tecnica_mvp.md`](docs/estrutura_tecnica_mvp.md) — o plano
  técnico escrito **antes** da implementação. Vale como registro da decisão
  original, não como descrição do que existe: ele ainda trata o nome do produto
  como aberto, e parte do que ele propõe foi construído de outro jeito. Para a
  arquitetura de agora, leia as seções acima.
- [`docs/pitch_certificado_freela.md`](docs/pitch_certificado_freela.md) — o pitch
- [`docs/dados_fontes_pitch.md`](docs/dados_fontes_pitch.md) — pesquisa e fontes
