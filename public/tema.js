// Aplica o tema escolhido antes da primeira pintura.
//
// Isto mora num arquivo proprio, e nao num <script> no meio do HTML, por dois
// motivos: a politica de seguranca da pagina nao permite script inline, e o
// app.js carrega como modulo — portanto depois da tela, o que faria a tela
// piscar clara para quem escolheu escuro.
//
// Quem nunca escolheu nada nao recebe atributo nenhum: ai quem decide e o
// sistema, pela consulta prefers-color-scheme do CSS.
(function () {
  try {
    var salvo = localStorage.getItem('uniwork.tema')
    if (salvo === 'claro' || salvo === 'escuro') {
      document.documentElement.setAttribute('data-tema', salvo)
    }
  } catch (erro) { /* sem armazenamento: segue a preferencia do sistema */ }
})()
