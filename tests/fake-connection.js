// Uma conexao de mentira, que a suite liga e desliga.
//
// Existe para provar a promessa mais importante da fase 3: derrubar a rede no
// meio de uma confirmacao nao perde dinheiro nem certificado. Com uma conexao
// de verdade nao daria para escolher o instante da queda.
//
// Ela nao simula a rede: ela responde o minimo que o codigo de montagem de
// transacao precisa para chegar ate o envio. O que esta sendo testado e a
// recuperacao, nao a rede.

import crypto from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'

export class FakeConnection {
  constructor ({ noAr = true } = {}) {
    this.noAr = noAr
    this.enviadas = []
    this.chamadas = { getLatestBlockhash: 0, sendRawTransaction: 0, confirmTransaction: 0 }
  }

  derrubar () { this.noAr = false }
  levantar () { this.noAr = true }

  #conferir (operacao) {
    if (!this.noAr) {
      const erro = new Error(`failed to send transaction: connect ECONNREFUSED (${operacao})`)
      erro.simulado = true
      throw erro
    }
  }

  async getLatestBlockhash () {
    this.chamadas.getLatestBlockhash += 1
    this.#conferir('getLatestBlockhash')
    return {
      // Precisa ser base58 de exatamente 32 bytes: a montagem da transacao
      // decodifica isto de volta. Uma primeira versao deste arquivo devolvia
      // uma string base58 de tamanho aproximado, o que funcionava quase sempre
      // e falhava de vez em quando, que e o pior tipo de teste.
      blockhash: new PublicKey(crypto.randomBytes(32)).toBase58(),
      lastValidBlockHeight: 1000
    }
  }

  async sendRawTransaction (bytes) {
    this.chamadas.sendRawTransaction += 1
    this.#conferir('sendRawTransaction')
    // Assinatura tem 64 bytes em base58.
    const assinatura = bs58.encode(crypto.randomBytes(64))
    this.enviadas.push({ assinatura, bytes: bytes.length })
    return assinatura
  }

  async confirmTransaction () {
    this.chamadas.confirmTransaction += 1
    this.#conferir('confirmTransaction')
    return { value: { err: null } }
  }

  // As contas de token "nao existem", entao o codigo monta a instrucao que as
  // cria. E o caminho mais comum na vida real de uma conta nova.
  async getAccountInfo () {
    this.#conferir('getAccountInfo')
    return null
  }

  async getBalance () {
    this.#conferir('getBalance')
    return 2_000_000_000
  }

  async getVersion () {
    this.#conferir('getVersion')
    return { 'solana-core': '0.0.0-teste' }
  }
}
