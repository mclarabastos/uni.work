// O produto raciocina em centavos de real. A rede raciocina em unidades base
// de um token de 6 casas decimais. A conversao mora aqui e em nenhum outro lugar.

export const TOKEN_DECIMALS = 6
const CENTS_TO_BASE = 10 ** (TOKEN_DECIMALS - 2) // 2 casas -> 6 casas

/** 12000 centavos -> 120000000 unidades base. */
export function centsToBase (cents) {
  return BigInt(Math.round(Number(cents))) * BigInt(CENTS_TO_BASE)
}

/** 120000000 unidades base -> 12000 centavos. */
export function baseToCents (base) {
  return Number(BigInt(base) / BigInt(CENTS_TO_BASE))
}

/** "R$ 120,00" */
export function formatBRL (cents) {
  const value = Number(cents) / 100
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

/**
 * Divide o valor entre estudante e plataforma.
 * A taxa e sempre arredondada para baixo, entao a soma bate exatamente
 * com o total e nunca sobra poeira presa no cofre.
 */
export function splitFee (totalCents, feeBps) {
  const total = BigInt(Math.round(Number(totalCents)))
  const bps = BigInt(Math.max(0, Math.min(10000, Math.round(Number(feeBps)))))
  const fee = (total * bps) / 10000n
  return { studentCents: Number(total - fee), feeCents: Number(fee), totalCents: Number(total) }
}
