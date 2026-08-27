# apps/web — Trampo

Interface do usuário. Regra de ouro: **nenhuma tela menciona "wallet", "blockchain", "gas" ou "cripto"**. A linguagem do produto usa "conta", "saldo", "comprovante".

## Stack sugerida

- Next.js (React)
- Wallet embutida (invisível ao usuário): Privy, Web3Auth ou Dynamic — cria a wallet Solana automaticamente no cadastro por e-mail/Google.
- Estilo: Tailwind CSS (ou o que o time preferir)

## Estrutura

```
src/
├── pages/        → telas (cadastro, feed de vagas, detalhe da vaga, comprovantes)
├── components/   → componentes reutilizáveis (card de vaga, card de comprovante, etc.)
├── lib/          → integração com a wallet embutida e chamadas à API (apps/api)
└── styles/       → estilos globais
```

## Telas mínimas para o MVP

1. Cadastro/login (e-mail ou Google → wallet criada por trás, sem o usuário perceber)
2. Feed de vagas (presencial e remoto)
3. Detalhe da vaga + botão "Aceitar" / "Confirmar entrega"
4. Tela de comprovantes recebidos (visual tipo "carteirinha")

## Setup (placeholder)

```bash
pnpm --filter trampo-web dev
```
