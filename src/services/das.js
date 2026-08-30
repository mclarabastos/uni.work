// Leitura pela DAS API (Digital Asset Standard), servida pelo Helius.
//
// Por que isso importa: a confirmacao de que o certificado existe precisa vir
// de fora do nosso banco. Se so nos dizemos que o certificado foi emitido, o
// certificado nao vale nada. O indexador e a segunda testemunha.
//
// Sem HELIUS_API_KEY a funcao nao inventa resposta: ela diz que a verificacao
// independente esta indisponivel, e o doctor reclama.

import { config } from '../config.js'

const cache = new Map()
const TTL_MS = 3 * 60 * 1000 // a carteira de certificados e tela muito visitada

function cacheGet (key) {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() > hit.expires) { cache.delete(key); return null }
  return hit.value
}

function cacheSet (key, value) {
  cache.set(key, { value, expires: Date.now() + TTL_MS })
  if (cache.size > 500) cache.delete(cache.keys().next().value)
  return value
}

export function clearDasCache () { cache.clear() }

export function indexerAvailable () {
  return Boolean(config.solana.dasUrl)
}

async function rpc (method, params) {
  if (!indexerAvailable()) {
    return { available: false, reason: 'indexador_nao_configurado', result: null }
  }
  const res = await fetch(config.solana.dasUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'uniwork', method, params })
  })
  if (!res.ok) {
    return { available: true, ok: false, reason: `HTTP ${res.status}`, result: null }
  }
  const body = await res.json()
  if (body.error) {
    return { available: true, ok: false, reason: body.error.message ?? 'erro_do_indexador', result: null }
  }
  return { available: true, ok: true, result: body.result }
}

/** Um ativo especifico pelo id. */
export async function getAsset (assetId) {
  const key = `asset:${assetId}`
  const hit = cacheGet(key)
  if (hit) return hit
  const out = await rpc('getAsset', { id: assetId })
  return out.ok ? cacheSet(key, out) : out
}

/** Todos os certificados de uma conta. Cacheado por alguns minutos. */
export async function getAssetsByOwner (ownerPubkey, { page = 1, limit = 100 } = {}) {
  const key = `owner:${ownerPubkey}:${page}:${limit}`
  const hit = cacheGet(key)
  if (hit) return hit
  const out = await rpc('getAssetsByOwner', { ownerAddress: ownerPubkey, page, limit })
  return out.ok ? cacheSet(key, out) : out
}

/**
 * Confirmacao independente de um certificado.
 * Devolve sempre um objeto com o mesmo formato, para a tela nunca precisar
 * adivinhar por que a confirmacao nao veio.
 */
export async function confirmCertificate ({ assetId, expectedOwner, expectedUri }) {
  if (!assetId) {
    return { confirmado: false, motivo: 'sem_registro_no_indexador', detalhe: 'O certificado ainda esta sendo registrado.' }
  }
  const out = await getAsset(assetId)
  if (!out.available) {
    return { confirmado: false, motivo: 'indexador_nao_configurado', detalhe: 'A confirmacao independente nao esta configurada neste ambiente.' }
  }
  if (!out.ok || !out.result) {
    return { confirmado: false, motivo: 'indexador_indisponivel', detalhe: out.reason ?? 'sem resposta' }
  }
  const asset = out.result
  const owner = asset.ownership?.owner ?? null
  const uri = asset.content?.json_uri ?? null
  return {
    confirmado: Boolean(owner) && (!expectedOwner || owner === expectedOwner),
    motivo: null,
    dono: owner,
    uri,
    uriConfere: !expectedUri || uri === expectedUri,
    comprimido: Boolean(asset.compression?.compressed),
    arvore: asset.compression?.tree ?? null,
    queimado: Boolean(asset.burnt)
  }
}
