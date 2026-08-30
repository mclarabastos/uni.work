// Certificado verificavel.
//
// Emitido no mesmo instante em que o pagamento e liberado. Por padrao vira um
// compressed NFT (Bubblegum) na conta do estudante. Se a rede recusar, cai no
// registro de memo e a operacao entra na fila para virar cNFT de verdade depois:
// o fallback nunca e o estado final, so o estado provisorio.
//
// O JSON servido em metadata.json e gravado no banco no momento da emissao e
// servido de la para sempre. Um certificado que muda de conteudo depois de
// emitido nao e um certificado.

import crypto from 'node:crypto'
import { PublicKey, TransactionInstruction } from '@solana/web3.js'
import { config, explorerUrl } from '../config.js'
import { platformKeypair, readPlatformState } from './platform.js'
import { sendTransaction, describeInstructions } from './solana.js'

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

/**
 * Serializa de forma canonica: chaves ordenadas, sem espaco supérfluo.
 * Duas maquinas diferentes precisam chegar no mesmo byte, senao o hash nao
 * serve para verificar nada.
 */
export function canonicalize (value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`
}

/** Hash canonico do conteudo do certificado. E o que prova que nada mudou. */
export function contentHash (content) {
  return crypto.createHash('sha256').update(canonicalize(content), 'utf8').digest('hex')
}

/**
 * Conteudo do certificado: so o que descreve a atividade.
 * Nada de id interno, nada de dado que possa mudar por motivo administrativo.
 */
export function buildContent ({ code, title, hours, studentName, issuerName, category, modality, completedAt }) {
  return {
    codigo: code,
    atividade: title,
    categoria: category,
    modalidade: modality,
    horas: Number(hours),
    estudante: studentName,
    contratante: issuerName,
    concluido_em: new Date(completedAt).toISOString(),
    emissor: 'Uni.work',
    versao: 1
  }
}

/** Metadados no padrao de token da rede, ja com o hash dentro. */
export function buildMetadata ({ content, hash, code }) {
  const base = config.publicBaseUrl
  return {
    name: `Certificado ${content.horas}h · ${content.atividade}`.slice(0, 32),
    symbol: 'UNIW',
    description: `Certificado de ${content.horas} horas de atividade complementar emitido pela Uni.work para ${content.estudante}, referente a "${content.atividade}" realizada para ${content.contratante} e concluida em ${new Date(content.concluido_em).toLocaleDateString('pt-BR')}. Verificacao publica em ${base}/verificar/${code}`,
    image: `${base}/api/certificates/${code}/image.svg`,
    external_url: `${base}/verificar/${code}`,
    attributes: [
      { trait_type: 'Carga horaria', value: `${content.horas}h` },
      { trait_type: 'Atividade', value: content.atividade },
      { trait_type: 'Categoria', value: content.categoria },
      { trait_type: 'Modalidade', value: content.modalidade },
      { trait_type: 'Contratante', value: content.contratante },
      { trait_type: 'Concluido em', value: new Date(content.concluido_em).toISOString().slice(0, 10) },
      { trait_type: 'Codigo', value: content.codigo },
      { trait_type: 'Hash', value: hash }
    ],
    properties: {
      category: 'image',
      files: [{ uri: `${base}/api/certificates/${code}/image.svg`, type: 'image/svg+xml' }],
      uniwork: { hash, conteudo: content }
    }
  }
}

function escapeXml (text) {
  return String(text).replace(/[<>&'"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
  ))
}

/** Cartao do certificado em SVG. Mesmo sistema visual do produto. */
export function renderSvg ({ content, hash, code }) {
  const dateBR = new Date(content.concluido_em).toLocaleDateString('pt-BR')
  const shortHash = `${hash.slice(0, 8)}…${hash.slice(-8)}`
  const title = content.atividade.length > 42 ? `${content.atividade.slice(0, 41)}…` : content.atividade
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="620" viewBox="0 0 1000 620" role="img" aria-label="Certificado ${escapeXml(code)}">
  <defs>
    <linearGradient id="marca" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#7c5cff"/>
      <stop offset="55%" stop-color="#c04cf0"/>
      <stop offset="100%" stop-color="#ff7a45"/>
    </linearGradient>
    <linearGradient id="brilho" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="1000" height="620" fill="#000000"/>
  <rect x="16" y="16" width="968" height="588" rx="26" fill="#0a0a0c" stroke="#1e1e24"/>
  <rect x="16" y="16" width="968" height="6" rx="3" fill="url(#marca)"/>
  <rect x="16" y="16" width="968" height="200" rx="26" fill="url(#brilho)"/>
  <text x="62" y="96" font-family="Plus Jakarta Sans, Segoe UI, sans-serif" font-size="15" font-weight="700" letter-spacing="4" fill="#8b8b96">UNI.WORK</text>
  <text x="62" y="132" font-family="Plus Jakarta Sans, Segoe UI, sans-serif" font-size="15" fill="#8b8b96">Certificado de atividade complementar</text>
  <text x="62" y="214" font-family="Plus Jakarta Sans, Segoe UI, sans-serif" font-size="42" font-weight="800" fill="#f5f5f7">${escapeXml(content.estudante)}</text>
  <text x="62" y="262" font-family="Plus Jakarta Sans, Segoe UI, sans-serif" font-size="20" fill="#b9b9c4">concluiu a atividade</text>
  <text x="62" y="310" font-family="Plus Jakarta Sans, Segoe UI, sans-serif" font-size="30" font-weight="700" fill="#f5f5f7">${escapeXml(title)}</text>
  <text x="62" y="352" font-family="Plus Jakarta Sans, Segoe UI, sans-serif" font-size="19" fill="#b9b9c4">para ${escapeXml(content.contratante)} · ${escapeXml(content.modalidade)} · ${escapeXml(content.categoria)}</text>
  <rect x="62" y="392" width="250" height="108" rx="18" fill="#121216" stroke="#26262e"/>
  <text x="86" y="428" font-family="Plus Jakarta Sans, Segoe UI, sans-serif" font-size="13" letter-spacing="2" fill="#8b8b96">CARGA HORARIA</text>
  <text x="86" y="478" font-family="JetBrains Mono, Consolas, monospace" font-size="40" font-weight="700" fill="#c04cf0">${escapeXml(content.horas)}h</text>
  <rect x="336" y="392" width="250" height="108" rx="18" fill="#121216" stroke="#26262e"/>
  <text x="360" y="428" font-family="Plus Jakarta Sans, Segoe UI, sans-serif" font-size="13" letter-spacing="2" fill="#8b8b96">CONCLUIDO EM</text>
  <text x="360" y="472" font-family="JetBrains Mono, Consolas, monospace" font-size="28" font-weight="700" fill="#f5f5f7">${escapeXml(dateBR)}</text>
  <rect x="610" y="392" width="328" height="108" rx="18" fill="#121216" stroke="#26262e"/>
  <text x="634" y="428" font-family="Plus Jakarta Sans, Segoe UI, sans-serif" font-size="13" letter-spacing="2" fill="#8b8b96">CODIGO DE VERIFICACAO</text>
  <text x="634" y="472" font-family="JetBrains Mono, Consolas, monospace" font-size="26" font-weight="700" fill="#f5f5f7">${escapeXml(code)}</text>
  <text x="62" y="552" font-family="JetBrains Mono, Consolas, monospace" font-size="14" fill="#6e6e78">registro publico ${escapeXml(shortHash)}</text>
  <text x="62" y="578" font-family="Plus Jakarta Sans, Segoe UI, sans-serif" font-size="14" fill="#6e6e78">confira em ${escapeXml(config.publicBaseUrl)}/verificar/${escapeXml(code)}</text>
</svg>
`
}

// ─── emissao ─────────────────────────────────────────────────────────────────

function memoInstruction (text) {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: platformKeypair().publicKey, isSigner: true, isWritable: false }],
    data: Buffer.from(text, 'utf8')
  })
}

/**
 * Registro de memo: prova que o hash existia naquele bloco, sem ser um cNFT.
 * E o plano B, sempre acompanhado de um item na fila para virar cNFT.
 */
export async function issueViaMemo ({ code, hash, studentPubkey }) {
  const payload = `uniwork:cert:v1 ${code} ${hash} ${studentPubkey}`
  const { signature, transaction } = await sendTransaction([memoInstruction(payload)])
  return {
    driver: 'memo',
    signature,
    assetId: null,
    pending: true,
    instructionsDescribed: describeInstructions(transaction)
  }
}

/** Emite o compressed NFT de verdade, via Bubblegum, na conta do estudante. */
export async function issueViaBubblegum ({ code, metadata, studentPubkey }) {
  const state = readPlatformState()
  if (!state?.merkleTree) {
    throw new Error('Merkle tree do certificado ainda nao existe. Rode: npm run bootstrap')
  }

  const [{ createUmi }, umiCore, bubblegum, adapters] = await Promise.all([
    import('@metaplex-foundation/umi-bundle-defaults'),
    import('@metaplex-foundation/umi'),
    import('@metaplex-foundation/mpl-bubblegum'),
    import('@metaplex-foundation/umi-web3js-adapters')
  ])

  const umi = createUmi(config.solana.rpcUrl).use(bubblegum.mplBubblegum())
  const payer = adapters.fromWeb3JsKeypair(platformKeypair())
  umi.use(umiCore.keypairIdentity(payer))

  const uri = `${config.publicBaseUrl}/api/certificates/${code}/metadata.json`
  const builder = bubblegum.mintV1(umi, {
    leafOwner: umiCore.publicKey(studentPubkey),
    merkleTree: umiCore.publicKey(state.merkleTree),
    metadata: {
      name: metadata.name,
      symbol: metadata.symbol,
      uri,
      sellerFeeBasisPoints: 0,
      // O certificado nao e negociavel: ele descreve algo que uma pessoa fez.
      isMutable: false,
      collection: null,
      creators: [{ address: payer.publicKey, verified: true, share: 100 }]
    }
  })

  const result = await builder.sendAndConfirm(umi, { confirm: { commitment: 'confirmed' } })
  const signature = umiCore.base58.deserialize(result.signature)[0]

  let assetId = null
  try {
    const leaf = await bubblegum.parseLeafFromMintV1Transaction(umi, result.signature)
    assetId = leaf.id.toString()
  } catch {
    // A transacao passou; so nao conseguimos ler o id agora.
    // A fila resolve isso depois com um cert_sync.
  }

  return { driver: 'bubblegum', signature, assetId, pending: assetId === null, uri }
}

/**
 * Emite pelo driver configurado, com queda para memo se a rede recusar.
 * Nunca lanca por falha de rede: devolve o resultado com pending e deixa quem
 * chamou decidir o que enfileirar. O fluxo de produto nao pode travar aqui.
 */
export async function issueCertificate ({ code, content, hash, metadata, studentPubkey }) {
  if (config.certificate.driver === 'bubblegum') {
    try {
      const out = await issueViaBubblegum({ code, metadata, studentPubkey })
      return { ...out, fallback: false }
    } catch (err) {
      try {
        const out = await issueViaMemo({ code, hash, studentPubkey })
        return { ...out, fallback: true, fallbackReason: err.message, pending: true }
      } catch (memoErr) {
        return { driver: 'nenhum', signature: null, assetId: null, pending: true, fallback: true, fallbackReason: `${err.message} | ${memoErr.message}` }
      }
    }
  }
  // Driver memo escolhido de proposito. Ainda assim o resultado fica pendente:
  // um memo prova que o hash existia naquele bloco, mas nao e um certificado
  // que um terceiro consegue achar sozinho. Ele sobe para cNFT pela fila.
  try {
    const out = await issueViaMemo({ code, hash, studentPubkey })
    return { ...out, fallback: false, pending: true }
  } catch (err) {
    return { driver: 'nenhum', signature: null, assetId: null, pending: true, fallback: true, fallbackReason: err.message }
  }
}

export function certificateLinks ({ code, signature, assetId }) {
  return {
    verificacao: `${config.publicBaseUrl}/verificar/${code}`,
    metadados: `${config.publicBaseUrl}/api/certificates/${code}/metadata.json`,
    imagem: `${config.publicBaseUrl}/api/certificates/${code}/image.svg`,
    registro: signature ? explorerUrl('tx', signature) : null,
    ativo: assetId ? explorerUrl('address', assetId) : null
  }
}
