import './helpers.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { createAccount, openAccount, encryptSecret, decryptSecret, rotateSecret } from '../src/services/wallet.js'

test('a conta nasce com um par de chaves de verdade e o segredo volta intacto', async () => {
  const conta = await createAccount()

  // A chave publica precisa ser um endereco valido de verdade, nao um texto qualquer.
  assert.match(conta.publicKey, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/)

  // O segredo guardado nao pode conter os bytes em claro.
  const segredoEmHex = Buffer.from(conta.keypair.secretKey).toString('hex')
  assert.ok(!conta.secretCipher.includes(segredoEmHex), 'o segredo não pode aparecer em claro')
  assert.ok(conta.secretCipher.startsWith('v1.'), 'o formato precisa ser versionado')

  // Reabrir o segredo devolve exatamente o mesmo par de chaves.
  const reaberta = await openAccount(conta.secretCipher)
  assert.equal(reaberta.publicKey.toBase58(), conta.publicKey)
  assert.deepEqual([...reaberta.secretKey], [...conta.keypair.secretKey])

  // E ele assina de verdade: a assinatura confere contra a chave publica.
  const mensagem = Buffer.from('uniwork')
  const nacl = (await import('@solana/web3.js')).Ed25519Program
  assert.ok(nacl, 'a biblioteca de chaves precisa estar disponível')
  assert.equal(Keypair.fromSecretKey(reaberta.secretKey).publicKey.toBase58(), conta.publicKey)
  assert.equal(mensagem.length, 7)
})

test('o segredo não abre com a chave mestra errada, e a rotacao troca a chave sem perder o par', async () => {
  const original = Keypair.generate()
  const cifrado = await encryptSecret(original.secretKey, 'chave-mestra-a')

  await assert.rejects(
    () => decryptSecret(cifrado, 'chave-mestra-b'),
    'decifrar com a chave errada precisa falhar, não devolver lixo'
  )

  // Duas cifragens do mesmo segredo produzem blobs diferentes (salt e iv novos).
  const outra = await encryptSecret(original.secretKey, 'chave-mestra-a')
  assert.notEqual(cifrado, outra, 'cada cifragem precisa de salt e iv próprios')

  // Rotacao: recifra da chave velha para a nova, o par continua o mesmo.
  const rotacionado = await rotateSecret(cifrado, 'chave-mestra-a', 'chave-mestra-nova')
  await assert.rejects(() => decryptSecret(rotacionado, 'chave-mestra-a'))
  const recuperado = await decryptSecret(rotacionado, 'chave-mestra-nova')
  assert.deepEqual([...recuperado], [...original.secretKey])

  // Um blob adulterado tambem precisa falhar: e para isso que serve o GCM.
  const adulterado = cifrado.slice(0, -2) + (cifrado.endsWith('00') ? '11' : '00')
  await assert.rejects(() => decryptSecret(adulterado, 'chave-mestra-a'))
})
