// Erro de aplicacao com formato estavel: { error, codigo, detalhes }.
// A mensagem e sempre em portugues e sempre em linguagem de produto:
// o usuario nao le jargao de rede, nem quando a rede e o que falhou.

export class AppError extends Error {
  constructor (message, { status = 400, codigo = 'requisicao_invalida', detalhes = null } = {}) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.codigo = codigo
    this.detalhes = detalhes
  }

  toJSON () {
    return { error: this.message, codigo: this.codigo, detalhes: this.detalhes }
  }
}

export const badRequest = (msg, detalhes) => new AppError(msg, { status: 400, codigo: 'requisicao_invalida', detalhes })
export const unauthorized = (msg = 'Você precisa entrar na sua conta para continuar.') => new AppError(msg, { status: 401, codigo: 'nao_autenticado' })
export const forbidden = (msg = 'Esta ação não está disponível para a sua conta.') => new AppError(msg, { status: 403, codigo: 'sem_permissao' })
export const notFound = (msg = 'Não encontramos o que você procura.') => new AppError(msg, { status: 404, codigo: 'nao_encontrado' })
export const conflict = (msg, codigo = 'conflito') => new AppError(msg, { status: 409, codigo })
export const tooMany = (msg = 'Muitas tentativas em pouco tempo. Espere um instante e tente de novo.') => new AppError(msg, { status: 429, codigo: 'excesso_de_tentativas' })

/**
 * Falha de rede traduzida para linguagem de produto.
 * O detalhe tecnico vai para o log e para a gaveta tecnica, nunca para a tela.
 */
export function networkTrouble (technicalDetail) {
  const err = new AppError(
    'Não conseguimos concluir agora, já estamos tentando de novo.',
    { status: 503, codigo: 'tentando_novamente' }
  )
  err.technicalDetail = technicalDetail
  return err
}

/**
 * O ambiente de demonstração não está preparado: falta o token de pagamento ou
 * a árvore do certificado, que nascem no bootstrap.
 *
 * Marcado como permanente de propósito. Repetir não resolve: sem o ambiente
 * pronto, a décima tentativa falha igual à primeira, e o que a pessoa vê é a
 * mesma falha empilhada várias vezes no lugar da causa. Quem lê a tela recebe
 * uma frase de produto; o comando que resolve fica no detalhe técnico.
 */
export function ambienteIncompleto (technicalDetail) {
  const err = new AppError(
    'O ambiente de demonstração ainda não foi preparado, então este valor não pode ser reservado agora.',
    { status: 409, codigo: 'ambiente_incompleto' }
  )
  err.technicalDetail = technicalDetail
  err.permanente = true
  return err
}
