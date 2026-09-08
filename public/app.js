// Uni.work — aplicacao de tela unica, sem build.
//
// Tres colunas: navegacao a esquerda, conteudo no meio, e a direita responde
// "onde esta a minha grana". Cada tela abre com um heroi proprio, e o resto e
// conteudo.
//
// Dois modos: http fala com a API de verdade; simulacao entra quando a API nao
// responde, com dados de exemplo e um aviso permanente na tela. Nada aqui finge
// que uma operacao aconteceu quando ela nao aconteceu.

const $ = (sel, raiz = document) => raiz.querySelector(sel)
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)]

const CHAVE_SESSAO = 'uniwork.sessao'
const CHAVE_GUIA = 'uniwork.guia-visto'
const CHAVE_TEMA = 'uniwork.tema'

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
  online: true,

  // Quantos reais vale um USDC. Vem do servidor, que e o unico lugar onde a
  // cotacao esta escrita. Nulo enquanto nao chegou.
  cotacao: null
}

// ─── util ────────────────────────────────────────────────────────────────────

const escapar = (t) => String(t ?? '').replace(/[<>&"']/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]
))

/**
 * O valor circula em USDC, a moeda estável do pagamento. Os centavos do banco
 * viram unidades inteiras aqui.
 */
const usdc = (centavos) => Math.round(Number(centavos ?? 0) / 100).toLocaleString('pt-BR')

/**
 * Quem le a tela pensa em real, não em USDC: um universitario não sabe quanto
 * vale 800 USDC. Entao o número grande e sempre em real, e o USDC aparece
 * embaixo como referência.
 *
 * A cotação mora num lugar só, no servidor, e chega junto com a saúde da API.
 * Sem ela não há conversao: o número grande volta a ser o USDC, porque exibir
 * reais com uma cotação inventada seria pior do que não exibir.
 */
const real = (centavos) => {
  if (!estado.cotacao) return null
  const reais = (Number(centavos ?? 0) / 100) * estado.cotacao
  return `R$ ${reais.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

/** O número grande: real quando da, USDC quando não da. */
const valorGrande = (centavos) => real(centavos) ?? `${usdc(centavos)} USDC`

/**
 * A linha de baixo, que ancora o número grande na unidade técnica e, quando
 * pedido, na carga horária. Volta vazia quando o número grande já e o USDC.
 */
function valorReferencia (centavos, { horas = null } = {}) {
  const partes = []
  if (estado.cotacao) partes.push(`${usdc(centavos)} USDC`)
  if (horas != null) partes.push(`${horas}h`)
  return partes.join(' · ')
}

/** Valor com a referência embaixo, do jeito que aparece em cartao e painel. */
function valorEmpilhado (centavos, { horas = null, classe = '' } = {}) {
  const ref = valorReferencia(centavos, { horas })
  return `<span class="${classe}">${escapar(valorGrande(centavos))}${
    ref ? `<small>${escapar(ref)}</small>` : ''}</span>`
}

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

/** Cor estável a partir do texto: o mesmo nome sempre recebe a mesma cor. */
function corDe (texto) {
  let soma = 0
  for (const ch of String(texto ?? '')) soma += ch.charCodeAt(0)
  return soma % 5
}

// As chaves sao o nome da categoria como ele vem do banco, agora com acento.
// Categoria que nao estiver aqui cai no simbolo generico, e nao numa falha.
const EMOJI_CATEGORIA = {
  Eventos: '🎪', Monitoria: '📐', Design: '🎨', Tradução: '🌐', Pesquisa: '🔬',
  Desenvolvimento: '⚙️', Conteúdo: '✍️', Fotografia: '📷'
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

// ─── tema ────────────────────────────────────────────────────────────────────

/**
 * O tema em vigor agora: a escolha salva, se houver, e senao a preferência do
 * sistema. Quem nunca escolheu nada não tem atributo no <html>, e ai quem
 * decide e o próprio sistema, pela consulta do CSS.
 */
function temaAtual () {
  const escolhido = document.documentElement.getAttribute('data-tema')
  if (escolhido === 'claro' || escolhido === 'escuro') return escolhido
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro'
}

/** O botao mostra para onde ele leva, e não onde a pessoa esta. */
function pintarBotaoDoTema () {
  const escuro = temaAtual() === 'escuro'
  $('#ico-tema')?.firstElementChild?.setAttribute('href', escuro ? '#i-sol' : '#i-lua')
  const rotulo = $('#rotulo-tema')
  if (rotulo) rotulo.textContent = escuro ? 'Modo claro' : 'Modo escuro'
  $('#btn-tema')?.setAttribute('aria-pressed', String(escuro))
}

/** A escolha da pessoa vence a do sistema, nos dois sentidos, e fica guardada. */
function alternarTema () {
  const proximo = temaAtual() === 'escuro' ? 'claro' : 'escuro'
  document.documentElement.setAttribute('data-tema', proximo)
  try {
    localStorage.setItem(CHAVE_TEMA, proximo)
  } catch { /* sem armazenamento: a escolha vale só para esta visita */ }
  pintarBotaoDoTema()
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
    const err = new Error('Sem conexão com o serviço agora.')
    err.offline = true
    throw err
  }
  marcarOffline(false)

  const texto = await resposta.text()
  const dados = texto ? JSON.parse(texto) : {}

  if (!resposta.ok) {
    const err = new Error(dados.error ?? 'Não conseguimos concluir agora, já estamos tentando de novo.')
    err.codigo = dados.codigo
    err.detalhes = dados.detalhes
    err.status = resposta.status
    // Só encerra a sessão se a chamada FOI feita com credencial e ela foi
    // recusada, e se essa credencial ainda e a atual. Sem as duas condições,
    // uma resposta atrasada da sessão anterior derruba a sessão de agora.
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

// ─── modo simulação ──────────────────────────────────────────────────────────

const SIM = {
  usuario: { id: 'usr_demo', nome: 'Marina Alves', email: 'marina@usp.br', perfil: 'student', universidade: 'USP', curso: 'Design' },
  vagas: [
    { id: 'job_1', titulo: 'Staff de credenciamento no congresso', descricao: 'Recepção e credenciamento dos participantes durante dois dias de evento.', categoria: 'Eventos', modalidade: 'presencial', local: 'São Paulo, SP', valorCentavos: 24000, horas: 12, status: 'garantida', statusRotulo: 'Pagamento reservado', pagamentoGarantido: true, trilha: { etapa: 2, total: 6, cancelada: false }, contratante: { id: 'c1', nome: 'Produtora XPTO' }, criadoEm: new Date(Date.now() - 3600e3).toISOString() },
    { id: 'job_2', titulo: 'Tradução PT-EN de documentação técnica', descricao: 'Tradução de 14 páginas de documentação de API, com glossário fornecido.', categoria: 'Tradução', modalidade: 'remoto', local: null, valorCentavos: 26000, horas: 9, status: 'aberta', statusRotulo: 'Aberta', pagamentoGarantido: false, trilha: { etapa: 1, total: 6, cancelada: false }, contratante: { id: 'c2', nome: 'Studio Nimbus' }, criadoEm: new Date(Date.now() - 7200e3).toISOString() }
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
  const erro = new Error('Esta ação precisa do serviço no ar. Estamos em modo de demonstração.')
  avisar(erro.message, '', 'info')
  throw erro
}

// ─── sessão ──────────────────────────────────────────────────────────────────

function guardarSessao (usuario, sessao) {
  estado.usuario = usuario
  estado.token = sessao?.token ?? null
  try {
    localStorage.setItem(CHAVE_SESSAO, JSON.stringify({ usuario, token: estado.token }))
  } catch { /* navegador sem armazenamento: a sessão dura enquanto a aba viver */ }
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
  // Limpar o que era da sessão anterior. Sem isto, um render pendente ainda
  // tentaria desenhar o detalhe de um trampo com estado.usuário já nulo.
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
 * Um orbe sobre uma plataforma isometrica. As cores vem dos tokens do tema, e
 * não cravadas no desenho: o mesmo SVG serve o modo claro e o escuro.
 *
 * O símbolo vai fora do SVG, num span comum: dentro de <text> ele depende da
 * fonte de emoji do sistema e some em ambiente sem ela, deixando a esfera vazia.
 */
function orbe (emoji, nome) {
  return `<div class="heroi-arte" aria-hidden="true">
    <svg viewBox="0 0 200 200" fill="none" width="100%" height="100%">
      <defs>
        <radialGradient id="o${nome}" cx="38%" cy="30%">
          <stop offset="0%" stop-color="var(--orbe-1)"/>
          <stop offset="70%" stop-color="var(--orbe-2)"/>
          <stop offset="100%" stop-color="var(--orbe-3)"/>
        </radialGradient>
        <filter id="b${nome}"><feGaussianBlur stdDeviation="9"/></filter>
      </defs>
      <path d="M100 132 168 168 100 200 32 168z" fill="var(--orbe-2)" opacity=".7"/>
      <path d="M100 132 168 168 100 200 32 168z" stroke="var(--line-2)"/>
      <ellipse cx="100" cy="150" rx="46" ry="16" fill="#000" opacity="var(--orbe-sombra)" filter="url(#b${nome})"/>
      <circle cx="100" cy="86" r="46" fill="url(#o${nome})" stroke="var(--line-2)"/>
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
      <div class="heroi-dado">
        <span>${escapar(d.rotulo)}</span>
        <strong ${d.mono ? 'class="mono"' : ''}>${escapar(d.valor)}</strong>
        ${d.nota ? `<span style="margin-top:2px">${escapar(d.nota)}</span>` : ''}
      </div>
    `).join('')}</div>` : ''}
    ${acoes ? `<div class="heroi-acoes">${acoes}</div>` : ''}
  </section>`
}

// ─── navegação ───────────────────────────────────────────────────────────────

/** Um icone da biblioteca do index.html, no tamanho de quem o usa. */
const ico = (nome, classe = '') =>
  `<svg class="${classe}" aria-hidden="true"><use href="#i-${nome}"></use></svg>`

/**
 * Os selos do estudante. A regra mora aqui e em nenhum outro lugar: sobe de
 * selo por trampo concluído, e o selo aparece na lista para o contratante.
 */
const SELOS = [
  { nome: 'Bronze', trampos: 0 },
  { nome: 'Prata', trampos: 3 },
  { nome: 'Ouro', trampos: 10 }
]

function selo (concluidos = 0) {
  let atual = SELOS[0]
  let proximo = null
  for (const s of SELOS) {
    if (concluidos >= s.trampos) atual = s
    else if (!proximo) proximo = s
  }
  const base = atual.trampos
  const alvo = proximo?.trampos ?? atual.trampos
  const progresso = proximo
    ? Math.round(((concluidos - base) / (alvo - base)) * 100)
    : 100
  return { atual, proximo, faltam: proximo ? alvo - concluidos : 0, progresso }
}

function itensNav () {
  const u = estado.usuario
  const ehEstudante = u?.perfil === 'student'
  const porStatus = estado.metricas?.porStatus
  const abertas = porStatus ? (porStatus.aberta ?? 0) + (porStatus.garantida ?? 0) : null

  if (!u) {
    return [
      { id: 'entrar', rotulo: 'Entrar', icone: 'user' },
      { id: 'feed', rotulo: 'Trampos abertos', icone: 'bussola', conta: abertas },
      { grupo: 'Público' },
      { id: 'verificar', rotulo: 'Verificar certificado', icone: 'check' },
      { id: 'painel', rotulo: 'Painel', icone: 'grafico' }
    ]
  }

  // A casa do contratante são as vagas dele: elas vêm primeiro. Cair na lista
  // de trampos de outras empresas é o que o redesenho veio corrigir.
  const minhas = ehEstudante
    ? { id: 'minhas', rotulo: 'Meus trampos', icone: 'mochila', conta: estado.minhasVagas.length || null }
    : { id: 'minhas', rotulo: 'Minhas vagas', icone: 'pasta', conta: estado.minhasVagas.length || null }
  const feed = { id: 'feed', rotulo: 'Trampos abertos', icone: 'bussola', conta: abertas }

  return [
    ...(ehEstudante ? [feed, minhas] : [minhas, feed]),
    ...(ehEstudante
      ? [{ id: 'certificados', rotulo: 'Meus certificados', icone: 'selo', conta: estado.certificados.length || null }]
      : []),
    { id: 'notificacoes', rotulo: 'Avisos', icone: 'sino', conta: estado.naoLidas || null, alerta: true },
    { grupo: 'Minha conta' },
    { id: 'conta', rotulo: 'Perfil e ajustes', icone: 'eng' },
    ...(u.mediador
      ? [
          { grupo: 'Mediação' },
          {
            id: 'mediacao',
            rotulo: 'Contestações',
            icone: 'balanca',
            conta: estado.contestacoes.filter((c) => ['open', 'in_review'].includes(c.status)).length || null
          }
        ]
      : []),
    { grupo: 'Público' },
    { id: 'verificar', rotulo: 'Verificar certificado', icone: 'check' },
    { id: 'painel', rotulo: 'Painel', icone: 'grafico' }
  ]
}

function renderNav () {
  $('#nav').innerHTML = itensNav().map((item) => {
    if (item.grupo) return `<div class="nav-grupo">${escapar(item.grupo)}</div>`
    return `<button class="nav-item ${item.alerta && item.conta ? 'alerta' : ''}" data-view="${item.id}"
                    ${estado.view === item.id ? 'aria-current="page"' : ''}>
      ${ico(item.icone, 'nav-glifo')}
      <span>${escapar(item.rotulo)}</span>
      ${item.conta ? `<span class="nav-conta">${item.conta}</span>` : ''}
    </button>`
  }).join('')

  $('#esq-rodape').innerHTML = cartaoDeQuemEntrou()

  const u = estado.usuario
  $('#topo-acoes').innerHTML = u
    ? `<button class="btn btn-linha btn-mini" data-acao="meu-perfil">
         <span class="avatar c${corDe(u.nome)}" aria-hidden="true">${iniciais(u.nome)}</span>
         ${escapar(u.nome.split(' ')[0])}
       </button>
       <button class="btn btn-fantasma btn-mini" id="btn-sair">Sair</button>`
    : `<button class="btn btn-linha btn-mini" data-view="entrar">Entrar</button>
       <button class="btn btn-primario btn-mini" data-acao="criar-conta">Criar conta</button>`
}

/**
 * O cartao no rodape do menu. Com sessão ele diz quem você e e a que distância
 * esta do próximo selo; sem sessão ele convida a entrar, que e o único passo
 * possível de quem chega.
 */
function cartaoDeQuemEntrou () {
  const u = estado.usuario
  const r = estado.resumo

  if (!u) {
    return `<div class="eu">
      <span class="eu-nome">Comece em um minuto</span>
      <p>Nome e e-mail bastam. Sua conta de recebimento fica pronta junto.</p>
      <button class="btn btn-primario btn-mini btn-bloco esq-cta" id="cta-botao">
        <span id="cta-rotulo">Criar minha conta</span>
      </button>
    </div>`
  }

  const ehEstudante = u.perfil === 'student'
  const porStatus = r?.vagasPorStatus ?? {}
  const reservadas = (porStatus.garantida ?? 0) + (porStatus.aceita ?? 0) +
    (porStatus.em_andamento ?? 0) + (porStatus.entregue ?? 0)

  let meio
  if (ehEstudante) {
    const s = selo(porStatus.concluida ?? 0)
    meio = `<div class="barra-selo" role="img" aria-label="Selo ${s.atual.nome}, ${s.progresso}% até o próximo">
         <i style="width:${Math.max(6, Math.min(100, s.progresso))}%"></i>
       </div>
       <p>${s.proximo
          ? `Faltam <b>${s.faltam} ${s.faltam === 1 ? 'trampo' : 'trampos'}</b> para o selo ${s.proximo.nome}, que sobe você na lista.`
          : `Selo <b>${s.atual.nome}</b>, o mais alto. Você aparece no topo da lista.`}</p>`
  } else {
    meio = `<p><b>${escapar(valorGrande(r?.valores?.reservadoCentavos))}</b> reservados em ${reservadas} ${reservadas === 1 ? 'vaga' : 'vagas'}.</p>`
  }

  return `<div class="eu">
    <div class="eu-topo">
      <span class="avatar g c${corDe(u.nome)}" aria-hidden="true">${iniciais(u.nome)}</span>
      <span style="min-width:0">
        <span class="eu-nome">${escapar(u.nome)}</span>
        <span class="eu-sub">${escapar(ehEstudante
          ? ([u.curso, u.universidade].filter(Boolean).join(' · ') || 'Estudante')
          : (u.headline || 'Contratante'))}</span>
      </span>
    </div>
    ${meio}
    <button class="btn ${ehEstudante ? 'btn-linha' : 'btn-primario'} btn-mini btn-bloco esq-cta" id="cta-botao">
      ${ehEstudante ? '' : ico('mais')}
      <span id="cta-rotulo">${ehEstudante ? 'Procurar trampos' : 'Publicar vaga'}</span>
    </button>
  </div>
  <div class="esq-vivo">
    <span class="ponto-vivo" aria-hidden="true"></span>
    <span>ao vivo</span>
  </div>
  <button class="esq-link" data-view="verificar">Verificar certificado</button>
  <button class="esq-link" data-view="painel">Painel do ecossistema</button>`
}

// ─── cartao de trampo ────────────────────────────────────────────────────────

/**
 * O que esta acontecendo agora, em uma linha.
 *
 * A trilha do servidor conta quantas etapas já foram cumpridas. A etapa em
 * curso e a seguinte, e e ela que a pessoa quer ler: "escolhendo quem faz" diz
 * mais do que uma barra pela metade. O caso da etapa 2 tem rotulo próprio,
 * porque "o valor ainda nao foi reservado" e a informação que decide se vale a
 * pena se candidatar.
 */
const ROTULO_DO_PASSO = {
  2: 'o contratante ainda não reservou o valor',
  3: 'escolhendo quem faz',
  4: 'combinando o início do trabalho',
  5: 'trabalho em andamento',
  6: 'esperando a confirmação da entrega'
}

function passoAtual (vaga) {
  const total = vaga.trilha?.total ?? 6
  const cumpridas = vaga.trilha?.etapa ?? 0

  if (vaga.trilha?.cancelada) {
    return { etapa: 0, total, texto: 'cancelado, o valor voltou para quem reservou', alerta: true }
  }
  if (vaga.status === 'concluida') {
    return { etapa: total, total, texto: 'pago e certificado', alerta: false }
  }
  const emCurso = Math.min(cumpridas + 1, total)
  return { etapa: emCurso, total, texto: ROTULO_DO_PASSO[emCurso] ?? '', alerta: emCurso === 2 }
}

function trilhaHtml (vaga) {
  const passo = passoAtual(vaga)
  const total = passo.total
  const cumpridas = vaga.trilha?.etapa ?? 0
  const cancelada = Boolean(vaga.trilha?.cancelada)

  const legenda = cancelada || vaga.status === 'concluida'
    ? passo.texto
    : `etapa ${passo.etapa} de ${total}, ${passo.texto}`

  return `<div>
    <div class="trilha" role="img" aria-label="${escapar(legenda)}">
      ${Array.from({ length: total }, (_, i) => {
        const classe = cancelada
          ? 'cancelado'
          : i < cumpridas ? 'feito' : i === cumpridas ? 'atual' : ''
        return `<span class="trilha-seg ${classe}"></span>`
      }).join('')}
    </div>
    <span class="passo-nome ${passo.alerta ? 'alerta' : ''}">${escapar(
      cancelada || vaga.status === 'concluida'
        ? passo.texto.charAt(0).toUpperCase() + passo.texto.slice(1)
        : `Etapa ${passo.etapa} de ${total} · ${passo.texto}`
    )}</span>
  </div>`
}

/** A etiqueta que responde "o dinheiro está separado?" antes de qualquer outra. */
function etiquetaDaGarantia (vaga) {
  if (vaga.status === 'concluida') return `<span class="etiqueta verde">${ico('check')} Pago</span>`
  if (vaga.emContestacao) return `<span class="etiqueta coral">${ico('relogio')} Em contestação</span>`
  if (vaga.pagamentoGarantido) return `<span class="etiqueta verde">${ico('lock')} Grana reservada</span>`
  return `<span class="etiqueta laranja">${ico('relogio')} Valor a reservar</span>`
}

function cartaoVaga (vaga) {
  return `<button class="vaga" data-vaga="${escapar(vaga.id)}">
    <div class="vaga-capa c${corDe(vaga.categoria ?? vaga.titulo)}">
      ${valorEmpilhado(vaga.valorCentavos, { horas: vaga.horas, classe: 'vaga-valor' })}
      <span class="vaga-modo">${vaga.modalidade === 'presencial' ? 'presencial' : 'remoto'}</span>
      <span class="vaga-selo" aria-hidden="true">${emojiDe(vaga.categoria)}</span>
    </div>
    <div class="vaga-corpo">
      <div class="vaga-titulo">${escapar(vaga.titulo)}</div>
      <p class="vaga-desc">${escapar(vaga.descricao)}</p>
      <div class="etiquetas">
        ${etiquetaDaGarantia(vaga)}
        <span class="etiqueta">${escapar(vaga.categoria)}</span>
      </div>
      ${trilhaHtml(vaga)}
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
    olho: 'Track 01 · Vida universitária · Hackathon Superteam Brasil',
    titulo: 'Trabalhe hoje. Receba hoje. Comprove sempre.',
    texto: 'Trampos curtos para universitários. O contratante reserva o valor antes de você começar, e cada trabalho concluído vira um certificado que ninguém consegue falsificar.',
    dados: [
      { rotulo: 'Pagamento', valor: 'em garantia' },
      { rotulo: 'Certificado', valor: 'automático' },
      { rotulo: 'Rede', valor: 'Solana devnet', mono: true }
    ],
    arte: marcaGrande()
  }) + `

  <div class="entrar-grade">
    <div class="painel">
      <h4>${ico('mochila')} Entrar como estudante</h4>
      ${listaDe(p?.estudantes, 'Nenhuma conta de exemplo neste ambiente. Crie a sua abaixo.')}
    </div>
    <div class="painel">
      <h4>${ico('pasta')} Entrar como contratante</h4>
      ${listaDe(p?.contratantes, 'Nenhuma conta de exemplo neste ambiente. Crie a sua abaixo.')}
    </div>
  </div>

  <div class="painel">
    <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <div style="flex:1;min-width:250px">
        <h4 style="margin-bottom:8px">Criar conta</h4>
        <p style="font-size:13px;color:var(--ink-3);line-height:1.6">
          Nome e e-mail. A conta de recebimento fica pronta junto, sem nenhum passo a mais
          e sem nenhuma extensão para instalar.
        </p>
      </div>
      <div style="display:flex;gap:9px;flex-wrap:wrap">
        <button class="btn btn-linha" data-criar="student">Sou estudante</button>
        <button class="btn btn-primario" data-criar="company">Quero contratar</button>
      </div>
    </div>
  </div>

  <div class="painel">
    <h4>Já tenho conta</h4>
    <form id="form-entrar" style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap">
      <div style="flex:1;min-width:220px">
        <label class="sr" for="entrar-email">E-mail</label>
        <input id="entrar-email" class="campo-filtro" style="width:100%" type="email"
               autocomplete="email" required placeholder="seu.nome@universidade.br">
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
    texto: 'Cada vaga diz se a grana já está separada. Você vê o dinheiro antes de topar, e o filtro deixa só as que já têm.',
    arte: orbe('🧭', 'Az')
  }) + `

  <div class="secao">
    <button class="aba" data-modalidade="" aria-pressed="${!f.modalidade}">Tudo</button>
    <button class="aba" data-modalidade="presencial" aria-pressed="${f.modalidade === 'presencial'}">Presencial</button>
    <button class="aba" data-modalidade="remoto" aria-pressed="${f.modalidade === 'remoto'}">Remoto</button>
    <button class="aba" data-garantidas="1" aria-pressed="${f.garantidas}">Só com grana reservada</button>
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
    : vazio('🔍', 'Nada com esse filtro',
        (f.busca || f.modalidade || f.categoria || f.garantidas)
          ? 'Nenhum trampo bate com o que você pediu. Solte um filtro e veja o que aparece.'
          : 'Ainda não há trampo publicado. Volte daqui a pouco.',
        '<button class="btn btn-linha" data-acao="limpar-filtros">Limpar filtros</button>')}`
}

function telaVerificar () {
  return heroi({
    cor: 'roxo',
    olho: 'Público · sem login',
    titulo: 'Verificar certificado',
    texto: 'Digite o código impresso no documento. Não precisa de conta, nem de login, nem de cadastro.',
    arte: orbe('🔎', 'Rx')
  }) + `

  <div class="painel" style="max-width:560px">
    <form class="codigo-caixa" id="form-codigo">
      <label class="sr" for="codigo">Código do certificado</label>
      <input id="codigo" placeholder="UNI-XXXX-XXXX" maxlength="14"
             autocomplete="off" spellcheck="false" value="${escapar(estado.codigoDigitado)}">
      <button class="btn btn-primario" type="submit">Verificar</button>
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
    olho: 'Público · em tempo real',
    titulo: 'Painel do ecossistema',
    texto: 'Quanto já foi pago, quanto está em garantia agora e quantas horas viraram certificado. Os números vem do banco e da rede, não de estimativa.',
    arte: orbe('📊', 'Gf')
  }) + `

  <div class="metricas">
    <div class="metrica"><div class="metrica-valor">${valorGrande(t?.pagoCentavos)}</div><div class="metrica-rotulo">pago a estudantes${valorReferencia(t?.pagoCentavos) ? ` · ${valorReferencia(t?.pagoCentavos)}` : ''}</div></div>
    <div class="metrica"><div class="metrica-valor">${valorGrande(t?.reservadoCentavos)}</div><div class="metrica-rotulo">separado agora${valorReferencia(t?.reservadoCentavos) ? ` · ${valorReferencia(t?.reservadoCentavos)}` : ''}</div></div>
    <div class="metrica"><div class="metrica-valor">${t?.horasCertificadas ?? 0}h</div><div class="metrica-rotulo">horas certificadas</div></div>
    <div class="metrica"><div class="metrica-valor">${t?.certificados ?? 0}</div><div class="metrica-rotulo">certificados emitidos</div></div>
    <div class="metrica"><div class="metrica-valor">${t?.vagas ?? 0}</div><div class="metrica-rotulo">trampos publicados</div></div>
    <div class="metrica"><div class="metrica-valor">${t?.concluidas ?? 0}</div><div class="metrica-rotulo">concluídos</div></div>
    <div class="metrica"><div class="metrica-valor">${t?.estudantes ?? 0}</div><div class="metrica-rotulo">estudantes</div></div>
    <div class="metrica"><div class="metrica-valor">${t?.contratantes ?? 0}</div><div class="metrica-rotulo">contratantes</div></div>
  </div>

  ${cat.length ? `<div class="painel">
    <h4>${ico('grafico')} Trampos por categoria</h4>
    <div class="cats">${(() => {
      // Conta todo trampo publicado, em qualquer etapa — e o que a consulta do
      // painel faz, e o painel e um retrato do ecossistema inteiro.
      //
      // A barra e proporcional a maior categoria, e nao ao total: a pergunta
      // aqui e "qual categoria puxa mais trampo", nao "que fatia do bolo".
      //
      // O teto nunca desce de 4, mesmo que a maior categoria tenha 1. Sem esse
      // piso, oito categorias empatadas em 1 viram oito barras cheias, que
      // parecem oito barras de progresso em 100% e nao dizem nada. Com ele, o
      // empate aparece como oito barras curtas e iguais, que e o que ele e.
      const teto = Math.max(...cat.map((c) => c.total), 4)
      return cat.map((c) => `<div class="cat"
              title="${escapar(c.categoria)}: ${c.total} ${c.total === 1 ? 'trampo publicado' : 'trampos publicados'}">
        <span class="cat-nome">${escapar(c.categoria)}</span>
        <span class="cat-trilho" aria-hidden="true">
          <span class="cat-barra" style="width:${Math.max(4, Math.round((c.total / teto) * 100))}%"></span>
        </span>
        <span class="cat-total">${c.total}</span>
      </div>`).join('')
    })()}</div>
  </div>` : ''}`
}

/**
 * As decisões que estão paradas esperando o contratante.
 *
 * "Precisam de voce" já existia, mas como contador ao lado de um título de
 * grupo. Aqui vira lista: uma linha por decisão, com o botao da ação do lado, e
 * o lembrete de reservar o valor incluido — que e a decisão que a pessoa não
 * sabe que precisa tomar.
 */
function decisoesPendentes (vagas) {
  const fila = []
  for (const vaga of vagas) {
    if (vaga.emContestacao) continue

    if (vaga.status === 'aberta') {
      fila.push({
        vaga,
        icone: 'lock',
        pronto: false,
        titulo: `Reservar o valor de ${vaga.titulo.toLowerCase()}`,
        texto: 'Enquanto o valor não está separado, a vaga aparece sem garantia e recebe menos candidatos.',
        acoes: `<button class="btn btn-dinheiro btn-mini" data-fila="reservar" data-fila-vaga="${escapar(vaga.id)}">
                  Reservar ${escapar(valorGrande(vaga.valorCentavos))}
                </button>`
      })
      continue
    }

    if (vaga.status === 'garantida' && vaga.candidaturasPendentes) {
      const n = vaga.candidaturasPendentes
      fila.push({
        vaga,
        icone: 'user',
        pronto: true,
        titulo: `Escolher quem faz ${vaga.titulo.toLowerCase()}`,
        texto: `${n} ${n === 1 ? 'candidatura' : 'candidaturas'} · ${valorGrande(vaga.valorCentavos)} já reservados`,
        acoes: `<button class="btn btn-primario btn-mini" data-vaga="${escapar(vaga.id)}">Ver perfis e escolher</button>`
      })
      continue
    }

    if (vaga.status === 'entregue' && !vaga.pagamentoEmProcessamento) {
      fila.push({
        vaga,
        icone: 'check',
        pronto: true,
        titulo: `Confirmar a entrega de ${vaga.titulo.toLowerCase()}`,
        texto: 'O mesmo clique paga o estudante e emite o certificado.',
        acoes: `<button class="btn btn-primario btn-mini" data-fila="confirmar" data-fila-vaga="${escapar(vaga.id)}">
                  Confirmar e pagar
                </button>`
      })
    }
  }
  return fila
}

function filaHtml (fila) {
  return `<div class="fila">${fila.map((item) => `<div class="acao ${item.pronto ? 'pronto' : ''}">
    <span class="acao-ico" aria-hidden="true">${ico(item.icone)}</span>
    <div>
      <h4>${escapar(item.titulo)}</h4>
      <p>${escapar(item.texto)}</p>
    </div>
    <div class="acao-bts">${item.acoes}</div>
  </div>`).join('')}</div>`
}

function telaMinhas () {
  const ehEstudante = estado.usuario?.perfil === 'student'
  // Lista própria, vinda de /jobs/minhas. Filtrar o resultado da busca pública
  // não funciona: ela só traz trampo aberto ou garantido.
  const minhas = estado.minhasVagas
  const emCurso = minhas.filter((v) => ['aberta', 'garantida', 'aceita', 'em_andamento', 'entregue'].includes(v.status))
  const fila = ehEstudante ? [] : decisoesPendentes(minhas)

  const grupos = [
    { titulo: ehEstudante ? 'Rolando agora' : 'Suas vagas em andamento', filtro: (v) => emCurso.includes(v) },
    { titulo: ehEstudante ? 'Concluídos' : 'Concluídas', filtro: (v) => v.status === 'concluida' },
    { titulo: ehEstudante ? 'Cancelados' : 'Canceladas', filtro: (v) => v.status === 'cancelada' }
  ]

  const resumoDoTopo = ehEstudante
    ? (minhas.length
        ? `${emCurso.length} ${emCurso.length === 1 ? 'trampo rolando' : 'trampos rolando'}. Cada um mostra em que etapa está.`
        : 'Tudo o que você aceitou ou está fazendo aparece aqui.')
    : (minhas.length
        ? `${emCurso.length} ${emCurso.length === 1 ? 'rolando' : 'rolando'}, ${fila.length} ${fila.length === 1 ? 'precisa' : 'precisam'} de você hoje.`
        : 'O que você publicar aparece aqui, com a etapa de cada vaga.')

  return heroi({
    cor: fila.length ? 'verde' : 'grafite',
    olho: ehEstudante ? 'Seu trabalho' : 'Suas contratações',
    titulo: ehEstudante ? 'Meus trampos' : 'Suas vagas',
    texto: resumoDoTopo,
    acoes: ehEstudante
      ? '<button class="btn btn-linha" data-view="feed">Ver trampos abertos</button>'
      : `<button class="btn btn-primario" data-acao="publicar">${ico('mais')} Publicar vaga</button>`,
    arte: orbe(ehEstudante ? '🎒' : '🗂️', 'Mn')
  }) + (fila.length
    ? `<div class="secao">
         <h2>Precisam de você hoje</h2>
         <span class="conta">${fila.length} ${fila.length === 1 ? 'decisão' : 'decisões'}</span>
       </div>
       ${filaHtml(fila)}`
    : '') + (minhas.length
    ? grupos.map((g) => {
        const lista = minhas.filter(g.filtro)
        if (!lista.length) return ''
        return `<div class="secao"><h2>${g.titulo}</h2><span class="conta">${lista.length}</span></div>
          <div class="grade">${lista.map(cartaoVaga).join('')}</div>`
      }).join('') + (estado.temMaisMinhas
        ? '<div style="display:flex;justify-content:center"><button class="btn btn-linha" data-acao="mais-minhas">Ver mais</button></div>'
        : '')
    : vazio('📋',
        ehEstudante ? 'Seu primeiro trampo ainda não saiu' : 'Nenhuma vaga publicada ainda',
        ehEstudante
          ? 'Dá para se candidatar a quantos você quiser: só vira compromisso quando você é escolhida.'
          : 'Publique a primeira e reserve o valor. Vaga com grana separada recebe mais candidatos.',
        ehEstudante
          ? '<button class="btn btn-primario" data-view="feed">Ver trampos abertos</button>'
          : '<button class="btn btn-primario" data-acao="publicar">Publicar vaga</button>'))
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
      titulo: 'O certificado é do estudante',
      texto: 'Cada entrega que você confirma emite um certificado com a carga horária, na conta de quem executou. Ele tem código público e qualquer pessoa confere sem ter conta.',
      arte: orbe('🎓', 'Ce')
    })
  }

  return heroi({
    cor: 'roxo',
    olho: 'Seus comprovantes',
    titulo: `${estado.horasTotais}h certificadas`,
    texto: 'Cada certificado tem código público. Mande o link para a coordenação do seu curso ou para um contratante: eles conferem sem precisar de conta.',
    arte: orbe('🎓', 'Ce')
  }) + (estado.certificados.length
    ? `<div class="cert-grade">${estado.certificados.map(cartaoCertificado).join('')}</div>`
    : vazio('🎓', 'Nenhum certificado ainda',
        'Conclua um trampo e o certificado com a carga horária aparece aqui automaticamente, sem você pedir.',
        '<button class="btn btn-primario" data-view="feed">Ver trampos abertos</button>'))
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
    acoes: `<button class="btn btn-linha" data-acao="meu-perfil">Ver meu perfil público</button>
            <button class="btn btn-fantasma" data-acao="rever-guia">Rever como funciona</button>`,
    arte: orbe(u.perfil === 'student' ? '🎒' : '🏢', 'Co')
  }) + `

  <div class="detalhe-grade">
    <div style="display:flex;flex-direction:column;gap:18px;min-width:0">
      <div class="painel">
        <h4>${ico('grafico')} Resumo</h4>
        <dl class="dados">
          <div class="linha-dado"><dt>${u.perfil === 'student' ? 'Já recebido' : 'Já pago'}</dt><dd>${valorGrande(r?.valores?.movimentadoCentavos)}</dd></div>
          <div class="linha-dado"><dt>Separado agora</dt><dd>${valorGrande(r?.valores?.reservadoCentavos)}</dd></div>
          <div class="linha-dado"><dt>Horas certificadas</dt><dd>${r?.certificados?.horas ?? 0}h</dd></div>
          <div class="linha-dado"><dt>Avaliação</dt><dd>${r?.avaliacao?.total
            ? `${r.avaliacao.media.toFixed(1)} de 5 <small style="font-family:var(--sans);font-size:11.5px;font-weight:700;color:var(--ink-3)">${r.avaliacao.total} ${r.avaliacao.total === 1 ? 'avaliação' : 'avaliações'}</small>`
            : '<span style="font-family:var(--sans);font-weight:700;font-size:13px;color:var(--ink-3)">ninguém avaliou ainda</span>'}</dd></div>
        </dl>
      </div>

      <div class="painel">
        <h4>${ico('lock')} Como o pagamento funciona</h4>
        <p style="font-size:13.5px;color:var(--ink-2);line-height:1.65">
          O contratante reserva o valor ao publicar. Ele sai da conta dele e fica separado, sem
          poder voltar sozinho. Quando a entrega e confirmada, o valor vai para o estudante e o
          certificado e emitido no mesmo instante. Se o trampo for cancelado antes da entrega, o
          valor volta inteiro para quem reservou.
        </p>
      </div>
    </div>

    <div class="painel">
      <h4>${ico('sino')} Avisos</h4>
      <dl class="dados">
        <div class="linha-dado"><dt>No aplicativo</dt><dd style="color:var(--verde-txt);font-family:var(--sans)">sempre</dd></div>
        <div class="linha-dado"><dt>Por e-mail</dt><dd style="font-family:var(--sans)">${p?.email ? 'ligado' : 'desligado'}</dd></div>
        <div class="linha-dado"><dt>No navegador</dt><dd style="font-family:var(--sans)">${p?.push ? 'ligado' : 'desligado'}</dd></div>
      </dl>
      <button class="btn btn-linha btn-mini btn-bloco" style="margin-top:12px" data-view="notificacoes">
        Ajustar notificações
      </button>
    </div>
  </div>`
}

// ─── detalhe do trampo ───────────────────────────────────────────────────────

const ETAPAS_ROTULO = [
  'Trampo publicado', 'Valor reservado', 'Estudante escolhido',
  'Trabalho em andamento', 'Entrega enviada', 'Confirmado e pago'
]

/** O que falta acontecer em cada etapa, do ponto de vista de quem espera. */
const ETAPAS_ESPERA = [
  'já saiu', 'é com o contratante', 'é com o contratante',
  'é com o estudante', 'é com o estudante', 'o mesmo clique paga e certifica'
]

function acoesDaVaga (vaga) {
  const u = estado.usuario
  // Sem sessão não há ação possível. Acontece quando um render pendente roda
  // logo depois de sair.
  if (!u) return []

  const souContratante = vaga.contratante?.id === u.id
  const souEstudante = vaga.estudante?.id === u.id
  const botoes = []

  if (souContratante) {
    if (vaga.status === 'aberta') botoes.push(['reservar', 'Reservar o valor', 'btn-primario'])
    if (vaga.status === 'entregue' && !vaga.emContestacao) botoes.push(['confirmar', 'Confirmar entrega e pagar', 'btn-primario'])
    if (['aberta', 'garantida', 'aceita', 'em_andamento'].includes(vaga.status) && !vaga.emContestacao) {
      botoes.push(['cancelar', 'Cancelar', 'btn-perigo'])
    }
  }
  if (souEstudante) {
    if (vaga.status === 'aceita') botoes.push(['comecar', 'Começar o trabalho', 'btn-primario'])
    if (vaga.status === 'em_andamento') botoes.push(['entregar', 'Enviar entrega', 'btn-primario'])
  }
  if (!souContratante && !souEstudante && u.perfil === 'student' &&
      ['aberta', 'garantida'].includes(vaga.status) && !vaga.minhaCandidatura) {
    botoes.push(['candidatar', 'Quero esse trampo', 'btn-primario'])
  }
  if (vaga.status === 'concluida' && (souContratante || souEstudante)) {
    botoes.push(['avaliar', 'Avaliar', 'btn-linha'])
  }
  // Contestar só aparece quando há trabalho combinado, valor reservado e o
  // dinheiro ainda não saiu. Fora dessa janela não há o que contestar.
  if ((souContratante || souEstudante) && !vaga.contestacao &&
      ['aceita', 'em_andamento', 'entregue'].includes(vaga.status)) {
    botoes.push(['contestar', 'Abrir contestação', 'btn-linha'])
  }
  return botoes
}

/** Onde o dinheiro esta neste momento, em uma frase. */
function frasePagamento (vaga) {
  const valor = valorGrande(vaga.valorCentavos)
  if (vaga.status === 'cancelada') return `${valor}. O trampo foi cancelado e o valor voltou para quem reservou.`
  if (vaga.status === 'concluida') return `${valor} pagos ao estudante, com o certificado emitido na mesma hora.`
  if (vaga.pagamentoEmProcessamento) return `${valor} já confirmados. Estamos concluindo o pagamento agora.`
  if (vaga.emContestacao) return `${valor} parados até a contestação ser decidida. Nem saem, nem voltam.`
  if (vaga.pagamentoGarantido) return `${valor} já separados. O valor sai para o estudante assim que a entrega for confirmada.`
  return `${valor}, ainda na conta do contratante. Enquanto ele não reservar, ninguém pode ser escolhido.`
}

/**
 * A linha que da contexto a uma candidatura.
 *
 * Sem ela, escolher entre dois nomes e chute. Com curso, trampos feitos e horas
 * certificadas, a escolha fica obvia — e o certificado passa a valer algo, que e
 * o propósito dele.
 */
function contextoDoCandidato (estudante) {
  const partes = [estudante.curso, estudante.universidade].filter(Boolean)
  const feitos = estudante.trabalhosConcluidos ?? 0
  const horas = estudante.horasCertificadas ?? 0
  partes.push(feitos
    ? `${feitos} ${feitos === 1 ? 'trampo' : 'trampos'}, ${horas}h certificadas`
    : 'primeira candidatura por aqui')
  return partes.join(' · ')
}

function telaDetalhe () {
  const vaga = estado.vagaAberta
  if (!vaga) return vazio('🔍', 'Trampo não encontrado', 'Ele pode ter sido removido.')

  const etapaAtual = vaga.trilha?.etapa ?? 0
  // Numa vaga concluída a última etapa esta cumprida, e não em curso.
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
      { rotulo: 'Quanto paga', valor: valorGrande(vaga.valorCentavos), nota: valorReferencia(vaga.valorCentavos) },
      { rotulo: 'Carga horária', valor: `${vaga.horas}h` },
      { rotulo: 'Etapa', valor: `${passoAtual(vaga).etapa} de ${passoAtual(vaga).total}` },
      { rotulo: 'Estado', valor: vaga.statusRotulo }
    ],
    acoes: botoes.map(([acao, rotulo, classe]) =>
      `<button class="btn ${classe}" data-acao-vaga="${acao}">${rotulo}</button>`).join('')
  })}

  <div class="detalhe-grade">
    <div style="display:flex;flex-direction:column;gap:18px;min-width:0">
      <div class="painel">
        <h4>Descrição</h4>
        <p style="font-size:14px;white-space:pre-wrap;line-height:1.65">${escapar(vaga.descricao)}</p>
      </div>

      ${vaga.entregaObservacao ? `<div class="painel">
        <h4>Observação da entrega</h4>
        <p style="font-size:14px;white-space:pre-wrap;line-height:1.65">${escapar(vaga.entregaObservacao)}</p>
      </div>` : ''}

      ${vaga.candidaturas?.length ? `<div class="painel">
        <h4>${ico('user')} Quem se candidatou (${vaga.candidaturas.length})</h4>
        <p style="font-size:12.5px;color:var(--ink-3);margin-bottom:12px">
          Escolher entre dois nomes é difícil. Curso, trampos feitos e horas certificadas
          são o que separa um do outro.
        </p>
        ${vaga.candidaturas.map((c) => `<div class="pessoa">
          <span class="avatar g c${corDe(c.estudante.nome)}" aria-hidden="true">${iniciais(c.estudante.nome)}</span>
          <span style="min-width:0;flex:1">
            <span class="pessoa-nome">${escapar(c.estudante.nome)}</span>
            <span class="pessoa-sub">${escapar(contextoDoCandidato(c.estudante))}</span>
            ${c.apresentacao ? `<span class="pessoa-sub" style="color:var(--ink-2);margin-top:5px">${escapar(c.apresentacao)}</span>` : ''}
          </span>
          ${c.status === 'pendente' && vaga.status === 'garantida'
            ? `<button class="btn btn-primario btn-mini" data-aceitar="${escapar(c.id)}">Escolher</button>`
            : `<span class="etiqueta">${escapar(c.status)}</span>`}
        </div>`).join('')}
        ${vaga.status === 'aberta'
          ? `<div class="acao" style="margin-top:12px">
               <span class="acao-ico" aria-hidden="true">${ico('lock')}</span>
               <div>
                 <h4>Reserve o valor para poder escolher</h4>
                 <p>Ninguém é escolhido antes de a grana estar separada. É o que garante o pagamento de quem aceitar.</p>
               </div>
               <div class="acao-bts">
                 <button class="btn btn-dinheiro btn-mini" data-acao-vaga="reservar">
                   Reservar ${escapar(valorGrande(vaga.valorCentavos))}
                 </button>
               </div>
             </div>`
          : ''}
      </div>` : ''}

      ${souParte ? `<div class="painel">
        <h4>${ico('chat')} Conversa</h4>
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
        <h4>${ico('raio')} Andamento</h4>
        <p class="passo-nome ${passoAtual(vaga).alerta ? 'alerta' : ''}" style="margin-bottom:12px">
          ${escapar(vaga.trilha?.cancelada || terminou
            ? passoAtual(vaga).texto.charAt(0).toUpperCase() + passoAtual(vaga).texto.slice(1)
            : `Etapa ${passoAtual(vaga).etapa} de ${passoAtual(vaga).total} · ${passoAtual(vaga).texto}`)}
        </p>
        <div class="etapas">
          ${ETAPAS_ROTULO.map((rotulo, i) => {
            const num = i + 1
            // etapaAtual conta o que já foi cumprido, entao ela mesma esta
            // feita. O que esta em curso e a etapa seguinte.
            const feita = !vaga.trilha?.cancelada && num <= etapaAtual
            const atual = !vaga.trilha?.cancelada && !terminou && num === etapaAtual + 1
            return `<div class="etapa ${feita ? 'feita' : ''} ${atual ? 'atual' : ''}">
              <span class="etapa-bola" aria-hidden="true">${feita ? '✓' : ''}</span>
              <div class="etapa-texto">${rotulo}${atual ? ` <span style="font-weight:700;color:var(--ink-3)">· ${ETAPAS_ESPERA[i]}</span>` : ''}</div>
            </div>`
          }).join('')}
          ${vaga.trilha?.cancelada ? `<div class="etapa"><span class="etapa-bola" aria-hidden="true">✕</span><div class="etapa-texto" style="color:var(--vermelho-txt)">Cancelado, valor devolvido</div></div>` : ''}
        </div>
      </div>

      ${vaga.contestacao ? `<div class="painel" style="border-color:rgba(245,158,11,.3)">
        <h4 style="color:var(--laranja-txt)">Contestação</h4>
        <p style="font-size:13.5px;font-weight:700;margin-bottom:6px">${escapar(vaga.contestacao.statusRotulo)}</p>
        <p style="font-size:13px;color:var(--ink-2);margin-bottom:10px">${escapar(vaga.contestacao.motivoRotulo)}</p>
        <p style="font-size:13px;color:var(--ink-2);white-space:pre-wrap;margin-bottom:12px">${escapar(vaga.contestacao.detalhe)}</p>
        <dl class="dados">
          <div class="linha-dado"><dt>Aberta por</dt><dd style="font-family:var(--sans)">${escapar(vaga.contestacao.abertaPor.nome ?? '-')}</dd></div>
          <div class="linha-dado"><dt>Prazo da análise</dt><dd>${dataBR(vaga.contestacao.prazoEm)}</dd></div>
        </dl>
        ${vaga.contestacao.resolucao ? `
          <p style="font-size:11px;letter-spacing:.1em;color:var(--ink-3);margin:14px 0 6px">DECISÃO</p>
          <p style="font-size:13px;color:var(--ink-2);white-space:pre-wrap">${escapar(vaga.contestacao.resolucao)}</p>
          ${vaga.contestacao.divisaoBps !== null ? `<p style="font-size:12.5px;color:var(--ink-3);margin-top:8px">Divisão: ${Math.round(vaga.contestacao.divisaoBps / 100)}% para o estudante</p>` : ''}
        ` : '<p style="font-size:12.5px;color:var(--ink-3);margin-top:10px">Enquanto a contestação estiver aberta, o valor fica parado. Nem sai, nem volta.</p>'}
      </div>` : ''}

      ${vaga.autoConfirmaEm && vaga.status === 'entregue' && !vaga.contestacao && !vaga.pagamentoEmProcessamento ? `<div class="painel">
        <h4>${ico('relogio')} Prazo de confirmação</h4>
        <p style="font-size:13px;color:var(--ink-2);line-height:1.6">
          Se ninguém confirmar nem contestar até <strong>${dataBR(vaga.autoConfirmaEm)}</strong>,
          o pagamento e liberado automaticamente para o estudante.
        </p>
      </div>` : ''}

      ${vaga.anexos ? `<div class="painel">
        <h4>Arquivos</h4>
        ${vaga.anexos.length
          ? `<dl class="dados">${vaga.anexos.map((a) => `<div class="linha-dado">
              <dt><a href="${escapar(a.url)}" target="_blank" rel="noopener" style="color:var(--azul-2)">${escapar(a.nome)}</a></dt>
              <dd>${Math.round(a.tamanho / 1024)} KB</dd>
            </div>`).join('')}</dl>`
          : '<p style="font-size:13px;color:var(--ink-3)">Nenhum arquivo por enquanto.</p>'}
        <button class="btn btn-linha btn-mini btn-bloco" style="margin-top:12px" data-enviar="delivery">Anexar arquivo</button>
      </div>` : ''}

      ${vaga.certificado ? `<div class="painel">
        <h4>${ico('selo')} Certificado</h4>
        <p style="font-size:14px;font-weight:700">${vaga.certificado.horas}h certificadas</p>
        <p class="mono" style="font-size:12px;color:var(--ink-3);margin:6px 0 12px">${escapar(vaga.certificado.codigo)}</p>
        <a class="btn btn-linha btn-mini btn-bloco" href="/verificar/${encodeURIComponent(vaga.certificado.codigo)}">Ver certificado</a>
      </div>` : ''}
    </div>
  </div>`
}

// ─── perfil público ──────────────────────────────────────────────────────────

function telaPerfil () {
  const p = estado.perfilAberto
  if (!p) return vazio('❓', 'Perfil não encontrado', 'Este perfil pode ter sido removido.')

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
          { rotulo: 'Trampos concluídos', valor: String(p.trabalhosConcluidos) },
          { rotulo: 'Avaliação', valor: p.avaliacao.total ? `${p.avaliacao.media.toFixed(1)} de 5` : 'sem avaliação' }
        ]
      : [
          { rotulo: 'Vagas publicadas', valor: String(p.vagasPublicadas) },
          { rotulo: 'Taxa de confirmação', valor: p.taxaDeConfirmacao === null ? '—' : `${p.taxaDeConfirmacao}%` },
          { rotulo: 'Tempo até confirmar', valor: p.tempoMedioAteConfirmarHoras === null ? '—' : `${p.tempoMedioAteConfirmarHoras}h` }
        ],
    acoes: p.souEu ? '<button class="btn btn-linha" data-acao="editar-perfil">Editar perfil</button>' : ''
  })}

  ${p.bio ? `<div class="painel"><h4>Sobre</h4><p style="font-size:14px;white-space:pre-wrap;line-height:1.65">${escapar(p.bio)}</p></div>` : ''}

  ${ehEstudante && p.habilidades?.length ? `<div class="painel">
    <h4>Habilidades</h4>
    <div class="etiquetas">${p.habilidades.map((h) => `<span class="etiqueta">${escapar(h)}</span>`).join('')}</div>
  </div>` : ''}

  ${p.links?.length ? `<div class="painel">
    <h4>Links</h4>
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
              <span class="cert-estado ${c.registrado ? 'pronto' : 'processando'}">${c.registrado ? 'verificável' : 'processando'}</span>
            </div>
          </a>`).join('')}</div>`
      : vazio('🎓', 'Nenhum certificado ainda', p.souEu
          ? 'Conclua um trampo e o certificado aparece aqui, pronto para mostrar.'
          : 'Esta pessoa ainda não concluiu nenhum trampo pela plataforma.')}

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
          ? 'Adicione trabalhos que você já fez. É o que um contratante olha antes de escolher.'
          : 'Esta pessoa ainda não publicou trabalhos.')}
  ` : ''}

  <div class="secao"><h2>Avaliações</h2><span class="conta">${p.avaliacoes.length}</span></div>
  ${p.avaliacoes.length
    ? `<div style="display:flex;flex-direction:column;gap:12px">${p.avaliacoes.map((a) => `<div class="painel">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
          <strong style="font-size:13.5px">${escapar(a.autor)}</strong>
          <span style="color:var(--laranja-txt);font-size:13px">${estrelas(a.nota)}</span>
          <span style="margin-left:auto;font-size:12px;color:var(--ink-3)">${quando(a.quando)}</span>
        </div>
        <p style="font-size:12.5px;color:var(--ink-3);margin-bottom:6px">${escapar(a.vaga)}</p>
        ${a.comentario ? `<p style="font-size:13.5px;color:var(--ink-2)">${escapar(a.comentario)}</p>` : ''}
      </div>`).join('')}</div>`
    : vazio('★', 'Nenhuma avaliação ainda', 'As avaliações aparecem quando um trampo é concluído pelos dois lados.')}`
}

// ─── notificações ────────────────────────────────────────────────────────────

function telaNotificacoes () {
  const p = estado.preferencias
  const naoLidas = estado.notificacoes.filter((n) => !n.lida).length

  return heroi({
    cor: 'grafite',
    olho: 'Sua caixa',
    titulo: 'Notificações',
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
        : vazio('🔔', 'Nada por aqui ainda', 'Quando alguém se candidatar, entregar ou confirmar um trampo seu, o aviso aparece aqui.')}
    </div>

    <div class="painel">
      <h4>${ico('sino')} Como ser avisado</h4>
      <dl class="dados">
        <div class="linha-dado"><dt>No aplicativo</dt><dd style="color:var(--verde-txt);font-family:var(--sans)">sempre</dd></div>
      </dl>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:12px">
        <button class="btn ${p?.email ? 'btn-primario' : 'btn-linha'} btn-mini btn-bloco" data-pref="email">
          Por e-mail: ${p?.email ? 'ligado' : 'desligado'}
        </button>
        <button class="btn ${p?.push ? 'btn-primario' : 'btn-linha'} btn-mini btn-bloco" data-pref="push"
                ${estado.pushDisponivel ? '' : 'disabled'}>
          No navegador: ${estado.pushDisponivel ? (p?.push ? 'ligado' : 'desligado') : 'indisponível'}
        </button>
      </div>

      <h4 style="margin-top:18px">Quando</h4>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${[['instant', 'Na hora'], ['daily', 'Resumo diário'], ['off', 'Desligado']].map(([valor, rotulo]) => `
          <button class="btn ${p?.digest === valor ? 'btn-primario' : 'btn-linha'} btn-mini btn-bloco" data-digest="${valor}">
            ${rotulo}
          </button>`).join('')}
      </div>
    </div>
  </div>`
}

// ─── mediação ────────────────────────────────────────────────────────────────

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
      <div class="mono" style="font-size:15px;font-weight:700">${valorGrande(c.valorCentavos)}</div>
    </div>
    <p style="font-size:13px;color:var(--ink-2);line-height:1.55;margin-bottom:10px">${escapar(c.detalhe)}</p>
    <div class="etiquetas" style="margin-bottom:10px">
      <span class="etiqueta">${escapar(c.statusRotulo)}</span>
      <span class="etiqueta" style="${c.atrasada ? 'color:var(--vermelho-txt);border-color:rgba(239,68,68,.3)' : ''}">
        prazo ${dataBR(c.prazoEm)}${c.atrasada ? ' · atrasada' : ''}
      </span>
    </div>
    ${c.resolucao ? `<p style="font-size:12.5px;color:var(--ink-3);white-space:pre-wrap">${escapar(c.resolucao)}</p>` : ''}
    ${['open', 'in_review'].includes(c.status) ? `<div style="display:flex;gap:8px;flex-wrap:wrap">
      ${c.status === 'open' ? `<button class="btn btn-linha btn-mini" data-assumir="${escapar(c.id)}">Assumir análise</button>` : ''}
      <button class="btn btn-primario btn-mini" data-resolver="${escapar(c.id)}">Decidir</button>
      <button class="btn btn-fantasma btn-mini" data-vaga="${escapar(c.vagaId)}">Ver o trampo</button>
    </div>` : ''}
  </div>`

  return heroi({
    cor: 'grafite',
    olho: 'Equipe de mediação',
    titulo: 'Contestações',
    texto: 'Quando as duas partes discordam, o valor fica parado até alguém decidir. Cada caso tem prazo, e o que você decide aqui move dinheiro de verdade.',
    arte: orbe('⚖️', 'Me')
  }) + `

  <div class="secao"><h2>Aguardando decisão</h2><span class="conta">${abertas.length}</span></div>
  ${abertas.length
    ? `<div style="display:flex;flex-direction:column;gap:14px">${abertas.map(cartao).join('')}</div>`
    : vazio('✓', 'Nenhuma contestação aberta', 'Quando alguém contestar um trampo, o caso aparece aqui com o prazo de análise.')}

  ${resolvidas.length ? `
    <div class="secao"><h2>Resolvidas</h2><span class="conta">${resolvidas.length}</span></div>
    <div style="display:flex;flex-direction:column;gap:14px">${resolvidas.map(cartao).join('')}</div>` : ''}`
}

// ─── painel da direita ───────────────────────────────────────────────────────

/** Um cartao da barra, com título, icone e o que vier dentro. */
function widget (titulo, icone, corpo, selo = '') {
  return `<div class="widget">
    <div class="widget-topo">
      <h3>${ico(icone)} ${escapar(titulo)}</h3>
      ${selo}
    </div>
    ${corpo}
  </div>`
}

const linhaDeValor = (rotulo, centavos, { destaque = false, nota = null } = {}) =>
  `<div class="linha ${destaque ? 'destaque' : ''}">
    <span>${escapar(rotulo)}</span>
    <b>${escapar(valorGrande(centavos))}${nota ? `<small>${escapar(nota)}</small>` : ''}</b>
  </div>`

const passoNumerado = (n, titulo, texto) =>
  `<div class="mini-passo">
    <span class="n" aria-hidden="true">${n}</span>
    <div><b>${escapar(titulo)}</b><p>${escapar(texto)}</p></div>
  </div>`

/**
 * A barra da direita responde "onde esta a minha grana".
 *
 * Antes ela falava de ecossistema, atividade da rede e do que roda por baixo do
 * capo: informação sobre o mecanismo, no lugar mais nobre da tela. Agora ela
 * responde quanto a pessoa tem esperando, reservado e recebido, e o resto desce
 * para a gaveta fechada do rodape.
 */
function renderDir () {
  const u = estado.usuario
  const r = estado.resumo
  const t = estado.metricas?.totais
  const porStatus = r?.vagasPorStatus ?? {}

  if (!u) {
    $('#dir-widgets').innerHTML =
      widget('Como funciona', 'raio',
        passoNumerado(1, 'O contratante reserva', 'O valor sai da conta dele antes de você começar.') +
        passoNumerado(2, 'Você faz e entrega', 'Pelo site mesmo, com arquivo ou recado.') +
        passoNumerado(3, 'Recebe e comprova', 'A confirmação paga e emite o certificado.')) +
      widget('O que já rolou aqui', 'grafico',
        linhaDeValor('Pago a estudantes', t?.pagoCentavos) +
        linhaDeValor('Reservado agora', t?.reservadoCentavos) +
        `<div class="linha"><span>Horas certificadas</span><b>${t?.horasCertificadas ?? 0}h</b></div>
         <div class="linha"><span>Certificados</span><b>${t?.certificados ?? 0}</b></div>`)
    return
  }

  if (u.perfil === 'student') {
    const esperando = r?.esperandoRespostaCentavos ?? 0
    const candidaturas = r?.candidaturasPendentes ?? 0

    $('#dir-widgets').innerHTML =
      widget('Sua grana', 'lock',
        linhaDeValor('Esperando resposta', esperando, {
          nota: candidaturas ? `${candidaturas} ${candidaturas === 1 ? 'candidatura' : 'candidaturas'}` : null
        }) +
        linhaDeValor('Reservado pra você', r?.valores?.reservadoCentavos, { destaque: true }) +
        linhaDeValor('Já recebido', r?.valores?.movimentadoCentavos) +
        '<p style="margin-top:9px">Quando você é escolhida, o valor já está travado. Ninguém consegue tirar de lá.</p>') +
      widget('Como funciona', 'raio',
        passoNumerado(1, 'Você se candidata', 'Vendo o valor já reservado.') +
        passoNumerado(2, 'Faz e entrega', 'Pelo site mesmo, com arquivo ou recado.') +
        passoNumerado(3, 'Recebe e comprova', 'A confirmação paga e emite o certificado.'))
    return
  }

  const publicadas = Object.values(porStatus).reduce((soma, n) => soma + n, 0)
  const reservadas = (porStatus.garantida ?? 0) + (porStatus.aceita ?? 0) +
    (porStatus.em_andamento ?? 0) + (porStatus.entregue ?? 0)

  $('#dir-widgets').innerHTML =
    widget('Suas vagas', 'pasta',
      `<div class="linha"><span>Publicadas</span><b>${publicadas}</b></div>
       <div class="linha"><span>Com valor reservado</span><b>${reservadas}</b></div>
       <div class="linha"><span>Concluídas</span><b>${porStatus.concluida ?? 0}</b></div>
       <div class="linha"><span>Certificados emitidos</span><b>${r?.certificadosEmitidos ?? 0}</b></div>` +
      linhaDeValor('Reservado agora', r?.valores?.reservadoCentavos, { destaque: true })) +
    widget('Como funciona', 'check',
      passoNumerado(1, 'Pública a vaga', 'Título, valor e carga horária.') +
      passoNumerado(2, 'Reserva o valor', 'Sai da sua conta e fica travado.') +
      passoNumerado(3, 'Confirma a entrega', 'O mesmo clique paga e certifica.'))
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

/**
 * Onde cada pessoa cai ao entrar.
 *
 * O contratante vai para as vagas dele. Mandar quem paga para a lista de
 * trampos de outras empresas era o erro mais caro do painel: a pessoa que
 * publica não via o que precisava decidir.
 */
const viewInicial = () => (estado.usuario?.perfil === 'company' ? 'minhas' : 'feed')

function render () {
  // Uma tela que exige sessão nunca e desenhada sem sessão.
  if (!estado.usuario && EXIGEM_SESSAO.includes(estado.view)) estado.view = 'entrar'
  if (estado.usuario && estado.view === 'entrar') estado.view = viewInicial()

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
      titulo: 'O pagamento vem antes de você aceitar',
      corpo: 'O contratante reserva o valor no ato de publicar. Quando você ve "garantido" num cartão, o dinheiro já saiu da conta dele e está separado. Você só aceita sabendo que vai receber.'
    },
    {
      arte: '🎓',
      titulo: 'Todo trampo concluído vira certificado',
      corpo: 'Quando o contratante confirma a entrega, o pagamento sai e o certificado com a carga horária é emitido no mesmo instante. Ele tem código público: a coordenação do seu curso confere sem precisar de conta.'
    },
    {
      arte: '🤝',
      titulo: 'Se algo der errado, há para quem recorrer',
      corpo: 'Entregou e o contratante sumiu? Você abre uma contestação e o valor fica parado até alguém da equipe analisar, com prazo. E se ninguém confirmar nem contestar, o pagamento sai sozinho depois de sete dias.'
    }
  ],
  company: [
    {
      arte: '🔒',
      titulo: 'Reservar o valor é o que atrai gente boa',
      corpo: 'Publicar e reservar são dois passos. Enquanto você não reserva, o trampo aparece sem garantia e não dá para escolher ninguém. Com o valor reservado, o estudante ve a garantia e o trampo fica muito mais atraente.'
    },
    {
      arte: '✓',
      titulo: 'Confirmar a entrega paga e certifica de uma vez',
      corpo: 'Um clique faz as duas coisas: libera o valor para o estudante e emite o certificado com a carga horária. Você não precisa fazer mais nada depois.'
    },
    {
      arte: '⏱',
      titulo: 'O prazo corre para os dois lados',
      corpo: 'Você tem sete dias para confirmar ou contestar uma entrega. Passado o prazo sem resposta, o sistema confirma sozinho. Sua taxa de confirmação fica visível no seu perfil, e e o que o estudante olha antes de aceitar.'
    }
  ]
}

function jaViuOGuia (perfil) {
  try {
    return (localStorage.getItem(CHAVE_GUIA) ?? '').split(',').includes(perfil)
  } catch {
    // Sem armazenamento, mostrar o guia toda vez seria pior do que não mostrar.
    return true
  }
}

function marcarGuiaComoVisto (perfil) {
  try {
    const vistos = new Set((localStorage.getItem(CHAVE_GUIA) ?? '').split(',').filter(Boolean))
    vistos.add(perfil)
    localStorage.setItem(CHAVE_GUIA, [...vistos].join(','))
  } catch { /* sem armazenamento: o guia volta na próxima sessão */ }
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
        <button class="btn btn-primario" data-guia="proximo">
          ${ultimo ? 'Entendi, vamos la' : 'Próximo'}
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
        nenhuma extensão para instalar.
      </p>
      <form id="form-criar">
        <div class="campo"><label for="cc-nome">Nome completo</label>
          <input id="cc-nome" required minlength="2" placeholder="${ehEstudante ? 'Marina Alves' : 'Produtora XPTO'}"></div>
        <div class="campo"><label for="cc-email">E-mail</label>
          <input id="cc-email" type="email" required autocomplete="email" placeholder="seu.nome@${ehEstudante ? 'universidade.br' : 'empresa.com.br'}"></div>
        ${ehEstudante ? `<div class="linha-2">
          <div class="campo"><label for="cc-universidade">Universidade</label><input id="cc-universidade" placeholder="USP"></div>
          <div class="campo"><label for="cc-curso">Curso</label><input id="cc-curso" placeholder="Design"></div>
        </div>` : ''}
      </form>`,
    rodape: `<button class="btn btn-fantasma" data-fechar>Cancelar</button>
             <button class="btn btn-primario" id="cc-ok">Criar minha conta</button>`,
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
          avisar('Conta criada', 'Sua conta já está pronta para receber.', 'ok')
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
          <button type="button" data-escolher-modalidade="remoto" aria-pressed="false"><strong>Remoto</strong><span>Design, código, tradução</span></button>
        </div>
      </div>
      <div class="campo"><label for="v-titulo">Título</label>
        <input id="v-titulo" required minlength="6" placeholder="Staff de credenciamento no congresso"></div>
      <div class="campo"><label for="v-descricao">Descrição</label>
        <textarea id="v-descricao" required minlength="20" placeholder="Explique o que precisa ser feito, quando e o que você espera da entrega."></textarea></div>
      <div class="linha-2">
        <div class="campo"><label for="v-categoria">Categoria</label>
          <input id="v-categoria" required placeholder="Eventos" list="categorias">
          <datalist id="categorias">
            <option>Eventos</option><option>Monitoria</option><option>Pesquisa</option>
            <option>Design</option><option>Desenvolvimento</option><option>Tradução</option>
            <option>Conteúdo</option><option>Fotografia</option>
          </datalist></div>
        <div class="campo" id="campo-local"><label for="v-local">Local</label>
          <input id="v-local" placeholder="São Paulo, SP"></div>
      </div>
      <div class="linha-2">
        <div class="campo"><label for="v-valor">Quanto você paga</label>
          <input id="v-valor" type="number" min="1" step="1" required placeholder="240">
          <span class="dica" id="dica-valor">Você reserva esse valor no próximo passo.</span></div>
        <div class="campo"><label for="v-horas">Carga horária</label>
          <input id="v-horas" type="number" min="0.5" step="0.5" required placeholder="12">
          <span class="dica">Vai no certificado do estudante.</span></div>
      </div>
    </form>`,
    rodape: `<button class="btn btn-fantasma" data-fechar>Cancelar</button>
             <button class="btn btn-primario" id="salvar-vaga">Publicar</button>`,
    aoMontar (raiz) {
      let modalidade = 'presencial'
      $$('#escolha-modalidade button', raiz).forEach((b) => b.addEventListener('click', () => {
        modalidade = b.dataset.escolherModalidade
        $$('#escolha-modalidade button', raiz).forEach((o) => o.setAttribute('aria-pressed', String(o === b)))
        $('#campo-local', raiz).style.display = modalidade === 'presencial' ? '' : 'none'
      }))

      // O campo recebe o valor na moeda do pagamento, mas quem digita pensa em
      // real: a dica mostra o equivalente enquanto a pessoa escreve.
      const campoValor = $('#v-valor', raiz)
      const dicaValor = $('#dica-valor', raiz)
      campoValor.addEventListener('input', () => {
        const unidades = Number(campoValor.value)
        const equivalente = unidades > 0 ? real(unidades * 100) : null
        dicaValor.textContent = equivalente
          ? `${equivalente}, hoje. Você reserva esse valor no próximo passo.`
          : 'Você reserva esse valor no próximo passo.'
      })

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
             <button class="btn btn-primario" id="m-ok">${escapar(textoBotao)}</button>`,
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
             <button class="btn btn-primario" id="a-ok">Enviar avaliação</button>`,
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
          avisar('Avaliação registrada', '', 'ok')
          await abrirVaga(vagaId)
        } catch { /* o aviso de erro já apareceu */ }
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
    titulo: 'Abrir contestação',
    corpo: `<p style="font-size:13.5px;color:var(--ink-3);margin-bottom:18px;line-height:1.6">
        Enquanto a contestação estiver aberta, os <strong style="color:var(--ink)">${valorGrande(vaga.valorCentavos)}</strong>
        ficam parados: nem saem para o estudante, nem voltam para o contratante. Uma pessoa da
        equipe analisa e decide, com prazo.
      </p>
      <div class="campo">
        <label for="ct-motivo">Qual é o problema?</label>
        <select id="ct-motivo">
          ${motivos.map((m) => `<option value="${escapar(m.valor)}">${escapar(m.rotulo)}</option>`).join('')}
        </select>
      </div>
      <div class="campo">
        <label for="ct-detalhe">Conte o que aconteceu</label>
        <textarea id="ct-detalhe" placeholder="Datas, o que foi combinado, o que aconteceu de fato."></textarea>
        <span class="dica">Mínimo de 20 caracteres. As duas partes leem o que você escrever.</span>
      </div>`,
    rodape: `<button class="btn btn-fantasma" data-fechar>Voltar</button>
             <button class="btn btn-primario" id="ct-ok">Abrir contestação</button>`,
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
          avisar('Contestação aberta', 'O valor ficou parado e a equipe vai analisar dentro do prazo.', 'ok')
          await abrirVaga(vaga.id)
        } catch {
          botao.disabled = false
          botao.textContent = 'Abrir contestação'
        }
      })
    }
  })
}

function modalResolver (contestacao) {
  let resultado = 'split'
  let divisao = 50

  abrirModal({
    titulo: 'Decidir a contestação',
    corpo: `<p style="font-size:13.5px;color:var(--ink-2);margin-bottom:16px">
        <strong>${escapar(contestacao.vagaTitulo ?? '')}</strong><br>
        ${valorGrande(contestacao.valorCentavos)} · ${escapar(contestacao.motivoRotulo)}
      </p>
      <div class="painel" style="margin-bottom:18px">
        <h4>O que foi alegado</h4>
        <p style="font-size:13px;color:var(--ink-2);white-space:pre-wrap">${escapar(contestacao.detalhe)}</p>
      </div>
      <div class="campo">
        <label>Decisão</label>
        <div class="escolha" id="r-resultado" style="grid-template-columns:1fr">
          <button type="button" data-resultado="split" aria-pressed="true"><strong>Dividir o valor</strong><span>Houve trabalho parcial</span></button>
          <button type="button" data-resultado="resolved_student" aria-pressed="false"><strong>Tudo para o estudante</strong><span>A entrega procede</span></button>
          <button type="button" data-resultado="resolved_company" aria-pressed="false"><strong>Tudo de volta para o contratante</strong><span>Não houve entrega</span></button>
        </div>
      </div>
      <div class="campo" id="r-divisao-campo">
        <label for="r-divisao">Quanto vai para o estudante: <span id="r-divisao-valor">50%</span></label>
        <input id="r-divisao" type="range" min="5" max="95" step="5" value="50" style="padding:0">
        <span class="dica" id="r-previa"></span>
      </div>
      <div class="campo">
        <label for="r-resolucao">Explique a decisão</label>
        <textarea id="r-resolucao" placeholder="As duas partes leem isto. Diga no que você se baseou."></textarea>
      </div>`,
    rodape: `<button class="btn btn-fantasma" data-fechar>Cancelar</button>
             <button class="btn btn-primario" id="r-ok">Confirmar decisão</button>`,
    aoMontar (raiz) {
      const campoDivisao = $('#r-divisao-campo', raiz)
      const previa = $('#r-previa', raiz)

      const atualizarPrevia = () => {
        const total = contestacao.valorCentavos ?? 0
        const bps = resultado === 'resolved_student' ? 10000 : resultado === 'resolved_company' ? 0 : divisao * 100
        const bruto = Math.floor((total * bps) / 10000)
        const taxa = Math.floor((bruto * 500) / 10000)
        previa.textContent = `Estudante recebe ${valorGrande(bruto - taxa)}, contratante recebe ${valorGrande(total - bruto)}.`
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
          avisar('Explique a decisão', 'Escreva pelo menos 20 caracteres: as duas partes vão ler.', 'erro')
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
          avisar('Contestação resolvida', saida.pagamentoEmProcessamento
            ? 'A decisão foi registrada e o valor está sendo movimentado.'
            : 'A decisão foi registrada e o valor já foi movimentado.', 'ok')
          await carregarContestacoes()
          render()
        } catch {
          botao.disabled = false
          botao.textContent = 'Confirmar decisão'
        }
      })
    }
  })
}

function modalEditarPerfil () {
  const p = estado.perfilAberto
  abrirModal({
    titulo: 'Editar perfil',
    corpo: `<div class="campo"><label for="pf-headline">Uma linha sobre você</label>
        <input id="pf-headline" maxlength="140" value="${escapar(p.headline ?? '')}" placeholder="Design de produto e pesquisa com usuário"></div>
      <div class="campo"><label for="pf-bio">Sobre</label>
        <textarea id="pf-bio" maxlength="600" placeholder="O que você faz, o que já fez, o que procura.">${escapar(p.bio ?? '')}</textarea></div>
      ${p.perfil === 'student' ? `<div class="linha-2">
        <div class="campo"><label for="pf-universidade">Universidade</label><input id="pf-universidade" value="${escapar(p.universidade ?? '')}"></div>
        <div class="campo"><label for="pf-curso">Curso</label><input id="pf-curso" value="${escapar(p.curso ?? '')}"></div>
      </div>
      <div class="campo"><label for="pf-habilidades">Habilidades</label>
        <input id="pf-habilidades" value="${escapar((p.habilidades ?? []).join(', '))}" placeholder="Figma, Pesquisa, Prototipagem">
        <span class="dica">Separadas por virgula.</span></div>` : ''}
      <div class="campo"><label for="pf-link">Link principal</label>
        <input id="pf-link" value="${escapar(p.links?.[0]?.url ?? '')}" placeholder="https://seu-site.com.br">
        <span class="dica">Endereço completo, começando com https://</span></div>`,
    rodape: `<button class="btn btn-fantasma" data-fechar>Cancelar</button>
             <button class="btn btn-linha" data-enviar="avatar">Trocar foto</button>
             <button class="btn btn-primario" id="pf-ok">Salvar</button>`,
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
      if (!resposta.ok) return avisar(dados.error ?? 'Não conseguimos enviar o arquivo', '', 'erro')
      avisar('Arquivo enviado', arquivo.name, 'ok')
      if (estado.view === 'perfil') await abrirPerfil(estado.perfilAberto.id)
      else if (estado.vagaAberta) await abrirVaga(estado.vagaAberta.id)
    } catch {
      avisar('Não conseguimos enviar o arquivo', 'Tente de novo em instantes.', 'erro')
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
    if (resumo) resumo.textContent = `${dados.cluster} · escrow ${dados.escrow.driver} · ${estado.registros.length} transações`
    renderCamadaTecnica(dados)
  } catch {
    const alvo = $('#gaveta-conteudo')
    if (alvo) alvo.innerHTML = '<div class="gaveta-vazia">Status da rede indisponível.</div>'
  }
}

function renderCamadaTecnica (dados) {
  const alvo = $('#gaveta-conteudo')
  if (!alvo) return
  const cabecalho = `<div class="gaveta-linha" style="border-top:0">
    <span class="gaveta-tipo">ambiente</span>
    <span class="gaveta-dado">
      cluster <b>${escapar(dados.cluster)}</b> · rpc <b>${escapar(dados.rpc)}</b><br>
      rede alcançável <b>${dados.rede.alcancavel ? 'sim' : 'nao'}</b>${dados.rede.versao ? ` · solana-core <b>${escapar(dados.rede.versao)}</b>` : ''}<br>
      escrow driver <b>${escapar(dados.escrow.driver)}</b>${dados.escrow.programId ? ` · program id <b>${escapar(dados.escrow.programId)}</b>` : ''}<br>
      certificado driver <b>${escapar(dados.certificado.driver)}</b> · indexador DAS <b>${dados.indexador.configurado ? 'configurado' : 'ausente'}</b><br>
      mint de pagamento <b>${escapar(dados.plataforma.paymentMint ?? 'não criado')}</b><br>
      merkle tree <b>${escapar(dados.plataforma.merkleTree ?? 'não criada')}</b>
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

  alvo.innerHTML = cabecalho + (linhas || '<div class="gaveta-vazia">Nenhuma transação registrada ainda.</div>')
}

/* camada-tecnica:fim */

// ─── acoes ───────────────────────────────────────────────────────────────────

async function executarAcao (acao, vaga) {
  const rotulos = {
    reservar: ['Reservando…', 'Valor reservado', 'O dinheiro saiu da sua conta e está separado para este trampo.'],
    confirmar: ['Confirmando…', 'Tudo certo', 'O pagamento foi liberado e o certificado foi emitido.'],
    comecar: ['Iniciando…', 'Bom trabalho', 'O trampo está em andamento.']
  }

  if (acao === 'entregar') {
    return modalTexto({
      titulo: 'Enviar entrega',
      rotulo: 'Quer deixar alguma observação?',
      dica: 'Onde está o material, o que foi feito, o que ficou pendente.',
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
      rotulo: 'Conte por que você é boa escolha',
      dica: 'Experiência parecida, disponibilidade, o que te faz encaixar.',
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
        avisar('Certificado emitido', `${resposta.certificado.horas}h · código ${resposta.certificado.codigo}`, 'ok')
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
    alvo.innerHTML = '<p style="color:var(--ink-3);font-size:13px">Não conseguimos carregar a conversa agora.</p>'
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
    avisar('Mensagem não enviada', 'Tente de novo em um instante.', 'erro')
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
    avisar('Este navegador não suporta avisos', 'Você continua recebendo dentro do aplicativo.', 'info')
    return false
  }
  const permissao = await Notification.requestPermission()
  if (permissao !== 'granted') {
    avisar('Permissão negada', 'Você pode mudar isso nas configurações do navegador.', 'info')
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
    avisar('Não conseguimos ligar os avisos', 'Tente de novo em instantes.', 'erro')
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
  estado.view = viewInicial()
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
    if (!resposta.ok) throw new Error('não encontrado')
    dados = await resposta.json()
  } catch {
    alvo.innerHTML = `<div class="verificacao">
      <a class="marca" href="/" aria-label="Uni.work, ir para o início" style="margin-bottom:30px">
        <span class="marca-imagem"></span>
      </a>
      ${vazio('❓', 'Certificado não encontrado',
        `Não existe certificado com o código ${codigo}. Confira se o código foi copiado inteiro.`,
        '<a class="btn btn-linha" href="/">Voltar ao início</a>')}
    </div>`
    return
  }

  const c = dados.certificado
  const conf = dados.confirmacaoIndependente
  const selo = dados.valido
    ? (conf.confirmado ? ['valido', '✓', 'Certificado autêntico e confirmado'] : ['parcial', '✓', 'Certificado autêntico'])
    : ['invalido', '✕', 'Este certificado não confere']

  alvo.innerHTML = `<div class="verificacao">
    <a class="marca" href="/" aria-label="Uni.work, ir para o início" style="margin-bottom:30px">
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
        <h4>${ico('check')} O que foi conferido</h4>
        <dl class="dados">
          <div class="linha-dado"><dt>Conteúdo integro</dt><dd style="color:${dados.integridade.confere ? 'var(--verde-txt)' : 'var(--vermelho-txt)'};font-family:var(--sans)">${dados.integridade.confere ? 'sim' : 'não'}</dd></div>
          <div class="linha-dado"><dt>Registro público</dt><dd style="color:${conf.confirmado ? 'var(--verde-txt)' : 'var(--laranja-txt)'};font-family:var(--sans)">${conf.confirmado ? 'confirmado' : 'aguardando'}</dd></div>
          <div class="linha-dado"><dt>Emitido em</dt><dd>${dataBR(c.emitidoEm)}</dd></div>
          <div class="linha-dado"><dt>Código</dt><dd>${escapar(c.codigo)}</dd></div>
        </dl>
        <p style="font-size:12.5px;color:var(--ink-3);margin-top:12px;line-height:1.6">
          ${conf.confirmado
            ? 'A confirmação veio de um serviço independente, não do banco de dados da Uni.work.'
            : conf.motivo === 'indexador_nao_configurado'
              ? 'A confirmação independente não está configurada neste ambiente. A integridade do conteúdo foi conferida localmente.'
              : 'O registro público ainda está sendo processado. A integridade do conteúdo já confere.'}
        </p>
      </div>
      <div class="painel">
        <h4>Detalhes da atividade</h4>
        <dl class="dados">
          <div class="linha-dado"><dt>Categoria</dt><dd style="font-family:var(--sans)">${escapar(c.categoria)}</dd></div>
          <div class="linha-dado"><dt>Modalidade</dt><dd style="font-family:var(--sans)">${escapar(c.modalidade)}</dd></div>
          <div class="linha-dado"><dt>Carga horária</dt><dd>${c.horas}h</dd></div>
          <div class="linha-dado"><dt>Contratante</dt><dd style="font-family:var(--sans)">${escapar(c.contratante)}</dd></div>
        </dl>
      </div>
    </div>

    <p style="margin-top:28px;font-size:13px;color:var(--ink-3)">
      Ambiente de demonstração. Este certificado comprova uma atividade registrada na Uni.work.
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

    // Acao disparada da fila de decisoes, onde nao existe vaga aberta: a vaga
    // vem do proprio botao.
    const fila = alvo('[data-fila]')
    if (fila) {
      const vaga = estado.minhasVagas.find((v) => v.id === fila.dataset.filaVaga)
      if (vaga) executarAcao(fila.dataset.fila, vaga)
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
          avisar('Análise assumida', 'A contestação aparece como em análise para as duas partes.', 'ok')
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
          avisar('Estudante escolhido', 'Agora é só acompanhar a entrega.', 'ok')
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
      estado.view = estado.usuario ? viewInicial() : 'entrar'
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
      if (nome === 'voltar') { estado.view = estado.usuario ? viewInicial() : 'entrar'; render() }
      if (nome === 'meu-perfil') abrirPerfil(estado.usuario.id)
      if (nome === 'editar-perfil') modalEditarPerfil()
      if (nome === 'rever-guia') mostrarGuia(estado.usuario.perfil, { forcado: true })
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

  // A gaveta tecnica e um <details>: quem abre e fecha e o proprio navegador,
  // e o unico trabalho daqui e buscar o conteudo quando ela abre.
  $('#gaveta').addEventListener('toggle', () => {
    if ($('#gaveta').open) carregarCamadaTecnica()
  })

  $('#btn-tema').addEventListener('click', alternarTema)

  // Enquanto a pessoa nao escolheu nada, o sistema manda: se ele trocar de
  // tema no meio da visita, o rotulo do botao acompanha.
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', pintarBotaoDoTema)
  } catch { /* navegador antigo: o rotulo so muda no clique */ }

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

  pintarBotaoDoTema()

  // Decide o modo: se a API nao responde, a interface segue em simulacao. A
  // mesma resposta traz a cotacao, que e o unico jeito de a tela mostrar reais
  // sem ter um numero de cambio escrito aqui dentro.
  try {
    const resposta = await fetch('/api/health')
    if (!resposta.ok) throw new Error('sem saúde')
    const saude = await resposta.json().catch(() => null)
    if (saude?.cotacaoBrlPorUsdc) estado.cotacao = Number(saude.cotacaoBrlPorUsdc)
  } catch {
    estado.modo = 'simulacao'
    marcarOffline(true)
    $('#faixa-offline').innerHTML =
      '<span aria-hidden="true">⚠</span><span>Modo de demonstração: o serviço não respondeu, então a tela está com dados de exemplo. Nenhuma operação real acontece agora.</span>'
  }

  $('#app').classList.add('ativo')

  const guardada = lerSessao()
  if (guardada?.token) {
    estado.token = guardada.token
    estado.usuario = guardada.usuario
    try {
      const { usuario } = await chamar('/me', { silencioso: true })
      estado.usuario = usuario
      estado.view = viewInicial()
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
