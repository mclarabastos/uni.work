# apps/api — Trampo

Lógica de negócio comum: tudo que não precisa de confiança pública fica aqui, fora da blockchain.

## Stack sugerida

- Node.js + Express (ou funções nativas do Supabase, se preferir menos peças)
- Supabase (Postgres) para banco de dados, autenticação e storage

## Estrutura

```
src/
├── routes/     → endpoints da API (vagas, cadastro, comprovantes)
├── services/   → lógica de negócio (ex: orquestrar a chamada ao programa em programs/escrow)
└── db/         → modelos e acesso ao banco de dados
```

## Responsabilidades

- Cadastro e perfil do usuário (integrado à wallet embutida criada em `apps/web`)
- Publicação e listagem de vagas (presencial e remoto)
- Chat e notificações
- Disparar a transação de escrow/certificado no momento certo (depósito, confirmação de entrega)

## O que NÃO fica aqui

Qualquer coisa que precise ser inviolável ou verificável por terceiros (o dinheiro em trânsito, o certificado emitido) — isso vive em `programs/escrow`.

## Setup (placeholder)

```bash
pnpm --filter trampo-api dev
```
