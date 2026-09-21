import http from 'node:http'
import { WebSocketInterceptor } from '@mswjs/interceptors/WebSocket'
import { Server } from 'socket.io'
import {
  createTestHttpServer,
  kServer,
  type TestHttpServer,
} from '@epic-web/test-server/http'
import { SocketIo, type SocketIoMessage } from '../src/index.js'

const interceptor = new WebSocketInterceptor({
  extensions: [new SocketIo()],
})

function createSocketIoServer(httpServer: TestHttpServer): Server {
  const rawServer: unknown = Reflect.get(httpServer.http, kServer)
  if (!(rawServer instanceof http.Server)) {
    throw new Error('Expected the test server to be an "http.Server" instance')
  }
  return new Server(rawServer)
}

function getWsUrl(httpServer: TestHttpServer): string {
  const url = httpServer.http.url()
  url.protocol = url.protocol.replace('http', 'ws')
  return url.href
}

beforeAll(() => {
  interceptor.apply()
})

afterEach(() => {
  interceptor.removeAllListeners()
})

afterAll(() => {
  interceptor.dispose()
})

it('decodes outgoing client events', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const eventLog: Array<SocketIoMessage> = []
  const outgoingData = Promise.withResolvers<SocketIoMessage>()

  interceptor.on('connection', ({ client }) => {
    client.addEventListener('message', (event) => {
      eventLog.push(event.data)
      outgoingData.resolve(event.data)
    })
  })

  const ws = createSocketClient('wss://example.com')
  onTestFinished(() => {
    ws.close()
  })
  ws.emit('hello', 'John')

  await expect(outgoingData.promise).resolves.toEqual({
    namespace: '/',
    event: 'hello',
    args: ['John'],
  })
  expect(eventLog, 'exposes no protocol packets').toEqual([
    { namespace: '/', event: 'hello', args: ['John'] },
  ])
})

it('encodes mocked incoming server events', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const incomingData = Promise.withResolvers<unknown>()

  interceptor.on('connection', ({ client }) => {
    client.addEventListener('message', (event) => {
      if (event.data.event === 'hello') {
        const [firstName] = event.data.args
        client.send({ event: 'greetings', args: [`Hello, ${firstName}!`] })
      }
    })
  })

  const ws = createSocketClient('wss://example.com')
  onTestFinished(() => {
    ws.close()
  })
  ws.emit('hello', 'John')
  ws.on('greetings', (message) => incomingData.resolve(message))

  await expect(incomingData.promise).resolves.toBe('Hello, John!')
})

it('decodes incoming server events', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')
  await using httpServer = await createTestHttpServer()
  const wsServer = createSocketIoServer(httpServer)
  onTestFinished(() => {
    wsServer.close()
  })

  const incomingServerData = Promise.withResolvers<SocketIoMessage>()
  const incomingClientData = Promise.withResolvers<unknown>()

  wsServer.on('connection', (client) => {
    client.on('hello', (name) => {
      client.emit('greeting', { id: 1, text: `Hello, ${name}!` })
    })
  })

  interceptor.on('connection', ({ server }) => {
    server.connect()

    server.addEventListener('message', (event) => {
      incomingServerData.resolve(event.data)
    })
  })

  const ws = createSocketClient(getWsUrl(httpServer))
  onTestFinished(() => {
    ws.close()
  })
  ws.emit('hello', 'John')
  ws.on('greeting', (message) => {
    incomingClientData.resolve(message)
  })

  await expect(
    incomingServerData.promise,
    'the interceptor gets the decoded event',
  ).resolves.toEqual({
    namespace: '/',
    event: 'greeting',
    args: [{ id: 1, text: 'Hello, John!' }],
  })
  await expect(
    incomingClientData.promise,
    'the Socket.IO client gets the original event',
  ).resolves.toEqual({
    id: 1,
    text: 'Hello, John!',
  })
})

it('modifies incoming server events', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')
  await using httpServer = await createTestHttpServer()
  const wsServer = createSocketIoServer(httpServer)
  onTestFinished(() => {
    wsServer.close()
  })

  const incomingServerData = Promise.withResolvers<SocketIoMessage>()
  const incomingClientData = Promise.withResolvers<unknown>()

  wsServer.on('connection', (client) => {
    client.on('hello', (name) => {
      client.emit('greeting', { id: 1, text: `Hello, ${name}!` })
    })
  })

  interceptor.on('connection', ({ client, server }) => {
    server.connect()

    server.addEventListener('message', (event) => {
      incomingServerData.resolve(event.data)

      event.preventDefault()
      client.send({
        event: 'greeting',
        args: [{ id: 2, text: 'Hello, Sarah!' }],
      })
    })
  })

  const ws = createSocketClient(getWsUrl(httpServer))
  onTestFinished(() => {
    ws.close()
  })
  ws.emit('hello', 'John')
  ws.on('greeting', (message) => {
    incomingClientData.resolve(message)
  })

  await expect(
    incomingServerData.promise,
    'the interceptor gets the original event',
  ).resolves.toEqual({
    namespace: '/',
    event: 'greeting',
    args: [{ id: 1, text: 'Hello, John!' }],
  })
  await expect(
    incomingClientData.promise,
    'the Socket.IO client gets the modified event',
  ).resolves.toEqual({
    id: 2,
    text: 'Hello, Sarah!',
  })
})

it('exchanges events on a custom namespace', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const outgoingData = Promise.withResolvers<SocketIoMessage>()
  const incomingData = Promise.withResolvers<unknown>()

  interceptor.on('connection', ({ client }) => {
    client.addEventListener('message', (event) => {
      outgoingData.resolve(event.data)

      if (event.data.event === 'hello') {
        client.send({
          namespace: event.data.namespace,
          event: 'greetings',
          args: ['Hello from /admin!'],
        })
      }
    })
  })

  const ws = createSocketClient('wss://example.com/admin')
  onTestFinished(() => {
    ws.close()
  })
  ws.emit('hello', 'John')
  ws.on('greetings', (message) => incomingData.resolve(message))

  await expect(outgoingData.promise).resolves.toEqual({
    namespace: '/admin',
    event: 'hello',
    args: ['John'],
  })
  await expect(incomingData.promise).resolves.toBe('Hello from /admin!')
})

it('sends events to every connection in a room', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const firstIncomingData = Promise.withResolvers<unknown>()
  const secondIncomingData = Promise.withResolvers<unknown>()

  interceptor.on('connection', ({ client, rooms }) => {
    client.addEventListener('message', (event) => {
      const [room] = event.data.args

      if (event.data.event === 'join' && typeof room === 'string') {
        rooms.join(room)
      }

      if (event.data.event === 'announce' && typeof room === 'string') {
        rooms.to(room).send({ event: 'news', args: ['hello lobby'] })
      }
    })
  })

  const first = createSocketClient('wss://example.com')
  onTestFinished(() => {
    first.close()
  })
  const second = createSocketClient('wss://example.com')
  onTestFinished(() => {
    second.close()
  })
  first.on('news', (message) => firstIncomingData.resolve(message))
  second.on('news', (message) => secondIncomingData.resolve(message))

  first.emit('join', 'lobby')
  second.emit('join', 'lobby')
  second.emit('announce', 'lobby')

  await expect(firstIncomingData.promise).resolves.toBe('hello lobby')
  await expect(secondIncomingData.promise).resolves.toBe('hello lobby')
})

it('does not send room events to connections outside the room', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const memberIncomingData = Promise.withResolvers<unknown>()
  const onOutsiderData = vi.fn<(message: unknown) => void>()

  interceptor.on('connection', ({ client, rooms }) => {
    client.addEventListener('message', (event) => {
      const [room] = event.data.args

      if (event.data.event === 'join' && typeof room === 'string') {
        rooms.join(room)
      }

      if (event.data.event === 'announce' && typeof room === 'string') {
        rooms.to(room).send({ event: 'news', args: ['hello lobby'] })
      }
    })
  })

  const member = createSocketClient('wss://example.com')
  onTestFinished(() => {
    member.close()
  })
  const outsider = createSocketClient('wss://example.com')
  onTestFinished(() => {
    outsider.close()
  })
  member.on('news', (message) => memberIncomingData.resolve(message))
  outsider.on('news', onOutsiderData)

  member.emit('join', 'lobby')
  outsider.emit('join', 'elsewhere')
  member.emit('announce', 'lobby')

  await expect(memberIncomingData.promise).resolves.toBe('hello lobby')
  expect(onOutsiderData).not.toHaveBeenCalled()
})
