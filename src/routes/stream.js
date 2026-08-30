// SSE: a tela recebe o evento no instante em que ele acontece, sem polling.

import { Router } from 'express'
import { onEvent } from '../domain/events.js'

export const streamRouter = Router()

streamRouter.get('/', (req, res) => {
  res.set({
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  })
  res.flushHeaders?.()
  res.write(`event: pronto\ndata: ${JSON.stringify({ em: new Date().toISOString() })}\n\n`)

  const unsubscribe = onEvent((event) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  })

  // Alguns proxies fecham conexao ociosa. Um ping periodico segura a linha.
  const ping = setInterval(() => res.write(': ping\n\n'), 25000)

  req.on('close', () => {
    clearInterval(ping)
    unsubscribe()
    res.end()
  })
})
