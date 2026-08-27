// Programa de escrow — Trampo
// Roda em Devnet. Nenhuma transação aqui envolve valor real.
//
// Responsabilidades deste programa:
//   1. deposit()  -> contratante deposita o token de teste numa conta controlada pelo programa
//   2. confirm()  -> confirmação de conclusão do trabalho (libera a trava)
//   3. release()  -> transfere o token da conta de escrow para a wallet do freela
//
// A emissão do certificado (compressed NFT via Metaplex Bubblegum) é disparada
// pelo backend (apps/api) no momento em que release() é confirmado on-chain —
// não faz parte deste programa.

use anchor_lang::prelude::*;

declare_id!("REPLACE_WITH_PROGRAM_ID_AFTER_ANCHOR_BUILD");

#[program]
pub mod escrow {
    use super::*;

    pub fn deposit(_ctx: Context<Deposit>, _amount: u64) -> Result<()> {
        // TODO: transferir o token do contratante para a conta de escrow (PDA)
        todo!()
    }

    pub fn confirm(_ctx: Context<Confirm>) -> Result<()> {
        // TODO: marcar o job como concluído (ex: ambas as partes confirmaram)
        todo!()
    }

    pub fn release(_ctx: Context<Release>) -> Result<()> {
        // TODO: transferir o token da conta de escrow para a wallet do freela
        todo!()
    }
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    // TODO: definir contas necessárias (contratante, conta de escrow/PDA, token program)
}

#[derive(Accounts)]
pub struct Confirm<'info> {
    // TODO: definir contas necessárias (freela, contratante, conta do job)
}

#[derive(Accounts)]
pub struct Release<'info> {
    // TODO: definir contas necessárias (conta de escrow/PDA, wallet do freela, token program)
}
