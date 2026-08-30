// Service worker: existe so para receber os avisos quando a aba esta fechada.
// Nao faz cache de nada. Cache aqui traria mais problema do que resolve num
// produto que muda de estado o tempo todo.

self.addEventListener('push', (evento) => {
  if (!evento.data) return
  let dados = {}
  try {
    dados = evento.data.json()
  } catch {
    dados = { title: 'Uni.work', body: evento.data.text() }
  }

  evento.waitUntil(
    self.registration.showNotification(dados.title ?? 'Uni.work', {
      body: dados.body ?? '',
      icon: '/logo.svg',
      badge: '/logo.svg',
      tag: dados.tag ?? 'uniwork',
      data: { url: dados.url ?? '/' },
      lang: 'pt-BR'
    })
  )
})

// Clicar no aviso traz a aba que ja estava aberta, em vez de abrir outra.
self.addEventListener('notificationclick', (evento) => {
  evento.notification.close()
  const destino = evento.notification.data?.url ?? '/'

  evento.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((abas) => {
      for (const aba of abas) {
        if ('focus' in aba) {
          aba.navigate?.(destino)
          return aba.focus()
        }
      }
      return self.clients.openWindow(destino)
    })
  )
})
