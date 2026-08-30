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
export const unauthorized = (msg = 'Voce precisa entrar na sua conta para continuar.') => new AppError(msg, { status: 401, codigo: 'nao_autenticado' })
export const forbidden = (msg = 'Esta acao nao esta disponivel para a sua conta.') => new AppError(msg, { status: 403, codigo: 'sem_permissao' })
export const notFound = (msg = 'Nao encontramos o que voce procura.') => new AppError(msg, { status: 404, codigo: 'nao_encontrado' })
export const conflict = (msg, codigo = 'conflito') => new AppError(msg, { status: 409, codigo })
export const tooMany = (msg = 'Muitas tentativas em pouco tempo. Espere um instante e tente de novo.') => new AppError(msg, { status: 429, codigo: 'excesso_de_tentativas' })

/**
 * Falha de rede traduzida para linguagem de produto.
 * O detalhe tecnico vai para o log e para a gaveta tecnica, nunca para a tela.
 */
export function networkTrouble (technicalDetail) {
  const err = new AppError(
    'Nao conseguimos concluir agora, ja estamos tentando de novo.',
    { status: 503, codigo: 'tentando_novamente' }
  )
  err.technicalDetail = technicalDetail
  return err
}
