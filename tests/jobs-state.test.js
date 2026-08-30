import './helpers.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { TRAIL, TRANSITIONS, canTransition, assertTransition, trailProgress, STATUS_LABELS } from '../src/domain/jobs.js'

test('a trilha de seis etapas anda na ordem e cada etapa conhece a proxima', () => {
  assert.equal(TRAIL.length, 6, 'a trilha do produto tem seis etapas')
  assert.deepEqual(TRAIL, ['aberta', 'garantida', 'aceita', 'em_andamento', 'entregue', 'concluida'])

  // O caminho feliz inteiro precisa ser percorrivel, passo a passo.
  for (let i = 0; i < TRAIL.length - 1; i += 1) {
    assert.ok(canTransition(TRAIL[i], TRAIL[i + 1]), `${TRAIL[i]} precisa poder virar ${TRAIL[i + 1]}`)
  }

  // Cancelar e possivel enquanto o trabalho nao terminou.
  for (const status of ['aberta', 'garantida', 'aceita', 'em_andamento', 'entregue']) {
    assert.ok(canTransition(status, 'cancelada'), `${status} precisa poder ser cancelada`)
  }

  // Uma entrega pode voltar para em andamento: o contratante pediu ajuste.
  assert.ok(canTransition('entregue', 'em_andamento'))

  // O progresso da barra acompanha o status.
  assert.deepEqual(trailProgress('aberta'), { etapa: 1, total: 6, cancelada: false })
  assert.deepEqual(trailProgress('entregue'), { etapa: 5, total: 6, cancelada: false })
  assert.deepEqual(trailProgress('concluida'), { etapa: 6, total: 6, cancelada: false })
  assert.equal(trailProgress('cancelada').cancelada, true)

  // Todo status tem rotulo em portugues para a tela.
  for (const status of [...TRAIL, 'cancelada']) {
    assert.ok(STATUS_LABELS[status], `falta rotulo para ${status}`)
  }
})

test('a maquina de estados recusa pular etapa, voltar no tempo e mexer no que ja terminou', () => {
  // Pular a reserva do pagamento e o erro mais importante de barrar: o produto
  // promete que o estudante so aceita depois do valor reservado.
  assert.equal(canTransition('aberta', 'aceita'), false)
  assert.equal(canTransition('aberta', 'concluida'), false)
  assert.equal(canTransition('garantida', 'entregue'), false)
  assert.equal(canTransition('garantida', 'concluida'), false)
  assert.equal(canTransition('aceita', 'concluida'), false)

  // Voltar no tempo nao vale.
  assert.equal(canTransition('concluida', 'entregue'), false)
  assert.equal(canTransition('em_andamento', 'aberta'), false)
  assert.equal(canTransition('entregue', 'garantida'), false)

  // Estados finais sao finais. Nao da para pagar duas vezes nem descancelar.
  assert.deepEqual(TRANSITIONS.concluida, [])
  assert.deepEqual(TRANSITIONS.cancelada, [])
  assert.equal(canTransition('concluida', 'concluida'), false)
  assert.equal(canTransition('concluida', 'cancelada'), false)
  assert.equal(canTransition('cancelada', 'aberta'), false)

  // A recusa vira um erro de produto, com mensagem em portugues e codigo estavel.
  assert.throws(
    () => assertTransition('aberta', 'concluida'),
    (err) => {
      assert.equal(err.codigo, 'transicao_invalida')
      assert.equal(err.status, 409)
      assert.match(err.message, /Aberta/)
      assert.ok(!/undefined/.test(err.message))
      return true
    }
  )
})
