# programs/escrow

Programa on-chain do Trampo — trava o pagamento até a confirmação do trabalho.

**Tudo roda em Devnet. Nenhuma transação aqui envolve valor real.**

## O que o programa precisa fazer

1. **deposit()** — contratante envia o token (de teste, simulando USDC) para uma conta controlada pelo programa (PDA).
2. **confirm()** — confirmação de conclusão do trabalho (libera a trava).
3. **release()** — transfere o token da conta de escrow para a wallet do freela.

A emissão do certificado (compressed NFT via Metaplex Bubblegum) é disparada por `apps/api` no momento em que `release()` é confirmado on-chain — não faz parte deste programa.

## Setup

```bash
anchor build
anchor test    # sempre em Devnet/localnet, nunca Mainnet
```
