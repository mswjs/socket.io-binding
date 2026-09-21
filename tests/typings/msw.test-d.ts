import { ws } from 'msw'
import { setupWorker } from 'msw/browser'
import {
  SocketIo,
  SocketIoSocket,
  SocketIoServer,
  type SocketIoMessage,
} from '../../src/index.js'

it('is compatible with the msw WebSocket link', () => {
  const api = ws.link('wss://example.com/', { extensions: [new SocketIo()] })

  setupWorker(
    api.addEventListener('connection', ({ client, server, socket, io }) => {
      expectTypeOf(socket).toEqualTypeOf<SocketIoSocket>()
      expectTypeOf(io).toEqualTypeOf<SocketIoServer>()

      client.send({ event: 'hello', args: ['John'] })
      client.send({ type: 'ack', id: 1, args: ['John'] })
      server.send({ namespace: '/admin', event: 'hello', args: ['John'] })
      api.broadcast({ event: 'hello', args: [] })

      client.addEventListener('message', (event) => {
        expectTypeOf(event.data).toEqualTypeOf<SocketIoMessage>()

        if (event.data.type === 'event') {
          expectTypeOf(event.data.event).toEqualTypeOf<string>()
        }
      })
      server.addEventListener('message', (event) => {
        expectTypeOf(event.data).toEqualTypeOf<SocketIoMessage>()
      })

      // @ts-expect-error Raw frames are never sent by the handler.
      client.send('42["hello","John"]')
    }),
  )
})
