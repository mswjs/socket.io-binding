import { ws } from 'msw'
import { setupWorker } from 'msw/browser'
import {
  SocketIo,
  SocketIoRooms,
  type SocketIoMessage,
} from '../../src/index.js'

it('is compatible with the msw WebSocket link', () => {
  const api = ws.link('wss://example.com/', { extensions: [new SocketIo()] })

  setupWorker(
    api.addEventListener('connection', ({ client, server, rooms }) => {
      expectTypeOf(rooms).toEqualTypeOf<SocketIoRooms>()

      client.send({ event: 'hello', args: ['John'] })
      server.send({ namespace: '/admin', event: 'hello', args: ['John'] })
      api.broadcast({ event: 'hello', args: [] })

      client.addEventListener('message', (event) => {
        expectTypeOf(event.data).toEqualTypeOf<SocketIoMessage>()
      })
      server.addEventListener('message', (event) => {
        expectTypeOf(event.data).toEqualTypeOf<SocketIoMessage>()
      })

      // @ts-expect-error Raw frames are never sent by the handler.
      client.send('42["hello","John"]')
    }),
  )
})
