// A regra de ouro, verificada por maquina.
//
// O usuario nunca ve blockchain. A unica excecao e a gaveta "camada tecnica",
// que existe para demonstracao. Este teste le tudo que e servido em public/ e
// falha se o jargao escapar da gaveta.

import './helpers.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { rootDir } from '../src/config.js'

const PUBLIC_DIR = path.join(rootDir, 'public')

// Lista da secao 9.1: verificada em todo arquivo servido.
const PROIBIDAS_EM_TODO_LUGAR = ['wallet', 'blockchain', 'gas', 'chave privada', 'assinar transacao']

// Lista da secao 11: verificada no texto que o usuario efetivamente le.
const PROIBIDAS_NO_TEXTO = [
  'carteira', 'wallet', 'chave privada', 'seed phrase', 'blockchain',
  'gas', 'taxa de rede', 'mintar', 'cripto', 'assinar transacao', 'smart contract'
]

function arquivosDePublic () {
  const saida = []
  const andar = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const completo = path.join(dir, item.name)
      if (item.isDirectory()) andar(completo)
      else if (/\.(html|js|css|json|svg|txt)$/i.test(item.name)) saida.push(completo)
    }
  }
  andar(PUBLIC_DIR)
  return saida
}

/**
 * Remove a gaveta tecnica do conteudo antes de conferir.
 *   HTML: o elemento marcado com data-camada-tecnica
 *   JS:   o trecho entre os marcadores camada-tecnica:inicio e :fim
 */
function semCamadaTecnica (conteudo, arquivo) {
  let limpo = conteudo
  if (arquivo.endsWith('.html')) {
    limpo = limpo.replace(/<section[^>]*data-camada-tecnica[\s\S]*?<\/section>/gi, ' ')
  }
  limpo = limpo.replace(/camada-tecnica:inicio[\s\S]*?camada-tecnica:fim/g, ' ')
  return limpo
}

/** Extrai so o que o usuario le: texto entre tags, mais atributos visiveis. */
function textoVisivel (html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+\b(placeholder|aria-label|alt|title)="([^"]*)"[^>]*>/gi, (_m, _a, valor) => ` ${valor} `)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
}

function ocorrencias (texto, palavra) {
  // \b nao funciona bem com acentuacao, entao delimitamos manualmente.
  const escapada = palavra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`(^|[^\\p{L}])${escapada}([^\\p{L}]|$)`, 'giu')
  return [...texto.matchAll(regex)]
}

test('nenhum arquivo servido usa jargao de rede fora da gaveta tecnica', () => {
  const arquivos = arquivosDePublic()
  assert.ok(arquivos.length >= 2, 'a interface precisa existir para ser verificada')

  const problemas = []
  for (const arquivo of arquivos) {
    const relativo = path.relative(rootDir, arquivo)
    const limpo = semCamadaTecnica(fs.readFileSync(arquivo, 'utf8'), arquivo).toLowerCase()
    for (const palavra of PROIBIDAS_EM_TODO_LUGAR) {
      for (const achado of ocorrencias(limpo, palavra)) {
        const inicio = Math.max(0, achado.index - 45)
        problemas.push(`${relativo}: "${palavra}" em ...${limpo.slice(inicio, achado.index + 55).replace(/\s+/g, ' ')}...`)
      }
    }
  }

  assert.deepEqual(problemas, [], `jargao encontrado fora da gaveta tecnica:\n${problemas.join('\n')}`)
})

test('o texto que o usuario le fala de conta, garantia e certificado, nunca de rede', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
  const visivel = textoVisivel(semCamadaTecnica(html, 'index.html')).toLowerCase()

  const problemas = []
  for (const palavra of PROIBIDAS_NO_TEXTO) {
    if (ocorrencias(visivel, palavra).length) problemas.push(palavra)
  }
  assert.deepEqual(problemas, [], `a interface mostra: ${problemas.join(', ')}`)

  // A gaveta tecnica precisa continuar existindo: ela e a valvula de escape
  // que permite demonstrar o mecanismo sem poluir o produto.
  assert.match(html, /data-camada-tecnica/, 'a gaveta tecnica precisa estar marcada')
  assert.match(html, /CAMADA TECNICA/i)

  // E o vocabulario do produto precisa estar presente de fato.
  for (const palavra of ['conta', 'pagamento', 'certificado', 'garantido']) {
    assert.ok(visivel.includes(palavra), `a interface precisa falar em "${palavra}"`)
  }
})

test('as mensagens do dominio e dos erros tambem seguem a regra', async () => {
  // A regra vale para mensagem de erro tambem: se a rede falhar, o usuario le
  // "nao conseguimos concluir agora", nao o erro cru.
  const { networkTrouble } = await import('../src/lib/errors.js')
  const erro = networkTrouble('Transaction simulation failed: blockhash not found')

  assert.match(erro.message, /nao conseguimos concluir agora/i)
  assert.equal(erro.codigo, 'tentando_novamente')
  assert.equal(erro.status, 503)

  // O detalhe tecnico existe, mas nao no que vai para a tela.
  assert.ok(erro.technicalDetail.includes('simulation failed'))
  const paraATela = JSON.stringify(erro.toJSON()).toLowerCase()
  assert.ok(!paraATela.includes('simulation'))
  assert.ok(!paraATela.includes('blockhash'))

  // Os rotulos de evento e de status tambem sao lidos pelo usuario.
  const { EVENT_LABELS } = await import('../src/domain/events.js')
  const { STATUS_LABELS } = await import('../src/domain/jobs.js')
  const rotulos = [...Object.values(EVENT_LABELS), ...Object.values(STATUS_LABELS)].join(' ').toLowerCase()
  for (const palavra of PROIBIDAS_NO_TEXTO) {
    assert.ok(!ocorrencias(rotulos, palavra).length, `um rotulo mostra "${palavra}"`)
  }
})
