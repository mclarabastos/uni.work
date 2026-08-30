// Conta de rede embutida.
//
// Nasce junto com o cadastro, sem o usuario pedir e sem passo extra. O par de
// chaves e um keypair Solana de verdade; o segredo nunca fica em claro no banco.
//
// Formato do segredo cifrado:  v1.<salt>.<iv>.<tag>.<ciphertext>   (tudo em hex)
//   salt  16 bytes, unico por conta, alimenta o scrypt
//   iv    12 bytes, unico por cifragem, exigido pelo GCM
//   tag   16 bytes de autenticacao: se a chave mestra estiver errada, falha aqui

import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { Keypair } from '@solana/web3.js'
import { config } from '../config.js'

const scrypt = promisify(crypto.scrypt)

const VERSION = 'v1'
const SALT_BYTES = 16
const IV_BYTES = 12
const KEY_BYTES = 32
// Parametros de custo do scrypt. N=16384 leva alguns milissegundos por conta,
// o que e barato para nos e caro para quem tentar forca bruta com o banco na mao.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

async function deriveKey (masterKey, salt) {
  return scrypt(masterKey, salt, KEY_BYTES, SCRYPT_PARAMS)
}

/** Cifra os 64 bytes do segredo com a chave mestra. */
export async function encryptSecret (secretKey, masterKey = config.security.masterKey) {
  const salt = crypto.randomBytes(SALT_BYTES)
  const iv = crypto.randomBytes(IV_BYTES)
  const key = await deriveKey(masterKey, salt)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const payload = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, salt.toString('hex'), iv.toString('hex'), tag.toString('hex'), payload.toString('hex')].join('.')
}

/** Decifra e devolve os bytes do segredo. Lanca se a chave mestra nao bater. */
export async function decryptSecret (blob, masterKey = config.security.masterKey) {
  const parts = String(blob).split('.')
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new Error('Formato de segredo desconhecido.')
  }
  const [, saltHex, ivHex, tagHex, payloadHex] = parts
  const key = await deriveKey(masterKey, Buffer.from(saltHex, 'hex'))
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(payloadHex, 'hex')), decipher.final()])
}

/** Cria uma conta nova: keypair real, segredo ja cifrado. */
export async function createAccount (masterKey = config.security.masterKey) {
  const keypair = Keypair.generate()
  const secretCipher = await encryptSecret(keypair.secretKey, masterKey)
  return { publicKey: keypair.publicKey.toBase58(), secretCipher, keypair }
}

/** Reabre o keypair a partir do segredo cifrado guardado no banco. */
export async function openAccount (secretCipher, masterKey = config.security.masterKey) {
  const secret = await decryptSecret(secretCipher, masterKey)
  return Keypair.fromSecretKey(Uint8Array.from(secret))
}

/**
 * Recifra um segredo da chave antiga para a nova.
 * Usado na rotacao da chave mestra, que roda em migration e nao pede downtime:
 * o segredo e lido com a chave velha e regravado com a nova, um por vez.
 */
export async function rotateSecret (blob, oldMasterKey, newMasterKey) {
  const secret = await decryptSecret(blob, oldMasterKey)
  return encryptSecret(secret, newMasterKey)
}
