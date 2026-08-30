//! Programa de escrow do Uni.work.
//!
//! Roda em devnet. O token que passa por aqui e um SPL Token de teste criado
//! pelo bootstrap: mesmo comportamento tecnico do USDC, zero valor financeiro.
//!
//! O que este programa existe para garantir:
//!
//!   Depois que o contratante deposita, o valor tem exatamente quatro saidas, e
//!   nenhuma delas pode ser tomada por uma parte sozinha contra a outra:
//!
//!     1. o contratante confirma a entrega  -> vai para o estudante (menos a taxa)
//!     2. o contratante desiste antes de escolher alguem -> volta para ele
//!     3. o prazo estoura e o contratante sumiu -> vai para o estudante
//!     4. as partes discordam -> o mediador divide
//!
//!   A autoridade sobre o cofre e do programa. Nem o contratante, nem o
//!   estudante, nem o Uni.work conseguem mover o valor fora dessas quatro
//!   saidas. E essa a diferenca entre este driver e o cofre custodial.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, TransferChecked},
};

declare_id!("Escrow111111111111111111111111111111111111");

/// Teto da taxa da plataforma: 10%. Um valor gravado em codigo, e nao so
/// validado fora da rede, para nenhuma configuracao errada conseguir cobrar
/// mais do que isso de quem trabalhou.
pub const TAXA_MAXIMA_BPS: u16 = 1000;

/// Quanto tempo depois do prazo qualquer pessoa pode liberar para o estudante.
/// Existe para o estudante nao ficar refem da inercia do contratante.
pub const CARENCIA_AUTO_RELEASE: i64 = 7 * 24 * 60 * 60;

#[program]
pub mod uniwork_escrow {
    use super::*;

    /// Cria o escrow e deposita o valor no mesmo passo.
    ///
    /// Um passo so de proposito: um escrow criado e nao financiado seria um
    /// estado que promete garantia sem ter garantia nenhuma por tras.
    pub fn initialize_and_deposit(
        ctx: Context<InitializeAndDeposit>,
        job_hash: [u8; 32],
        amount: u64,
        fee_bps: u16,
        deadline: i64,
    ) -> Result<()> {
        require!(amount > 0, ErroEscrow::ValorInvalido);
        require!(fee_bps <= TAXA_MAXIMA_BPS, ErroEscrow::TaxaAcimaDoTeto);

        let escrow = &mut ctx.accounts.escrow;
        escrow.job_hash = job_hash;
        escrow.company = ctx.accounts.company.key();
        escrow.student = Pubkey::default();
        escrow.mediator = ctx.accounts.mediator.key();
        escrow.mint = ctx.accounts.mint.key();
        escrow.amount = amount;
        escrow.fee_bps = fee_bps;
        escrow.deadline = deadline;
        escrow.state = EstadoEscrow::Financiado as u8;
        escrow.dispute_reason = 0;
        escrow.opened_by = Pubkey::default();
        escrow.bump = ctx.bumps.escrow;
        escrow.created_at = Clock::get()?.unix_timestamp;

        // O valor sai da conta do contratante, autorizado por ele, e entra no
        // cofre do programa. Daqui em diante ele nao manda mais nisso sozinho.
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.company_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.company.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        emit!(TrabalhoGarantido {
            job_hash,
            company: escrow.company,
            amount,
            fee_bps,
            deadline,
        });
        Ok(())
    }

    /// Registra quem foi escolhido.
    ///
    /// Precisa estar na rede, e nao so no banco, porque auto_release e
    /// resolve_dispute mandam valor para o estudante sem o contratante
    /// participar. Se o destino viesse de fora, o programa nao garantiria nada.
    pub fn assign_student(ctx: Context<AssignStudent>, student: Pubkey) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(
            escrow.state == EstadoEscrow::Financiado as u8,
            ErroEscrow::EstadoNaoPermiteEssaAcao
        );
        require!(student != Pubkey::default(), ErroEscrow::EstudanteInvalido);
        require!(
            escrow.student == Pubkey::default(),
            ErroEscrow::EstudanteJaDefinido
        );

        escrow.student = student;
        emit!(EstudanteEscolhido { job_hash: escrow.job_hash, student });
        Ok(())
    }

    /// O contratante confirma a entrega: o valor sai para o estudante.
    ///
    /// A taxa e calculada aqui dentro, a partir do fee_bps gravado no escrow na
    /// criacao. Antes ela era calculada fora da rede, o que significa que quem
    /// controlasse o servidor controlaria a taxa depois do combinado feito.
    pub fn confirm_and_release(ctx: Context<ConfirmAndRelease>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(
            escrow.state == EstadoEscrow::Financiado as u8,
            ErroEscrow::EstadoNaoPermiteEssaAcao
        );
        require!(
            escrow.student != Pubkey::default(),
            ErroEscrow::EstudanteNaoDefinido
        );
        require_keys_eq!(
            ctx.accounts.student_token.owner,
            escrow.student,
            ErroEscrow::ContaDeDestinoErrada
        );

        let (para_estudante, taxa) = dividir(escrow.amount, escrow.fee_bps)?;
        let job_hash = escrow.job_hash;
        let bump = escrow.bump;
        let semente: &[&[&[u8]]] = &[&[b"escrow", job_hash.as_ref(), &[bump]]];
        let decimais = ctx.accounts.mint.decimals;

        pagar(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            &ctx.accounts.student_token,
            &ctx.accounts.escrow.to_account_info(),
            semente,
            para_estudante,
            decimais,
        )?;

        if taxa > 0 {
            pagar(
                &ctx.accounts.token_program,
                &ctx.accounts.vault,
                &ctx.accounts.mint,
                &ctx.accounts.platform_token,
                &ctx.accounts.escrow.to_account_info(),
                semente,
                taxa,
                decimais,
            )?;
        }

        let escrow = &mut ctx.accounts.escrow;
        escrow.state = EstadoEscrow::Liberado as u8;

        emit!(TrabalhoConfirmado {
            job_hash,
            company: escrow.company,
            student: escrow.student,
            paid_to_student: para_estudante,
            platform_fee: taxa,
        });
        Ok(())
    }

    /// O contratante desiste e o valor volta para ele.
    ///
    /// So enquanto ninguem foi escolhido. Depois que um estudante aceitou, o
    /// contratante nao consegue mais puxar o valor de volta sozinho: o caminho
    /// passa a ser a disputa.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(
            escrow.state == EstadoEscrow::Financiado as u8,
            ErroEscrow::EstadoNaoPermiteEssaAcao
        );
        require!(
            escrow.student == Pubkey::default(),
            ErroEscrow::EstudanteJaEscolhidoUseDisputa
        );

        let job_hash = escrow.job_hash;
        let bump = escrow.bump;
        let semente: &[&[&[u8]]] = &[&[b"escrow", job_hash.as_ref(), &[bump]]];
        let valor = ctx.accounts.vault.amount;

        pagar(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            &ctx.accounts.company_token,
            &ctx.accounts.escrow.to_account_info(),
            semente,
            valor,
            ctx.accounts.mint.decimals,
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.state = EstadoEscrow::Devolvido as u8;

        emit!(TrabalhoCancelado { job_hash, company: escrow.company, refunded: valor });
        Ok(())
    }

    /// Abre uma contestacao e trava a liberacao.
    ///
    /// Qualquer uma das duas partes pode abrir. Depois disso nem o contratante
    /// libera nem ele mesmo recupera: so o mediador desata o no.
    pub fn open_dispute(ctx: Context<OpenDispute>, reason_code: u8) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(
            escrow.state == EstadoEscrow::Financiado as u8,
            ErroEscrow::EstadoNaoPermiteEssaAcao
        );
        require!(
            escrow.student != Pubkey::default(),
            ErroEscrow::EstudanteNaoDefinido
        );

        let quem = ctx.accounts.party.key();
        require!(
            quem == escrow.company || quem == escrow.student,
            ErroEscrow::SemAutoridade
        );

        escrow.state = EstadoEscrow::EmDisputa as u8;
        escrow.dispute_reason = reason_code;
        escrow.opened_by = quem;

        emit!(DisputaAberta { job_hash: escrow.job_hash, opened_by: quem, reason_code });
        Ok(())
    }

    /// O mediador resolve, dividindo o valor.
    ///
    /// split_bps e a parte do estudante: 10000 e tudo para ele, 0 e tudo de
    /// volta para o contratante, 5000 e meio a meio. A taxa da plataforma incide
    /// so sobre a parte do estudante, porque e ela que remunera trabalho feito.
    pub fn resolve_dispute(ctx: Context<ResolveDispute>, split_bps: u16) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(
            escrow.state == EstadoEscrow::EmDisputa as u8,
            ErroEscrow::EstadoNaoPermiteEssaAcao
        );
        require!(split_bps <= 10_000, ErroEscrow::DivisaoInvalida);
        require_keys_eq!(
            ctx.accounts.mediator.key(),
            escrow.mediator,
            ErroEscrow::SemAutoridade
        );
        require_keys_eq!(
            ctx.accounts.student_token.owner,
            escrow.student,
            ErroEscrow::ContaDeDestinoErrada
        );
        require_keys_eq!(
            ctx.accounts.company_token.owner,
            escrow.company,
            ErroEscrow::ContaDeDestinoErrada
        );

        let total = ctx.accounts.vault.amount;
        let bruto_estudante = (total as u128)
            .checked_mul(split_bps as u128)
            .ok_or(ErroEscrow::EstouroDeCalculo)?
            .checked_div(10_000)
            .ok_or(ErroEscrow::EstouroDeCalculo)? as u64;

        let (liquido_estudante, taxa) = dividir(bruto_estudante, escrow.fee_bps)?;
        // O que sobra vai para o contratante. Calculado por subtracao para nao
        // sobrar poeira presa no cofre por causa de arredondamento.
        let para_contratante = total
            .checked_sub(bruto_estudante)
            .ok_or(ErroEscrow::EstouroDeCalculo)?;

        let job_hash = escrow.job_hash;
        let bump = escrow.bump;
        let semente: &[&[&[u8]]] = &[&[b"escrow", job_hash.as_ref(), &[bump]]];
        let decimais = ctx.accounts.mint.decimals;
        let escrow_info = ctx.accounts.escrow.to_account_info();

        if liquido_estudante > 0 {
            pagar(
                &ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.mint,
                &ctx.accounts.student_token, &escrow_info, semente, liquido_estudante, decimais,
            )?;
        }
        if taxa > 0 {
            pagar(
                &ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.mint,
                &ctx.accounts.platform_token, &escrow_info, semente, taxa, decimais,
            )?;
        }
        if para_contratante > 0 {
            pagar(
                &ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.mint,
                &ctx.accounts.company_token, &escrow_info, semente, para_contratante, decimais,
            )?;
        }

        let escrow = &mut ctx.accounts.escrow;
        escrow.state = EstadoEscrow::Dividido as u8;

        emit!(DisputaResolvida {
            job_hash,
            split_bps,
            to_student: liquido_estudante,
            to_company: para_contratante,
            platform_fee: taxa,
        });
        Ok(())
    }

    /// Libera para o estudante depois do prazo, se o contratante sumiu.
    ///
    /// Qualquer pessoa pode chamar, e isso e intencional: se so o estudante
    /// pudesse, ele precisaria saber que essa possibilidade existe e ter SOL
    /// para pagar a taxa. Como qualquer um pode, a plataforma chama por ele.
    ///
    /// Nao serve para atropelar disputa: so funciona no estado financiado.
    pub fn auto_release(ctx: Context<AutoRelease>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(
            escrow.state == EstadoEscrow::Financiado as u8,
            ErroEscrow::EstadoNaoPermiteEssaAcao
        );
        require!(
            escrow.student != Pubkey::default(),
            ErroEscrow::EstudanteNaoDefinido
        );
        require!(escrow.deadline > 0, ErroEscrow::SemPrazoDefinido);

        let agora = Clock::get()?.unix_timestamp;
        require!(
            agora >= escrow.deadline + CARENCIA_AUTO_RELEASE,
            ErroEscrow::AindaDentroDoPrazo
        );
        require_keys_eq!(
            ctx.accounts.student_token.owner,
            escrow.student,
            ErroEscrow::ContaDeDestinoErrada
        );

        let (para_estudante, taxa) = dividir(escrow.amount, escrow.fee_bps)?;
        let job_hash = escrow.job_hash;
        let bump = escrow.bump;
        let semente: &[&[&[u8]]] = &[&[b"escrow", job_hash.as_ref(), &[bump]]];
        let decimais = ctx.accounts.mint.decimals;
        let escrow_info = ctx.accounts.escrow.to_account_info();

        pagar(
            &ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.mint,
            &ctx.accounts.student_token, &escrow_info, semente, para_estudante, decimais,
        )?;
        if taxa > 0 {
            pagar(
                &ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.mint,
                &ctx.accounts.platform_token, &escrow_info, semente, taxa, decimais,
            )?;
        }

        let escrow = &mut ctx.accounts.escrow;
        escrow.state = EstadoEscrow::Liberado as u8;

        emit!(TrabalhoConfirmado {
            job_hash,
            company: escrow.company,
            student: escrow.student,
            paid_to_student: para_estudante,
            platform_fee: taxa,
        });
        Ok(())
    }
}

// ─── auxiliares ──────────────────────────────────────────────────────────────

/// Divide um valor entre o destinatario e a taxa.
/// A taxa arredonda para baixo, entao a soma bate exatamente com o total e o
/// cofre sempre zera.
fn dividir(total: u64, fee_bps: u16) -> Result<(u64, u64)> {
    let taxa = (total as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(ErroEscrow::EstouroDeCalculo)?
        .checked_div(10_000)
        .ok_or(ErroEscrow::EstouroDeCalculo)? as u64;
    let liquido = total.checked_sub(taxa).ok_or(ErroEscrow::EstouroDeCalculo)?;
    Ok((liquido, taxa))
}

/// Transfere do cofre, assinando como o PDA do escrow.
#[allow(clippy::too_many_arguments)]
fn pagar<'info>(
    token_program: &Program<'info, Token>,
    vault: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    destino: &Account<'info, TokenAccount>,
    escrow: &AccountInfo<'info>,
    semente: &[&[&[u8]]],
    valor: u64,
    decimais: u8,
) -> Result<()> {
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: destino.to_account_info(),
                authority: escrow.clone(),
            },
            semente,
        ),
        valor,
        decimais,
    )
}

// ─── estado ──────────────────────────────────────────────────────────────────

#[repr(u8)]
pub enum EstadoEscrow {
    Financiado = 0,
    Liberado = 1,
    Devolvido = 2,
    EmDisputa = 3,
    Dividido = 4,
}

#[account]
pub struct Escrow {
    pub job_hash: [u8; 32],
    pub company: Pubkey,
    pub student: Pubkey,
    pub mediator: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub fee_bps: u16,
    pub deadline: i64,
    pub state: u8,
    pub dispute_reason: u8,
    pub opened_by: Pubkey,
    pub bump: u8,
    pub created_at: i64,
}

impl Escrow {
    pub const TAMANHO: usize = 8   // discriminador
        + 32  // job_hash
        + 32  // company
        + 32  // student
        + 32  // mediator
        + 32  // mint
        + 8   // amount
        + 2   // fee_bps
        + 8   // deadline
        + 1   // state
        + 1   // dispute_reason
        + 32  // opened_by
        + 1   // bump
        + 8; // created_at
}

// ─── contas ──────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(job_hash: [u8; 32])]
pub struct InitializeAndDeposit<'info> {
    #[account(
        init,
        payer = platform,
        space = Escrow::TAMANHO,
        seeds = [b"escrow", job_hash.as_ref()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        init,
        payer = platform,
        associated_token::mint = mint,
        associated_token::authority = escrow
    )]
    pub vault: Account<'info, TokenAccount>,

    pub company: Signer<'info>,

    #[account(
        mut,
        constraint = company_token.owner == company.key() @ ErroEscrow::ContaDeOrigemErrada,
        constraint = company_token.mint == mint.key() @ ErroEscrow::MintErrado
    )]
    pub company_token: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    /// CHECK: so o endereco importa. Fica gravado no escrow e e o unico que
    /// consegue resolver uma disputa depois.
    pub mediator: UncheckedAccount<'info>,

    /// A plataforma paga o aluguel das contas: nem o contratante nem o
    /// estudante precisam ter SOL.
    #[account(mut)]
    pub platform: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AssignStudent<'info> {
    #[account(mut, seeds = [b"escrow", escrow.job_hash.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,

    #[account(constraint = company.key() == escrow.company @ ErroEscrow::SemAutoridade)]
    pub company: Signer<'info>,
}

#[derive(Accounts)]
pub struct ConfirmAndRelease<'info> {
    #[account(mut, seeds = [b"escrow", escrow.job_hash.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = escrow
    )]
    pub vault: Account<'info, TokenAccount>,

    /// So o contratante confirma a entrega. E a acao dele, e de mais ninguem.
    #[account(constraint = company.key() == escrow.company @ ErroEscrow::SemAutoridade)]
    pub company: Signer<'info>,

    #[account(mut, constraint = student_token.mint == mint.key() @ ErroEscrow::MintErrado)]
    pub student_token: Account<'info, TokenAccount>,

    #[account(mut, constraint = platform_token.mint == mint.key() @ ErroEscrow::MintErrado)]
    pub platform_token: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut, seeds = [b"escrow", escrow.job_hash.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = escrow)]
    pub vault: Account<'info, TokenAccount>,

    #[account(constraint = company.key() == escrow.company @ ErroEscrow::SemAutoridade)]
    pub company: Signer<'info>,

    #[account(
        mut,
        constraint = company_token.owner == escrow.company @ ErroEscrow::ContaDeDestinoErrada,
        constraint = company_token.mint == mint.key() @ ErroEscrow::MintErrado
    )]
    pub company_token: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct OpenDispute<'info> {
    #[account(mut, seeds = [b"escrow", escrow.job_hash.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,

    /// Contratante ou estudante. A checagem de qual dos dois esta na instrucao.
    pub party: Signer<'info>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(mut, seeds = [b"escrow", escrow.job_hash.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = escrow)]
    pub vault: Account<'info, TokenAccount>,

    /// Definido na criacao do escrow. Trocar depois nao e possivel.
    pub mediator: Signer<'info>,

    #[account(mut, constraint = student_token.mint == mint.key() @ ErroEscrow::MintErrado)]
    pub student_token: Account<'info, TokenAccount>,

    #[account(mut, constraint = company_token.mint == mint.key() @ ErroEscrow::MintErrado)]
    pub company_token: Account<'info, TokenAccount>,

    #[account(mut, constraint = platform_token.mint == mint.key() @ ErroEscrow::MintErrado)]
    pub platform_token: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AutoRelease<'info> {
    #[account(mut, seeds = [b"escrow", escrow.job_hash.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = escrow)]
    pub vault: Account<'info, TokenAccount>,

    /// Qualquer pessoa. Nao ha constraint de identidade aqui de proposito: o
    /// que protege nao e quem chama, e o prazo mais o destino gravado no escrow.
    pub caller: Signer<'info>,

    #[account(mut, constraint = student_token.mint == mint.key() @ ErroEscrow::MintErrado)]
    pub student_token: Account<'info, TokenAccount>,

    #[account(mut, constraint = platform_token.mint == mint.key() @ ErroEscrow::MintErrado)]
    pub platform_token: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

// ─── eventos ─────────────────────────────────────────────────────────────────
// O backend escuta estes eventos pelo webhook do indexador e reconcilia o
// banco, para o caso de ele ter caido no meio de uma confirmacao.

#[event]
pub struct TrabalhoGarantido {
    pub job_hash: [u8; 32],
    pub company: Pubkey,
    pub amount: u64,
    pub fee_bps: u16,
    pub deadline: i64,
}

#[event]
pub struct EstudanteEscolhido {
    pub job_hash: [u8; 32],
    pub student: Pubkey,
}

#[event]
pub struct TrabalhoConfirmado {
    pub job_hash: [u8; 32],
    pub company: Pubkey,
    pub student: Pubkey,
    pub paid_to_student: u64,
    pub platform_fee: u64,
}

#[event]
pub struct TrabalhoCancelado {
    pub job_hash: [u8; 32],
    pub company: Pubkey,
    pub refunded: u64,
}

#[event]
pub struct DisputaAberta {
    pub job_hash: [u8; 32],
    pub opened_by: Pubkey,
    pub reason_code: u8,
}

#[event]
pub struct DisputaResolvida {
    pub job_hash: [u8; 32],
    pub split_bps: u16,
    pub to_student: u64,
    pub to_company: u64,
    pub platform_fee: u64,
}

// ─── erros ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum ErroEscrow {
    #[msg("O valor precisa ser maior que zero.")]
    ValorInvalido,
    #[msg("A taxa da plataforma passa do teto permitido.")]
    TaxaAcimaDoTeto,
    #[msg("O estado atual deste escrow nao permite esta acao.")]
    EstadoNaoPermiteEssaAcao,
    #[msg("Quem assinou nao tem autoridade para esta acao.")]
    SemAutoridade,
    #[msg("O estudante ainda nao foi definido neste escrow.")]
    EstudanteNaoDefinido,
    #[msg("O estudante deste escrow ja foi definido.")]
    EstudanteJaDefinido,
    #[msg("Endereco de estudante invalido.")]
    EstudanteInvalido,
    #[msg("Ja ha um estudante escolhido: o caminho agora e a disputa, nao a devolucao.")]
    EstudanteJaEscolhidoUseDisputa,
    #[msg("A conta de destino nao pertence a quem deveria receber.")]
    ContaDeDestinoErrada,
    #[msg("A conta de origem nao pertence a quem deveria pagar.")]
    ContaDeOrigemErrada,
    #[msg("A conta de token nao e do mint deste escrow.")]
    MintErrado,
    #[msg("A divisao precisa estar entre 0 e 10000.")]
    DivisaoInvalida,
    #[msg("Este escrow nao tem prazo definido.")]
    SemPrazoDefinido,
    #[msg("Ainda esta dentro do prazo mais a carencia.")]
    AindaDentroDoPrazo,
    #[msg("O calculo estourou.")]
    EstouroDeCalculo,
}
