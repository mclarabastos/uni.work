import crypto from 'node:crypto'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32, sem I L O U

/** Id curto com prefixo legivel: usr_..., job_..., cer_... */
export function newId (prefix) {
  const bytes = crypto.randomBytes(10)
  let out = ''
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length]
  return `${prefix}_${out.toLowerCase()}`
}

/** Codigo publico de verificacao do certificado: UNI-XXXX-XXXX. */
export function newVerificationCode () {
  const bytes = crypto.randomBytes(8)
  let out = ''
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length]
  return `UNI-${out.slice(0, 4)}-${out.slice(4, 8)}`
}

/** Token opaco de sessao. */
export function newToken (bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url')
}
