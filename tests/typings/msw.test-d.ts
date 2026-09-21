import { ws } from 'msw'
import { setupWorker } from 'msw/browser'
import { SocketIo } from '../../src/index.js'

it('is compatible with the msw WebSocket link', () => {
  const api = ws.link('wss://example.com/', { protocol: new SocketIo() })

  setupWorker(
    api.addEventListener('connection', ({ client, server }) => {
      client.send('["hello","John"]')
      server.send('["hello","John"]')
    }),
  )
})
