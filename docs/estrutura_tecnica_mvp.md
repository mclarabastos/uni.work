# Trampo / Uni.work — Estrutura do Produto e Stack Técnica para o MVP

**Track 01 — Vida Universitária | Hackathon Superteam Brasil**
*Nome em aberto entre "Trampo" e "Uni.work" — usar como placeholder ao longo do documento*

---

## 1. O produto, resumido

Marketplace de trabalhos temporários para universitários. A cada trabalho concluído, dois eventos acontecem simultaneamente:

1. O pagamento é liberado do escrow para o freela.
2. Um certificado verificável é emitido, comprovando a atividade — usável como hora complementar ou portfólio.

Por trás, tudo roda em Solana. Na frente, o usuário não vê nada disso.

### 1.1 Dois tipos de trabalho na mesma plataforma

O marketplace comporta duas modalidades, e isso muda a forma de pagamento em cada uma:

**A) Trabalho presencial/local** — staff de evento, credenciamento, monitoria, tutoria presencial. Contratante é tipicamente uma empresa ou produtora brasileira. Aqui o freela quer o dinheiro "de verdade" no fim do dia — é o caso de uso onde a saída via MoneyGram (dinheiro físico, ver seção 10) faz mais sentido, porque o usuário não é necessariamente cripto-nativo.

**B) Trabalho remoto/internacional** — design, desenvolvimento, criação de conteúdo, tradução — no formato de pequenos serviços/bounties, como o modelo que a própria Superteam usa para remunerar quem executa tarefas para o ecossistema. Aqui, o contratante pode ser uma empresa de fora do Brasil, e faz todo sentido o pagamento permanecer em USDC — é exatamente o tipo de usuário (freelancer remoto, empresa internacional) que já é confortável recebendo/pagando em stablecoin, sem precisar converter pra dinheiro físico.

Essa divisão é importante para o pitch: mostra que a escolha de pagar em cripto não é arbitrária — ela faz mais sentido em um dos dois casos (B) do que no outro (A), e o produto contempla os dois sem forçar a mesma solução pros dois perfis de usuário.

---

## 2. Princípio de design: o usuário nunca precisa saber que existe blockchain

Este é o ponto mais importante da arquitetura, e vale repetir antes de qualquer decisão técnica: **estudante e contratante não devem ver a palavra "wallet", "chave privada", "gas fee" ou "assinar transação" em nenhum momento da experiência.**

Isso é possível hoje graças a uma categoria de ferramenta chamada **embedded wallet** (carteira embutida) ou **wallet-as-a-service**. Na prática, ela funciona assim:

- O usuário se cadastra com e-mail, Google ou número de celular — como em qualquer app comum.
- Por trás, o serviço cria automaticamente uma wallet Solana para esse usuário, guardando as chaves de forma segura (geralmente distribuída/criptografada, não numa única mão).
- Quando uma ação precisa de "assinatura" (aceitar um trabalho, confirmar conclusão), o app mostra um botão comum ("Confirmar entrega") — a assinatura da transação acontece de forma invisível.

Ferramentas desse tipo relevantes para Solana: **Privy**, **Web3Auth**, **Dynamic** e **Crossmint**. Para um MVP de hackathon, qualquer uma delas cobre a necessidade — a decisão entre elas pode ficar para depois, o importante agora é registrar que essa camada existe e resolve exatamente o problema de UX que vocês querem evitar.

---

## 3. Arquitetura em três camadas

```
┌─────────────────────────────────────────┐
│  FRONTEND (o que o usuário vê)           │
│  App web/mobile — nada de "blockchain"   │
└───────────────┬───────────────────────────┘
                │
┌───────────────▼───────────────────────────┐
│  BACKEND (a lógica de negócio comum)      │
│  Cadastro, vagas, chat, notificações       │
└───────────────┬───────────────────────────┘
                │
┌───────────────▼───────────────────────────┐
│  BLOCKCHAIN (a camada de confiança)        │
│  Escrow do pagamento + emissão do certificado │
└─────────────────────────────────────────────┘
```

A regra geral: **tudo que não precisa de confiança pública fica fora da blockchain** (perfil do usuário, descrição da vaga, chat, avaliação em texto) — isso vai num banco de dados comum, mais rápido e barato. **Só o que precisa ser inviolável e verificável por terceiros vai on-chain**: o dinheiro em trânsito (escrow) e o certificado emitido.

---

## 4. Camada Blockchain (o coração técnico do projeto)

### 4.1 A rede: Solana

Escolhida pelas razões já validadas: taxa de transação próxima de zero (viável para diárias de baixo valor) e liquidação em segundos.

### 4.2 O dinheiro: stablecoin (USDC)

O pagamento não deve ser feito em SOL puro (que varia de preço) — deve ser em **USDC**, a stablecoin mais usada na rede, atrelada ao dólar. Isso significa que o contratante deposita o equivalente ao valor combinado, e o freela recebe exatamente esse valor, sem risco de variação de preço no meio do caminho. USDC na Solana segue o padrão **SPL Token** (o equivalente Solana ao ERC-20 da Ethereum).

### 4.3 O contrato de escrow: um "programa" Solana

Na Solana, o que outras redes chamam de "smart contract" se chama **programa**, geralmente escrito em Rust usando o framework **Anchor** (o padrão de mercado para tornar esse desenvolvimento mais rápido e seguro).

O programa de escrow para o MVP precisa fazer, no mínimo:

1. **Depositar**: contratante envia USDC para uma conta controlada pelo programa (não por nenhuma das duas partes sozinha).
2. **Confirmar conclusão**: uma ação (ex: o freela marca "concluí" e o contratante confirma, ou um QR code de check-out é escaneado) libera a trava.
3. **Liberar**: o programa transfere o USDC da conta de escrow para a wallet do freela.
4. **Dispara o certificado**: a mesma confirmação aciona a emissão do certificado (item 4.4).

Não é necessário escrever esse programa inteiramente do zero — existem templates de referência de escrow em Anchor disponíveis publicamente (inclusive o próprio guia oficial da Solana usa "escrow" como exemplo didático de programa Anchor), que podem ser adaptados para o caso de uso específico.

### 4.4 O certificado: NFT comprimido (compressed NFT / cNFT)

Aqui está uma decisão técnica importante para o MVP: **um certificado é, na prática, um NFT** — um token único e não fungível que representa aquele registro específico (aquele trabalho, aquela data, aquela carga horária).

O problema: emitir um NFT "comum" tem custo por unidade que soma rápido se a plataforma emitir milhares de certificados. A solução usada no ecossistema Solana é o **compressed NFT (cNFT)**, viabilizado pelo protocolo **Metaplex Bubblegum** — ele permite emitir uma quantidade enorme de NFTs a um custo drasticamente menor, mantendo a mesma verificabilidade pública. Para um produto que pretende emitir um certificado a cada trabalho concluído (potencialmente milhares por mês), cNFT é a escolha técnica correta, não um "extra".

Cada certificado carregaria metadados como: nome da atividade, carga horária, data, contratante, e um link/hash para verificação.

### 4.5 RPC e indexação: como o app "lê" a blockchain

O app não se conecta diretamente aos validadores da rede — ele usa um **provedor de RPC** (o "portal de entrada" para ler e escrever na blockchain). Para Solana, os mais usados são **Helius**, **QuickNode** e **Triton**. Helius, especificamente, tem suporte nativo a uma API para consultar cNFTs (a **DAS API** — Digital Asset Standard), o que facilita muito mostrar "todos os certificados do usuário X" sem reinventar a indexação do zero.

---

## 5. Camada Backend

Tudo que é lógica de produto comum, sem necessidade de estar na blockchain:

- **Cadastro e autenticação**: integrado com a embedded wallet (login por e-mail/Google que já cria a wallet por trás, como visto na seção 2).
- **Banco de dados**: PostgreSQL (via um serviço gerenciado como Supabase, que já resolve autenticação, banco e storage juntos — bom encaixe para velocidade de hackathon).
- **Publicação de vagas, chat, avaliações em texto, notificações**: API REST comum (Node.js/Express, ou as próprias funções do Supabase), sem qualquer relação com blockchain.
- **Orquestração da chamada ao programa Solana**: quando o usuário aperta "Confirmar entrega" na interface comum, o backend (ou o frontend diretamente, dependendo da escolha) monta e envia a transação para a rede via o RPC.

---

## 6. Camada Frontend

- **Framework**: React (Next.js), a escolha mais comum e com melhor suporte a bibliotecas do ecossistema Solana.
- **Conexão com a wallet**: aqui entra a embedded wallet (Privy/Web3Auth/Dynamic/Crossmint) escolhida na seção 2 — ela fornece um SDK que se integra ao React e expõe funções simples tipo `signAndSend()`, sem expor o usuário a nenhuma tela de "wallet" tradicional (tipo Phantom).
- **Interface**: nenhuma tela deve mencionar "carteira", "blockchain" ou "cripto" — a linguagem do produto usa "conta", "saldo", "certificado", "comprovante".

---

## 7. Fluxo técnico completo, do início ao fim

1. Estudante se cadastra com e-mail → embedded wallet é criada automaticamente por trás.
2. Contratante publica vaga e deposita valor em USDC → transação chama o programa de escrow, fundos ficam travados numa conta controlada pelo programa.
3. Estudante aceita a vaga (registro no backend comum, sem custo de blockchain).
4. Trabalho é realizado.
5. Conclusão é confirmada (ex: ambos confirmam no app, ou um QR code de check-out é escaneado).
6. Essa confirmação dispara duas ações no mesmo fluxo:
   - o programa de escrow libera o USDC da conta travada para a wallet do estudante;
   - um cNFT de certificado é mintado (via Metaplex Bubblegum) para a mesma wallet, com os metadados do trabalho.
7. App mostra ao estudante, em linguagem simples: "Pagamento recebido: R$120" e "Certificado emitido — 6h de atividade complementar", sem nenhuma menção técnica.

---

## 8. Stack resumida (tabela de referência rápida)

| Camada | Componente | Ferramenta sugerida |
|---|---|---|
| Frontend | Framework | Next.js (React) |
| Frontend | Wallet invisível ao usuário | Privy, Web3Auth, Dynamic ou Crossmint |
| Backend | Banco de dados + auth + storage | Supabase (Postgres) |
| Backend | API | Node.js/Express, ou funções nativas do Supabase |
| Blockchain | Rede | Solana |
| Blockchain | Moeda do pagamento | USDC (padrão SPL Token) |
| Blockchain | Contrato de escrow | Programa Anchor (Rust), a partir de template de referência |
| Blockchain | Certificado | Compressed NFT via Metaplex Bubblegum |
| Blockchain | Acesso/leitura da rede | RPC + DAS API — Helius (ou QuickNode) |

---

## 9. Escopo do MVP de hackathon: 100% Devnet, custo zero, dados mockados onde precisar

Regra geral para esta seção: **nenhuma parte do MVP deve envolver dinheiro real, empresa real pagando de verdade, ou infraestrutura paga.** Tudo roda em ambiente de teste. O objetivo é só demonstrar o fluxo funcionando de ponta a ponta, não operar um produto real.

O que isso significa, na prática, componente por componente:

- **Rede**: tudo em **Devnet**, a rede de testes pública da Solana. Nunca Mainnet. Isso, por si só, já garante que nenhuma transação tem valor financeiro real.
- **"USDC" do MVP**: em vez do USDC real (que teria valor), usa-se um **token de teste (SPL Token mockado)**, criado pelo próprio time, simulando ser o USDC — mesmo comportamento técnico, zero valor real. Alternativa mais simples ainda: usar o próprio SOL de Devnet, obtido de graça via **faucet** (torneira de tokens de teste que a própria Solana disponibiliza — ninguém paga nada por isso).
- **Vagas e contratantes**: os "contratantes" de exemplo no demo são fictícios/mockados (ex: "Produtora XPTO", "Empresa Beta") — não é necessário (nem desejável) usar nome de empresa real sem autorização.
- **Check-in/check-out**: simulado com um botão de confirmação simples na interface, em vez de geolocalização ou QR code funcionando de verdade.
- **Embedded wallet**: usar o plano gratuito de qualquer um dos provedores (Privy, Web3Auth, Dynamic) configurado para Devnet — a criação de wallet embutida não tem custo nesse estágio.
- **RPC**: usar o endpoint público e gratuito de Devnet da Solana, ou o plano gratuito do Helius — suficiente para volume de demo.
- **Escrow**: o programa Anchor pode (e deve) ser real e funcional — só que deployado em Devnet, movimentando o token de teste, não dinheiro de verdade. Isso é importante: o *mecanismo* do escrow deve funcionar de verdade no demo (é o que prova o conceito), só o *dinheiro* que passa por ele é fictício.
- **Certificado (cNFT)**: também real e funcional em Devnet — o certificado é de fato mintado e fica na wallet de teste do usuário, comprovando que o mecanismo de emissão funciona, sem nenhum custo real envolvido.

Resumindo o critério de decisão: **o mecanismo (escrow, emissão de certificado, fluxo de UX) deve ser real e demonstrável — o valor movimentado (dinheiro, empresas, dados de contratante) pode e deve ser mockado.** Isso é o que permite mostrar um MVP crível sem gastar um centavo.

---

## 10. Fora do escopo do MVP, mas bom mencionar como "próximos passos" no pitch

- **Integração com MoneyGram Ramps**, para permitir que o freela de trabalho presencial (modalidade A da seção 1.1) saque o pagamento em dinheiro físico numa agência parceira, sem precisar entender USDC ou wallet — resolve exatamente o perfil de usuário que não é cripto-nativo. Esse é o ponto mais forte a destacar no pitch como visão de futuro: o mecanismo de saque físico já existe como infraestrutura madura (ver pesquisa anterior desta conversa), falta só a integração.
- Para a modalidade B (trabalho remoto/internacional), o USDC permanece como forma final de recebimento — não há necessidade de conversão para dinheiro físico nesse caso, já que esse perfil de usuário tende a já lidar naturalmente com stablecoin.
- Validação formal do certificado junto a coordenações de curso (é decisão institucional de cada faculdade, fora do controle técnico do produto).
- Migração de Devnet para Mainnet, com todos os requisitos de compliance que isso implica (aí sim, com dinheiro real envolvido, e não antes disso).
