import './helpers.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { splitFee, centsToBase, baseToCents, formatBRL } from '../src/lib/money.js'

test('a divisao entre estudante e plataforma soma exatamente o total', () => {
  // Cada centavo precisa ter destino. Se a soma nao bate, sobra poeira presa
  // no cofre e o cofre nunca zera.
  const casos = [
    [12000, 500], [1, 500], [99, 999], [333, 333],
    [100000, 0], [7777, 10000], [12345, 250]
  ]
  for (const [total, bps] of casos) {
    const s = splitFee(total, bps)
    assert.equal(s.studentCents + s.feeCents, total, `total ${total} com ${bps} bps`)
    assert.ok(s.feeCents >= 0 && s.studentCents >= 0)
  }

  // 5% de R$120,00 e R$6,00.
  assert.deepEqual(splitFee(12000, 500), { studentCents: 11400, feeCents: 600, totalCents: 12000 })

  // Taxa zero entrega tudo ao estudante; taxa cheia nao deixa nada negativo.
  assert.equal(splitFee(12000, 0).studentCents, 12000)
  assert.equal(splitFee(12000, 10000).studentCents, 0)

  // A taxa arredonda para baixo, entao o estudante nunca recebe a menos por
  // causa de arredondamento.
  assert.equal(splitFee(101, 500).feeCents, 5)
  assert.equal(splitFee(101, 500).studentCents, 96)
})

test('a conversao entre centavos e unidades base do token de 6 casas fecha nos dois sentidos', () => {
  assert.equal(centsToBase(12000).toString(), '120000000')
  assert.equal(centsToBase(1).toString(), '10000')
  assert.equal(baseToCents(120000000n), 12000)

  for (const cents of [1, 99, 12000, 4500, 999999]) {
    assert.equal(baseToCents(centsToBase(cents)), cents, `ida e volta de ${cents}`)
  }

  assert.equal(formatBRL(12000).replace(/ /g, ' '), 'R$ 120,00')
})
