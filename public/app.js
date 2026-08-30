// Uni.work — aplicacao de tela unica, sem build.
//
// Dois modos:
//   http       fala com a API de verdade
//   simulacao  a API nao respondeu, entao a interface roda com dados de exemplo
//              em memoria. A faixa no topo avisa. Nada aqui finge que uma
//              operacao foi para a rede quando nao foi.

const $ = (sel, raiz = document) => raiz.querySelector(sel)
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)]

const CHAVE_SESSAO = 'uniwork.sessao'

const estado = {
  modo: 'http',
  usuario: null,
  token: null,
  vagas: [],
  certificados: [],
  resumo: null,
  metricas: null,
  feed: [],
  registros: [],
  view: 'feed',
  filtros: { modalidade: null, status: null, busca: '' },
  vagaAberta: null,
  contestacoes: [],
  motivosDeContestacao: [],
  carregando: false,
  online: true
}

// ─── util ────────────────────────────────────────────────────────────────────

const escapar = (t) => String(t ?? '').replace(/[<>&"']/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]
))

const reais = (centavos) => (Number(centavos) / 100).toLocaleString('pt-BR', {
  style: 'currency', currency: 'BRL', minimumFractionDigits: 0, maximumFractionDigits: 0
})

const reaisExato = (centavos) => (Number(centavos) / 100).toLocaleString('pt-BR', {
  style: 'currency', currency: 'BRL'
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

function iniciais (nome) {
  return String(nome ?? '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase()
}

function corDe (texto) {
  const cores = ['', 'verde', 'laranja', 'azul', 'rosa']
  let soma = 0
  for (const ch of String(texto ?? '')) soma += ch.charCodeAt(0)
  return cores[soma % cores.length]
}

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
  if (estado.modo === 'simulacao') return simulacao(caminho, method, body)

  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (estado.token) headers.authorization = `Bearer ${estado.token}`

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
    if (resposta.status === 401) sair(true)
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
// Dados de exemplo para a interface continuar navegavel quando a API nao sobe.
// Toda resposta daqui e marcada, e a faixa no topo deixa claro o que esta
// acontecendo. Nenhuma operacao de valor acontece neste modo.

const SIM = {
  usuario: { id: 'usr_demo', nome: 'Marina Alves', email: 'marina@usp.br', perfil: 'student', universidade: 'USP', curso: 'Design', cor: 'violeta' },
  vagas: [
    { id: 'job_1', titulo: 'Staff de credenciamento no congresso de tecnologia', descricao: 'Recepcao e credenciamento dos participantes durante dois dias de evento. Precisamos de gente comunicativa e pontual.', categoria: 'Eventos', modalidade: 'presencial', local: 'Sao Paulo, SP', valorCentavos: 24000, horas: 12, status: 'garantida', statusRotulo: 'Pagamento reservado', pagamentoGarantido: true, trilha: { etapa: 2, total: 6, cancelada: false }, contratante: { id: 'c1', nome: 'Produtora XPTO' }, criadoEm: new Date(Date.now() - 3600e3).toISOString() },
    { id: 'job_2', titulo: 'Traducao de artigo tecnico PT para EN', descricao: 'Artigo de 4000 palavras sobre energia renovavel. Precisa de revisao final e entrega em formato editavel.', categoria: 'Traducao', modalidade: 'remoto', local: null, valorCentavos: 45000, horas: 10, status: 'aberta', statusRotulo: 'Aberta', pagamentoGarantido: false, trilha: { etapa: 1, total: 6, cancelada: false }, contratante: { id: 'c2', nome: 'Instituto Beta' }, criadoEm: new Date(Date.now() - 7200e3).toISOString() },
    { id: 'job_3', titulo: 'Monitoria de calculo 1 para turma de engenharia', descricao: 'Duas sessoes semanais de monitoria presencial, com preparacao de lista de exercicios.', categoria: 'Monitoria', modalidade: 'presencial', local: 'Campinas, SP', valorCentavos: 60000, horas: 20, status: 'concluida', statusRotulo: 'Concluida', pagamentoGarantido: true, trilha: { etapa: 6, total: 6, cancelada: false }, contratante: { id: 'c3', nome: 'Faculdade Gama' }, criadoEm: new Date(Date.now() - 86400e3 * 5).toISOString() }
  ],
  certificados: [
    { codigo: 'UNI-DEMO-0001', titulo: 'Monitoria de calculo 1 para turma de engenharia', horas: 20, contratante: 'Faculdade Gama', categoria: 'Monitoria', modalidade: 'presencial', emitidoEm: new Date(Date.now() - 86400e3 * 2).toISOString(), registrado: true, emProcessamento: false, hash: 'demo' }
  ]
}

async function simulacao (caminho, method) {
  await new Promise((r) => setTimeout(r, 90))
  if (caminho === '/me') return { usuario: SIM.usuario }
  if (caminho === '/jobs' && method === 'GET') return { vagas: SIM.vagas }
  if (caminho === '/me/certificates') return { certificados: SIM.certificados, horasTotais: 20 }
  if (caminho === '/me/dashboard') {
    return {
      usuario: SIM.usuario,
      certificados: { total: 1, horas: 20 },
      vagasPorStatus: { concluida: 1, garantida: 1 },
      valores: { movimentadoCentavos: 60000, reservadoCentavos: 24000 },
      avaliacao: { media: 5, total: 1 }
    }
  }
  if (caminho === '/metrics') {
    return {
      totais: { estudantes: 12, contratantes: 4, vagas: 3, concluidas: 1, certificados: 1, horasCertificadas: 20, pagoCentavos: 60000, reservadoCentavos: 24000 },
      porStatus: { aberta: 1, garantida: 1, concluida: 1 },
      porCategoria: [{ categoria: 'Eventos', total: 1 }, { categoria: 'Monitoria', total: 1 }],
      porModalidade: { presencial: 2, remoto: 1 },
      contadores: {}
    }
  }
  if (caminho.startsWith('/jobs/')) {
    const id = caminho.split('/')[2]
    const vaga = SIM.vagas.find((v) => v.id === id)
    if (vaga) return { vaga: { ...vaga, timeline: [], candidaturas: [] } }
  }
  const erro = new Error('Esta acao precisa do servico no ar. Estamos em modo de demonstracao.')
  erro.simulacao = true
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
    if (!cru) return null
    return JSON.parse(cru)
  } catch { return null }
}

function sair (silencioso = false) {
  if (!silencioso) chamar('/logout', { method: 'POST', silencioso: true }).catch(() => {})
  estado.usuario = null
  estado.token = null
  try { localStorage.removeItem(CHAVE_SESSAO) } catch { /* nada a limpar */ }
  mostrarPorta()
}

// ─── navegacao ───────────────────────────────────────────────────────────────

const ICONE = {
  feed: 'M4 6h16M4 12h16M4 18h10',
  minhas: 'M4 7h16v13H4zM9 7V4h6v3',
  certificados: 'M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z',
  conta: 'M12 12a4 4 0 100-8 4 4 0 000 8zM5 20a7 7 0 0114 0',
  mediacao: 'M12 3v18M3 8h18M6 8l-3 6a3.5 3.5 0 006 0zM18 8l-3 6a3.5 3.5 0 006 0z'
}

function itensNav () {
  const ehEstudante = estado.usuario?.perfil === 'student'
  return [
    { grupo: 'DESCOBRIR' },
    { id: 'feed', rotulo: 'Vagas abertas', icone: ICONE.feed, badge: estado.vagas.filter((v) => ['aberta', 'garantida'].includes(v.status)).length },
    { grupo: 'MEU' },
    { id: 'minhas', rotulo: ehEstudante ? 'Meus trampos' : 'Minhas vagas', icone: ICONE.minhas },
    ...(ehEstudante ? [{ id: 'certificados', rotulo: 'Meus certificados', icone: ICONE.certificados, badge: estado.certificados.length }] : []),
    { id: 'conta', rotulo: 'Minha conta', icone: ICONE.conta },
    ...(estado.usuario?.mediador
      ? [
          { grupo: 'MEDIACAO' },
          {
            id: 'mediacao',
            rotulo: 'Contestacoes',
            icone: ICONE.mediacao,
            badge: estado.contestacoes.filter((c) => ['open', 'in_review'].includes(c.status)).length
          }
        ]
      : [])
  ]
}

function renderNav () {
  $('#nav').innerHTML = itensNav().map((item) => {
    if (item.grupo) return `<div class="nav-grupo">${item.grupo}</div>`
    const atual = estado.view === item.id
    return `<button class="nav-item" data-view="${item.id}" ${atual ? 'aria-current="page"' : ''}>
      <span class="nav-ico" aria-hidden="true" style="-webkit-mask:url('data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${item.icone}"/></svg>`)}') center/contain no-repeat;mask:url('data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${item.icone}"/></svg>`)}') center/contain no-repeat"></span>
      <span>${item.rotulo}</span>
      ${item.badge ? `<span class="nav-badge">${item.badge}</span>` : ''}
    </button>`
  }).join('')
}

// ─── cartao de vaga ──────────────────────────────────────────────────────────

function trilhaHtml (trilha) {
  const passos = []
  for (let i = 1; i <= (trilha?.total ?? 6); i += 1) {
    const feito = !trilha?.cancelada && i <= (trilha?.etapa ?? 0)
    passos.push(`<span class="trilha-passo ${trilha?.cancelada ? 'cancelado' : feito ? 'feito' : ''}"></span>`)
  }
  return `<div style="display:flex;align-items:center;gap:10px">
    <div class="trilha" role="img" aria-label="Etapa ${trilha?.etapa ?? 0} de ${trilha?.total ?? 6}">${passos.join('')}</div>
    <span class="trilha-legenda">${trilha?.cancelada ? 'cancelada' : `${trilha?.etapa ?? 0}/${trilha?.total ?? 6}`}</span>
  </div>`
}

function cartaoVaga (vaga) {
  return `<button class="cartao" data-vaga="${vaga.id}">
    <div class="cartao-topo">
      <span class="avatar ${corDe(vaga.contratante?.nome)}" aria-hidden="true">${iniciais(vaga.contratante?.nome)}</span>
      <div style="min-width:0;flex:1">
        <div class="cartao-titulo">${escapar(vaga.titulo)}</div>
        <div class="cartao-sub">${escapar(vaga.contratante?.nome ?? 'Contratante')} · ${quando(vaga.criadoEm)}</div>
      </div>
    </div>
    <div class="tags">
      <span class="tag ${vaga.modalidade}">${vaga.modalidade === 'presencial' ? '📍 Presencial' : '🌐 Remoto'}</span>
      <span class="tag">${escapar(vaga.categoria)}</span>
      <span class="tag">${vaga.horas}h</span>
      ${vaga.local ? `<span class="tag">${escapar(vaga.local)}</span>` : ''}
    </div>
    <p class="cartao-desc">${escapar(vaga.descricao)}</p>
    ${trilhaHtml(vaga.trilha)}
    <div class="cartao-rodape">
      <div class="valor">${reais(vaga.valorCentavos)} <small>· ${vaga.horas}h</small></div>
      <span class="garantia ${vaga.pagamentoGarantido ? '' : 'pendente'}">
        ${vaga.pagamentoGarantido ? '🔒 Pagamento garantido' : 'Aguardando reserva'}
      </span>
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

function telaFeed () {
  const termo = estado.filtros.busca.trim().toLowerCase()
  const lista = estado.vagas.filter((v) => {
    if (estado.filtros.modalidade && v.modalidade !== estado.filtros.modalidade) return false
    if (estado.filtros.status && v.status !== estado.filtros.status) return false
    if (termo && !`${v.titulo} ${v.descricao} ${v.categoria}`.toLowerCase().includes(termo)) return false
    return true
  })

  const ehEstudante = estado.usuario?.perfil === 'student'

  return `
  <section class="banner">
    <h1>${ehEstudante ? 'Trampo curto, comprovante na hora' : 'Publique e reserve o valor no ato'}</h1>
    <p>${ehEstudante
      ? 'O valor fica reservado antes de voce aceitar, entao voce ja sabe que vai receber. Quando a entrega e confirmada, o pagamento sai e o certificado com a carga horaria e emitido no mesmo instante.'
      : 'Voce reserva o valor ao publicar, o estudante ve essa garantia antes de aceitar, e a confirmacao de entrega libera o pagamento e emite o certificado de uma vez so.'}</p>
    <div class="banner-acoes">
      ${ehEstudante
        ? '<button class="btn btn-solido" data-filtro-status="garantida">Ver so as garantidas</button>'
        : '<button class="btn btn-solido" data-acao="publicar">Publicar uma vaga</button>'}
      <button class="btn btn-linha" data-view="certificados">${ehEstudante ? 'Meus certificados' : 'Como funciona o certificado'}</button>
    </div>
  </section>

  <div class="secao-topo">
    <h2>Vagas abertas</h2>
    <span class="conta">${lista.length}</span>
    <div class="filtros">
      <button class="chip" data-filtro-modalidade="" aria-pressed="${!estado.filtros.modalidade}">Todas</button>
      <button class="chip" data-filtro-modalidade="presencial" aria-pressed="${estado.filtros.modalidade === 'presencial'}">Presencial</button>
      <button class="chip" data-filtro-modalidade="remoto" aria-pressed="${estado.filtros.modalidade === 'remoto'}">Remoto</button>
      <button class="chip" data-filtro-status="garantida" aria-pressed="${estado.filtros.status === 'garantida'}">Garantidas</button>
    </div>
  </div>

  ${lista.length
    ? `<div class="grade">${lista.map(cartaoVaga).join('')}</div>`
    : vazio('🔍', 'Nenhuma vaga por aqui', termo || estado.filtros.modalidade || estado.filtros.status
        ? 'Nenhuma vaga bate com esse filtro. Tente afrouxar a busca.'
        : 'Ainda nao ha vagas publicadas. Volte daqui a pouco.',
      '<button class="btn btn-linha" data-acao="limpar-filtros">Limpar filtros</button>')}
  `
}

function telaMinhas () {
  const ehEstudante = estado.usuario?.perfil === 'student'
  const minhas = estado.vagas.filter((v) => (
    ehEstudante ? v.estudante?.id === estado.usuario.id : v.contratante?.id === estado.usuario.id
  ))

  const grupos = [
    { titulo: 'Precisam de voce', filtro: (v) => ['aberta', 'garantida', 'aceita', 'em_andamento', 'entregue'].includes(v.status) },
    { titulo: 'Concluidas', filtro: (v) => v.status === 'concluida' },
    { titulo: 'Canceladas', filtro: (v) => v.status === 'cancelada' }
  ]

  if (!minhas.length) {
    return `<section class="banner"><h1>${ehEstudante ? 'Meus trampos' : 'Minhas vagas'}</h1>
      <p>${ehEstudante ? 'Tudo que voce se candidatou ou esta executando aparece aqui.' : 'Tudo que voce publicou aparece aqui, com o estagio de cada vaga.'}</p></section>
      ${vazio('📋', ehEstudante ? 'Voce ainda nao pegou nenhum trampo' : 'Voce ainda nao publicou nada',
        ehEstudante ? 'Procure na lista de vagas abertas e candidate-se a que combinar com voce.' : 'Publique a primeira vaga e reserve o valor para os estudantes verem a garantia.',
        ehEstudante ? '<button class="btn btn-marca" data-view="feed">Ver vagas abertas</button>' : '<button class="btn btn-marca" data-acao="publicar">Publicar vaga</button>')}`
  }

  return `<section class="banner"><h1>${ehEstudante ? 'Meus trampos' : 'Minhas vagas'}</h1>
    <p>${minhas.length} no total. Acompanhe cada etapa e confirme quando estiver tudo certo.</p></section>
    ${grupos.map((g) => {
      const lista = minhas.filter(g.filtro)
      if (!lista.length) return ''
      return `<div class="secao-topo"><h2>${g.titulo}</h2><span class="conta">${lista.length}</span></div>
        <div class="grade">${lista.map(cartaoVaga).join('')}</div>`
    }).join('')}`
}

function telaCertificados () {
  if (estado.usuario?.perfil !== 'student') {
    return `<section class="banner"><h1>Certificados</h1>
      <p>Quando voce confirma a entrega, o estudante recebe o pagamento e um certificado verificavel com a carga horaria daquela atividade. O certificado tem um codigo publico: qualquer pessoa confere, sem precisar de conta.</p></section>
      ${vazio('🎓', 'Os certificados sao dos estudantes', 'Cada entrega que voce confirma emite um. Eles aparecem na conta de quem executou o trampo.')}`
  }

  const total = estado.certificados.reduce((s, c) => s + Number(c.horas), 0)
  return `<section class="banner">
    <h1>${total}h certificadas</h1>
    <p>Cada certificado tem um codigo publico de verificacao. Mande o link para a coordenacao do seu curso ou para um contratante: eles conferem sem precisar de conta.</p>
  </section>
  ${estado.certificados.length
    ? `<div class="cert-grade">${estado.certificados.map((c) => `
      <button class="cert" data-certificado="${escapar(c.codigo)}">
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
      </button>`).join('')}</div>`
    : vazio('🎓', 'Nenhum certificado ainda', 'Conclua um trampo e o certificado com a carga horaria aparece aqui automaticamente, sem voce pedir.',
      '<button class="btn btn-marca" data-view="feed">Ver vagas abertas</button>')}`
}

function telaConta () {
  const u = estado.usuario
  const r = estado.resumo
  return `<section class="banner">
    <h1>${escapar(u.nome)}</h1>
    <p>${escapar(u.perfil === 'student' ? [u.curso, u.universidade].filter(Boolean).join(' · ') || 'Estudante' : 'Contratante')} · ${escapar(u.email)}</p>
  </section>
  <div class="grade">
    <div class="cartao" style="cursor:default">
      <h3 style="font-size:14px">Resumo</h3>
      <dl style="margin:0">
        <div class="dado-linha"><dt>Movimentado</dt><dd class="mono">${reaisExato(r?.valores?.movimentadoCentavos ?? 0)}</dd></div>
        <div class="dado-linha"><dt>Reservado agora</dt><dd class="mono">${reaisExato(r?.valores?.reservadoCentavos ?? 0)}</dd></div>
        <div class="dado-linha"><dt>Horas certificadas</dt><dd class="mono">${r?.certificados?.horas ?? 0}h</dd></div>
        <div class="dado-linha"><dt>Avaliacao</dt><dd class="mono">${(r?.avaliacao?.media ?? 0).toFixed(1)} (${r?.avaliacao?.total ?? 0})</dd></div>
      </dl>
    </div>
    <div class="cartao" style="cursor:default">
      <h3 style="font-size:14px">Como o pagamento funciona</h3>
      <p style="font-size:13.5px;color:var(--ink-2)">O contratante reserva o valor ao publicar. Ele sai da conta dele e fica separado, sem poder voltar sozinho. Quando a entrega e confirmada, o valor vai para o estudante e o certificado e emitido no mesmo instante. Se a vaga for cancelada antes da entrega, o valor volta inteiro para quem reservou.</p>
    </div>
  </div>`
}

// ─── detalhe da vaga ─────────────────────────────────────────────────────────

const ETAPAS_ROTULO = [
  ['aberta', 'Vaga publicada'],
  ['garantida', 'Valor reservado'],
  ['aceita', 'Estudante escolhido'],
  ['em_andamento', 'Trabalho em andamento'],
  ['entregue', 'Entrega enviada'],
  ['concluida', 'Confirmada e paga']
]

function acoesDaVaga (vaga) {
  const u = estado.usuario
  const souContratante = vaga.contratante?.id === u.id
  const souEstudante = vaga.estudante?.id === u.id
  const botoes = []

  if (souContratante) {
    if (vaga.status === 'aberta') botoes.push(['reservar', 'Reservar o valor', 'btn-marca'])
    if (vaga.status === 'entregue') botoes.push(['confirmar', 'Confirmar entrega e pagar', 'btn-marca'])
    if (['aberta', 'garantida', 'aceita', 'em_andamento'].includes(vaga.status)) {
      botoes.push(['cancelar', 'Cancelar vaga', 'btn-perigo'])
    }
  }
  if (souEstudante) {
    if (vaga.status === 'aceita') botoes.push(['comecar', 'Comecar o trabalho', 'btn-marca'])
    if (vaga.status === 'em_andamento') botoes.push(['entregar', 'Enviar entrega', 'btn-marca'])
  }
  if (!souContratante && !souEstudante && u.perfil === 'student' &&
      ['aberta', 'garantida'].includes(vaga.status) && !vaga.minhaCandidatura) {
    botoes.push(['candidatar', 'Quero esse trampo', 'btn-marca'])
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

function telaDetalhe () {
  const vaga = estado.vagaAberta
  if (!vaga) return vazio('🔍', 'Vaga nao encontrada', 'Ela pode ter sido removida.')

  const etapaAtual = vaga.trilha?.etapa ?? 0
  const botoes = acoesDaVaga(vaga)
  const souParte = vaga.contratante?.id === estado.usuario.id || vaga.estudante?.id === estado.usuario.id

  return `
  <button class="btn btn-fantasma btn-mini" data-acao="voltar" style="align-self:flex-start">← Voltar</button>
  <section class="banner">
    <div class="tags" style="margin-bottom:12px">
      <span class="tag ${vaga.modalidade}">${vaga.modalidade === 'presencial' ? '📍 Presencial' : '🌐 Remoto'}</span>
      <span class="tag">${escapar(vaga.categoria)}</span>
      <span class="garantia ${vaga.pagamentoGarantido ? '' : 'pendente'}">
        ${vaga.pagamentoGarantido ? '🔒 Pagamento garantido' : 'Aguardando reserva'}
      </span>
    </div>
    <h1>${escapar(vaga.titulo)}</h1>
    <p>${escapar(vaga.contratante?.nome ?? '')}${vaga.local ? ` · ${escapar(vaga.local)}` : ''}</p>
    <div class="banner-acoes">
      ${botoes.map(([acao, rotulo, classe]) => `<button class="btn ${classe}" data-acao-vaga="${acao}">${rotulo}</button>`).join('')}
    </div>
  </section>

  <div class="detalhe-grade">
    <div style="display:flex;flex-direction:column;gap:20px;min-width:0">
      <div class="painel">
        <h4>DESCRICAO</h4>
        <p style="font-size:14px;white-space:pre-wrap">${escapar(vaga.descricao)}</p>
      </div>

      ${vaga.entregaObservacao ? `<div class="painel">
        <h4>OBSERVACAO DA ENTREGA</h4>
        <p style="font-size:14px;white-space:pre-wrap">${escapar(vaga.entregaObservacao)}</p>
      </div>` : ''}

      ${vaga.candidaturas?.length ? `<div class="painel">
        <h4>CANDIDATURAS (${vaga.candidaturas.length})</h4>
        ${vaga.candidaturas.map((c) => `<div style="display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--line)">
          <span class="avatar ${corDe(c.estudante.nome)}" aria-hidden="true">${iniciais(c.estudante.nome)}</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:14px">${escapar(c.estudante.nome)}</div>
            <div style="font-size:12px;color:var(--ink-4)">${escapar([c.estudante.curso, c.estudante.universidade].filter(Boolean).join(' · '))}</div>
            ${c.apresentacao ? `<p style="font-size:13px;color:var(--ink-2);margin-top:6px">${escapar(c.apresentacao)}</p>` : ''}
          </div>
          ${c.status === 'pendente' && vaga.status === 'garantida'
            ? `<button class="btn btn-solido btn-mini" data-aceitar="${c.id}">Escolher</button>`
            : `<span class="tag">${c.status}</span>`}
        </div>`).join('')}
        ${vaga.status === 'aberta' ? '<p style="font-size:12.5px;color:var(--amarelo);margin-top:10px">Reserve o valor para poder escolher um estudante.</p>' : ''}
      </div>` : ''}

      ${souParte ? `<div class="painel">
        <h4>CONVERSA</h4>
        <div class="conversa" id="conversa"><p style="color:var(--ink-4);font-size:13px">Carregando…</p></div>
        <form id="form-mensagem" style="display:flex;gap:8px;margin-top:12px">
          <label class="sr" for="mensagem-texto">Mensagem</label>
          <input id="mensagem-texto" placeholder="Escreva uma mensagem" style="flex:1;padding:9px 13px;background:var(--surface-3);border:1px solid var(--line);border-radius:var(--r-md)">
          <button class="btn btn-solido btn-mini" type="submit">Enviar</button>
        </form>
      </div>` : ''}
    </div>

    <div style="display:flex;flex-direction:column;gap:16px">
      <div class="painel">
        <h4>PAGAMENTO</h4>
        <div class="valor" style="font-size:27px;margin-bottom:4px">${reaisExato(vaga.valorCentavos)}</div>
        <p style="font-size:12.5px;color:var(--ink-3)">${vaga.horas}h · ${reaisExato(vaga.valorCentavos / vaga.horas)} por hora</p>
        ${vaga.pagamentoGarantido
          ? '<p style="font-size:12.5px;color:var(--verde);margin-top:10px">🔒 O valor ja esta reservado. Ele sai para o estudante assim que a entrega for confirmada.</p>'
          : '<p style="font-size:12.5px;color:var(--ink-4);margin-top:10px">O valor ainda nao foi reservado pelo contratante.</p>'}
      </div>

      <div class="painel">
        <h4>ANDAMENTO</h4>
        <div class="etapas">
          ${ETAPAS_ROTULO.map(([chave, rotulo], i) => {
            const num = i + 1
            const feita = !vaga.trilha?.cancelada && num < etapaAtual
            const atual = !vaga.trilha?.cancelada && num === etapaAtual
            return `<div class="etapa ${feita ? 'feita' : ''} ${atual ? 'atual' : ''}">
              <span class="etapa-bola" aria-hidden="true">${feita ? '✓' : ''}</span>
              <div><div class="etapa-texto">${rotulo}</div></div>
            </div>`
          }).join('')}
          ${vaga.trilha?.cancelada ? '<div class="etapa"><span class="etapa-bola" aria-hidden="true">✕</span><div class="etapa-texto" style="color:var(--vermelho)">Cancelada, valor devolvido</div></div>' : ''}
        </div>
      </div>

      ${vaga.contestacao ? `<div class="painel" style="border-color:rgba(255,197,85,.32)">
        <h4 style="color:var(--amarelo)">CONTESTACAO</h4>
        <p style="font-size:13.5px;font-weight:700;margin-bottom:6px">${escapar(vaga.contestacao.statusRotulo)}</p>
        <p style="font-size:13px;color:var(--ink-2);margin-bottom:10px">${escapar(vaga.contestacao.motivoRotulo)}</p>
        <p style="font-size:13px;color:var(--ink-2);white-space:pre-wrap;margin-bottom:12px">${escapar(vaga.contestacao.detalhe)}</p>
        <div class="dado-linha"><dt>Aberta por</dt><dd>${escapar(vaga.contestacao.abertaPor.nome ?? '-')}</dd></div>
        <div class="dado-linha"><dt>Prazo da analise</dt><dd class="mono">${
          new Date(vaga.contestacao.prazoEm).toLocaleDateString('pt-BR')
        }</dd></div>
        ${vaga.contestacao.resolucao ? `
          <p style="font-size:12px;letter-spacing:1px;color:var(--ink-4);margin:14px 0 6px">DECISAO</p>
          <p style="font-size:13px;color:var(--ink-2);white-space:pre-wrap">${escapar(vaga.contestacao.resolucao)}</p>
          ${vaga.contestacao.divisaoBps !== null ? `<p style="font-size:12.5px;color:var(--ink-3);margin-top:8px">Divisao: ${
            Math.round(vaga.contestacao.divisaoBps / 100)
          }% para o estudante</p>` : ''}
        ` : `<p style="font-size:12.5px;color:var(--ink-4);margin-top:10px">
          Enquanto a contestacao estiver aberta, o valor fica parado. Nem o pagamento sai, nem volta.
        </p>`}
      </div>` : ''}

      ${vaga.autoConfirmaEm && vaga.status === 'entregue' && !vaga.contestacao && !vaga.pagamentoEmProcessamento ? `<div class="painel">
        <h4>PRAZO DE CONFIRMACAO</h4>
        <p style="font-size:13px;color:var(--ink-2)">
          Se ninguem confirmar nem contestar ate
          <strong style="color:var(--ink)">${new Date(vaga.autoConfirmaEm).toLocaleDateString('pt-BR')}</strong>,
          o pagamento e liberado automaticamente para o estudante.
        </p>
      </div>` : ''}

      ${vaga.certificado ? `<div class="painel">
        <h4>CERTIFICADO</h4>
        <p style="font-size:13.5px">${vaga.certificado.horas}h certificadas</p>
        <p class="mono" style="font-size:12px;color:var(--ink-3);margin:6px 0 12px">${escapar(vaga.certificado.codigo)}</p>
        <a class="btn btn-linha btn-mini btn-bloco" href="/verificar/${encodeURIComponent(vaga.certificado.codigo)}">Ver certificado</a>
      </div>` : ''}
    </div>
  </div>`
}

function telaMediacao () {
  const abertas = estado.contestacoes.filter((c) => ['open', 'in_review'].includes(c.status))
  const resolvidas = estado.contestacoes.filter((c) => !['open', 'in_review'].includes(c.status))

  const cartao = (c) => `<div class="cartao" style="cursor:default;border-color:${
    c.atrasada ? 'rgba(255,90,90,.35)' : 'var(--line)'
  }">
    <div class="cartao-topo">
      <span class="avatar ${corDe(c.vagaTitulo)}" aria-hidden="true">${iniciais(c.vagaTitulo)}</span>
      <div style="min-width:0;flex:1">
        <div class="cartao-titulo">${escapar(c.vagaTitulo ?? c.vagaId)}</div>
        <div class="cartao-sub">${escapar(c.motivoRotulo)} · aberta por ${escapar(c.abertaPor.nome ?? '-')}</div>
      </div>
      <div class="valor" style="font-size:16px">${reais(c.valorCentavos ?? 0)}</div>
    </div>
    <p class="cartao-desc" style="-webkit-line-clamp:4">${escapar(c.detalhe)}</p>
    <div class="tags">
      <span class="tag">${escapar(c.statusRotulo)}</span>
      <span class="tag" style="${c.atrasada ? 'color:var(--vermelho)' : ''}">
        prazo ${new Date(c.prazoEm).toLocaleDateString('pt-BR')}${c.atrasada ? ' · atrasada' : ''}
      </span>
    </div>
    ${c.resolucao ? `<p style="font-size:12.5px;color:var(--ink-3);white-space:pre-wrap">${escapar(c.resolucao)}</p>` : ''}
    ${['open', 'in_review'].includes(c.status)
      ? `<div style="display:flex;gap:8px;flex-wrap:wrap">
          ${c.status === 'open' ? `<button class="btn btn-linha btn-mini" data-assumir="${c.id}">Assumir analise</button>` : ''}
          <button class="btn btn-marca btn-mini" data-resolver="${c.id}">Decidir</button>
          <a class="btn btn-fantasma btn-mini" href="#" data-vaga="${c.vagaId}">Ver a vaga</a>
        </div>`
      : ''}
  </div>`

  return `<section class="banner">
    <h1>Contestacoes</h1>
    <p>Quando as duas partes discordam, o valor fica parado ate alguem decidir. Cada caso tem prazo, e o que voce decide aqui move dinheiro de verdade.</p>
  </section>

  <div class="secao-topo"><h2>Aguardando decisao</h2><span class="conta">${abertas.length}</span></div>
  ${abertas.length
    ? `<div class="grade">${abertas.map(cartao).join('')}</div>`
    : vazio('✓', 'Nenhuma contestacao aberta', 'Quando alguem contestar uma vaga, o caso aparece aqui com o prazo de analise.')}

  ${resolvidas.length
    ? `<div class="secao-topo"><h2>Resolvidas</h2><span class="conta">${resolvidas.length}</span></div>
       <div class="grade">${resolvidas.map(cartao).join('')}</div>`
    : ''}`
}

// ─── painel lateral ──────────────────────────────────────────────────────────

function renderLateral () {
  const m = estado.metricas?.totais
  $('#lateral').innerHTML = `
    <div class="widget">
      <h3><span class="pulso" aria-hidden="true"></span>AGORA NA PLATAFORMA</h3>
      <div class="metrica-grade">
        <div class="metrica"><div class="metrica-valor">${m?.vagas ?? 0}</div><div class="metrica-rotulo">vagas</div></div>
        <div class="metrica"><div class="metrica-valor">${m?.certificados ?? 0}</div><div class="metrica-rotulo">certificados</div></div>
        <div class="metrica"><div class="metrica-valor">${m?.horasCertificadas ?? 0}h</div><div class="metrica-rotulo">horas</div></div>
        <div class="metrica"><div class="metrica-valor" style="font-size:17px">${reais(m?.reservadoCentavos ?? 0)}</div><div class="metrica-rotulo">reservado</div></div>
      </div>
    </div>

    <div class="widget">
      <h3>ACONTECENDO</h3>
      <div class="feed">
        ${estado.feed.length
          ? estado.feed.slice(0, 14).map((e, i) => `<div class="feed-item ${i === 0 ? 'novo' : ''}">
              <span class="feed-ponto" aria-hidden="true"></span>
              <div><div class="feed-texto">${escapar(e.label ?? e.type)}</div>
              <div class="feed-quando">${quando(e.created_at)}</div></div>
            </div>`).join('')
          : '<p style="font-size:12.5px;color:var(--ink-4);padding:6px 4px">Nada aconteceu ainda. Assim que alguem publicar ou concluir uma vaga, aparece aqui na hora.</p>'}
      </div>
    </div>

    ${estado.metricas?.porCategoria?.length ? `<div class="widget">
      <h3>CATEGORIAS</h3>
      ${estado.metricas.porCategoria.map((c) => `<div class="dado-linha">
        <dt style="color:var(--ink-2)">${escapar(c.categoria)}</dt><dd class="mono">${c.total}</dd>
      </div>`).join('')}
    </div>` : ''}
  `
}

// ─── render principal ────────────────────────────────────────────────────────

function render () {
  renderNav()
  const telas = {
    feed: telaFeed, minhas: telaMinhas, certificados: telaCertificados,
    conta: telaConta, detalhe: telaDetalhe, mediacao: telaMediacao
  }
  $('#conteudo').innerHTML = (telas[estado.view] ?? telaFeed)()
  renderLateral()
  $('#btn-publicar').hidden = estado.usuario?.perfil !== 'company'
  if (estado.view === 'detalhe' && estado.vagaAberta) carregarConversa(estado.vagaAberta.id)
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

function escFecha (e) { if (e.key === 'Escape') fecharModal() }
function fecharModal () {
  $('#modal-raiz').innerHTML = ''
  document.removeEventListener('keydown', escFecha)
}

function modalPublicar () {
  abrirModal({
    titulo: 'Publicar uma vaga',
    corpo: `<form id="form-vaga">
      <div class="campo">
        <label>Modalidade</label>
        <div class="escolha" id="escolha-modalidade">
          <button type="button" data-modalidade="presencial" aria-pressed="true"><strong>Presencial</strong><span>Evento, monitoria, campo</span></button>
          <button type="button" data-modalidade="remoto" aria-pressed="false"><strong>Remoto</strong><span>Design, codigo, traducao</span></button>
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
          <span class="dica">Em reais. Voce reserva esse valor na proxima etapa.</span></div>
        <div class="campo"><label for="v-horas">Carga horaria</label>
          <input id="v-horas" type="number" min="0.5" step="0.5" required placeholder="12">
          <span class="dica">Vai no certificado do estudante.</span></div>
      </div>
    </form>`,
    rodape: `<button class="btn btn-fantasma" data-fechar>Cancelar</button>
             <button class="btn btn-marca" id="salvar-vaga">Publicar</button>`,
    aoMontar (raiz) {
      let modalidade = 'presencial'
      $$('#escolha-modalidade button', raiz).forEach((b) => b.addEventListener('click', () => {
        modalidade = b.dataset.modalidade
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
              local: modalidade === 'presencial' ? $('#v-local', raiz).value.trim() || null : null,
              valorCentavos: Math.round(Number($('#v-valor', raiz).value) * 100),
              horas: Number($('#v-horas', raiz).value)
            }
          })
          fecharModal()
          avisar('Vaga publicada', 'Agora reserve o valor para os estudantes verem a garantia.', 'ok')
          await recarregar()
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
             <button class="btn btn-marca" id="m-ok">${escapar(textoBotao)}</button>`,
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
             <button class="btn btn-marca" id="a-ok">Enviar avaliacao</button>`,
    aoMontar (raiz) {
      let nota = 5
      $$('#notas button', raiz).forEach((b) => b.addEventListener('click', () => {
        nota = Number(b.dataset.nota)
        $$('#notas button', raiz).forEach((o) => o.setAttribute('aria-pressed', String(o === b)))
      }))
      $('#a-ok', raiz).addEventListener('click', async () => {
        try {
          await chamar(`/jobs/${vagaId}/review`, {
            method: 'POST',
            body: { nota, comentario: $('#a-comentario', raiz).value.trim() || null }
          })
          fecharModal()
          avisar('Avaliacao registrada', '', 'ok')
          await abrirVaga(vagaId)
        } catch { /* o aviso de erro ja apareceu */ }
      })
    }
  })
}

// ─── acoes ───────────────────────────────────────────────────────────────────

async function executarAcao (acao, vaga) {
  const rotulos = {
    reservar: ['Reservando o valor…', 'Valor reservado', 'O dinheiro saiu da sua conta e esta separado para esta vaga.'],
    confirmar: ['Confirmando…', 'Tudo certo', 'O pagamento foi liberado e o certificado foi emitido.'],
    comecar: ['Iniciando…', 'Bom trabalho', 'A vaga esta em andamento.'],
    cancelar: ['Cancelando…', 'Vaga cancelada', 'O valor reservado voltou para a sua conta.']
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
      titulo: 'Cancelar a vaga',
      rotulo: 'Motivo (fica registrado)',
      dica: 'Ajuda o outro lado a entender.',
      textoBotao: 'Cancelar vaga',
      aoConfirmar: async (texto) => {
        await chamar(`/jobs/${vaga.id}/cancel`, { method: 'POST', body: { motivo: texto || null } })
        avisar(rotulos.cancelar[1], rotulos.cancelar[2], 'ok')
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
    if (acao === 'confirmar' && resposta.certificado) {
      avisar('Certificado emitido', `${resposta.certificado.horas}h · codigo ${resposta.certificado.codigo}`, 'ok')
    }
    await abrirVaga(vaga.id)
    await recarregar()
  } catch {
    if (botao) { botao.disabled = false; botao.textContent = acao }
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
      : '<p style="color:var(--ink-4);font-size:13px">Nenhuma mensagem ainda. Diga oi.</p>'
    alvo.scrollTop = alvo.scrollHeight
  } catch {
    alvo.innerHTML = '<p style="color:var(--ink-4);font-size:13px">Nao conseguimos carregar a conversa agora.</p>'
  }
}

// Atualizacao otimista: a mensagem aparece antes da resposta e volta atras se falhar.
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

async function recarregar () {
  const [vagas, metricas] = await Promise.all([
    chamar('/jobs', { silencioso: true }).catch(() => ({ vagas: estado.vagas })),
    chamar('/metrics', { silencioso: true }).catch(() => estado.metricas)
  ])
  estado.vagas = vagas.vagas ?? []
  estado.metricas = metricas ?? estado.metricas

  if (estado.usuario?.perfil === 'student') {
    const certs = await chamar('/me/certificates', { silencioso: true }).catch(() => null)
    if (certs) estado.certificados = certs.certificados
  }
  const resumo = await chamar('/me/dashboard', { silencioso: true }).catch(() => null)
  if (resumo) estado.resumo = resumo

  await carregarContestacoes()

  // Os motivos alimentam o formulario de contestacao das duas partes, e nao so
  // o painel de mediacao.
  if (!estado.motivosDeContestacao.length) {
    const motivos = await chamar('/disputes/motivos', { silencioso: true }).catch(() => null)
    if (motivos) estado.motivosDeContestacao = motivos.motivos
  }

  render()
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

// ─── camada tecnica ──────────────────────────────────────────────────────────
/* camada-tecnica:inicio
   Tudo daqui ate o marcador de fim alimenta a gaveta do rodape. E o unico lugar
   do produto que fala a lingua da rede, e existe para demonstracao. */

async function carregarCamadaTecnica () {
  try {
    const dados = await chamar('/chain/status', { silencioso: true })
    estado.registros = dados.transacoes ?? []
    const resumo = $('#gaveta-resumo')
    if (resumo) {
      resumo.textContent = `${dados.cluster} · escrow ${dados.escrow.driver} · ${estado.registros.length} transacoes`
    }
    renderCamadaTecnica(dados)
  } catch {
    const alvo = $('#gaveta-conteudo')
    if (alvo) alvo.innerHTML = '<div class="gaveta-vazia">Status da rede indisponivel.</div>'
  }
}

function renderCamadaTecnica (dados) {
  const alvo = $('#gaveta-conteudo')
  if (!alvo) return
  const cabecalho = `
    <div class="gaveta-linha" style="border-top:0">
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

  const linhas = estado.registros.map((t) => `
    <div class="gaveta-linha">
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

// ─── eventos ao vivo ─────────────────────────────────────────────────────────

let fonteEventos = null

function ligarEventos () {
  if (estado.modo === 'simulacao' || fonteEventos) return
  fonteEventos = new EventSource('/api/stream')
  fonteEventos.addEventListener('error', () => { /* o navegador reconecta sozinho */ })
  fonteEventos.onmessage = () => {}
  ;['vaga.publicada', 'vaga.garantida', 'vaga.candidatura', 'vaga.aceita', 'vaga.iniciada',
    'vaga.entregue', 'vaga.concluida', 'vaga.cancelada', 'certificado.emitido',
    'certificado.pendente', 'conta.criada', 'avaliacao.registrada',
    'disputa.aberta', 'disputa.resolvida', 'vaga.auto_confirmada'].forEach((tipo) => {
    fonteEventos.addEventListener(tipo, (e) => {
      const evento = JSON.parse(e.data)
      estado.feed.unshift(evento)
      estado.feed = estado.feed.slice(0, 40)
      renderLateral()
      if (tipo.startsWith('disputa.')) carregarContestacoes().then(() => render()).catch(() => {})
      if (['vaga.publicada', 'vaga.garantida', 'vaga.concluida', 'vaga.cancelada'].includes(tipo)) {
        recarregar().catch(() => {})
        carregarCamadaTecnica()
      }
    })
  })
}

// ─── verificacao publica ─────────────────────────────────────────────────────

async function telaVerificacao (codigo) {
  $('#porta').classList.add('escondida')
  $('#app').classList.remove('ativo')
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
      <a class="marca" href="/" style="margin-bottom:30px"><span class="marca-simbolo"></span><span class="marca-nome">Uni<span>.work</span></span></a>
      ${vazio('❓', 'Certificado nao encontrado', `Nao existe certificado com o codigo ${codigo}. Confira se o codigo foi copiado inteiro.`)}
    </div>`
    return
  }

  const c = dados.certificado
  const conf = dados.confirmacaoIndependente
  const selo = dados.valido
    ? (conf.confirmado ? ['valido', '✓', 'Certificado autentico e confirmado'] : ['parcial', '✓', 'Certificado autentico'])
    : ['invalido', '✕', 'Este certificado nao confere']

  alvo.innerHTML = `<div class="verificacao">
    <a class="marca" href="/" style="margin-bottom:30px"><span class="marca-simbolo"></span><span class="marca-nome">Uni<span>.work</span></span></a>
    <div class="verif-selo ${selo[0]}"><span aria-hidden="true">${selo[1]}</span> ${selo[2]}</div>
    <h1 style="font-size:33px;margin-bottom:8px">${escapar(c.estudante)}</h1>
    <p style="font-size:17px;color:var(--ink-2);margin-bottom:26px">
      concluiu <strong style="color:var(--ink)">${escapar(c.atividade)}</strong> para ${escapar(c.contratante)},
      totalizando <strong style="color:var(--ink)">${c.horas} horas</strong> de atividade complementar.
    </p>

    <img src="/api/certificates/${encodeURIComponent(c.codigo)}/image.svg" alt="Certificado de ${escapar(c.atividade)}"
         style="width:100%;border-radius:var(--r-lg);border:1px solid var(--line);margin-bottom:26px">

    <div class="grade">
      <div class="painel">
        <h4>O QUE FOI CONFERIDO</h4>
        <div class="dado-linha"><dt>Conteudo integro</dt><dd style="color:${dados.integridade.confere ? 'var(--verde)' : 'var(--vermelho)'}">${dados.integridade.confere ? 'sim' : 'nao'}</dd></div>
        <div class="dado-linha"><dt>Registro publico</dt><dd style="color:${conf.confirmado ? 'var(--verde)' : 'var(--amarelo)'}">${conf.confirmado ? 'confirmado' : 'aguardando'}</dd></div>
        <div class="dado-linha"><dt>Emitido em</dt><dd class="mono">${new Date(c.emitidoEm).toLocaleDateString('pt-BR')}</dd></div>
        <div class="dado-linha"><dt>Codigo</dt><dd class="mono">${escapar(c.codigo)}</dd></div>
        <p style="font-size:12.5px;color:var(--ink-4);margin-top:12px">
          ${conf.confirmado
            ? 'A confirmacao veio de um servico independente, nao do banco de dados da Uni.work.'
            : conf.motivo === 'indexador_nao_configurado'
              ? 'A confirmacao independente nao esta configurada neste ambiente. A integridade do conteudo foi conferida localmente.'
              : 'O registro publico ainda esta sendo processado. A integridade do conteudo ja confere.'}
        </p>
      </div>
      <div class="painel">
        <h4>DETALHES DA ATIVIDADE</h4>
        <div class="dado-linha"><dt>Categoria</dt><dd>${escapar(c.categoria)}</dd></div>
        <div class="dado-linha"><dt>Modalidade</dt><dd>${escapar(c.modalidade)}</dd></div>
        <div class="dado-linha"><dt>Carga horaria</dt><dd class="mono">${c.horas}h</dd></div>
        <div class="dado-linha"><dt>Contratante</dt><dd>${escapar(c.contratante)}</dd></div>
      </div>
    </div>

    <p style="margin-top:30px;font-size:13px;color:var(--ink-4)">
      Ambiente de demonstracao. Este certificado comprova uma atividade registrada na Uni.work.
    </p>
  </div>`
}

// ─── porta de entrada ────────────────────────────────────────────────────────

function mostrarPorta () {
  $('#porta').classList.remove('escondida')
  $('#app').classList.remove('ativo')
  $('#verificacao').hidden = true
  carregarPrevia()
}

async function carregarPrevia () {
  try {
    const m = await chamar('/metrics', { silencioso: true })
    $('#porta-vagas').textContent = m.totais.vagas
    $('#porta-horas').textContent = `${m.totais.horasCertificadas}h`
    $('#porta-certs').textContent = m.totais.certificados
  } catch { /* a porta funciona sem os numeros */ }

  try {
    const { vagas } = await chamar('/jobs', { silencioso: true })
    const exemplos = [...new Set(vagas.map((v) => v.contratante?.nome).filter(Boolean))].slice(0, 2)
    if (exemplos.length) {
      $('#entrar-exemplos').textContent = `Ambiente de demonstracao com contas de exemplo, entre elas ${exemplos.join(' e ')}.`
    }
  } catch { /* sem exemplos, sem problema */ }
}

async function mostrarApp () {
  $('#porta').classList.add('escondida')
  $('#verificacao').hidden = true
  $('#app').classList.add('ativo')
  await recarregar()
  ligarEventos()
  carregarCamadaTecnica()
}

// ─── ligacao de eventos da interface ─────────────────────────────────────────

function ligarInterface () {
  // abas da porta
  $('#aba-entrar').addEventListener('click', () => trocarAba('entrar'))
  $('#aba-criar').addEventListener('click', () => trocarAba('criar'))

  function trocarAba (qual) {
    $('#aba-entrar').setAttribute('aria-selected', String(qual === 'entrar'))
    $('#aba-criar').setAttribute('aria-selected', String(qual === 'criar'))
    $('#form-entrar').hidden = qual !== 'entrar'
    $('#form-criar').hidden = qual !== 'criar'
  }

  let perfilEscolhido = 'student'
  $$('#escolha-perfil button').forEach((b) => b.addEventListener('click', () => {
    perfilEscolhido = b.dataset.perfil
    $$('#escolha-perfil button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)))
    $('#campos-estudante').style.display = perfilEscolhido === 'student' ? '' : 'none'
  }))

  $('#form-entrar').addEventListener('submit', async (e) => {
    e.preventDefault()
    const botao = $('button[type="submit"]', e.target)
    botao.disabled = true
    try {
      const out = await chamar('/login', { method: 'POST', body: { email: $('#entrar-email').value.trim() } })
      guardarSessao(out.usuario, out.sessao)
      await mostrarApp()
    } finally { botao.disabled = false }
  })

  $('#form-criar').addEventListener('submit', async (e) => {
    e.preventDefault()
    const botao = $('button[type="submit"]', e.target)
    botao.disabled = true
    try {
      const out = await chamar('/signup', {
        method: 'POST',
        body: {
          nome: $('#criar-nome').value.trim(),
          email: $('#criar-email').value.trim(),
          perfil: perfilEscolhido,
          universidade: perfilEscolhido === 'student' ? $('#criar-universidade').value.trim() || null : null,
          curso: perfilEscolhido === 'student' ? $('#criar-curso').value.trim() || null : null
        }
      })
      guardarSessao(out.usuario, out.sessao)
      avisar('Conta criada', 'Sua conta ja esta pronta para receber.', 'ok')
      await mostrarApp()
    } finally { botao.disabled = false }
  })

  $('#btn-sair').addEventListener('click', () => sair())
  $('#btn-publicar').addEventListener('click', modalPublicar)
  $('#ir-inicio').addEventListener('click', (e) => {
    e.preventDefault()
    estado.view = 'feed'
    render()
  })

  let debounce
  $('#busca').addEventListener('input', (e) => {
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      estado.filtros.busca = e.target.value
      if (estado.view !== 'feed') estado.view = 'feed'
      render()
    }, 180)
  })

  // delegacao: um ouvinte para toda a aplicacao
  document.addEventListener('click', (e) => {
    const alvo = (sel) => e.target.closest(sel)

    const nav = alvo('[data-view]')
    if (nav) {
      estado.view = nav.dataset.view
      render()
      $('#conteudo').focus()
      return
    }

    const cartao = alvo('[data-vaga]')
    if (cartao) return void abrirVaga(cartao.dataset.vaga)

    const cert = alvo('[data-certificado]')
    if (cert) { window.location.href = `/verificar/${encodeURIComponent(cert.dataset.certificado)}`; return }

    const modalidade = alvo('[data-filtro-modalidade]')
    if (modalidade) {
      estado.filtros.modalidade = modalidade.dataset.filtroModalidade || null
      render()
      return
    }

    const status = alvo('[data-filtro-status]')
    if (status) {
      estado.filtros.status = estado.filtros.status === status.dataset.filtroStatus ? null : status.dataset.filtroStatus
      estado.view = 'feed'
      render()
      return
    }

    const acao = alvo('[data-acao]')
    if (acao) {
      if (acao.dataset.acao === 'publicar') modalPublicar()
      if (acao.dataset.acao === 'voltar') { estado.view = 'feed'; render() }
      if (acao.dataset.acao === 'limpar-filtros') {
        estado.filtros = { modalidade: null, status: null, busca: '' }
        $('#busca').value = ''
        render()
      }
      return
    }

    const acaoVaga = alvo('[data-acao-vaga]')
    if (acaoVaga && estado.vagaAberta) return void executarAcao(acaoVaga.dataset.acaoVaga, estado.vagaAberta)

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
    }
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
  })

  // gaveta tecnica
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

  // Decide o modo: se a API nao responde, a interface segue em simulacao.
  try {
    const resposta = await fetch('/api/health')
    if (!resposta.ok) throw new Error('sem saude')
  } catch {
    estado.modo = 'simulacao'
    marcarOffline(true)
    $('#faixa-offline').innerHTML = '<span aria-hidden="true">⚠</span><span>Modo de demonstracao: o servico nao respondeu, entao a tela esta com dados de exemplo. Nenhuma operacao real acontece agora.</span>'
  }

  const guardada = lerSessao()
  if (guardada?.token) {
    estado.token = guardada.token
    estado.usuario = guardada.usuario
    try {
      const { usuario } = await chamar('/me', { silencioso: true })
      estado.usuario = usuario
      return mostrarApp()
    } catch {
      estado.token = null
      estado.usuario = null
    }
  }

  if (estado.modo === 'simulacao') {
    estado.usuario = SIM.usuario
    return mostrarApp()
  }

  mostrarPorta()
}

iniciar()
