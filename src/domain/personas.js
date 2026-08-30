// As personas ficticias do ambiente de demonstracao.
//
// Ficam aqui, e nao dentro do seed, porque duas partes precisam da mesma
// lista: o seed que cria as contas e a tela de entrada que oferece "entrar
// como". Se cada uma tivesse a sua copia, bastaria trocar um e-mail em um
// lugar para a tela de entrada oferecer uma conta que nao existe.
//
// Sao pessoas e empresas inventadas, como manda a secao 14 do brief. Nenhuma
// delas corresponde a alguem real.

export const ESTUDANTES = Object.freeze([
  { nome: 'Marina Alves', email: 'marina@usp.br', universidade: 'USP', curso: 'Design', headline: 'Design de produto e pesquisa com usuario' },
  { nome: 'Rafael Souza', email: 'rafael@unicamp.br', universidade: 'Unicamp', curso: 'Engenharia de Computacao', headline: 'Desenvolvimento web e automacao' },
  { nome: 'Beatriz Lima', email: 'beatriz@ufmg.br', universidade: 'UFMG', curso: 'Letras', headline: 'Traducao PT/EN e revisao de texto' },
  { nome: 'Caio Mendes', email: 'caio@ufrj.br', universidade: 'UFRJ', curso: 'Publicidade', headline: 'Producao de evento e conteudo' },
  { nome: 'Larissa Prado', email: 'larissa@puc-rio.br', universidade: 'PUC-Rio', curso: 'Matematica', headline: 'Monitoria de calculo e estatistica' }
])

export const CONTRATANTES = Object.freeze([
  { nome: 'Produtora XPTO', email: 'contato@xpto.com.br', headline: 'Producao de eventos corporativos' },
  { nome: 'Instituto Beta', email: 'projetos@institutobeta.org', headline: 'Pesquisa aplicada e extensao' },
  { nome: 'Faculdade Gama', email: 'coordenacao@gama.edu.br', headline: 'Ensino superior' },
  { nome: 'Estudio Delta', email: 'oi@estudiodelta.co', headline: 'Design e produto digital' }
])

/** Os e-mails das personas, para reconhecer quais contas do banco sao delas. */
export const EMAILS_DE_EXEMPLO = Object.freeze(
  [...ESTUDANTES, ...CONTRATANTES].map((p) => p.email)
)
