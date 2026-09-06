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
  { nome: 'Marina Alves', email: 'marina@usp.br', universidade: 'USP', curso: 'Design', headline: 'Design de produto e pesquisa com usuário' },
  { nome: 'Rafael Souza', email: 'rafael@unicamp.br', universidade: 'Unicamp', curso: 'Engenharia de Computação', headline: 'Desenvolvimento web e automação' },
  { nome: 'Beatriz Lima', email: 'beatriz@ufmg.br', universidade: 'UFMG', curso: 'Letras', headline: 'Tradução PT/EN e revisão de texto' },
  { nome: 'Caio Mendes', email: 'caio@ufrj.br', universidade: 'UFRJ', curso: 'Publicidade', headline: 'Produção de evento e conteúdo' },
  { nome: 'Larissa Prado', email: 'larissa@puc-rio.br', universidade: 'PUC-Rio', curso: 'Matemática', headline: 'Monitoria de cálculo e estatística' }
])

export const CONTRATANTES = Object.freeze([
  { nome: 'Produtora XPTO', email: 'contato@xpto.com.br', headline: 'Produção de eventos corporativos' },
  { nome: 'Instituto Beta', email: 'projetos@institutobeta.org', headline: 'Pesquisa aplicada e extensão' },
  { nome: 'Faculdade Gama', email: 'coordenacao@gama.edu.br', headline: 'Ensino superior' },
  { nome: 'Estúdio Delta', email: 'oi@estudiodelta.co', headline: 'Design e produto digital' }
])

/** Os e-mails das personas, para reconhecer quais contas do banco sao delas. */
export const EMAILS_DE_EXEMPLO = Object.freeze(
  [...ESTUDANTES, ...CONTRATANTES].map((p) => p.email)
)
