# Trampo

Marketplace de trabalhos temporários para universitários, com pagamento em escrow e certificado de hora complementar emitido automaticamente — rodando na Solana.

> Hackathon Superteam Brasil — Track 01 · Vida Universitária
> MVP conceitual, 100% Devnet, sem custo real em nenhuma camada.

## Estrutura do repositório

Monorepo no padrão comum de projetos Solana (programa Anchor na raiz, apps organizados por workspace).

```
trampo/
├── Anchor.toml           → configuração do workspace Anchor (Devnet)
├── programs/
│   └── escrow/            → programa on-chain que trava o pagamento até confirmação
├── tests/                  → testes do programa (Anchor/TypeScript)
├── apps/
│   ├── web/                → frontend (Next.js) — wallet fica invisível ao usuário final
│   └── api/                → backend (Node/Express + Supabase) — lógica de negócio comum
└── docs/                    → pitch, dados de pesquisa e a estrutura técnica completa do produto
```

## Por onde começar

1. `docs/estrutura_tecnica_mvp.md` — arquitetura em 3 camadas e a stack escolhida.
2. `docs/pitch_certificado_freela.md` — o pitch estruturado do produto.
3. Cada workspace (`apps/web`, `apps/api`, `programs/escrow`) tem seu próprio README.

## Stack resumida

| Camada | Tecnologia |
|---|---|
| Frontend (`apps/web`) | Next.js (React) |
| Wallet (invisível ao usuário) | Privy / Web3Auth / Dynamic |
| Backend (`apps/api`) | Node.js/Express + Supabase (Postgres) |
| Rede | Solana (Devnet) |
| Pagamento | Token de teste (simulando USDC) |
| Escrow (`programs/escrow`) | Programa Anchor (Rust) |
| Certificado | Compressed NFT (Metaplex Bubblegum) |
| RPC / indexação | Helius (Devnet) |

## Regra do MVP

O mecanismo (escrow, emissão de certificado) deve ser real e funcional em Devnet. O valor movimentado e os dados de contratante podem e devem ser mockados — nenhuma parte do MVP envolve dinheiro real.

## Setup do monorepo (placeholder)

```bash
pnpm install         # instala as dependências de apps/web e apps/api via workspace
anchor build          # compila o programa em programs/escrow
anchor test            # roda os testes em Devnet/localnet
```
