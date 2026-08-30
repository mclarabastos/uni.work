// Uni.work — aplicacao de tela unica, sem build.
//
// Tres colunas: navegacao a esquerda, conteudo no meio, painel do ecossistema a
// direita. Cada tela abre com um heroi proprio, e o resto e conteudo.
//
// Dois modos: http fala com a API de verdade; simulacao entra quando a API nao
// responde, com dados de exemplo e um aviso permanente na tela. Nada aqui finge
// que uma operacao aconteceu quando ela nao aconteceu.

const $ = (sel, raiz = document) => raiz.querySelector(sel)
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)]

const CHAVE_SESSAO = 'uniwork.sessao'
const CHAVE_GUIA = 'uniwork.guia-visto'

const estado = {
  modo: 'http',
  usuario: null,
  token: null,
  view: 'entrar',

  vagas: [],
  proximoCursor: null,
  temMais: false,
  buscando: false,
  facetas: null,
  ordensDisponiveis: [],
  ordemAtual: null,
  filtros: { busca: '', modalidade: null, categoria: null, garantidas: false, ordem: null },

  minhasVagas: [],
  cursorMinhas: null,
  temMaisMinhas: false,

  certificados: [],
  horasTotais: 0,
  resumo: null,
  metricas: null,
  feed: [],
  registros: [],

  notificacoes: [],
  naoLidas: 0,
  preferencias: null,
  pushDisponivel: false,

  contestacoes: [],
  motivosDeContestacao: [],

  vagaAberta: null,
  perfilAberto: null,
  perfilPendente: null,
  personas: null,
  codigoDigitado: '',
  online: true
}

// ─── util ────────────────────────────────────────────────────────────────────

const escapar = (t) => String(t ?? '').replace(/[<>&"']/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]
))

/**
 * O valor circula em USDC, a moeda estavel do pagamento. Os centavos do banco
 * viram unidades inteiras aqui, que e como o numero aparece na tela.
 */
const usdc = (centavos) => Math.round(Number(centavos ?? 0) / 100).toLocaleString('pt-BR')
const usdcExato = (centavos) => (Number(centavos ?? 0) / 100).toLocaleString('pt-BR', {
  minimumFractionDigits: 2, maximumFractionDigits: 2
})

function quando (iso) {
  if (!iso) return ''
  const delta = Date.now() - new Date(iso).getTime()
  const min = Math.floor(delta / 60000)
  if (min < 1) return 'agora'
  if (min < 60) return `${min}min`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d`
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
}

const dataBR = (iso) => iso ? new Date(iso).toLocaleDateString('pt-BR') : ''

function iniciais (nome) {
  return String(nome ?? '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase()
}

/** Cor estavel a partir do texto: o mesmo nome sempre recebe a mesma cor. */
function corDe (texto) {
  let soma = 0
  for (const ch of String(texto ?? '')) soma += ch.charCodeAt(0)
  return soma % 5
}

const EMOJI_CATEGORIA = {
  Eventos: '🎪', Monitoria: '📐', Design: '🎨', Traducao: '🌐', Pesquisa: '🔬',
  Desenvolvimento: '⚙️', Conteudo: '✍️', Fotografia: '📷'
}
const emojiDe = (categoria) => EMOJI_CATEGORIA[categoria] ?? '📌'

// ─── avisos ──────────────────────────────────────────────────────────────────

function avisar (titulo, texto = '', tipo = 'info') {
  const icones = { ok: '✓', erro: '!', info: 'i' }
  const el = document.createElement('div')
  el.className = `aviso ${tipo}`
  el.innerHTML = `<span class="aviso-ico" aria-hidden="true">${icones[tipo] ?? 'i'}</span>
    <div><strong>${escapar(titulo)}</strong>${texto ? `<p>${escapar(texto)}</p>` : ''}</div>`
  $('#avisos').append(el)
  setTimeout(() => {
    el.style.opacity = '0'
    el.style.transition = 'opacity .25s'
    setTimeout(() => el.remove(), 250)
  }, tipo === 'erro' ? 6500 : 4200)
}

function marcarOffline (offline) {
  estado.online = !offline
  $('#faixa-offline').classList.toggle('ativa', offline)
}

// ─── cliente da API ──────────────────────────────────────────────────────────

async function chamar (caminho, { method = 'GET', body, silencioso = false } = {}) {
  if (estado.modo === 'simulacao') return simulacao(caminho, method)

  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  const tokenUsado = estado.token
  if (tokenUsado) headers.authorization = `Bearer ${tokenUsado}`

  let resposta
  try {
    resposta = await fetch(`/api${caminho}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    })
  } catch {
    marcarOffline(true)
    const err = new Error('Sem conexao com o servico agora.')
    err.offline = true
    throw err
  }
  marcarOffline(false)

  const texto = await resposta.text()
  const dados = texto ? JSON.parse(texto) : {}

  if (!resposta.ok) {
    const err = new Error(dados.error ?? 'Nao conseguimos concluir agora, ja estamos tentando de novo.')
    err.codigo = dados.codigo
    err.detalhes = dados.detalhes
    err.status = resposta.status
    // So encerra a sessao se a chamada FOI feita com credencial e ela foi
    // recusada, e se essa credencial ainda e a atual. Sem as duas condicoes,
    // uma resposta atrasada da sessao anterior derruba a sessao de agora.
    if (resposta.status === 401 && tokenUsado && tokenUsado === estado.token) sair(true)
    if (!silencioso) avisar(err.message, primeiroDetalhe(err), 'erro')
    throw err
  }
  return dados
}

function primeiroDetalhe (err) {
  if (Array.isArray(err.detalhes) && err.detalhes[0]?.mensagem) return err.detalhes[0].mensagem
  return ''
}

// ─── modo simulacao ──────────────────────────────────────────────────────────

const SIM = {
  usuario: { id: 'usr_demo', nome: 'Marina Alves', email: 'marina@usp.br', perfil: 'student', universidade: 'USP', curso: 'Design' },
  vagas: [
    { id: 'job_1', titulo: 'Staff de credenciamento no congresso', descricao: 'Recepcao e credenciamento dos participantes durante dois dias de evento.', categoria: 'Eventos', modalidade: 'presencial', local: 'Sao Paulo, SP', valorCentavos: 24000, horas: 12, status: 'garantida', statusRotulo: 'Pagamento reservado', pagamentoGarantido: true, trilha: { etapa: 2, total: 6, cancelada: false }, contratante: { id: 'c1', nome: 'Produtora XPTO' }, criadoEm: new Date(Date.now() - 3600e3).toISOString() },
    { id: 'job_2', titulo: 'Traducao PT-EN de documentacao tecnica', descricao: 'Traducao de 14 paginas de documentacao de API, com glossario fornecido.', categoria: 'Traducao', modalidade: 'remoto', local: null, valorCentavos: 26000, horas: 9, status: 'aberta', statusRotulo: 'Aberta', pagamentoGarantido: false, trilha: { etapa: 1, total: 6, cancelada: false }, contratante: { id: 'c2', nome: 'Studio Nimbus' }, criadoEm: new Date(Date.now() - 7200e3).toISOString() }
  ]
}

async function simulacao (caminho) {
  await new Promise((r) => setTimeout(r, 80))
  if (caminho === '/me') return { usuario: SIM.usuario }
  if (caminho.startsWith('/jobs/search')) return { vagas: SIM.vagas, proximoCursor: null, temMais: false, ordem: 'recentes', ordensDisponiveis: [] }
  if (caminho.startsWith('/jobs/facetas')) return { categorias: [{ nome: 'Eventos', total: 1 }], modalidades: {}, faixaDeValor: {} }
  if (caminho.startsWith('/jobs/minhas')) return { vagas: [], proximoCursor: null, temMais: false }
  if (caminho.startsWith('/demo/contas')) return { estudantes: [], contratantes: [], disponivel: false }
  if (caminho === '/me/certificates') return { certificados: [], horasTotais: 0 }
  if (caminho === '/metrics') {
    return {
      totais: { estudantes: 5, contratantes: 4, vagas: 2, concluidas: 0, certificados: 0, horasCertificadas: 0, pagoCentavos: 0, reservadoCentavos: 24000 },
      porStatus: {}, porCategoria: [], porModalidade: {}, contadores: {}
    }
  }
  const erro = new Error('Esta acao precisa do servico no ar. Estamos em modo de demonstracao.')
  avisar(erro.message, '', 'info')
  throw erro
}

// ─── sessao ──────────────────────────────────────────────────────────────────

function guardarSessao (usuario, sessao) {
  estado.usuario = usuario
  estado.token = sessao?.token ?? null
  try {
    localStorage.setItem(CHAVE_SESSAO, JSON.stringify({ usuario, token: estado.token }))
  } catch { /* navegador sem armazenamento: a sessao dura enquanto a aba viver */ }
}

function lerSessao () {
  try {
    const cru = localStorage.getItem(CHAVE_SESSAO)
    return cru ? JSON.parse(cru) : null
  } catch { return null }
}

function sair (silencioso = false) {
  if (!silencioso) chamar('/logout', { method: 'POST', silencioso: true }).catch(() => {})
  desligarEventos()
  estado.usuario = null
  estado.token = null
  // Limpar o que era da sessao anterior. Sem isto, um render pendente ainda
  // tentaria desenhar o detalhe de um trampo com estado.usuario ja nulo.
  estado.view = 'entrar'
  estado.vagaAberta = null
  estado.perfilAberto = null
  estado.minhasVagas = []
  estado.certificados = []
  estado.notificacoes = []
  estado.naoLidas = 0
  estado.preferencias = null
  estado.contestacoes = []
  estado.resumo = null
  try { localStorage.removeItem(CHAVE_SESSAO) } catch { /* nada a limpar */ }
  recarregarPublico().then(render).catch(() => render())
}

// ─── arte dos herois ─────────────────────────────────────────────────────────

/**
 * Um orbe escuro com brilho, sobre uma plataforma isometrica.
 *
 * O simbolo vai fora do SVG, num span comum: dentro de <text> ele depende da
 * fonte de emoji do sistema e some em ambiente sem ela, deixando a esfera vazia.
 */
function orbe (emoji, nome) {
  return `<div class="heroi-arte" aria-hidden="true">
    <svg viewBox="0 0 200 200" fill="none" width="100%" height="100%">
      <defs>
        <radialGradient id="o${nome}" cx="38%" cy="30%">
          <stop offset="0%" stop-color="#2c313a"/><stop offset="70%" stop-color="#14171c"/>
          <stop offset="100%" stop-color="#0c0e12"/>
        </radialGradient>
        <linearGradient id="p${nome}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#ffffff" stop-opacity=".10"/>
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
        </linearGradient>
        <filter id="b${nome}"><feGaussianBlur stdDeviation="9"/></filter>
      </defs>
      <path d="M100 132 168 168 100 200 32 168z" fill="url(#p${nome})"/>
      <path d="M100 132 168 168 100 200 32 168z" stroke="#ffffff" stroke-opacity=".10"/>
      <ellipse cx="100" cy="150" rx="46" ry="16" fill="#000" opacity=".45" filter="url(#b${nome})"/>
      <circle cx="100" cy="86" r="46" fill="url(#o${nome})" stroke="#ffffff" stroke-opacity=".08"/>
      <circle cx="84" cy="70" r="16" fill="#ffffff" opacity=".05"/>
    </svg>
    <span class="heroi-glifo">${emoji}</span>
  </div>`
}

/** A marca em grande, como assinatura do heroi principal. */
function marcaGrande () {
  return `<div class="heroi-arte" aria-hidden="true"
    style="background:var(--ink);opacity:.9;-webkit-mask:url('/marca/simbolo') center/contain no-repeat;mask:url('/marca/simbolo') center/contain no-repeat"></div>`
}

function heroi ({ cor = 'grafite', olho, titulo, texto, dados = [], acoes = '', arte = '' }) {
  return `<section class="heroi ${cor}">
    ${arte}
    ${olho ? `<p class="heroi-olho">${escapar(olho)}</p>` : ''}
    <h1>${escapar(titulo)}</h1>
    ${texto ? `<p>${escapar(texto)}</p>` : ''}
    ${dados.length ? `<div class="heroi-dados">${dados.map((d) => `
      <div class="heroi-dado"><span>${escapar(d.rotulo)}</span><strong>${escapar(d.valor)}</strong></div>
    `).join('')}</div>` : ''}
    ${acoes ? `<div class="heroi-acoes">${acoes}</div>` : ''}
  </section>`
}

// ─── navegacao ───────────────────────────────────────────────────────────────

function itensNav () {
  const u = estado.usuario
  const ehEstudante = u?.perfil === 'student'
  const porStatus = estado.metricas?.porStatus
  const abertas = porStatus ? (porStatus.aberta ?? 0) + (porStatus.garantida ?? 0) : null

  if (!u) {
    return [
      { id: 'entrar', rotulo: 'Entrar', glifo: '◆' },
      { id: 'feed', rotulo: 'Trampos abertos', glifo: '▸', conta: abertas },
      { grupo: 'PUBLICO' },
      { id: 'verificar', rotulo: 'Verificar certificado', glifo: '◎' },
      { id: 'painel', rotulo: 'Painel', glifo: '▲' }
    ]
  }

  return [
    { id: 'feed', rotulo: 'Trampos abertos', glifo: '▸', conta: abertas },
    { id: 'minhas', rotulo: ehEstudante ? 'Meus trampos' : 'Minhas vagas', glifo: '▪' },
    ...(ehEstudante ? [{ id: 'certificados', rotulo: 'Certificados', glifo: '★', conta: estado.certificados.length || null }] : []),
    { id: 'notificacoes', rotulo: 'Notificacoes', glifo: '◉', conta: estado.naoLidas || null },
    { grupo: 'MINHA CONTA' },
    { id: 'conta', rotulo: 'Perfil e ajustes', glifo: '◍' },
    ...(u.mediador
      ? [
          { grupo: 'MEDIACAO' },
          {
            id: 'mediacao',
            rotulo: 'Contestacoes',
            glifo: '⚖',
            conta: estado.contestacoes.filter((c) => ['open', 'in_review'].includes(c.status)).length || null
          }
        ]
      : []),
    { grupo: 'PUBLICO' },
    { id: 'verificar', rotulo: 'Verificar certificado', glifo: '◎' },
    { id: 'painel', rotulo: 'Painel', glifo: '▲' }
  ]
}

function renderNav () {
  $('#nav').innerHTML = itensNav().map((item) => {
    if (item.grupo) return `<div class="nav-grupo">${item.grupo}</div>`
    return `<button class="nav-item" data-view="${item.id}" ${estado.view === item.id ? 'aria-current="page"' : ''}>
      <span class="nav-glifo" aria-hidden="true">${item.glifo}</span>
      <span>${escapar(item.rotulo)}</span>
      ${item.conta ? `<span class="nav-conta">${item.conta}</span>` : ''}
    </button>`
  }).join('')

  // O bloco de baixo fala com quem esta olhando. Sem sessao ele nao promete
  // publicar nem procurar: convida a entrar, que e o unico passo possivel.
  const u = estado.usuario
  const ehEstudante = u?.perfil === 'student'
  const cta = !u
    ? ['Comece em um minuto', 'Nome e e-mail bastam. A conta de recebimento fica pronta junto.', 'Criar minha conta']
    : ehEstudante
      ? ['Trabalhe com garantia', 'O valor ja esta reservado quando voce aceita, e a entrega confirmada vira certificado.', 'Procurar trampos']
      : ['Contrate com garantia', 'Publique um trampo, reserve o valor e pague na confirmacao.', 'Publicar vaga']
  $('#cta-titulo').textContent = cta[0]
  $('#cta-texto').textContent = cta[1]
  $('#cta-rotulo').textContent = cta[2]

  $('#topo-acoes').innerHTML = u
    ? `<button class="btn btn-linha btn-mini" data-acao="meu-perfil">${escapar(u.nome.split(' ')[0])}</button>
       <button class="btn btn-fantasma btn-mini" id="btn-sair">Sair</button>`
    : `<button class="btn btn-linha btn-mini" data-view="entrar">Entrar</button>
       <button class="btn btn-azul btn-mini" data-acao="criar-conta">Criar conta</button>`
}

// ─── cartao de trampo ────────────────────────────────────────────────────────

function trilhaHtml (trilha) {
  const total = trilha?.total ?? 6
  const etapa = trilha?.etapa ?? 0
  return `<div class="trilha" role="img" aria-label="Etapa ${etapa} de ${total}">
    ${Array.from({ length: total }, (_, i) => {
      const feito = !trilha?.cancelada && i < etapa
      return `<span class="trilha-seg ${trilha?.cancelada ? 'cancelado' : feito ? 'feito' : ''}"></span>`
    }).join('')}
  </div>`
}

function cartaoVaga (vaga) {
  return `<button class="vaga" data-vaga="${escapar(vaga.id)}">
    <div class="vaga-capa c${corDe(vaga.categoria ?? vaga.titulo)}">
      <div class="vaga-valor">${usdc(vaga.valorCentavos)}<small>USDC</small></div>
      <span class="vaga-modo">${vaga.modalidade === 'presencial' ? 'presencial' : 'remoto'}</span>
      <span class="vaga-selo" aria-hidden="true">${emojiDe(vaga.categoria)}</span>
    </div>
    <div class="vaga-corpo">
      <div class="vaga-titulo">${escapar(vaga.titulo)}</div>
      <p class="vaga-desc">${escapar(vaga.descricao)}</p>
      ${trilhaHtml(vaga.trilha)}
      <div class="etiquetas">
        <span class="etiqueta">${vaga.horas}h certificadas</span>
        <span class="etiqueta">${escapar(vaga.categoria)}</span>
        ${vaga.pagamentoGarantido ? '<span class="etiqueta" style="color:var(--verde);border-color:rgba(34,197,94,.28)">garantido</span>' : ''}
      </div>
      <div class="vaga-rodape">
        <span class="avatar c${corDe(vaga.contratante?.nome)}" aria-hidden="true">${iniciais(vaga.contratante?.nome)}</span>
        <span>${escapar(vaga.contratante?.nome ?? 'Contratante')}</span>
        ${vaga.local ? `<span style="margin-left:auto">${escapar(vaga.local)}</span>` : ''}
      </div>
    </div>
  </button>`
}

function vazio (icone, titulo, texto, acao = '') {
  return `<div class="vazio">
    <div class="vazio-ico" aria-hidden="true">${icone}</div>
    <h3>${escapar(titulo)}</h3>
    <p>${escapar(texto)}</p>
    ${acao}
  </div>`
}

// ─── telas ───────────────────────────────────────────────────────────────────

function telaEntrar () {
  const p = estado.personas
  const listaDe = (pessoas, semTexto) => pessoas?.length
    ? pessoas.map((pessoa) => `<button class="pessoa" data-entrar="${escapar(pessoa.email)}">
        <span class="avatar g c${corDe(pessoa.nome)}" aria-hidden="true">${iniciais(pessoa.nome)}</span>
        <span style="min-width:0">
          <span class="pessoa-nome">${escapar(pessoa.nome)}</span>
          <span class="pessoa-sub">${escapar(pessoa.detalhe ?? '')}</span>
        </span>
      </button>`).join('')
    : `<p style="font-size:13px;color:var(--ink-3);line-height:1.6">${escapar(semTexto)}</p>`

  return heroi({
    cor: 'verde',
    olho: 'Track 01 · Vida universitaria · Hackathon Superteam Brasil',
    titulo: 'Trabalhe hoje. Receba hoje. Comprove sempre.',
    texto: 'Trampos curtos para universitarios. O contratante reserva o valor antes de voce comecar, e cada trabalho concluido vira um certificado que ninguem consegue falsificar.',
    dados: [
      { rotulo: 'Pagamento', valor: 'em garantia' },
      { rotulo: 'Certificado', valor: 'automatico' },
      { rotulo: 'Rede', valor: 'Solana devnet' }
    ],
    arte: marcaGrande()
  }) + `

  <div class="entrar-grade">
    <div class="painel">
      <h4>ENTRAR COMO ESTUDANTE</h4>
      ${listaDe(p?.estudantes, 'Nenhuma conta de exemplo neste ambiente. Crie a sua abaixo.')}
    </div>
    <div class="painel">
      <h4>ENTRAR COMO CONTRATANTE</h4>
      ${listaDe(p?.contratantes, 'Nenhuma conta de exemplo neste ambiente. Crie a sua abaixo.')}
    </div>
  </div>

  <div class="painel">
    <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <div style="flex:1;min-width:250px">
        <h4 style="margin-bottom:8px">CRIAR CONTA</h4>
        <p style="font-size:13px;color:var(--ink-3);line-height:1.6">
          Nome e e-mail. A conta de recebimento fica pronta junto, sem nenhum passo a mais
          e sem nenhuma extensao para instalar.
        </p>
      </div>
      <div style="display:flex;gap:9px;flex-wrap:wrap">
        <button class="btn btn-linha" data-criar="student">Sou estudante</button>
        <button class="btn btn-azul" data-criar="company">Quero contratar</button>
      </div>
    </div>
  </div>

  <div class="painel">
    <h4>JA TENHO CONTA</h4>
    <form id="form-entrar" style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap">
      <div style="flex:1;min-width:220px">
        <label class="sr" for="entrar-email">E-mail</label>
        <input id="entrar-email" class="campo-filtro" style="width:100%" type="email"
               autocomplete="email" required placeholder="voce@universidade.br">
      </div>
      <button class="btn btn-claro" type="submit">Entrar</button>
    </form>
  </div>`
}

function telaFeed () {
  const lista = estado.vagas
  const f = estado.filtros

  return heroi({
    cor: 'azul',
    olho: 'Descobrir',
    titulo: 'Trampos abertos',
    texto: 'Todo valor listado aqui ja esta reservado pelo contratante. Voce ve o dinheiro garantido antes de aceitar.',
    arte: orbe('🧭', 'Az')
  }) + `

  <div class="secao">
    <button class="aba" data-modalidade="" aria-pressed="${!f.modalidade}">Tudo</button>
    <button class="aba" data-modalidade="presencial" aria-pressed="${f.modalidade === 'presencial'}">Presencial</button>
    <button class="aba" data-modalidade="remoto" aria-pressed="${f.modalidade === 'remoto'}">Remoto</button>
    <button class="aba" data-garantidas="1" aria-pressed="${f.garantidas}">So garantidas</button>
    <div class="filtros">
      ${estado.ordensDisponiveis.length > 1 ? `
        <label class="sr" for="ordenar">Ordenar por</label>
        <select id="ordenar" class="campo-filtro" style="min-width:auto">
          ${estado.ordensDisponiveis.map((o) => `
            <option value="${escapar(o.valor)}" ${(f.ordem ?? estado.ordemAtual) === o.valor ? 'selected' : ''}>
              ${escapar(o.rotulo)}
            </option>`).join('')}
        </select>` : ''}
      <label class="sr" for="filtro-palavra">Filtrar por palavra</label>
      <input id="filtro-palavra" class="campo-filtro" placeholder="Filtrar por palavra" value="${escapar(f.busca)}">
    </div>
  </div>

  ${estado.facetas?.categorias?.length ? `<div class="secao" style="margin-top:-12px">
    <button class="aba" data-categoria="" aria-pressed="${!f.categoria}">Todas</button>
    ${estado.facetas.categorias.slice(0, 7).map((c) => `
      <button class="aba" data-categoria="${escapar(c.nome)}" aria-pressed="${f.categoria === c.nome}">
        ${escapar(c.nome)} <span style="opacity:.55">${c.total}</span>
      </button>`).join('')}
  </div>` : ''}

  ${lista.length
    ? `<div class="grade">${lista.map(cartaoVaga).join('')}</div>
       ${estado.temMais ? `<div style="display:flex;justify-content:center;padding:4px 0">
         <button class="btn btn-linha" data-acao="mais-vagas" ${estado.buscando ? 'disabled' : ''}>
           ${estado.buscando ? 'Carregando…' : 'Ver mais trampos'}
         </button></div>` : ''}`
    : vazio('🔍', 'Nenhum trampo por aqui',
        (f.busca || f.modalidade || f.categoria || f.garantidas)
          ? 'Nenhum trampo bate com esse filtro. Tente afrouxar a busca.'
          : 'Ainda nao ha trampos publicados. Volte daqui a pouco.',
        '<button class="btn btn-linha" data-acao="limpar-filtros">Limpar filtros</button>')}`
}

function telaVerificar () {
  return heroi({
    cor: 'roxo',
    olho: 'Publico · sem login',
    titulo: 'Verificar certificado',
    texto: 'Digite o codigo impresso no documento. Nao precisa de conta, nem de login, nem de cadastro.',
    arte: orbe('🔎', 'Rx')
  }) + `

  <div class="painel" style="max-width:560px">
    <form class="codigo-caixa" id="form-codigo">
      <label class="sr" for="codigo">Codigo do certificado</label>
      <input id="codigo" placeholder="UNI-XXXX-XXXX" maxlength="14"
             autocomplete="off" spellcheck="false" value="${escapar(estado.codigoDigitado)}">
      <button class="btn btn-azul" type="submit">Verificar</button>
    </form>
  </div>

  ${estado.certificados.length ? `
    <div class="secao"><h2>Seus certificados</h2><span class="conta">${estado.certificados.length}</span></div>
    <div class="cert-grade">${estado.certificados.slice(0, 3).map(cartaoCertificado).join('')}</div>` : ''}`
}

function telaPainel () {
  const t = estado.metricas?.totais
  const cat = estado.metricas?.porCategoria ?? []

  return heroi({
    cor: 'grafite',
    olho: 'Publico · em tempo real',
    titulo: 'Painel do ecossistema',
    texto: 'Quanto ja foi pago, quanto esta em garantia agora e quantas horas viraram certificado. Os numeros vem do banco e da rede, nao de estimativa.',
    arte: orbe('📊', 'Gf')
  }) + `

  <div class="metricas">
    <div class="metrica"><div class="metrica-valor">${usdc(t?.pagoCentavos)}<span style="font-size:13px;color:var(--ink-3)"> USDC</span></div><div class="metrica-rotulo">pago a estudantes</div></div>
    <div class="metrica"><div class="metrica-valor">${usdc(t?.reservadoCentavos)}<span style="font-size:13px;color:var(--ink-3)"> USDC</span></div><div class="metrica-rotulo">em garantia agora</div></div>
    <div class="metrica"><div class="metrica-valor">${t?.horasCertificadas ?? 0}h</div><div class="metrica-rotulo">horas certificadas</div></div>
    <div class="metrica"><div class="metrica-valor">${t?.certificados ?? 0}</div><div class="metrica-rotulo">certificados emitidos</div></div>
    <div class="metrica"><div class="metrica-valor">${t?.vagas ?? 0}</div><div class="metrica-rotulo">trampos publicados</div></div>
    <div class="metrica"><div class="metrica-valor">${t?.concluidas ?? 0}</div><div class="metrica-rotulo">concluidos</div></div>
    <div class="metrica"><div class="metrica-valor">${t?.estudantes ?? 0}</div><div class="metrica-rotulo">estudantes</div></div>
    <div class="metrica"><div class="metrica-valor">${t?.contratantes ?? 0}</div><div class="metrica-rotulo">contratantes</div></div>
  </div>

  ${cat.length ? `<div class="painel">
    <h4>POR CATEGORIA</h4>
    <dl class="dados">${cat.map((c) => `<div class="linha-dado">
      <dt>${escapar(c.categoria)}</dt><dd>${c.total}</dd>
    </div>`).join('')}</dl>
  </div>` : ''}`
}

function telaMinhas () {
  const ehEstudante = estado.usuario?.perfil === 'student'
  // Lista propria, vinda de /jobs/minhas. Filtrar o resultado da busca publica
  // nao funciona: ela so traz trampo aberto ou garantido.
  const minhas = estado.minhasVagas

  const grupos = [
    { titulo: 'Precisam de voce', filtro: (v) => ['aberta', 'garantida', 'aceita', 'em_andamento', 'entregue'].includes(v.status) },
    { titulo: 'Concluidos', filtro: (v) => v.status === 'concluida' },
    { titulo: 'Cancelados', filtro: (v) => v.status === 'cancelada' }
  ]

  return heroi({
    cor: 'grafite',
    olho: ehEstudante ? 'Seu trabalho' : 'Suas contratacoes',
    titulo: ehEstudante ? 'Meus trampos' : 'Minhas vagas',
    texto: minhas.length
      ? `${minhas.length} no total. Acompanhe cada etapa e confirme quando estiver tudo certo.`
      : (ehEstudante
          ? 'Tudo que voce se candidatou ou esta executando aparece aqui.'
          : 'Tudo que voce publicou aparece aqui, com o estagio de cada trampo.'),
    arte: orbe(ehEstudante ? '🎒' : '🗂️', 'Mn')
  }) + (minhas.length
    ? grupos.map((g) => {
        const lista = minhas.filter(g.filtro)
        if (!lista.length) return ''
        return `<div class="secao"><h2>${g.titulo}</h2><span class="conta">${lista.length}</span></div>
          <div class="grade">${lista.map(cartaoVaga).join('')}</div>`
      }).join('') + (estado.temMaisMinhas
        ? '<div style="display:flex;justify-content:center"><button class="btn btn-linha" data-acao="mais-minhas">Ver mais</button></div>'
        : '')
    : vazio('📋',
        ehEstudante ? 'Voce ainda nao pegou nenhum trampo' : 'Voce ainda nao publicou nada',
        ehEstudante
          ? 'Procure na lista de trampos abertos e candidate-se ao que combinar com voce.'
          : 'Publique o primeiro trampo e reserve o valor para os estudantes verem a garantia.',
        ehEstudante
          ? '<button class="btn btn-azul" data-view="feed">Ver trampos abertos</button>'
          : '<button class="btn btn-azul" data-acao="publicar">Publicar vaga</button>'))
}

function cartaoCertificado (c) {
  return `<button class="cert" data-certificado="${escapar(c.codigo)}">
    <img src="/api/certificates/${encodeURIComponent(c.codigo)}/image.svg" alt="Certificado de ${escapar(c.titulo)}" loading="lazy">
    <div class="cert-info">
      <span class="cert-horas">${c.horas}h</span>
      <div style="min-width:0">
        <div class="cert-titulo">${escapar(c.titulo)}</div>
        <div class="cert-sub">${escapar(c.contratante)} · ${quando(c.emitidoEm)}</div>
      </div>
      <span class="cert-estado ${c.emProcessamento ? 'processando' : 'pronto'}">
        ${c.emProcessamento ? 'processando' : 'pronto'}
      </span>
    </div>
  </button>`
}

function telaCertificados () {
  if (estado.usuario?.perfil !== 'student') {
    return heroi({
      cor: 'roxo',
      olho: 'Certificados',
      titulo: 'O certificado e do estudante',
      texto: 'Cada entrega que voce confirma emite um certificado com a carga horaria, na conta de quem executou. Ele tem codigo publico e qualquer pessoa confere sem ter conta.',
      arte: orbe('🎓', 'Ce')
    })
  }

  return heroi({
    cor: 'roxo',
    olho: 'Seus comprovantes',
    titulo: `${estado.horasTotais}h certificadas`,
    texto: 'Cada certificado tem codigo publico. Mande o link para a coordenacao do seu curso ou para um contratante: eles conferem sem precisar de conta.',
    arte: orbe('🎓', 'Ce')
  }) + (estado.certificados.length
    ? `<div class="cert-grade">${estado.certificados.map(cartaoCertificado).join('')}</div>`
    : vazio('🎓', 'Nenhum certificado ainda',
        'Conclua um trampo e o certificado com a carga horaria aparece aqui automaticamente, sem voce pedir.',
        '<button class="btn btn-azul" data-view="feed">Ver trampos abertos</button>'))
}

function telaConta () {
  const u = estado.usuario
  const r = estado.resumo
  const p = estado.preferencias

  return heroi({
    cor: 'grafite',
    olho: u.email,
    titulo: u.nome,
    texto: u.perfil === 'student'
      ? ([u.curso, u.universidade].filter(Boolean).join(' · ') || 'Estudante')
      : 'Contratante',
    acoes: `<button class="btn btn-linha" data-acao="meu-perfil">Ver meu perfil publico</button>
            <button class="btn btn-fantasma" data-acao="rever-guia">Rever como funciona</button>`,
    arte: orbe(u.perfil === 'student' ? '🎒' : '🏢', 'Co')
  }) + `

  <div class="detalhe-grade">
    <div style="display:flex;flex-direction:column;gap:18px;min-width:0">
      <div class="painel">
        <h4>RESUMO</h4>
        <dl class="dados">
          <div class="linha-dado"><dt>Movimentado</dt><dd>${usdcExato(r?.valores?.movimentadoCentavos)} USDC</dd></div>
          <div class="linha-dado"><dt>Em garantia agora</dt><dd>${usdcExato(r?.valores?.reservadoCentavos)} USDC</dd></div>
          <div class="linha-dado"><dt>Horas certificadas</dt><dd>${r?.certificados?.horas ?? 0}h</dd></div>
          <div class="linha-dado"><dt>Avaliacao</dt><dd>${(r?.avaliacao?.media ?? 0).toFixed(1)} (${r?.avaliacao?.total ?? 0})</dd></div>
        </dl>
      </div>

      <div class="painel">
        <h4>COMO O PAGAMENTO FUNCIONA</h4>
        <p style="font-size:13.5px;color:var(--ink-2);line-height:1.65">
          O contratante reserva o valor ao publicar. Ele sai da conta dele e fica separado, sem
          poder voltar sozinho. Quando a entrega e confirmada, o valor vai para o estudante e o
          certificado e emitido no mesmo instante. Se o trampo for cancelado antes da entrega, o
          valor volta inteiro para quem reservou.
        </p>
      </div>
    </div>

    <div class="painel">
      <h4>NOTIFICACOES</h4>
      <dl class="dados">
        <div class="linha-dado"><dt>No aplicativo</dt><dd style="color:var(--verde);font-family:var(--sans)">sempre</dd></div>
        <div class="linha-dado"><dt>Por e-mail</dt><dd style="font-family:var(--sans)">${p?.email ? 'ligado' : 'desligado'}</dd></div>
        <div class="linha-dado"><dt>No navegador</dt><dd style="font-family:var(--sans)">${p?.push ? 'ligado' : 'desligado'}</dd></div>
      </dl>
      <button class="btn btn-linha btn-mini btn-bloco" style="margin-top:12px" data-view="notificacoes">
        Ajustar notificacoes
      </button>
    </div>
  </div>`
}

// ─── detalhe do trampo ───────────────────────────────────────────────────────

const ETAPAS_ROTULO = [
  'Trampo publicado', 'Valor reservado', 'Estudante escolhido',
  'Trabalho em andamento', 'Entrega enviada', 'Confirmado e pago'
]

function acoesDaVaga (vaga) {
  const u = estado.usuario
  // Sem sessao nao ha acao possivel. Acontece quando um render pendente roda
  // logo depois de sair.
  if (!u) return []

  const souContratante = vaga.contratante?.id === u.id
  const souEstudante = vaga.estudante?.id === u.id
  const botoes = []

  if (souContratante) {
    if (vaga.status === 'aberta') botoes.push(['reservar', 'Reservar o valor', 'btn-azul'])
    if (vaga.status === 'entregue' && !vaga.emContestacao) botoes.push(['confirmar', 'Confirmar entrega e pagar', 'btn-azul'])
    if (['aberta', 'garantida', 'aceita', 'em_andamento'].includes(vaga.status) && !vaga.emContestacao) {
      botoes.push(['cancelar', 'Cancelar', 'btn-perigo'])
    }
  }
  if (souEstudante) {
    if (vaga.status === 'aceita') botoes.push(['comecar', 'Comecar o trabalho', 'btn-azul'])
    if (vaga.status === 'em_andamento') botoes.push(['entregar', 'Enviar entrega', 'btn-azul'])
  }
  if (!souContratante && !souEstudante && u.perfil === 'student' &&
      ['aberta', 'garantida'].includes(vaga.status) && !vaga.minhaCandidatura) {
    botoes.push(['candidatar', 'Quero esse trampo', 'btn-azul'])
  }
  if (vaga.status === 'concluida' && (souContratante || souEstudante)) {
    botoes.push(['avaliar', 'Avaliar', 'btn-linha'])
  }
  // Contestar so aparece quando ha trabalho combinado, valor reservado e o
  // dinheiro ainda nao saiu. Fora dessa janela nao ha o que contestar.
  if ((souContratante || souEstudante) && !vaga.contestacao &&
      ['aceita', 'em_andamento', 'entregue'].includes(vaga.status)) {
    botoes.push(['contestar', 'Abrir contestacao', 'btn-linha'])
  }
  return botoes
}

/** Onde o dinheiro esta neste momento, em uma frase. */
function frasePagamento (vaga) {
  const valor = `${usdc(vaga.valorCentavos)} USDC`
  if (vaga.status === 'cancelada') return `${valor}. O trampo foi cancelado e o valor voltou para quem reservou.`
  if (vaga.status === 'concluida') return `${valor} pagos ao estudante, com o certificado emitido na mesma hora.`
  if (vaga.pagamentoEmProcessamento) return `${valor} ja confirmados. Estamos concluindo o pagamento agora.`
  if (vaga.emContestacao) return `${valor} parados ate a contestacao ser decidida. Nem saem, nem voltam.`
  if (vaga.pagamentoGarantido) return `${valor} ja reservados. O valor sai para o estudante assim que a entrega for confirmada.`
  return `${valor}. O contratante ainda nao reservou o valor.`
}

function telaDetalhe () {
  const vaga = estado.vagaAberta
  if (!vaga) return vazio('🔍', 'Trampo nao encontrado', 'Ele pode ter sido removido.')

  const etapaAtual = vaga.trilha?.etapa ?? 0
  // Numa vaga concluida a ultima etapa esta cumprida, e nao em curso.
  const terminou = vaga.status === 'concluida'
  const botoes = acoesDaVaga(vaga)
  const u = estado.usuario
  const souParte = Boolean(u) && (vaga.contratante?.id === u.id || vaga.estudante?.id === u.id)

  return `
  <button class="btn btn-fantasma btn-mini" data-acao="voltar" style="align-self:flex-start">← Voltar</button>

  ${heroi({
    cor: vaga.emContestacao ? 'grafite' : vaga.pagamentoGarantido ? 'verde' : 'azul',
    olho: `${vaga.categoria} · ${vaga.modalidade}${vaga.local ? ` · ${vaga.local}` : ''}`,
    titulo: vaga.titulo,
    texto: frasePagamento(vaga),
    dados: [
      { rotulo: 'Valor', valor: `${usdc(vaga.valorCentavos)} USDC` },
      { rotulo: 'Carga horaria', valor: `${vaga.horas}h` },
      { rotulo: 'Estado', valor: vaga.statusRotulo }
    ],
    acoes: botoes.map(([acao, rotulo, classe]) =>
      `<button class="btn ${classe}" data-acao-vaga="${acao}">${rotulo}</button>`).join('')
  })}

  <div class="detalhe-grade">
    <div style="display:flex;flex-direction:column;gap:18px;min-width:0">
      <div class="painel">
        <h4>DESCRICAO</h4>
        <p style="font-size:14px;white-space:pre-wrap;line-height:1.65">${escapar(vaga.descricao)}</p>
      </div>

      ${vaga.entregaObservacao ? `<div class="painel">
        <h4>OBSERVACAO DA ENTREGA</h4>
        <p style="font-size:14px;white-space:pre-wrap;line-height:1.65">${escapar(vaga.entregaObservacao)}</p>
      </div>` : ''}

      ${vaga.candidaturas?.length ? `<div class="painel">
        <h4>CANDIDATURAS (${vaga.candidaturas.length})</h4>
        ${vaga.candidaturas.map((c) => `<div style="display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--line)">
          <span class="avatar g c${corDe(c.estudante.nome)}" aria-hidden="true">${iniciais(c.estudante.nome)}</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:14px">${escapar(c.estudante.nome)}</div>
            <div style="font-size:12px;color:var(--ink-3)">${escapar([c.estudante.curso, c.estudante.universidade].filter(Boolean).join(' · '))}</div>
            ${c.apresentacao ? `<p style="font-size:13px;color:var(--ink-2);margin-top:6px">${escapar(c.apresentacao)}</p>` : ''}
          </div>
          ${c.status === 'pendente' && vaga.status === 'garantida'
            ? `<button class="btn btn-claro btn-mini" data-aceitar="${escapar(c.id)}">Escolher</button>`
            : `<span class="etiqueta">${escapar(c.status)}</span>`}
        </div>`).join('')}
        ${vaga.status === 'aberta' ? '<p style="font-size:12.5px;color:var(--laranja);margin-top:10px">Reserve o valor para poder escolher um estudante.</p>' : ''}
      </div>` : ''}

      ${souParte ? `<div class="painel">
        <h4>CONVERSA</h4>
        <div class="conversa" id="conversa"><p style="color:var(--ink-3);font-size:13px">Carregando…</p></div>
        <form id="form-mensagem" style="display:flex;gap:8px;margin-top:12px">
          <label class="sr" for="mensagem-texto">Mensagem</label>
          <input id="mensagem-texto" class="campo-filtro" style="flex:1" placeholder="Escreva uma mensagem">
          <button class="btn btn-claro btn-mini" type="submit">Enviar</button>
        </form>
      </div>` : ''}
    </div>

    <div style="display:flex;flex-direction:column;gap:14px">
      <div class="painel">
        <h4>ANDAMENTO</h4>
        <div class="etapas">
          ${ETAPAS_ROTULO.map((rotulo, i) => {
            const num = i + 1
            const feita = !vaga.trilha?.cancelada && (num < etapaAtual || (terminou && num === etapaAtual))
            const atual = !vaga.trilha?.cancelada && !terminou && num === etapaAtual
            return `<div class="etapa ${feita ? 'feita' : ''} ${atual ? 'atual' : ''}">
              <span class="etapa-bola" aria-hidden="true">${feita ? '✓' : ''}</span>
              <div class="etapa-texto">${rotulo}</div>
            </div>`
          }).join('')}
          ${vaga.trilha?.cancelada ? '<div class="etapa"><span class="etapa-bola" aria-hidden="true">✕</span><div class="etapa-texto" style="color:#f87171">Cancelado, valor devolvido</div></div>' : ''}
        </div>
      </div>

      ${vaga.contestacao ? `<div class="painel" style="border-color:rgba(245,158,11,.3)">
        <h4 style="color:var(--laranja)">CONTESTACAO</h4>
        <p style="font-size:13.5px;font-weight:700;margin-bottom:6px">${escapar(vaga.contestacao.statusRotulo)}</p>
        <p style="font-size:13px;color:var(--ink-2);margin-bottom:10px">${escapar(vaga.contestacao.motivoRotulo)}</p>
        <p style="font-size:13px;color:var(--ink-2);white-space:pre-wrap;margin-bottom:12px">${escapar(vaga.contestacao.detalhe)}</p>
        <dl class="dados">
          <div class="linha-dado"><dt>Aberta por</dt><dd style="font-family:var(--sans)">${escapar(vaga.contestacao.abertaPor.nome ?? '-')}</dd></div>
          <div class="linha-dado"><dt>Prazo da analise</dt><dd>${dataBR(vaga.contestacao.prazoEm)}</dd></div>
        </dl>
        ${vaga.contestacao.resolucao ? `
          <p style="font-size:11px;letter-spacing:.1em;color:var(--ink-3);margin:14px 0 6px">DECISAO</p>
          <p style="font-size:13px;color:var(--ink-2);white-space:pre-wrap">${escapar(vaga.contestacao.resolucao)}</p>
          ${vaga.contestacao.divisaoBps !== null ? `<p style="font-size:12.5px;color:var(--ink-3);margin-top:8px">Divisao: ${Math.round(vaga.contestacao.divisaoBps / 100)}% para o estudante</p>` : ''}
        ` : '<p style="font-size:12.5px;color:var(--ink-3);margin-top:10px">Enquanto a contestacao estiver aberta, o valor fica parado. Nem sai, nem volta.</p>'}
      </div>` : ''}

      ${vaga.autoConfirmaEm && vaga.status === 'entregue' && !vaga.contestacao && !vaga.pagamentoEmProcessamento ? `<div class="painel">
        <h4>PRAZO DE CONFIRMACAO</h4>
        <p style="font-size:13px;color:var(--ink-2);line-height:1.6">
          Se ninguem confirmar nem contestar ate <strong>${dataBR(vaga.autoConfirmaEm)}</strong>,
          o pagamento e liberado automaticamente para o estudante.
        </p>
      </div>` : ''}

      ${vaga.anexos ? `<div class="painel">
        <h4>ARQUIVOS</h4>
        ${vaga.anexos.length
          ? `<dl class="dados">${vaga.anexos.map((a) => `<div class="linha-dado">
              <dt><a href="${escapar(a.url)}" target="_blank" rel="noopener" style="color:var(--azul-2)">${escapar(a.nome)}</a></dt>
              <dd>${Math.round(a.tamanho / 1024)} KB</dd>
            </div>`).join('')}</dl>`
          : '<p style="font-size:13px;color:var(--ink-3)">Nenhum arquivo por enquanto.</p>'}
        <button class="btn btn-linha btn-mini btn-bloco" style="margin-top:12px" data-enviar="delivery">Anexar arquivo</button>
      </div>` : ''}

      ${vaga.certificado ? `<div class="painel">
        <h4>CERTIFICADO</h4>
        <p style="font-size:14px;font-weight:700">${vaga.certificado.horas}h certificadas</p>
        <p class="mono" style="font-size:12px;color:var(--ink-3);margin:6px 0 12px">${escapar(vaga.certificado.codigo)}</p>
        <a class="btn btn-linha btn-mini btn-bloco" href="/verificar/${encodeURIComponent(vaga.certificado.codigo)}">Ver certificado</a>
      </div>` : ''}
    </div>
  </div>`
}

// ─── perfil publico ──────────────────────────────────────────────────────────

function telaPerfil () {
  const p = estado.perfilAberto
  if (!p) return vazio('❓', 'Perfil nao encontrado', 'Este perfil pode ter sido removido.')

  const ehEstudante = p.perfil === 'student'
  const estrelas = (n) => '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n))

  return `
  <button class="btn btn-fantasma btn-mini" data-acao="voltar" style="align-self:flex-start">← Voltar</button>

  ${heroi({
    cor: 'grafite',
    olho: ehEstudante ? ([p.curso, p.universidade].filter(Boolean).join(' · ') || 'Estudante') : 'Contratante',
    titulo: p.nome,
    texto: p.headline ?? '',
    dados: ehEstudante
      ? [
          { rotulo: 'Horas certificadas', valor: `${p.horasCertificadas}h` },
          { rotulo: 'Trampos concluidos', valor: String(p.trabalhosConcluidos) },
          { rotulo: 'Avaliacao', valor: p.avaliacao.total ? `${p.avaliacao.media.toFixed(1)} de 5` : 'sem avaliacao' }
        ]
      : [
          { rotulo: 'Vagas publicadas', valor: String(p.vagasPublicadas) },
          { rotulo: 'Taxa de confirmacao', valor: p.taxaDeConfirmacao === null ? '—' : `${p.taxaDeConfirmacao}%` },
          { rotulo: 'Tempo ate confirmar', valor: p.tempoMedioAteConfirmarHoras === null ? '—' : `${p.tempoMedioAteConfirmarHoras}h` }
        ],
    acoes: p.souEu ? '<button class="btn btn-linha" data-acao="editar-perfil">Editar perfil</button>' : ''
  })}

  ${p.bio ? `<div class="painel"><h4>SOBRE</h4><p style="font-size:14px;white-space:pre-wrap;line-height:1.65">${escapar(p.bio)}</p></div>` : ''}

  ${ehEstudante && p.habilidades?.length ? `<div class="painel">
    <h4>HABILIDADES</h4>
    <div class="etiquetas">${p.habilidades.map((h) => `<span class="etiqueta">${escapar(h)}</span>`).join('')}</div>
  </div>` : ''}

  ${p.links?.length ? `<div class="painel">
    <h4>LINKS</h4>
    <div class="etiquetas">${p.links.map((l) => `<a class="etiqueta" href="${escapar(l.url)}" target="_blank" rel="noopener nofollow">${escapar(l.rotulo)} ↗</a>`).join('')}</div>
  </div>` : ''}

  ${ehEstudante ? `
    <div class="secao"><h2>Certificados</h2><span class="conta">${p.certificados.length}</span></div>
    ${p.certificados.length
      ? `<div class="cert-grade">${p.certificados.map((c) => `
          <a class="cert" href="${escapar(c.verificacao)}">
            <img src="/api/certificates/${encodeURIComponent(c.codigo)}/image.svg" alt="Certificado de ${escapar(c.titulo)}" loading="lazy">
            <div class="cert-info">
              <span class="cert-horas">${c.horas}h</span>
              <div style="min-width:0">
                <div class="cert-titulo">${escapar(c.titulo)}</div>
                <div class="cert-sub">${escapar(c.contratante)}</div>
              </div>
              <span class="cert-estado ${c.registrado ? 'pronto' : 'processando'}">${c.registrado ? 'verificavel' : 'processando'}</span>
            </div>
          </a>`).join('')}</div>`
      : vazio('🎓', 'Nenhum certificado ainda', p.souEu
          ? 'Conclua um trampo e o certificado aparece aqui, pronto para mostrar.'
          : 'Esta pessoa ainda nao concluiu nenhum trampo pela plataforma.')}

    <div class="secao">
      <h2>Portfolio</h2><span class="conta">${p.portfolio?.length ?? 0}</span>
      ${p.souEu ? '<div class="filtros"><button class="btn btn-linha btn-mini" data-enviar="portfolio">Adicionar arquivo</button></div>' : ''}
    </div>
    ${p.portfolio?.length
      ? `<div class="grade">${p.portfolio.map((a) => `<div class="painel">
          ${a.ehImagem
            ? `<img src="${escapar(a.url)}" alt="${escapar(a.nome)}" style="width:100%;border-radius:10px;aspect-ratio:16/10;object-fit:cover;margin-bottom:10px">`
            : '<div style="padding:24px;text-align:center;background:var(--card-2);border-radius:10px;font-size:24px;margin-bottom:10px">📄</div>'}
          <div style="display:flex;align-items:center;gap:10px">
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:700">${escapar(a.nome)}</div>
              <div style="font-size:11.5px;color:var(--ink-3)">${Math.round(a.tamanho / 1024)} KB</div>
            </div>
            ${p.souEu ? `<button class="btn btn-fantasma btn-mini" data-apagar-anexo="${escapar(a.id)}">Apagar</button>` : ''}
          </div>
        </div>`).join('')}</div>`
      : vazio('📎', 'Portfolio vazio', p.souEu
          ? 'Adicione trabalhos que voce ja fez. E o que um contratante olha antes de escolher.'
          : 'Esta pessoa ainda nao publicou trabalhos.')}
  ` : ''}

  <div class="secao"><h2>Avaliacoes</h2><span class="conta">${p.avaliacoes.length}</span></div>
  ${p.avaliacoes.length
    ? `<div style="display:flex;flex-direction:column;gap:12px">${p.avaliacoes.map((a) => `<div class="painel">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
          <strong style="font-size:13.5px">${escapar(a.autor)}</strong>
          <span style="color:var(--laranja);font-size:13px">${estrelas(a.nota)}</span>
          <span style="margin-left:auto;font-size:12px;color:var(--ink-3)">${quando(a.quando)}</span>
        </div>
        <p style="font-size:12.5px;color:var(--ink-3);margin-bottom:6px">${escapar(a.vaga)}</p>
        ${a.comentario ? `<p style="font-size:13.5px;color:var(--ink-2)">${escapar(a.comentario)}</p>` : ''}
      </div>`).join('')}</div>`
    : vazio('★', 'Nenhuma avaliacao ainda', 'As avaliacoes aparecem quando um trampo e concluido pelos dois lados.')}`
}

// ─── notificacoes ────────────────────────────────────────────────────────────

function telaNotificacoes () {
  const p = estado.preferencias
  const naoLidas = estado.notificacoes.filter((n) => !n.lida).length

  return heroi({
    cor: 'grafite',
    olho: 'Sua caixa',
    titulo: 'Notificacoes',
    texto: naoLidas ? `${naoLidas} nova${naoLidas === 1 ? '' : 's'}.` : 'Tudo em dia por aqui.',
    acoes: naoLidas ? '<button class="btn btn-linha" data-acao="marcar-lidas">Marcar todas como lidas</button>' : '',
    arte: orbe('🔔', 'No')
  }) + `

  <div class="detalhe-grade">
    <div style="display:flex;flex-direction:column;gap:10px;min-width:0">
      ${estado.notificacoes.length
        ? estado.notificacoes.map((n) => `<button class="painel" style="text-align:left;cursor:pointer;display:flex;gap:12px;align-items:flex-start;${n.lida ? '' : 'border-left:3px solid var(--azul)'}"
              data-notificacao="${escapar(n.id)}" data-link="${escapar(n.link ?? '')}">
            <div style="flex:1;min-width:0">
              <div style="font-size:14px;font-weight:700;margin-bottom:3px">${escapar(n.titulo)}</div>
              <p style="font-size:13px;color:var(--ink-3);line-height:1.5">${escapar(n.corpo)}</p>
            </div>
            <time class="mono" style="font-size:11.5px;color:var(--ink-3);white-space:nowrap">${quando(n.quando)}</time>
          </button>`).join('')
        : vazio('🔔', 'Nada por aqui ainda', 'Quando alguem se candidatar, entregar ou confirmar um trampo seu, o aviso aparece aqui.')}
    </div>

    <div class="painel">
      <h4>COMO SER AVISADO</h4>
      <dl class="dados">
        <div class="linha-dado"><dt>No aplicativo</dt><dd style="color:var(--verde);font-family:var(--sans)">sempre</dd></div>
      </dl>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:12px">
        <button class="btn ${p?.email ? 'btn-azul' : 'btn-linha'} btn-mini btn-bloco" data-pref="email">
          Por e-mail: ${p?.email ? 'ligado' : 'desligado'}
        </button>
        <button class="btn ${p?.push ? 'btn-azul' : 'btn-linha'} btn-mini btn-bloco" data-pref="push"
                ${estado.pushDisponivel ? '' : 'disabled'}>
          No navegador: ${estado.pushDisponivel ? (p?.push ? 'ligado' : 'desligado') : 'indisponivel'}
        </button>
      </div>

      <h4 style="margin-top:18px">QUANDO</h4>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${[['instant', 'Na hora'], ['daily', 'Resumo diario'], ['off', 'Desligado']].map(([valor, rotulo]) => `
          <button class="btn ${p?.digest === valor ? 'btn-azul' : 'btn-linha'} btn-mini btn-bloco" data-digest="${valor}">
            ${rotulo}
          </button>`).join('')}
      </div>
    </div>
  </div>`
}

// ─── mediacao ────────────────────────────────────────────────────────────────

function telaMediacao () {
  const abertas = estado.contestacoes.filter((c) => ['open', 'in_review'].includes(c.status))
  const resolvidas = estado.contestacoes.filter((c) => !['open', 'in_review'].includes(c.status))

  const cartao = (c) => `<div class="painel" style="${c.atrasada ? 'border-color:rgba(239,68,68,.35)' : ''}">
    <div style="display:flex;gap:12px;align-items:flex-start;margin-bottom:10px">
      <span class="avatar g c${corDe(c.vagaTitulo)}" aria-hidden="true">${iniciais(c.vagaTitulo)}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:700">${escapar(c.vagaTitulo ?? c.vagaId)}</div>
        <div style="font-size:12px;color:var(--ink-3)">${escapar(c.motivoRotulo)} · aberta por ${escapar(c.abertaPor.nome ?? '-')}</div>
      </div>
      <div class="mono" style="font-size:15px;font-weight:700">${usdc(c.valorCentavos)} <span style="font-size:11px;color:var(--ink-3)">USDC</span></div>
    </div>
    <p style="font-size:13px;color:var(--ink-2);line-height:1.55;margin-bottom:10px">${escapar(c.detalhe)}</p>
    <div class="etiquetas" style="margin-bottom:10px">
      <span class="etiqueta">${escapar(c.statusRotulo)}</span>
      <span class="etiqueta" style="${c.atrasada ? 'color:#f87171;border-color:rgba(239,68,68,.3)' : ''}">
        prazo ${dataBR(c.prazoEm)}${c.atrasada ? ' · atrasada' : ''}
      </span>
    </div>
    ${c.resolucao ? `<p style="font-size:12.5px;color:var(--ink-3);white-space:pre-wrap">${escapar(c.resolucao)}</p>` : ''}
    ${['open', 'in_review'].includes(c.status) ? `<div style="display:flex;gap:8px;flex-wrap:wrap">
      ${c.status === 'open' ? `<button class="btn btn-linha btn-mini" data-assumir="${escapar(c.id)}">Assumir analise</button>` : ''}
      <button class="btn btn-azul btn-mini" data-resolver="${escapar(c.id)}">Decidir</button>
      <button class="btn btn-fantasma btn-mini" data-vaga="${escapar(c.vagaId)}">Ver o trampo</button>
    </div>` : ''}
  </div>`

  return heroi({
    cor: 'grafite',
    olho: 'Equipe de mediacao',
    titulo: 'Contestacoes',
    texto: 'Quando as duas partes discordam, o valor fica parado ate alguem decidir. Cada caso tem prazo, e o que voce decide aqui move dinheiro de verdade.',
    arte: orbe('⚖️', 'Me')
  }) + `

  <div class="secao"><h2>Aguardando decisao</h2><span class="conta">${abertas.length}</span></div>
  ${abertas.length
    ? `<div style="display:flex;flex-direction:column;gap:14px">${abertas.map(cartao).join('')}</div>`
    : vazio('✓', 'Nenhuma contestacao aberta', 'Quando alguem contestar um trampo, o caso aparece aqui com o prazo de analise.')}

  ${resolvidas.length ? `
    <div class="secao"><h2>Resolvidas</h2><span class="conta">${resolvidas.length}</span></div>
    <div style="display:flex;flex-direction:column;gap:14px">${resolvidas.map(cartao).join('')}</div>` : ''}`
}

// ─── painel da direita ───────────────────────────────────────────────────────

const PASSOS = 6

function renderDir () {
  const t = estado.metricas?.totais
  // A barra acompanha a etapa do trampo aberto; sem trampo aberto, mostra 1.
  const etapa = estado.vagaAberta?.trilha?.etapa ?? 1

  $('#dir').innerHTML = `
    <div class="widget">
      <div class="widget-topo">
        <h3>Como funciona</h3>
        <span class="widget-selo">${PASSOS} etapas</span>
      </div>
      <div class="barra">
        <div class="barra-trilho" role="img" aria-label="Etapa ${etapa} de ${PASSOS}">
          ${Array.from({ length: PASSOS }, (_, i) => `<span class="barra-seg ${i < etapa ? 'feito' : ''}"></span>`).join('')}
        </div>
        <span class="barra-num">${etapa}/${PASSOS}</span>
      </div>
      <p>Publicar, reservar o valor, escolher o estudante, executar, entregar e confirmar.
         A confirmacao paga e certifica no mesmo clique.</p>
    </div>

    <div class="widget">
      <div class="widget-topo">
        <h3>Ecossistema</h3>
        <span class="widget-selo">devnet</span>
      </div>
      <dl class="dados">
        <div class="linha-dado"><dt>Pago a estudantes</dt><dd>${usdc(t?.pagoCentavos)}</dd></div>
        <div class="linha-dado"><dt>Em garantia</dt><dd>${usdc(t?.reservadoCentavos)}</dd></div>
        <div class="linha-dado"><dt>Horas certificadas</dt><dd>${t?.horasCertificadas ?? 0}h</dd></div>
        <div class="linha-dado"><dt>Certificados</dt><dd>${t?.certificados ?? 0}</dd></div>
      </dl>
    </div>

    <div class="widget">
      <div class="widget-topo">
        <h3>Atividade recente</h3>
        <span class="widget-selo vivo"><span class="ponto-vivo" aria-hidden="true"></span>ao vivo</span>
      </div>
      ${estado.feed.length
        ? estado.feed.slice(0, 8).map((e) => `<div class="feed-item">
            <span class="feed-ponto" aria-hidden="true"></span>
            <div>
              <div class="feed-texto">${escapar(e.label ?? e.type)}</div>
              <div class="feed-quando">${quando(e.created_at)}</div>
            </div>
          </div>`).join('')
        : '<p>Nada aconteceu ainda. Assim que alguem publicar, aceitar ou confirmar um trampo, aparece aqui.</p>'}
    </div>

    <div class="widget">
      <div class="widget-topo"><h3>Por baixo do capo</h3></div>
      <p style="margin-bottom:12px">O pagamento e o certificado rodam na Solana. Nenhuma tela do produto
         precisa que voce entenda nada disso.</p>
      <button class="btn btn-linha btn-mini btn-bloco" data-acao="abrir-gaveta">Abrir camada tecnica</button>
    </div>`
}

// ─── render ──────────────────────────────────────────────────────────────────

const TELAS = {
  entrar: telaEntrar,
  feed: telaFeed,
  verificar: telaVerificar,
  painel: telaPainel,
  minhas: telaMinhas,
  certificados: telaCertificados,
  conta: telaConta,
  detalhe: telaDetalhe,
  perfil: telaPerfil,
  notificacoes: telaNotificacoes,
  mediacao: telaMediacao
}

const EXIGEM_SESSAO = ['minhas', 'certificados', 'conta', 'notificacoes', 'mediacao']

function render () {
  // Uma tela que exige sessao nunca e desenhada sem sessao.
  if (!estado.usuario && EXIGEM_SESSAO.includes(estado.view)) estado.view = 'entrar'
  if (estado.usuario && estado.view === 'entrar') estado.view = 'feed'

  renderNav()
  $('#conteudo').innerHTML = (TELAS[estado.view] ?? telaFeed)()
  renderDir()
  if (estado.view === 'detalhe' && estado.vagaAberta) carregarConversa(estado.vagaAberta.id)
}

// ─── onboarding ──────────────────────────────────────────────────────────────

const GUIAS = {
  student: [
    {
      arte: '🔒',
      titulo: 'O pagamento vem antes de voce aceitar',
      corpo: 'O contratante reserva o valor no ato de publicar. Quando voce ve "garantido" num cartao, o dinheiro ja saiu da conta dele e esta separado. Voce so aceita sabendo que vai receber.'
    },
    {
      arte: '🎓',
      titulo: 'Todo trampo concluido vira certificado',
      corpo: 'Quando o contratante confirma a entrega, o pagamento sai e o certificado com a carga horaria e emitido no mesmo instante. Ele tem codigo publico: a coordenacao do seu curso confere sem precisar de conta.'
    },
    {
      arte: '🤝',
      titulo: 'Se algo der errado, ha para quem recorrer',
      corpo: 'Entregou e o contratante sumiu? Voce abre uma contestacao e o valor fica parado ate alguem da equipe analisar, com prazo. E se ninguem confirmar nem contestar, o pagamento sai sozinho depois de sete dias.'
    }
  ],
  company: [
    {
      arte: '🔒',
      titulo: 'Reservar o valor e o que atrai gente boa',
      corpo: 'Publicar e reservar sao dois passos. Enquanto voce nao reserva, o trampo aparece sem garantia e nao da para escolher ninguem. Com o valor reservado, o estudante ve a garantia e o trampo fica muito mais atraente.'
    },
    {
      arte: '✓',
      titulo: 'Confirmar a entrega paga e certifica de uma vez',
      corpo: 'Um clique faz as duas coisas: libera o valor para o estudante e emite o certificado com a carga horaria. Voce nao precisa fazer mais nada depois.'
    },
    {
      arte: '⏱',
      titulo: 'O prazo corre para os dois lados',
      corpo: 'Voce tem sete dias para confirmar ou contestar uma entrega. Passado o prazo sem resposta, o sistema confirma sozinho. Sua taxa de confirmacao fica visivel no seu perfil, e e o que o estudante olha antes de aceitar.'
    }
  ]
}

function jaViuOGuia (perfil) {
  try {
    return (localStorage.getItem(CHAVE_GUIA) ?? '').split(',').includes(perfil)
  } catch {
    // Sem armazenamento, mostrar o guia toda vez seria pior do que nao mostrar.
    return true
  }
}

function marcarGuiaComoVisto (perfil) {
  try {
    const vistos = new Set((localStorage.getItem(CHAVE_GUIA) ?? '').split(',').filter(Boolean))
    vistos.add(perfil)
    localStorage.setItem(CHAVE_GUIA, [...vistos].join(','))
  } catch { /* sem armazenamento: o guia volta na proxima sessao */ }
}

function mostrarGuia (perfil, { forcado = false } = {}) {
  const passos = GUIAS[perfil]
  if (!passos || (!forcado && jaViuOGuia(perfil))) return

  let atual = 0
  const raiz = document.createElement('div')
  raiz.className = 'guia'
  raiz.setAttribute('role', 'dialog')
  raiz.setAttribute('aria-modal', 'true')
  raiz.setAttribute('aria-label', 'Como o Uni.work funciona')

  const desenhar = () => {
    const passo = passos[atual]
    const ultimo = atual === passos.length - 1
    raiz.innerHTML = `<div class="guia-cartao">
      <div class="guia-arte"><span aria-hidden="true">${passo.arte}</span></div>
      <div class="guia-corpo">
        <h2>${escapar(passo.titulo)}</h2>
        <p>${escapar(passo.corpo)}</p>
      </div>
      <div class="guia-rodape">
        <div class="guia-pontos" role="img" aria-label="Passo ${atual + 1} de ${passos.length}">
          ${passos.map((_, i) => `<span class="guia-ponto ${i === atual ? 'atual' : ''}"></span>`).join('')}
        </div>
        <button class="btn btn-fantasma btn-mini" style="margin-left:auto" data-guia="pular">
          ${ultimo ? '' : 'Pular'}
        </button>
        <button class="btn btn-azul" data-guia="proximo">
          ${ultimo ? 'Entendi, vamos la' : 'Proximo'}
        </button>
      </div>
    </div>`
    raiz.querySelector('[data-guia="proximo"]').focus()
  }

  const fechar = () => {
    marcarGuiaComoVisto(perfil)
    raiz.remove()
    document.removeEventListener('keydown', aoTeclar)
    $('#conteudo')?.focus()
  }

  const aoTeclar = (e) => {
    if (e.key === 'Escape') return fechar()
    if (e.key === 'ArrowRight' && atual < passos.length - 1) { atual += 1; desenhar() }
    if (e.key === 'ArrowLeft' && atual > 0) { atual -= 1; desenhar() }
    prenderFoco(e, raiz)
  }

  raiz.addEventListener('click', (e) => {
    const acao = e.target.closest('[data-guia]')?.dataset.guia
    if (acao === 'pular') return fechar()
    if (acao === 'proximo') {
      if (atual === passos.length - 1) return fechar()
      atual += 1
      desenhar()
    }
  })

  document.addEventListener('keydown', aoTeclar)
  document.body.append(raiz)
  desenhar()
}

/**
 * Mantem o foco dentro do dialogo aberto.
 * Sem isto, quem navega por teclado sai do dialogo para a pagina atras dele e
 * nao encontra o caminho de volta.
 */
function prenderFoco (evento, raiz) {
  if (evento.key !== 'Tab') return
  const focaveis = [...raiz.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter((el) => el.offsetParent !== null)
  if (!focaveis.length) return

  const primeiro = focaveis[0]
  const ultimo = focaveis[focaveis.length - 1]
  if (evento.shiftKey && document.activeElement === primeiro) {
    evento.preventDefault()
    ultimo.focus()
  } else if (!evento.shiftKey && document.activeElement === ultimo) {
    evento.preventDefault()
    primeiro.focus()
  }
}

// ─── modal ───────────────────────────────────────────────────────────────────

function abrirModal ({ titulo, corpo, rodape = '', aoMontar }) {
  const raiz = $('#modal-raiz')
  raiz.innerHTML = `<div class="modal-fundo" role="dialog" aria-modal="true" aria-label="${escapar(titulo)}">
    <div class="modal">
      <div class="modal-topo"><h2>${escapar(titulo)}</h2>
        <button class="fechar" data-fechar aria-label="Fechar">✕</button></div>
      <div class="modal-corpo">${corpo}</div>
      ${rodape ? `<div class="modal-rodape">${rodape}</div>` : ''}
    </div>
  </div>`
  const fundo = $('.modal-fundo', raiz)
  fundo.addEventListener('click', (e) => { if (e.target === fundo) fecharModal() })
  $$('[data-fechar]', raiz).forEach((b) => b.addEventListener('click', fecharModal))
  document.addEventListener('keydown', escFecha)
  aoMontar?.(raiz)
  $('input,textarea,select,button', $('.modal-corpo', raiz))?.focus()
}

function escFecha (e) {
  if (e.key === 'Escape') return fecharModal()
  const fundo = $('.modal-fundo')
  if (fundo) prenderFoco(e, fundo)
}

function fecharModal () {
  $('#modal-raiz').innerHTML = ''
  document.removeEventListener('keydown', escFecha)
}

function modalCriarConta (perfil) {
  const ehEstudante = perfil === 'student'
  abrirModal({
    titulo: ehEstudante ? 'Criar conta de estudante' : 'Criar conta de contratante',
    corpo: `<p style="font-size:13.5px;color:var(--ink-3);margin-bottom:18px;line-height:1.6">
        Nome e e-mail. A conta de recebimento fica pronta junto, sem nenhum passo a mais e sem
        nenhuma extensao para instalar.
      </p>
      <form id="form-criar">
        <div class="campo"><label for="cc-nome">Nome completo</label>
          <input id="cc-nome" required minlength="2" placeholder="${ehEstudante ? 'Marina Alves' : 'Produtora XPTO'}"></div>
        <div class="campo"><label for="cc-email">E-mail</label>
          <input id="cc-email" type="email" required autocomplete="email" placeholder="voce@${ehEstudante ? 'universidade.br' : 'empresa.com.br'}"></div>
        ${ehEstudante ? `<div class="linha-2">
          <div class="campo"><label for="cc-universidade">Universidade</label><input id="cc-universidade" placeholder="USP"></div>
          <div class="campo"><label for="cc-curso">Curso</label><input id="cc-curso" placeholder="Design"></div>
        </div>` : ''}
      </form>`,
    rodape: `<button class="btn btn-fantasma" data-fechar>Cancelar</button>
             <button class="btn btn-azul" id="cc-ok">Criar minha conta</button>`,
    aoMontar (raiz) {
      $('#cc-ok', raiz).addEventListener('click', async () => {
        const form = $('#form-criar', raiz)
        if (!form.reportValidity()) return
        const botao = $('#cc-ok', raiz)
        botao.disabled = true
        botao.textContent = 'Criando…'
        try {
          const out = await chamar('/signup', {
            method: 'POST',
            body: {
              nome: $('#cc-nome', raiz).value.trim(),
              email: $('#cc-email', raiz).value.trim(),
              perfil,
              universidade: ehEstudante ? ($('#cc-universidade', raiz).value.trim() || null) : null,
              curso: ehEstudante ? ($('#cc-curso', raiz).value.trim() || null) : null
            }
          })
          fecharModal()
          guardarSessao(out.usuario, out.sessao)
          avisar('Conta criada', 'Sua conta ja esta pronta para receber.', 'ok')
          await entrarNoApp()
        } catch {
          botao.disabled = false
          botao.textContent = 'Criar minha conta'
        }
      })
    }
  })
}

function modalPublicar () {
  abrirModal({
    titulo: 'Publicar um trampo',
    corpo: `<form id="form-vaga">
      <div class="campo">
        <label>Modalidade</label>
        <div class="escolha" id="escolha-modalidade">
          <button type="button" data-escolher-modalidade="presencial" aria-pressed="true"><strong>Presencial</strong><span>Evento, monitoria, campo</span></button>
          <button type="button" data-escolher-modalidade="remoto" aria-pressed="false"><strong>Remoto</strong><span>Design, codigo, traducao</span></button>
        </div>
      </div>
      <div class="campo"><label for="v-titulo">Titulo</label>
        <input id="v-titulo" required minlength="6" placeholder="Staff de credenciamento no congresso"></div>
      <div class="campo"><label for="v-descricao">Descricao</label>
        <textarea id="v-descricao" required minlength="20" placeholder="Explique o que precisa ser feito, quando e o que voce espera da entrega."></textarea></div>
      <div class="linha-2">
        <div class="campo"><label for="v-categoria">Categoria</label>
          <input id="v-categoria" required placeholder="Eventos" list="categorias">
          <datalist id="categorias">
            <option>Eventos</option><option>Monitoria</option><option>Pesquisa</option>
            <option>Design</option><option>Desenvolvimento</option><option>Traducao</option>
            <option>Conteudo</option><option>Fotografia</option>
          </datalist></div>
        <div class="campo" id="campo-local"><label for="v-local">Local</label>
          <input id="v-local" placeholder="Sao Paulo, SP"></div>
      </div>
      <div class="linha-2">
        <div class="campo"><label for="v-valor">Valor total</label>
          <input id="v-valor" type="number" min="1" step="1" required placeholder="240">
          <span class="dica">Em USDC. Voce reserva esse valor na proxima etapa.</span></div>
        <div class="campo"><label for="v-horas">Carga horaria</label>
          <input id="v-horas" type="number" min="0.5" step="0.5" required placeholder="12">
          <span class="dica">Vai no certificado do estudante.</span></div>
      </div>
    </form>`,
    rodape: `<button class="btn btn-fantasma" data-fechar>Cancelar</button>
             <button class="btn btn-azul" id="salvar-vaga">Publicar</button>`,
    aoMontar (raiz) {
      let modalidade = 'presencial'
      $$('#escolha-modalidade button', raiz).forEach((b) => b.addEventListener('click', () => {
        modalidade = b.dataset.escolherModalidade
        $$('#escolha-modalidade button', raiz).forEach((o) => o.setAttribute('aria-pressed', String(o === b)))
        $('#campo-local', raiz).style.display = modalidade === 'presencial' ? '' : 'none'
      }))

      $('#salvar-vaga', raiz).addEventListener('click', async () => {
        const form = $('#form-vaga', raiz)
        if (!form.reportValidity()) return
        const botao = $('#salvar-vaga', raiz)
        botao.disabled = true
        botao.textContent = 'Publicando…'
        try {
          await chamar('/jobs', {
            method: 'POST',
            body: {
              titulo: $('#v-titulo', raiz).value.trim(),
              descricao: $('#v-descricao', raiz).value.trim(),
              categoria: $('#v-categoria', raiz).value.trim(),
              modalidade,
              local: modalidade === 'presencial' ? ($('#v-local', raiz).value.trim() || null) : null,
              valorCentavos: Math.round(Number($('#v-valor', raiz).value) * 100),
              horas: Number($('#v-horas', raiz).value)
            }
          })
          fecharModal()
          avisar('Trampo publicado', 'Agora reserve o valor para os estudantes verem a garantia.', 'ok')
          estado.view = 'minhas'
          await recarregar()
          render()
        } catch {
          botao.disabled = false
          botao.textContent = 'Publicar'
        }
      })
    }
  })
}

function modalTexto ({ titulo, rotulo, textoBotao, dica = '', aoConfirmar }) {
  abrirModal({
    titulo,
    corpo: `<div class="campo">
      <label for="m-texto">${escapar(rotulo)}</label>
      <textarea id="m-texto" placeholder="${escapar(dica)}"></textarea>
    </div>`,
    rodape: `<button class="btn btn-fantasma" data-fechar>Cancelar</button>
             <button class="btn btn-azul" id="m-ok">${escapar(textoBotao)}</button>`,
    aoMontar (raiz) {
      $('#m-ok', raiz).addEventListener('click', async () => {
        const botao = $('#m-ok', raiz)
        botao.disabled = true
        botao.textContent = 'Enviando…'
        try {
          await aoConfirmar($('#m-texto', raiz).value.trim())
          fecharModal()
        } catch {
          botao.disabled = false
          botao.textContent = textoBotao
        }
      })
    }
  })
}

function modalAvaliar (vagaId) {
  abrirModal({
    titulo: 'Como foi?',
    corpo: `<div class="campo"><label>Nota</label>
        <div class="escolha" id="notas" style="grid-template-columns:repeat(5,1fr)">
          ${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-nota="${n}" aria-pressed="${n === 5}" style="text-align:center"><strong>${n}</strong></button>`).join('')}
        </div></div>
      <div class="campo"><label for="a-comentario">Comentario</label>
        <textarea id="a-comentario" placeholder="Opcional"></textarea></div>`,
    rodape: `<button class="btn btn-fantasma" data-fechar>Cancelar</button>
             <button class="btn btn-azul" id="a-ok">Enviar avaliacao</button>`,
    aoMontar (raiz) {
      let nota = 5
      $$('#notas button', raiz).forEach((b) => b.addEventListener('click', () => {
        nota = Number(b.dataset.nota)
        $$('#notas button', raiz).forEach((o) => o.setAttribute('aria-pressed', String(o === b)))
      }))
      $('#a-ok', raiz).addEventListener('click', async () => {
        try {
          await chamar(`/jobs/${vagaId}/review`, {
            method: 'POST', body: { nota, comentario: $('#a-comentario', raiz).value.trim() || null }
          })
          fecharModal()
          avisar('Avaliacao registrada', '', 'ok')
          await abrirVaga(vagaId)
        } catch { /* o aviso de erro ja apareceu */ }
      })
    }
  })
}

function modalContestar (vaga) {
  const motivos = estado.motivosDeContestacao.length
    ? estado.motivosDeContestacao
    : [{ valor: 'outro', rotulo: 'Outro motivo' }]
  let motivoEscolhido = motivos[0].valor

  abrirModal({
    titulo: 'Abrir contestacao',
    corpo: `<p style="font-size:13.5px;color:var(--ink-3);margin-bottom:18px;line-height:1.6">
        Enquanto a contestacao estiver aberta, os <strong style="color:var(--ink)">${usdc(vaga.valorCentavos)} USDC</strong>
        ficam parados: nem saem para o estudante, nem voltam para o contratante. Uma pessoa da
        equipe analisa e decide, com prazo.
      </p>
      <div class="campo">
        <label for="ct-motivo">Qual e o problema?</label>
        <select id="ct-motivo">
          ${motivos.map((m) => `<option value="${escapar(m.valor)}">${escapar(m.rotulo)}</option>`).join('')}
        </select>
      </div>
      <div class="campo">
        <label for="ct-detalhe">Conte o que aconteceu</label>
        <textarea id="ct-detalhe" placeholder="Datas, o que foi combinado, o que aconteceu de fato."></textarea>
        <span class="dica">Minimo de 20 caracteres. As duas partes leem o que voce escrever.</span>
      </div>`,
    rodape: `<button class="btn btn-fantasma" data-fechar>Voltar</button>
             <button class="btn btn-azul" id="ct-ok">Abrir contestacao</button>`,
    aoMontar (raiz) {
      $('#ct-motivo', raiz).addEventListener('change', (e) => { motivoEscolhido = e.target.value })
      $('#ct-ok', raiz).addEventListener('click', async () => {
        const detalhe = $('#ct-detalhe', raiz).value.trim()
        if (detalhe.length < 20) {
          avisar('Explique um pouco mais', 'Escreva pelo menos 20 caracteres.', 'erro')
          return
        }
        const botao = $('#ct-ok', raiz)
        botao.disabled = true
        botao.textContent = 'Abrindo…'
        try {
          await chamar(`/jobs/${vaga.id}/dispute`, { method: 'POST', body: { motivo: motivoEscolhido, detalhe } })
          fecharModal()
          avisar('Contestacao aberta', 'O valor ficou parado e a equipe vai analisar dentro do prazo.', 'ok')
          await abrirVaga(vaga.id)
        } catch {
          botao.disabled = false
          botao.textContent = 'Abrir contestacao'
        }
      })
    }
  })
}

function modalResolver (contestacao) {
  let resultado = 'split'
  let divisao = 50

  abrirModal({
    titulo: 'Decidir a contestacao',
    corpo: `<p style="font-size:13.5px;color:var(--ink-2);margin-bottom:16px">
        <strong>${escapar(contestacao.vagaTitulo ?? '')}</strong><br>
        ${usdc(contestacao.valorCentavos)} USDC · ${escapar(contestacao.motivoRotulo)}
      </p>
      <div class="painel" style="margin-bottom:18px">
        <h4>O QUE FOI ALEGADO</h4>
        <p style="font-size:13px;color:var(--ink-2);white-space:pre-wrap">${escapar(contestacao.detalhe)}</p>
      </div>
      <div class="campo">
        <label>Decisao</label>
        <div class="escolha" id="r-resultado" style="grid-template-columns:1fr">
          <button type="button" data-resultado="split" aria-pressed="true"><strong>Dividir o valor</strong><span>Houve trabalho parcial</span></button>
          <button type="button" data-resultado="resolved_student" aria-pressed="false"><strong>Tudo para o estudante</strong><span>A entrega procede</span></button>
          <button type="button" data-resultado="resolved_company" aria-pressed="false"><strong>Tudo de volta para o contratante</strong><span>Nao houve entrega</span></button>
        </div>
      </div>
      <div class="campo" id="r-divisao-campo">
        <label for="r-divisao">Quanto vai para o estudante: <span id="r-divisao-valor">50%</span></label>
        <input id="r-divisao" type="range" min="5" max="95" step="5" value="50" style="padding:0">
        <span class="dica" id="r-previa"></span>
      </div>
      <div class="campo">
        <label for="r-resolucao">Explique a decisao</label>
        <textarea id="r-resolucao" placeholder="As duas partes leem isto. Diga no que voce se baseou."></textarea>
      </div>`,
    rodape: `<button class="btn btn-fantasma" data-fechar>Cancelar</button>
             <button class="btn btn-azul" id="r-ok">Confirmar decisao</button>`,
    aoMontar (raiz) {
      const campoDivisao = $('#r-divisao-campo', raiz)
      const previa = $('#r-previa', raiz)

      const atualizarPrevia = () => {
        const total = contestacao.valorCentavos ?? 0
        const bps = resultado === 'resolved_student' ? 10000 : resultado === 'resolved_company' ? 0 : divisao * 100
        const bruto = Math.floor((total * bps) / 10000)
        const taxa = Math.floor((bruto * 500) / 10000)
        previa.textContent = `Estudante recebe ${usdcExato(bruto - taxa)} USDC, contratante recebe ${usdcExato(total - bruto)} USDC.`
      }

      $$('#r-resultado button', raiz).forEach((b) => b.addEventListener('click', () => {
        resultado = b.dataset.resultado
        $$('#r-resultado button', raiz).forEach((o) => o.setAttribute('aria-pressed', String(o === b)))
        campoDivisao.style.display = resultado === 'split' ? '' : 'none'
        atualizarPrevia()
      }))

      $('#r-divisao', raiz).addEventListener('input', (e) => {
        divisao = Number(e.target.value)
        $('#r-divisao-valor', raiz).textContent = `${divisao}%`
        atualizarPrevia()
      })
      atualizarPrevia()

      $('#r-ok', raiz).addEventListener('click', async () => {
        const resolucao = $('#r-resolucao', raiz).value.trim()
        if (resolucao.length < 20) {
          avisar('Explique a decisao', 'Escreva pelo menos 20 caracteres: as duas partes vao ler.', 'erro')
          return
        }
        const botao = $('#r-ok', raiz)
        botao.disabled = true
        botao.textContent = 'Confirmando…'
        try {
          const saida = await chamar(`/disputes/${contestacao.id}/resolve`, {
            method: 'POST',
            body: { resultado, divisaoBps: resultado === 'split' ? divisao * 100 : null, resolucao }
          })
          fecharModal()
          avisar('Contestacao resolvida', saida.pagamentoEmProcessamento
            ? 'A decisao foi registrada e o valor esta sendo movimentado.'
            : 'A decisao foi registrada e o valor ja foi movimentado.', 'ok')
          await carregarContestacoes()
          render()
        } catch {
          botao.disabled = false
          botao.textContent = 'Confirmar decisao'
        }
      })
    }
  })
}

function modalEditarPerfil () {
  const p = estado.perfilAberto
  abrirModal({
    titulo: 'Editar perfil',
    corpo: `<div class="campo"><label for="pf-headline">Uma linha sobre voce</label>
        <input id="pf-headline" maxlength="140" value="${escapar(p.headline ?? '')}" placeholder="Design de produto e pesquisa com usuario"></div>
      <div class="campo"><label for="pf-bio">Sobre</label>
        <textarea id="pf-bio" maxlength="600" placeholder="O que voce faz, o que ja fez, o que procura.">${escapar(p.bio ?? '')}</textarea></div>
      ${p.perfil === 'student' ? `<div class="linha-2">
        <div class="campo"><label for="pf-universidade">Universidade</label><input id="pf-universidade" value="${escapar(p.universidade ?? '')}"></div>
        <div class="campo"><label for="pf-curso">Curso</label><input id="pf-curso" value="${escapar(p.curso ?? '')}"></div>
      </div>
      <div class="campo"><label for="pf-habilidades">Habilidades</label>
        <input id="pf-habilidades" value="${escapar((p.habilidades ?? []).join(', '))}" placeholder="Figma, Pesquisa, Prototipagem">
        <span class="dica">Separadas por virgula.</span></div>` : ''}
      <div class="campo"><label for="pf-link">Link principal</label>
        <input id="pf-link" value="${escapar(p.links?.[0]?.url ?? '')}" placeholder="https://seu-site.com.br">
        <span class="dica">Endereco completo, comecando com https://</span></div>`,
    rodape: `<button class="btn btn-fantasma" data-fechar>Cancelar</button>
             <button class="btn btn-linha" data-enviar="avatar">Trocar foto</button>
             <button class="btn btn-azul" id="pf-ok">Salvar</button>`,
    aoMontar (raiz) {
      $('#pf-ok', raiz).addEventListener('click', async () => {
        const link = $('#pf-link', raiz).value.trim()
        const corpo = {
          headline: $('#pf-headline', raiz).value.trim() || null,
          bio: $('#pf-bio', raiz).value.trim() || null,
          links: link ? [{ rotulo: 'Site', url: link }] : []
        }
        if (p.perfil === 'student') {
          corpo.universidade = $('#pf-universidade', raiz).value.trim() || null
          corpo.curso = $('#pf-curso', raiz).value.trim() || null
          corpo.habilidades = $('#pf-habilidades', raiz).value.split(',').map((h) => h.trim()).filter(Boolean)
        }
        const botao = $('#pf-ok', raiz)
        botao.disabled = true
        botao.textContent = 'Salvando…'
        try {
          await chamar('/me/perfil', { method: 'PUT', body: corpo })
          fecharModal()
          avisar('Perfil atualizado', '', 'ok')
          await abrirPerfil(p.id)
        } catch {
          botao.disabled = false
          botao.textContent = 'Salvar'
        }
      })
    }
  })
}

// ─── envio de arquivo ────────────────────────────────────────────────────────

/**
 * Envio em dois passos: pede permissao, e so entao manda os bytes. O servidor
 * decide o limite antes de o arquivo comecar a subir, e diz por que recusou.
 */
async function enviarArquivo (tipo, vagaId = null) {
  const seletor = document.createElement('input')
  seletor.type = 'file'
  seletor.accept = tipo === 'avatar' || tipo === 'portfolio'
    ? 'image/*,application/pdf'
    : 'image/*,application/pdf,video/mp4,.zip'

  seletor.addEventListener('change', async () => {
    const arquivo = seletor.files?.[0]
    if (!arquivo) return
    try {
      const permissao = await chamar('/uploads', { method: 'POST', body: { tipo, vagaId } })
      const resposta = await fetch(`/api/uploads/${permissao.bilhete}`, {
        method: 'PUT',
        headers: {
          'content-type': arquivo.type || 'application/octet-stream',
          'x-nome-do-arquivo': arquivo.name
        },
        body: arquivo
      })
      const dados = await resposta.json().catch(() => ({}))
      if (!resposta.ok) return avisar(dados.error ?? 'Nao conseguimos enviar o arquivo', '', 'erro')
      avisar('Arquivo enviado', arquivo.name, 'ok')
      if (estado.view === 'perfil') await abrirPerfil(estado.perfilAberto.id)
      else if (estado.vagaAberta) await abrirVaga(estado.vagaAberta.id)
    } catch {
      avisar('Nao conseguimos enviar o arquivo', 'Tente de novo em instantes.', 'erro')
    }
  })
  seletor.click()
}

// ─── camada tecnica ──────────────────────────────────────────────────────────
/* camada-tecnica:inicio
   Tudo daqui ate o marcador de fim alimenta a gaveta do rodape. E o unico lugar
   do produto que fala a lingua da rede, e existe para demonstracao. */

async function carregarCamadaTecnica () {
  try {
    const dados = await chamar('/chain/status', { silencioso: true })
    estado.registros = dados.transacoes ?? []
    const resumo = $('#gaveta-resumo')
    if (resumo) resumo.textContent = `${dados.cluster} · escrow ${dados.escrow.driver} · ${estado.registros.length} transacoes`
    renderCamadaTecnica(dados)
  } catch {
    const alvo = $('#gaveta-conteudo')
    if (alvo) alvo.innerHTML = '<div class="gaveta-vazia">Status da rede indisponivel.</div>'
  }
}

function renderCamadaTecnica (dados) {
  const alvo = $('#gaveta-conteudo')
  if (!alvo) return
  const cabecalho = `<div class="gaveta-linha" style="border-top:0">
    <span class="gaveta-tipo">ambiente</span>
    <span class="gaveta-dado">
      cluster <b>${escapar(dados.cluster)}</b> · rpc <b>${escapar(dados.rpc)}</b><br>
      rede alcancavel <b>${dados.rede.alcancavel ? 'sim' : 'nao'}</b>${dados.rede.versao ? ` · solana-core <b>${escapar(dados.rede.versao)}</b>` : ''}<br>
      escrow driver <b>${escapar(dados.escrow.driver)}</b>${dados.escrow.programId ? ` · program id <b>${escapar(dados.escrow.programId)}</b>` : ''}<br>
      certificado driver <b>${escapar(dados.certificado.driver)}</b> · indexador DAS <b>${dados.indexador.configurado ? 'configurado' : 'ausente'}</b><br>
      mint de pagamento <b>${escapar(dados.plataforma.paymentMint ?? 'nao criado')}</b><br>
      merkle tree <b>${escapar(dados.plataforma.merkleTree ?? 'nao criada')}</b>
    </span>
    <span></span>
  </div>`

  const linhas = estado.registros.map((t) => `<div class="gaveta-linha">
    <span class="gaveta-tipo">${escapar(t.tipo)}</span>
    <span class="gaveta-dado">
      assinatura <b>${escapar(t.assinatura ?? 'sem assinatura')}</b><br>
      status <b>${escapar(t.status)}</b> · vaga <b>${escapar(t.vagaId ?? '-')}</b> · ${quando(t.quando)}
      ${t.erro ? `<br>erro <b>${escapar(t.erro)}</b>` : ''}
    </span>
    ${t.link ? `<a class="gaveta-link" href="${escapar(t.link)}" target="_blank" rel="noopener">explorer ↗</a>` : '<span></span>'}
  </div>`).join('')

  alvo.innerHTML = cabecalho + (linhas || '<div class="gaveta-vazia">Nenhuma transacao registrada ainda.</div>')
}

/* camada-tecnica:fim */

// ─── acoes ───────────────────────────────────────────────────────────────────

async function executarAcao (acao, vaga) {
  const rotulos = {
    reservar: ['Reservando…', 'Valor reservado', 'O dinheiro saiu da sua conta e esta separado para este trampo.'],
    confirmar: ['Confirmando…', 'Tudo certo', 'O pagamento foi liberado e o certificado foi emitido.'],
    comecar: ['Iniciando…', 'Bom trabalho', 'O trampo esta em andamento.']
  }

  if (acao === 'entregar') {
    return modalTexto({
      titulo: 'Enviar entrega',
      rotulo: 'Quer deixar alguma observacao?',
      dica: 'Onde esta o material, o que foi feito, o que ficou pendente.',
      textoBotao: 'Enviar entrega',
      aoConfirmar: async (texto) => {
        await chamar(`/jobs/${vaga.id}/deliver`, { method: 'POST', body: { observacao: texto || null } })
        avisar('Entrega enviada', 'O contratante foi avisado e vai confirmar.', 'ok')
        await abrirVaga(vaga.id)
      }
    })
  }

  if (acao === 'candidatar') {
    return modalTexto({
      titulo: 'Quero esse trampo',
      rotulo: 'Conte por que voce e boa escolha',
      dica: 'Experiencia parecida, disponibilidade, o que te faz encaixar.',
      textoBotao: 'Enviar candidatura',
      aoConfirmar: async (texto) => {
        await chamar(`/jobs/${vaga.id}/apply`, { method: 'POST', body: { apresentacao: texto || null } })
        avisar('Candidatura enviada', 'O contratante recebeu e vai avaliar.', 'ok')
        await abrirVaga(vaga.id)
      }
    })
  }

  if (acao === 'avaliar') return modalAvaliar(vaga.id)
  if (acao === 'contestar') return modalContestar(vaga)

  if (acao === 'cancelar') {
    return modalTexto({
      titulo: 'Cancelar o trampo',
      rotulo: 'Motivo (fica registrado)',
      dica: 'Ajuda o outro lado a entender.',
      textoBotao: 'Cancelar trampo',
      aoConfirmar: async (texto) => {
        await chamar(`/jobs/${vaga.id}/cancel`, { method: 'POST', body: { motivo: texto || null } })
        avisar('Trampo cancelado', 'O valor reservado voltou para a sua conta.', 'ok')
        await abrirVaga(vaga.id)
      }
    })
  }

  const rotas = { reservar: 'fund', confirmar: 'confirm', comecar: 'start' }
  const [carregando, ok, detalhe] = rotulos[acao] ?? ['Enviando…', 'Pronto', '']
  const botao = $(`[data-acao-vaga="${acao}"]`)
  if (botao) { botao.disabled = true; botao.textContent = carregando }

  try {
    const resposta = await chamar(`/jobs/${vaga.id}/${rotas[acao]}`, { method: 'POST' })
    avisar(ok, detalhe, 'ok')
    if (acao === 'confirmar') {
      if (resposta.certificado) {
        avisar('Certificado emitido', `${resposta.certificado.horas}h · codigo ${resposta.certificado.codigo}`, 'ok')
      } else if (resposta.pagamento?.emProcessamento) {
        avisar('Estamos concluindo', resposta.pagamento.mensagem, 'info')
      }
    }
    await abrirVaga(vaga.id)
    await recarregar()
  } catch {
    await abrirVaga(vaga.id)
  }
}

// ─── conversa ────────────────────────────────────────────────────────────────

async function carregarConversa (vagaId) {
  const alvo = $('#conversa')
  if (!alvo) return
  try {
    const { mensagens } = await chamar(`/jobs/${vagaId}/messages`, { silencioso: true })
    alvo.innerHTML = mensagens.length
      ? mensagens.map((m) => `<div class="balao ${m.meu ? 'meu' : 'deles'}">
          ${m.meu ? '' : `<div class="balao-autor">${escapar(m.autor.nome)}</div>`}
          ${escapar(m.texto)}
        </div>`).join('')
      : '<p style="color:var(--ink-3);font-size:13px">Nenhuma mensagem ainda. Diga oi.</p>'
    alvo.scrollTop = alvo.scrollHeight
  } catch {
    alvo.innerHTML = '<p style="color:var(--ink-3);font-size:13px">Nao conseguimos carregar a conversa agora.</p>'
  }
}

/** Atualizacao otimista: a mensagem aparece antes da resposta e volta atras se falhar. */
async function enviarMensagem (vagaId, texto) {
  const alvo = $('#conversa')
  const provisorio = document.createElement('div')
  provisorio.className = 'balao meu pendente'
  provisorio.textContent = texto
  alvo?.append(provisorio)
  if (alvo) alvo.scrollTop = alvo.scrollHeight

  try {
    await chamar(`/jobs/${vagaId}/messages`, { method: 'POST', body: { texto } })
    await carregarConversa(vagaId)
  } catch {
    provisorio.remove()
    avisar('Mensagem nao enviada', 'Tente de novo em um instante.', 'erro')
  }
}

// ─── carregamento ────────────────────────────────────────────────────────────

/** Pergunta ao banco, e nao ao navegador: filtrar no cliente exigiria baixar tudo. */
async function buscar ({ mais = false } = {}) {
  estado.buscando = true
  if (!mais) { estado.proximoCursor = null; estado.temMais = false }

  const p = new URLSearchParams()
  const f = estado.filtros
  if (f.busca.trim()) p.set('termo', f.busca.trim())
  if (f.modalidade) p.set('modalidade', f.modalidade)
  if (f.categoria) p.set('categoria', f.categoria)
  if (f.garantidas) p.set('garantidas', '1')
  if (f.ordem) p.set('ordem', f.ordem)
  if (mais && estado.proximoCursor) p.set('cursor', estado.proximoCursor)

  try {
    const saida = await chamar(`/jobs/search?${p}`, { silencioso: true })
    estado.vagas = mais ? [...estado.vagas, ...saida.vagas] : saida.vagas
    estado.proximoCursor = saida.proximoCursor
    estado.temMais = saida.temMais
    estado.ordemAtual = saida.ordem
    estado.ordensDisponiveis = saida.ordensDisponiveis ?? []
  } catch {
    if (!mais) estado.vagas = []
  } finally {
    estado.buscando = false
  }
}

/** O que qualquer pessoa ve, com ou sem sessao. */
async function recarregarPublico () {
  const [, metricas, facetas, personas] = await Promise.all([
    buscar(),
    chamar('/metrics', { silencioso: true }).catch(() => estado.metricas),
    chamar('/jobs/facetas', { silencioso: true }).catch(() => estado.facetas),
    estado.personas ? Promise.resolve(estado.personas) : chamar('/demo/contas', { silencioso: true }).catch(() => null)
  ])
  estado.metricas = metricas ?? estado.metricas
  estado.facetas = facetas ?? estado.facetas
  if (personas) estado.personas = personas
}

async function carregarMinhasVagas ({ mais = false } = {}) {
  if (!estado.usuario) return
  const p = new URLSearchParams()
  if (mais && estado.cursorMinhas) p.set('cursor', estado.cursorMinhas)
  const saida = await chamar(`/jobs/minhas?${p}`, { silencioso: true }).catch(() => null)
  if (!saida) return
  estado.minhasVagas = mais ? [...estado.minhasVagas, ...saida.vagas] : saida.vagas
  estado.cursorMinhas = saida.proximoCursor
  estado.temMaisMinhas = saida.temMais
}

async function carregarNotificacoes () {
  if (!estado.usuario) return
  const dados = await chamar('/notifications', { silencioso: true }).catch(() => null)
  if (dados) {
    estado.notificacoes = dados.notificacoes
    estado.naoLidas = dados.naoLidas
  }
  if (!estado.preferencias) {
    const prefs = await chamar('/me/notification-preferences', { silencioso: true }).catch(() => null)
    if (prefs) {
      estado.preferencias = prefs.preferencias
      estado.pushDisponivel = Boolean(prefs.disponivel?.push)
    }
  }
}

async function carregarContestacoes () {
  if (!estado.usuario?.mediador) return
  const fila = await chamar('/disputes', { silencioso: true }).catch(() => null)
  if (fila) estado.contestacoes = fila.contestacoes
}

async function recarregar () {
  await recarregarPublico()
  if (!estado.usuario) return

  const [resumo, certs] = await Promise.all([
    chamar('/me/dashboard', { silencioso: true }).catch(() => null),
    estado.usuario.perfil === 'student'
      ? chamar('/me/certificates', { silencioso: true }).catch(() => null)
      : Promise.resolve(null)
  ])
  if (resumo) estado.resumo = resumo
  if (certs) {
    estado.certificados = certs.certificados
    estado.horasTotais = certs.horasTotais
  }

  await carregarMinhasVagas()
  await carregarNotificacoes()
  await carregarContestacoes()

  // Os motivos alimentam o formulario de contestacao das duas partes.
  if (!estado.motivosDeContestacao.length) {
    const motivos = await chamar('/disputes/motivos', { silencioso: true }).catch(() => null)
    if (motivos) estado.motivosDeContestacao = motivos.motivos
  }
}

/**
 * Ligar o aviso no navegador precisa de tres coisas, nesta ordem: a permissao
 * do navegador, o service worker registrado e a inscricao guardada no servidor.
 * Se qualquer uma falhar, a preferencia nao e ligada: dizer que esta ligado sem
 * conseguir entregar seria mentir para a pessoa.
 */
async function ligarPushDoNavegador () {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    avisar('Este navegador nao suporta avisos', 'Voce continua recebendo dentro do aplicativo.', 'info')
    return false
  }
  const permissao = await Notification.requestPermission()
  if (permissao !== 'granted') {
    avisar('Permissao negada', 'Voce pode mudar isso nas configuracoes do navegador.', 'info')
    return false
  }
  try {
    const { chave } = await chamar('/push/key')
    const registro = await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready
    const inscricao = await registro.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: chaveParaBytes(chave)
    })
    await chamar('/push/subscribe', { method: 'POST', body: { inscricao: inscricao.toJSON() } })
    return true
  } catch {
    avisar('Nao conseguimos ligar os avisos', 'Tente de novo em instantes.', 'erro')
    return false
  }
}

/** A chave VAPID vem em base64url e o navegador exige bytes. */
function chaveParaBytes (base64url) {
  const preenchimento = '='.repeat((4 - (base64url.length % 4)) % 4)
  const base64 = (base64url + preenchimento).replace(/-/g, '+').replace(/_/g, '/')
  const cru = atob(base64)
  return Uint8Array.from([...cru].map((c) => c.charCodeAt(0)))
}

async function abrirVaga (id) {
  try {
    const { vaga } = await chamar(`/jobs/${id}`)
    estado.vagaAberta = vaga
    estado.view = 'detalhe'
    render()
    $('#conteudo').focus()
  } catch { /* o aviso de erro ja apareceu */ }
}

async function abrirPerfil (id) {
  try {
    const { perfil } = await chamar(`/perfis/${id}`)
    estado.perfilAberto = perfil
    estado.view = 'perfil'
    render()
    $('#conteudo').focus()
  } catch { /* o aviso de erro ja apareceu */ }
}

async function entrarComEmail (email) {
  try {
    const out = await chamar('/login', { method: 'POST', body: { email } })
    guardarSessao(out.usuario, out.sessao)
    await entrarNoApp()
  } catch { /* o aviso de erro ja apareceu */ }
}

async function entrarNoApp () {
  estado.view = 'feed'
  await recarregar()
  render()
  ligarEventos()
  carregarCamadaTecnica()
  // Depois do primeiro render, para o guia nao aparecer sobre uma tela vazia.
  if (estado.usuario?.perfil) mostrarGuia(estado.usuario.perfil)
}

// ─── eventos ao vivo ─────────────────────────────────────────────────────────

let fonteEventos = null

function desligarEventos () {
  fonteEventos?.close()
  fonteEventos = null
  estado.feed = []
}

function ligarEventos () {
  if (estado.modo === 'simulacao' || fonteEventos) return
  fonteEventos = new EventSource('/api/stream')
  fonteEventos.addEventListener('error', () => { /* o navegador reconecta sozinho */ })

  ;['vaga.publicada', 'vaga.garantida', 'vaga.candidatura', 'vaga.aceita', 'vaga.iniciada',
    'vaga.entregue', 'vaga.concluida', 'vaga.cancelada', 'certificado.emitido',
    'certificado.pendente', 'conta.criada', 'avaliacao.registrada',
    'disputa.aberta', 'disputa.resolvida', 'vaga.auto_confirmada'].forEach((tipo) => {
    fonteEventos.addEventListener(tipo, (e) => {
      const evento = JSON.parse(e.data)
      estado.feed.unshift(evento)
      estado.feed = estado.feed.slice(0, 30)
      renderDir()

      if (tipo.startsWith('disputa.')) carregarContestacoes().then(render).catch(() => {})
      if (['vaga.publicada', 'vaga.garantida', 'vaga.concluida', 'vaga.cancelada'].includes(tipo)) {
        recarregar().then(render).catch(() => {})
        carregarCamadaTecnica()
      }
      carregarNotificacoes().then(renderNav).catch(() => {})
    })
  })
}

// ─── verificacao publica ─────────────────────────────────────────────────────

async function telaVerificacao (codigo) {
  $('#app').classList.remove('ativo')
  // A pagina de verificacao e para quem conferiu um comprovante e nao usa o
  // produto: a gaveta tecnica nao tem o que fazer aqui.
  $('#gaveta').hidden = true
  const alvo = $('#verificacao')
  alvo.hidden = false
  alvo.innerHTML = '<div class="verificacao"><p style="color:var(--ink-3)">Conferindo…</p></div>'

  let dados
  try {
    const resposta = await fetch(`/api/verify/${encodeURIComponent(codigo)}`)
    if (!resposta.ok) throw new Error('nao encontrado')
    dados = await resposta.json()
  } catch {
    alvo.innerHTML = `<div class="verificacao">
      <a class="marca" href="/" aria-label="Uni.work, ir para o inicio" style="margin-bottom:30px">
        <span class="marca-imagem"></span>
      </a>
      ${vazio('❓', 'Certificado nao encontrado',
        `Nao existe certificado com o codigo ${codigo}. Confira se o codigo foi copiado inteiro.`,
        '<a class="btn btn-linha" href="/">Voltar ao inicio</a>')}
    </div>`
    return
  }

  const c = dados.certificado
  const conf = dados.confirmacaoIndependente
  const selo = dados.valido
    ? (conf.confirmado ? ['valido', '✓', 'Certificado autentico e confirmado'] : ['parcial', '✓', 'Certificado autentico'])
    : ['invalido', '✕', 'Este certificado nao confere']

  alvo.innerHTML = `<div class="verificacao">
    <a class="marca" href="/" aria-label="Uni.work, ir para o inicio" style="margin-bottom:30px">
      <span class="marca-imagem"></span>
    </a>
    <div class="selo ${selo[0]}"><span aria-hidden="true">${selo[1]}</span> ${selo[2]}</div>
    <h1 style="font-size:32px;margin-bottom:8px">${escapar(c.estudante)}</h1>
    <p style="font-size:16px;color:var(--ink-2);margin-bottom:26px;line-height:1.6">
      concluiu <strong style="color:var(--ink)">${escapar(c.atividade)}</strong> para ${escapar(c.contratante)},
      totalizando <strong style="color:var(--ink)">${c.horas} horas</strong> de atividade complementar.
    </p>

    <img src="/api/certificates/${encodeURIComponent(c.codigo)}/image.svg" alt="Certificado de ${escapar(c.atividade)}"
         style="width:100%;border-radius:var(--r-lg);border:1px solid var(--line);margin-bottom:24px">

    <div class="grade">
      <div class="painel">
        <h4>O QUE FOI CONFERIDO</h4>
        <dl class="dados">
          <div class="linha-dado"><dt>Conteudo integro</dt><dd style="color:${dados.integridade.confere ? 'var(--verde)' : '#f87171'};font-family:var(--sans)">${dados.integridade.confere ? 'sim' : 'nao'}</dd></div>
          <div class="linha-dado"><dt>Registro publico</dt><dd style="color:${conf.confirmado ? 'var(--verde)' : 'var(--laranja)'};font-family:var(--sans)">${conf.confirmado ? 'confirmado' : 'aguardando'}</dd></div>
          <div class="linha-dado"><dt>Emitido em</dt><dd>${dataBR(c.emitidoEm)}</dd></div>
          <div class="linha-dado"><dt>Codigo</dt><dd>${escapar(c.codigo)}</dd></div>
        </dl>
        <p style="font-size:12.5px;color:var(--ink-3);margin-top:12px;line-height:1.6">
          ${conf.confirmado
            ? 'A confirmacao veio de um servico independente, nao do banco de dados da Uni.work.'
            : conf.motivo === 'indexador_nao_configurado'
              ? 'A confirmacao independente nao esta configurada neste ambiente. A integridade do conteudo foi conferida localmente.'
              : 'O registro publico ainda esta sendo processado. A integridade do conteudo ja confere.'}
        </p>
      </div>
      <div class="painel">
        <h4>DETALHES DA ATIVIDADE</h4>
        <dl class="dados">
          <div class="linha-dado"><dt>Categoria</dt><dd style="font-family:var(--sans)">${escapar(c.categoria)}</dd></div>
          <div class="linha-dado"><dt>Modalidade</dt><dd style="font-family:var(--sans)">${escapar(c.modalidade)}</dd></div>
          <div class="linha-dado"><dt>Carga horaria</dt><dd>${c.horas}h</dd></div>
          <div class="linha-dado"><dt>Contratante</dt><dd style="font-family:var(--sans)">${escapar(c.contratante)}</dd></div>
        </dl>
      </div>
    </div>

    <p style="margin-top:28px;font-size:13px;color:var(--ink-3)">
      Ambiente de demonstracao. Este certificado comprova uma atividade registrada na Uni.work.
    </p>
  </div>`
}

// ─── ligacao de eventos da interface ─────────────────────────────────────────

function ligarInterface () {
  let debounceBusca
  let debounceFiltro

  $('#busca').addEventListener('input', (e) => {
    clearTimeout(debounceBusca)
    const valor = e.target.value
    debounceBusca = setTimeout(async () => {
      estado.filtros.busca = valor
      // Buscar por relevancia so faz sentido com termo; ao limpar a busca, a
      // ordenacao volta ao padrao em vez de ficar numa opcao inexistente.
      if (!valor.trim() && estado.filtros.ordem === 'relevancia') estado.filtros.ordem = null
      if (estado.view !== 'feed') estado.view = 'feed'
      await buscar()
      render()
    }, 220)
  })

  // A barra "/" leva o foco para a busca, como em qualquer ferramenta de uso diario.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return
    if ($('.modal-fundo') || $('.guia')) return
    e.preventDefault()
    $('#busca').focus()
  })

  document.addEventListener('change', async (e) => {
    if (e.target.id === 'ordenar') {
      estado.filtros.ordem = e.target.value
      await buscar()
      render()
    }
  })

  document.addEventListener('input', (e) => {
    if (e.target.id === 'filtro-palavra') {
      clearTimeout(debounceFiltro)
      const valor = e.target.value
      debounceFiltro = setTimeout(async () => {
        estado.filtros.busca = valor
        await buscar()
        render()
        const campo = $('#filtro-palavra')
        if (campo) { campo.focus(); campo.setSelectionRange(valor.length, valor.length) }
      }, 280)
    }
    if (e.target.id === 'codigo') estado.codigoDigitado = e.target.value
  })

  document.addEventListener('submit', (e) => {
    if (e.target.id === 'form-mensagem') {
      e.preventDefault()
      const campo = $('#mensagem-texto')
      const texto = campo.value.trim()
      if (!texto) return
      campo.value = ''
      enviarMensagem(estado.vagaAberta.id, texto)
    }
    if (e.target.id === 'form-entrar') {
      e.preventDefault()
      const email = $('#entrar-email').value.trim()
      if (email) entrarComEmail(email)
    }
    if (e.target.id === 'form-codigo') {
      e.preventDefault()
      const codigo = $('#codigo').value.trim().toUpperCase()
      if (codigo) window.location.href = `/verificar/${encodeURIComponent(codigo)}`
    }
  })

  // Delegacao: um ouvinte para toda a aplicacao.
  document.addEventListener('click', (e) => {
    const alvo = (sel) => e.target.closest(sel)

    const entrar = alvo('[data-entrar]')
    if (entrar) return void entrarComEmail(entrar.dataset.entrar)

    const criar = alvo('[data-criar]')
    if (criar) return void modalCriarConta(criar.dataset.criar)

    const nav = alvo('[data-view]')
    if (nav) {
      estado.view = nav.dataset.view
      render()
      $('#conteudo').focus()
      return
    }

    const perfil = alvo('[data-perfil]')
    if (perfil?.dataset.perfil) return void abrirPerfil(perfil.dataset.perfil)

    const enviar = alvo('[data-enviar]')
    if (enviar) return void enviarArquivo(enviar.dataset.enviar, estado.vagaAberta?.id ?? null)

    const apagarAnexo = alvo('[data-apagar-anexo]')
    if (apagarAnexo) {
      apagarAnexo.disabled = true
      chamar(`/uploads/${apagarAnexo.dataset.apagarAnexo}`, { method: 'DELETE' })
        .then(() => {
          avisar('Arquivo apagado', '', 'ok')
          if (estado.view === 'perfil') return abrirPerfil(estado.perfilAberto.id)
          if (estado.vagaAberta) return abrirVaga(estado.vagaAberta.id)
        })
        .catch(() => { apagarAnexo.disabled = false })
      return
    }

    const cartao = alvo('[data-vaga]')
    if (cartao) return void abrirVaga(cartao.dataset.vaga)

    const cert = alvo('[data-certificado]')
    if (cert) { window.location.href = `/verificar/${encodeURIComponent(cert.dataset.certificado)}`; return }

    const modalidade = alvo('[data-modalidade]')
    if (modalidade) {
      estado.filtros.modalidade = modalidade.dataset.modalidade || null
      buscar().then(render)
      return
    }

    const categoria = alvo('[data-categoria]')
    if (categoria) {
      estado.filtros.categoria = categoria.dataset.categoria || null
      buscar().then(render)
      return
    }

    if (alvo('[data-garantidas]')) {
      estado.filtros.garantidas = !estado.filtros.garantidas
      buscar().then(render)
      return
    }

    const notificacao = alvo('[data-notificacao]')
    if (notificacao) {
      const id = notificacao.dataset.notificacao
      const link = notificacao.dataset.link
      const item = estado.notificacoes.find((n) => n.id === id)
      if (item && !item.lida) {
        // Otimista: marca como lida na tela antes da resposta.
        item.lida = true
        estado.naoLidas = Math.max(0, estado.naoLidas - 1)
        render()
        chamar('/notifications/read', { method: 'POST', body: { ids: [id] }, silencioso: true })
          .catch(() => { item.lida = false; estado.naoLidas += 1; render() })
      }
      if (link?.startsWith('/vaga/')) abrirVaga(link.slice(6))
      else if (link) window.location.href = link
      return
    }

    const pref = alvo('[data-pref]')
    if (pref && !pref.disabled) {
      const campo = pref.dataset.pref
      const ligando = !estado.preferencias?.[campo]
      ;(async () => {
        if (campo === 'push' && ligando && !(await ligarPushDoNavegador())) return
        const saida = await chamar('/me/notification-preferences', {
          method: 'PUT', body: { [campo]: ligando }
        }).catch(() => null)
        if (saida) { estado.preferencias = saida.preferencias; render() }
      })()
      return
    }

    const digest = alvo('[data-digest]')
    if (digest) {
      chamar('/me/notification-preferences', { method: 'PUT', body: { digest: digest.dataset.digest } })
        .then((saida) => { estado.preferencias = saida.preferencias; render() })
        .catch(() => {})
      return
    }

    const assumir = alvo('[data-assumir]')
    if (assumir) {
      assumir.disabled = true
      chamar(`/disputes/${assumir.dataset.assumir}/assumir`, { method: 'POST' })
        .then(async () => {
          avisar('Analise assumida', 'A contestacao aparece como em analise para as duas partes.', 'ok')
          await carregarContestacoes()
          render()
        })
        .catch(() => { assumir.disabled = false })
      return
    }

    const resolver = alvo('[data-resolver]')
    if (resolver) {
      const contestacao = estado.contestacoes.find((c) => c.id === resolver.dataset.resolver)
      if (contestacao) modalResolver(contestacao)
      return
    }

    const aceitar = alvo('[data-aceitar]')
    if (aceitar) {
      aceitar.disabled = true
      chamar(`/jobs/applications/${aceitar.dataset.aceitar}/accept`, { method: 'POST' })
        .then(() => {
          avisar('Estudante escolhido', 'Agora e so acompanhar a entrega.', 'ok')
          return abrirVaga(estado.vagaAberta.id)
        })
        .catch(() => { aceitar.disabled = false })
      return
    }

    const acaoVaga = alvo('[data-acao-vaga]')
    if (acaoVaga && estado.vagaAberta) return void executarAcao(acaoVaga.dataset.acaoVaga, estado.vagaAberta)

    if (alvo('#btn-sair')) return void sair()

    if (alvo('#ir-inicio')) {
      e.preventDefault()
      estado.view = estado.usuario ? 'feed' : 'entrar'
      render()
      return
    }

    if (alvo('#cta-botao')) {
      if (!estado.usuario) modalCriarConta('student')
      else if (estado.usuario.perfil === 'company') modalPublicar()
      else { estado.view = 'feed'; render() }
      return
    }

    const acao = alvo('[data-acao]')
    if (acao) {
      const nome = acao.dataset.acao
      if (nome === 'publicar') modalPublicar()
      if (nome === 'criar-conta') modalCriarConta('student')
      if (nome === 'voltar') { estado.view = estado.usuario ? 'feed' : 'entrar'; render() }
      if (nome === 'meu-perfil') abrirPerfil(estado.usuario.id)
      if (nome === 'editar-perfil') modalEditarPerfil()
      if (nome === 'rever-guia') mostrarGuia(estado.usuario.perfil, { forcado: true })
      if (nome === 'abrir-gaveta') {
        $('#gaveta').classList.add('aberta')
        $('#gaveta-puxador').setAttribute('aria-expanded', 'true')
        carregarCamadaTecnica()
      }
      if (nome === 'marcar-lidas') {
        chamar('/notifications/read', { method: 'POST', body: {} })
          .then(() => carregarNotificacoes()).then(render).catch(() => {})
      }
      if (nome === 'mais-vagas') { render(); buscar({ mais: true }).then(render) }
      if (nome === 'mais-minhas') carregarMinhasVagas({ mais: true }).then(render)
      if (nome === 'limpar-filtros') {
        estado.filtros = { busca: '', modalidade: null, categoria: null, garantidas: false, ordem: null }
        $('#busca').value = ''
        buscar().then(render)
      }
    }
  })

  const puxador = $('#gaveta-puxador')
  puxador.addEventListener('click', () => {
    const aberta = $('#gaveta').classList.toggle('aberta')
    puxador.setAttribute('aria-expanded', String(aberta))
    if (aberta) carregarCamadaTecnica()
  })

  window.addEventListener('online', () => marcarOffline(false))
  window.addEventListener('offline', () => marcarOffline(true))
}

// ─── inicio ──────────────────────────────────────────────────────────────────

async function iniciar () {
  ligarInterface()

  const rotaVerificacao = window.location.pathname.match(/^\/verificar\/(.+)$/)
  if (rotaVerificacao) return telaVerificacao(decodeURIComponent(rotaVerificacao[1]))

  const rotaPerfil = window.location.pathname.match(/^\/perfil\/(.+)$/)
  if (rotaPerfil) estado.perfilPendente = decodeURIComponent(rotaPerfil[1])

  // Decide o modo: se a API nao responde, a interface segue em simulacao.
  try {
    const resposta = await fetch('/api/health')
    if (!resposta.ok) throw new Error('sem saude')
  } catch {
    estado.modo = 'simulacao'
    marcarOffline(true)
    $('#faixa-offline').innerHTML =
      '<span aria-hidden="true">⚠</span><span>Modo de demonstracao: o servico nao respondeu, entao a tela esta com dados de exemplo. Nenhuma operacao real acontece agora.</span>'
  }

  $('#app').classList.add('ativo')

  const guardada = lerSessao()
  if (guardada?.token) {
    estado.token = guardada.token
    estado.usuario = guardada.usuario
    try {
      const { usuario } = await chamar('/me', { silencioso: true })
      estado.usuario = usuario
      estado.view = 'feed'
      await recarregar()
      render()
      ligarEventos()
      carregarCamadaTecnica()
      if (estado.perfilPendente) { await abrirPerfil(estado.perfilPendente); estado.perfilPendente = null }
      return
    } catch {
      estado.token = null
      estado.usuario = null
    }
  }

  if (estado.modo === 'simulacao') {
    estado.usuario = SIM.usuario
    estado.view = 'feed'
  }

  await recarregarPublico()
  render()
  ligarEventos()
  carregarCamadaTecnica()
  if (estado.perfilPendente) { await abrirPerfil(estado.perfilPendente); estado.perfilPendente = null }
}

iniciar()
