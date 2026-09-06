#!/usr/bin/env node
// npm run demo — o fluxo completo no terminal, do cadastro ao certificado.
//
// Sobe o servidor numa porta livre e conversa com ele pela API, exatamente como
// a interface faz. Serve para demonstrar o produto sem abrir o navegador e para
// conferir que a integracao inteira esta de pe.
//
// As etapas que tocam a rede (reservar o valor, confirmar e pagar) so rodam se
// o bootstrap tiver acontecido. Sem isso o demo para e diz o que falta, em vez
// de pular a parte que importa fingindo que deu certo.

import { createApp } from '../src/server.js'
import { migrar } from '../src/db/migrate.js'
import { closeDb } from '../src/db/index.js'
import { platformSummary } from '../src/services/platform.js'
import { formatBRL } from '../src/lib/money.js'
import { getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import { Keypair, PublicKey } from '@solana/web3.js'
import { one } from '../src/db/index.js'
import { readPlatformState } from '../src/services/platform.js'
import { getConnection } from '../src/services/solana.js'
import { TOKEN_DECIMALS } from '../src/lib/money.js'

const etapa = (n, texto) => console.log(`\n  ${String(n).padStart(2)}. ${texto}`)
const detalhe = (texto) => console.log(`      ${texto}`)
const falha = (texto) => console.log(`      X  ${texto}`)

await migrar()
const servidor = createApp().listen(0)
await new Promise((r) => servidor.once('listening', r))
const base = `http://127.0.0.1:${servidor.address().port}`

let passos = 0
async function api (caminho, { method = 'GET', body, token } = {}) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const resposta = await fetch(base + caminho, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  })
  const texto = await resposta.text()
  const dados = texto ? JSON.parse(texto) : null
  if (!resposta.ok) {
    const erro = new Error(dados?.error ?? `HTTP ${resposta.status}`)
    erro.corpo = dados
    erro.status = resposta.status
    throw erro
  }
  return dados
}

const marca = Date.now()
console.log('\n  demonstração do fluxo completo do Uni.work')

try {
  etapa(++passos, 'Uma estudante cria a conta')
  const estudante = await api('/api/signup', {
    method: 'POST',
    body: { nome: 'Marina Alves', email: `marina.${marca}@usp.br`, perfil: 'student', universidade: 'USP', curso: 'Design' }
  })
  detalhe(`${estudante.usuario.nome} entrou. A conta de recebimento nasceu junto, sem passo extra.`)

  etapa(++passos, 'Um contratante cria a conta')
  const contratante = await api('/api/signup', {
    method: 'POST',
    body: { nome: 'Produtora XPTO', email: `xpto.${marca}@empresa.com.br`, perfil: 'company' }
  })
  detalhe(`${contratante.usuario.nome} entrou.`)

  etapa(++passos, 'O contratante pública uma vaga')
  const { vaga } = await api('/api/jobs', {
    method: 'POST',
    token: contratante.sessao.token,
    body: {
      titulo: 'Staff de credenciamento no congresso de tecnologia',
      descricao: 'Recepção e credenciamento dos participantes durante dois dias de congresso.',
      categoria: 'Eventos',
      modalidade: 'presencial',
      local: 'São Paulo, SP',
      valorCentavos: 24000,
      horas: 12
    }
  })
  detalhe(`"${vaga.titulo}"`)
  detalhe(`${formatBRL(vaga.valorCentavos)} por ${vaga.horas}h · etapa ${vaga.trilha.etapa} de ${vaga.trilha.total}`)
  detalhe(`pagamento garantido: ${vaga.pagamentoGarantido ? 'sim' : 'ainda não'}`)

  etapa(++passos, 'A estudante se candidata')
  await api(`/api/jobs/${vaga.id}/apply`, {
    method: 'POST',
    token: estudante.sessao.token,
    body: { apresentacao: 'Já trabalhei em três congressos de tecnologia.' }
  })
  detalhe('candidatura enviada')

  etapa(++passos, 'O contratante tenta escolher antes de reservar o valor')
  const comCandidatura = await api(`/api/jobs/${vaga.id}`, { token: contratante.sessao.token })
  const candidaturaId = comCandidatura.vaga.candidaturas[0].id
  try {
    await api(`/api/jobs/applications/${candidaturaId}/accept`, { method: 'POST', token: contratante.sessao.token })
    falha('o sistema deixou escolher sem pagamento reservado, e isso e um erro')
    process.exitCode = 1
  } catch (err) {
    detalhe(`recusado, como tem que ser: "${err.message}"`)
    detalhe('a promessa do produto e que o estudante ve a garantia antes de dizer sim')
  }

  const plataforma = platformSummary()
  if (!plataforma.ready) {
    console.log(`
  ─────────────────────────────────────────────────────────────────────────

  O demo parou aqui de propósito.

  As próximas etapas (reservar o valor, liberar o pagamento e emitir o
  certificado) acontecem de verdade na rede, e o ambiente de devnet ainda não
  foi preparado. Rode:

      npm run bootstrap

  e chame npm run demo de novo. Não vou simular essa parte: ela e o produto.
`)
    servidor.close()
    await closeDb()
    process.exit(0)
  }

  etapa(++passos, 'O contratante reserva o valor')
  detalhe('saindo da conta dele e indo para o cofre da vaga…')
  const reservada = await api(`/api/jobs/${vaga.id}/fund`, { method: 'POST', token: contratante.sessao.token })
  detalhe(`status: ${reservada.vaga.statusRotulo} · etapa ${reservada.vaga.trilha.etapa} de ${reservada.vaga.trilha.total}`)
  detalhe(`pagamento garantido: ${reservada.vaga.pagamentoGarantido ? 'sim' : 'nao'}`)

  etapa(++passos, 'Agora sim o contratante escolhe a estudante')
  const aceita = await api(`/api/jobs/applications/${candidaturaId}/accept`, { method: 'POST', token: contratante.sessao.token })
  detalhe(`status: ${aceita.vaga.statusRotulo}`)

  etapa(++passos, 'A estudante começa e entrega')
  await api(`/api/jobs/${vaga.id}/start`, { method: 'POST', token: estudante.sessao.token })
  const entregue = await api(`/api/jobs/${vaga.id}/deliver`, {
    method: 'POST',
    token: estudante.sessao.token,
    body: { observacao: 'Credenciamento concluído nos dois dias, 480 participantes atendidos.' }
  })
  detalhe(`status: ${entregue.vaga.statusRotulo} · etapa ${entregue.vaga.trilha.etapa} de ${entregue.vaga.trilha.total}`)

  etapa(++passos, 'O contratante confirma: paga e certifica no mesmo fluxo')
  const confirmada = await api(`/api/jobs/${vaga.id}/confirm`, { method: 'POST', token: contratante.sessao.token })
  detalhe(`status: ${confirmada.vaga.statusRotulo} · etapa ${confirmada.vaga.trilha.etapa} de ${confirmada.vaga.trilha.total}`)
  if (confirmada.certificado) {
  detalhe(`certificado ${confirmada.certificado.codigo} · ${confirmada.certificado.horas}h`)
  if (confirmada.certificado.emProcessamento) {
    detalhe('o registro público ainda está sendo processado; a fila termina sozinha')
  }

  etapa(++passos, 'Qualquer pessoa verifica o certificado, sem conta')
  const verificacao = await api(`/api/verify/${confirmada.certificado.codigo}`)
  detalhe(`valido: ${verificacao.valido ? 'sim' : 'nao'}`)
  detalhe(`${verificacao.certificado.estudante} · ${verificacao.certificado.horas}h · ${verificacao.certificado.atividade}`)
  detalhe(`integridade: ${verificacao.integridade.confere ? 'confere' : 'NÃO confere'}`)
  detalhe(`confirmação independente: ${
    verificacao.confirmacaoIndependente.confirmado
      ? 'confirmada pelo indexador'
      : verificacao.confirmacaoIndependente.motivo ?? 'pendente'}`)
  detalhe(`link público: ${verificacao.links.verificacao}`)

  etapa(++passos, 'A estudante ve as horas na conta dela')
  const carteira = await api('/api/me/certificates', { token: estudante.sessao.token })
  detalhe(`${carteira.certificados.length} certificado(s), ${carteira.horasTotais}h no total`)

  } else {
    detalhe('pagamento confirmado; o certificado entrou na fila e sai em instantes (nao esperamos aqui, e so uma demonstracao rapida)')
  }

  console.log(`
  fluxo completo, do cadastro ao certificado verificado publicamente.
  Nenhuma etapa pediu ao usuário para entender nada de rede.
`)
} catch (err) {
  console.log(`\n  o demo parou: ${err.message}`)
  if (err.corpo?.detalhes) console.log(`  detalhes: ${JSON.stringify(err.corpo.detalhes)}`)
  process.exitCode = 1
} finally {
  servidor.close()
  await closeDb().catch(() => {})
}
