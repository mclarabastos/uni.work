// Checagem estatica da interface.
//
// Este arquivo existe por causa de um erro real: duas telas foram escritas
// chamando funcoes que nunca chegaram a ser definidas no arquivo. O `node
// --check` passou, porque a sintaxe estava correta, e o problema so apareceria
// no navegador de quem clicasse no botao.
//
// O que se verifica aqui e o que um parser de sintaxe nao verifica: que todo
// nome chamado existe, que todo elemento procurado por id existe no HTML, e que
// toda rota chamada existe na API.

import './helpers.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { rootDir } from '../src/config.js'

const PUBLIC_DIR = path.join(rootDir, 'public')
const appJs = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8')
const indexHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'app.html'), 'utf8')

/** Palavras que aparecem antes de "(" mas nao sao chamada de funcao. */
const PALAVRAS_RESERVADAS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof',
  'await', 'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'try', 'yield',
  'instanceof', 'case', 'throw', 'with', 'super', 'import', 'export', 'class',
  'const', 'let', 'var', 'async'
])

/** O que o navegador ja oferece. */
const GLOBAIS = new Set([
  'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'Date',
  'Promise', 'Map', 'Set', 'WeakMap', 'RegExp', 'Error', 'Symbol', 'BigInt',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'atob', 'btoa',
  'console', 'document', 'window', 'navigator', 'location', 'localStorage',
  'sessionStorage', 'history', 'alert', 'confirm', 'prompt',
  'EventSource', 'WebSocket', 'URL', 'URLSearchParams', 'FormData', 'Blob',
  'File', 'FileReader', 'Image', 'Notification', 'CustomEvent', 'Event',
  'Uint8Array', 'Int8Array', 'ArrayBuffer', 'TextEncoder', 'TextDecoder',
  'requestAnimationFrame', 'cancelAnimationFrame', 'structuredClone',
  'queueMicrotask', 'AbortController', 'Intl', 'globalThis'
])

/**
 * Todo nome que o arquivo cria em algum lugar: declaracao, parametro,
 * desestruturacao, captura de erro. A lista e propositalmente generosa: o
 * objetivo e nunca acusar um nome que existe, e ainda assim pegar o que nao
 * existe em lugar nenhum.
 */
function nomesDeclarados (codigo) {
  const nomes = new Set()
  const adicionar = (texto) => {
    for (const parte of String(texto).split(',')) {
      const limpo = parte
        .replace(/=[\s\S]*$/, '')       // valor padrao
        .replace(/\.\.\./, '')          // rest
        .replace(/[{}[\]]/g, ' ')       // desestruturacao
        .trim()
      for (const nome of limpo.split(/[\s:]+/)) {
        if (/^[A-Za-z_$][\w$]*$/.test(nome)) nomes.add(nome)
      }
    }
  }

  for (const m of codigo.matchAll(/(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g)) {
    if (m[1]) nomes.add(m[1])
    adicionar(m[2])
  }
  for (const m of codigo.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) nomes.add(m[1])
  for (const m of codigo.matchAll(/(?:const|let|var)\s*(\{[^}]*\}|\[[^\]]*\])/g)) adicionar(m[1])
  for (const m of codigo.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) nomes.add(m[1])
  for (const m of codigo.matchAll(/catch\s*\(([^)]*)\)/g)) adicionar(m[1])
  // arrow: (a, b) => ...   e   a => ...
  for (const m of codigo.matchAll(/\(([^()]*)\)\s*=>/g)) adicionar(m[1])
  for (const m of codigo.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/gm)) nomes.add(m[1])
  // metodo abreviado em objeto:  aoMontar (raiz) {
  for (const m of codigo.matchAll(/^\s{2,}([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
    nomes.add(m[1])
    adicionar(m[2])
  }
  // for (const x of ...)
  for (const m of codigo.matchAll(/for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) nomes.add(m[1])
  return nomes
}

/**
 * Devolve so o codigo executavel: descarta comentarios, o conteudo de strings,
 * o texto literal dos templates e o corpo das expressoes regulares, mas
 * preserva o que esta dentro de ${...}, que e codigo de verdade.
 *
 * Sem isto, CSS e HTML escritos dentro de crase viram falso positivo ("url(",
 * "rgba(", "CANDIDATURAS ("). Com uma versao mal feita disto acontece o pior:
 * o arquivo inteiro e engolido e o teste passa sem examinar nada. Por isso o
 * teste seguinte confere que sobrou codigo suficiente para valer alguma coisa.
 */
export function apenasCodigo (texto) {
  const saida = []
  // Pilha de contextos de template: cada item guarda a profundidade de chaves
  // dentro do ${...} atual. -1 significa "no texto do template".
  const templates = []
  let i = 0

  const anteriorSignificativo = () => {
    for (let k = saida.length - 1; k >= 0; k -= 1) {
      if (!/\s/.test(saida[k])) return saida[k]
    }
    return ''
  }

  while (i < texto.length) {
    const ch = texto[i]
    const prox = texto[i + 1]
    const dentroDeTemplate = templates.length > 0 && templates[templates.length - 1] === -1

    if (dentroDeTemplate) {
      if (ch === '\\') { i += 2; continue }
      if (ch === '`') { templates.pop(); saida.push(' '); i += 1; continue }
      if (ch === '$' && prox === '{') {
        templates[templates.length - 1] = 0
        saida.push(' ')
        i += 2
        continue
      }
      i += 1 // texto puro: descartado
      continue
    }

    // Fim de um ${...}: a chave que fecha devolve ao texto do template.
    if (templates.length && ch === '}') {
      if (templates[templates.length - 1] === 0) {
        templates[templates.length - 1] = -1
        saida.push(' ')
        i += 1
        continue
      }
      templates[templates.length - 1] -= 1
    } else if (templates.length && ch === '{') {
      templates[templates.length - 1] += 1
    }

    if (ch === '/' && prox === '/') {
      while (i < texto.length && texto[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && prox === '*') {
      i += 2
      while (i < texto.length && !(texto[i] === '*' && texto[i + 1] === '/')) i += 1
      i += 2
      saida.push(' ')
      continue
    }
    if (ch === '`') { templates.push(-1); saida.push(' '); i += 1; continue }
    if (ch === "'" || ch === '"') {
      const aspas = ch
      i += 1
      while (i < texto.length && texto[i] !== aspas) {
        if (texto[i] === '\\') i += 1
        i += 1
      }
      i += 1
      saida.push(aspas, aspas)
      continue
    }
    // Uma barra so e inicio de expressao regular quando o token anterior nao
    // pode terminar um valor. Senao e divisao.
    if (ch === '/' && !/[\w$)\]]/.test(anteriorSignificativo())) {
      i += 1
      let emClasse = false
      while (i < texto.length) {
        const c = texto[i]
        if (c === '\\') { i += 2; continue }
        if (c === '[') emClasse = true
        else if (c === ']') emClasse = false
        else if (c === '/' && !emClasse) break
        else if (c === '\n') break
        i += 1
      }
      i += 1
      saida.push(' ')
      continue
    }

    saida.push(ch)
    i += 1
  }
  return saida.join('')
}

/** Nomes chamados como funcao, ignorando chamadas de metodo (algo.metodo()). */
function nomesChamados (codigo) {
  const semComentarios = apenasCodigo(codigo)
  const chamados = new Map()
  for (const m of semComentarios.matchAll(/(?:^|[^\w$.?])([A-Za-z_$][\w$]*)\s*\(/gm)) {
    const nome = m[1]
    if (PALAVRAS_RESERVADAS.has(nome)) continue
    if (!chamados.has(nome)) {
      const linha = semComentarios.slice(0, m.index).split('\n').length
      chamados.set(nome, linha)
    }
  }
  return chamados
}

test('o próprio verificador enxerga o arquivo, em vez de examinar o vazio', () => {
  // Esta e a protecao contra o modo de falha mais traicoeiro deste arquivo:
  // um extrator quebrado engole o codigo, encontra zero chamadas e passa
  // alegremente sem ter verificado nada.
  const codigo = apenasCodigo(appJs)
  assert.ok(codigo.length > appJs.length * 0.2,
    `sobrou pouco código depois da limpeza (${codigo.length} de ${appJs.length})`)

  const chamados = nomesChamados(appJs)
  assert.ok(chamados.size > 30,
    `só ${chamados.size} chamadas encontradas: o extrator deve estar quebrado`)

  // Funcoes que sabidamente existem precisam aparecer como chamadas.
  for (const esperada of ['render', 'chamar', 'avisar', 'escapar', 'abrirVaga']) {
    assert.ok(chamados.has(esperada), `o extrator perdeu as chamadas a ${esperada}`)
  }

  // E o texto dentro de template literal precisa ter sumido.
  assert.ok(!codigo.includes('CANDIDATURAS'), 'texto de template vazou para a análise')
  assert.ok(!codigo.includes('rgba('), 'CSS de template vazou para a análise')
})

test('toda função chamada em app.js existe de verdade', () => {
  const declarados = nomesDeclarados(appJs)
  const chamados = nomesChamados(appJs)

  const orfas = []
  for (const [nome, linha] of chamados) {
    if (declarados.has(nome) || GLOBAIS.has(nome)) continue
    orfas.push(`${nome} (linha ${linha})`)
  }

  assert.deepEqual(orfas, [],
    `estas funções são chamadas mas não existem em lugar nenhum:\n  ${orfas.join('\n  ')}`)
})

test('todo id procurado pelo script existe no HTML', () => {
  // Ids criados dinamicamente pelo proprio script, dentro de modais e telas.
  const criadosPeloScript = new Set(
    [...appJs.matchAll(/id="([a-z0-9-]+)"/gi)].map((m) => m[1])
  )
  const noHtml = new Set([...indexHtml.matchAll(/id="([a-z0-9-]+)"/gi)].map((m) => m[1]))

  const faltando = []
  for (const m of appJs.matchAll(/\$\('#([a-z0-9-]+)'\)/gi)) {
    const id = m[1]
    if (noHtml.has(id) || criadosPeloScript.has(id)) continue
    faltando.push(id)
  }

  assert.deepEqual([...new Set(faltando)], [],
    `o script procura ids que não existem: ${faltando.join(', ')}`)
})

test('toda rota chamada pelo script existe na API', async () => {
  const rotas = new Set()
  for (const m of appJs.matchAll(/chamar\(\s*[`'"]([^`'"$]*)/g)) {
    const caminho = m[1].split('?')[0].replace(/\/$/, '')
    if (caminho.startsWith('/')) rotas.add(caminho)
  }
  assert.ok(rotas.size > 10, 'o script precisa chamar a API para isto valer alguma coisa')

  // Junta os caminhos declarados em todos os routers do servidor.
  const dirRotas = path.join(rootDir, 'src', 'routes')
  const declaradas = []
  for (const arquivo of fs.readdirSync(dirRotas)) {
    const conteudo = fs.readFileSync(path.join(dirRotas, arquivo), 'utf8')
    for (const m of conteudo.matchAll(/Router\.(get|post|put|delete|patch)\(\s*'([^']+)'/g)) {
      declaradas.push(m[2])
    }
  }
  const servidorJs = fs.readFileSync(path.join(rootDir, 'src', 'server.js'), 'utf8')
  const prefixos = [...servidorJs.matchAll(/app\.use\('(\/api[^']*)'/g)].map((m) => m[1])

  // Um caminho do script confere se existe uma rota cujo padrao bate, sob
  // algum dos prefixos montados no servidor.
  const combina = (caminho) => {
    for (const prefixo of prefixos) {
      if (!caminho.startsWith(prefixo === '/api' ? '/' : prefixo.replace('/api', ''))) continue
      const resto = prefixo === '/api' ? caminho : caminho.slice(prefixo.replace('/api', '').length) || '/'
      for (const padrao of declaradas) {
        const regex = new RegExp(`^${padrao.replace(/:[^/]+/g, '[^/]+').replace(/\//g, '\\/')}$`)
        if (regex.test(resto)) return true
      }
    }
    return false
  }

  const inexistentes = [...rotas].filter((r) => !combina(r))
  assert.deepEqual(inexistentes, [],
    `o script chama rotas que a API não tem: ${inexistentes.join(', ')}`)
})

test('o service worker só faz o que precisa fazer', () => {
  const sw = fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8')
  assert.match(sw, /addEventListener\('push'/, 'precisa receber o aviso')
  assert.match(sw, /addEventListener\('notificationclick'/, 'e reagir ao clique')

  // Cache em produto que muda de estado o tempo todo traz mais problema do que
  // resolve. Se algum dia entrar, que seja uma decisao, nao um descuido.
  assert.ok(!/caches\.open|cache\.addAll/.test(sw), 'o service worker não deve fazer cache')
})
