// Envio de arquivo e perfil publico.
//
// O envio tem dois passos: pedir permissao, e depois mandar o arquivo com o
// bilhete que voltou. Isso deixa o limite de tamanho e de tipo ser decidido
// antes de o arquivo comecar a subir.

import express, { Router } from 'express'
import {
  pedirPermissao, receber, conteudoDe, listarDe, remover, regrasDeEnvio
} from '../domain/attachments.js'
import { perfilPublico, vagasDoPerfil, atualizarPerfil } from '../domain/profiles.js'
import { ler } from '../services/storage.js'
import { one } from '../db/index.js'
import { notFound } from '../lib/errors.js'
import { asyncRoute, requireAuth } from './helpers.js'

export const uploadsRouter = Router()

uploadsRouter.get('/regras', (_req, res) => {
  res.json({ regras: regrasDeEnvio() })
})

uploadsRouter.post('/', requireAuth, asyncRoute(async (req, res) => {
  res.json(await pedirPermissao(req.user, {
    tipo: req.body?.tipo,
    vagaId: req.body?.vagaId ?? null
  }))
}))

/**
 * O arquivo chega cru no corpo, e nao em multipart.
 * Um parser de multipart seria mais uma dependencia para resolver um problema
 * que aqui nao existe: a tela envia um arquivo por vez, e os metadados ja
 * viajaram no bilhete.
 */
uploadsRouter.put(
  '/:bilhete',
  express.raw({ type: '*/*', limit: '26mb' }),
  asyncRoute(async (req, res) => {
    const anexo = await receber({
      bilhete: req.params.bilhete,
      buffer: req.body,
      nomeInformado: req.get('x-nome-do-arquivo') ?? 'arquivo',
      mimeInformado: req.get('content-type') ?? '',
      ip: req.ip
    })
    res.status(201).json({ anexo })
  })
)

uploadsRouter.get('/:id/conteudo', asyncRoute(async (req, res) => {
  const { anexo, buffer } = await conteudoDe(req.params.id, req.user)
  res.set('content-type', anexo.mime)
  // Nunca deixar o navegador adivinhar o tipo de arquivo que veio de fora.
  res.set('x-content-type-options', 'nosniff')
  res.set('content-disposition',
    `${anexo.mime.startsWith('image/') ? 'inline' : 'attachment'}; filename="${encodeURIComponent(anexo.filename)}"`)
  res.set('cache-control', 'private, max-age=3600')
  res.send(buffer)
}))

uploadsRouter.get('/', requireAuth, asyncRoute(async (req, res) => {
  res.json({ anexos: await listarDe(req.user.id, req.query.tipo ?? null) })
}))

uploadsRouter.delete('/:id', requireAuth, asyncRoute(async (req, res) => {
  res.json(await remover(req.user, req.params.id))
}))

// ─── perfis publicos ─────────────────────────────────────────────────────────

export const profilesRouter = Router()

profilesRouter.get('/:id', asyncRoute(async (req, res) => {
  const perfil = await perfilPublico(req.params.id, req.user)
  const vagas = perfil.perfil === 'company' ? await vagasDoPerfil(req.params.id) : undefined
  res.json({ perfil, vagas })
}))

profilesRouter.get('/:id/foto', asyncRoute(async (req, res) => {
  const pessoa = await one('select avatar_key from users where id = $1', [req.params.id])
  if (!pessoa?.avatar_key) throw notFound('Esta conta não tem foto.')
  const buffer = await ler(pessoa.avatar_key)
  res.set('content-type', pessoa.avatar_key.endsWith('.png') ? 'image/png' : 'image/jpeg')
  res.set('cache-control', 'public, max-age=600')
  res.send(buffer)
}))

export const mePerfilRouter = Router()

mePerfilRouter.put('/perfil', requireAuth, asyncRoute(async (req, res) => {
  res.json({ perfil: await atualizarPerfil(req.user, req.body) })
}))
