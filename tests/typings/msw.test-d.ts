import { ws } from 'msw'
import { setupWorker } from 'msw/browser'
import { toSocketIo } from '../../src/index.js'

it('creates a connection object compatible with msw', () => {
  const api = ws.link('wss://example.com/')

  setupWorker(
    api.addEventListener('connection', (connection) => {
      const io = toSocketIo(connection)

      io.client.on('message', (data) => {
        expectTypeOf(data).toEqualTypeOf<MessageEvent<any>>()
      })
      io.server.on('message', (data) => {
        expectTypeOf(data).toEqualTypeOf<MessageEvent<any>>()
      })
    }),
  )
})
