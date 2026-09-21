import http from 'node:http'
import {
  WebSocketInterceptor,
  type WebSocketData,
} from '@mswjs/interceptors/WebSocket'
import { Server } from 'socket.io'
import {
  createTestHttpServer,
  kServer,
  type TestHttpServer,
} from '@epic-web/test-server/http'
import { SocketIo } from '../src/index.js'

const interceptor = new WebSocketInterceptor({
  protocols: [new SocketIo()],
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

  const eventLog: Array<WebSocketData> = []
  const outgoingData = Promise.withResolvers<WebSocketData>()

  interceptor.on('connection', ({ client }) => {
    client.addEventListener('message', (event) => {
      eventLog.push(event.data)
      outgoingData.resolve(event.data)
    })
  })

  const ws = createSocketClient('wss://example.com')
  ws.emit('hello', 'John')

  await expect(outgoingData.promise).resolves.toBe('["hello","John"]')
  expect(eventLog, 'exposes no protocol packets').toEqual([
    '["hello","John"]',
  ])
})

it('encodes mocked incoming server events', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const incomingData = Promise.withResolvers<WebSocketData>()

  interceptor.on('connection', ({ client }) => {
    client.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        return
      }

      const [name, firstName]: [string, string] = JSON.parse(event.data)

      if (name === 'hello') {
        client.send(JSON.stringify(['greetings', `Hello, ${firstName}!`]))
      }
    })
  })

  const ws = createSocketClient('wss://example.com')
  ws.emit('hello', 'John')
  ws.on('greetings', (message) => incomingData.resolve(message))

  await expect(incomingData.promise).resolves.toBe('Hello, John!')
})

it('decodes incoming server events', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')
  await using httpServer = await createTestHttpServer()
  const wsServer = createSocketIoServer(httpServer)
  onTestFinished(() => wsServer.close())

  const incomingServerData = Promise.withResolvers<WebSocketData>()
  const incomingClientData = Promise.withResolvers<WebSocketData>()

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
  ws.emit('hello', 'John')
  ws.on('greeting', (message) => {
    incomingClientData.resolve(message)
  })

  await expect(
    incomingServerData.promise,
    'the interceptor gets the decoded event'
  ).resolves.toBe('["greeting",{"id":1,"text":"Hello, John!"}]')
  await expect(
    incomingClientData.promise,
    'the Socket.IO client gets the original event'
  ).resolves.toEqual({
    id: 1,
    text: 'Hello, John!',
  })
})

it('modifies incoming server events', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')
  await using httpServer = await createTestHttpServer()
  const wsServer = createSocketIoServer(httpServer)
  onTestFinished(() => wsServer.close())

  const incomingServerData = Promise.withResolvers<WebSocketData>()
  const incomingClientData = Promise.withResolvers<WebSocketData>()

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
      client.send(JSON.stringify(['greeting', { id: 2, text: 'Hello, Sarah!' }]))
    })
  })

  const ws = createSocketClient(getWsUrl(httpServer))
  ws.emit('hello', 'John')
  ws.on('greeting', (message) => {
    incomingClientData.resolve(message)
  })

  await expect(
    incomingServerData.promise,
    'the interceptor gets the original event'
  ).resolves.toBe('["greeting",{"id":1,"text":"Hello, John!"}]')
  await expect(
    incomingClientData.promise,
    'the Socket.IO client gets the modified event'
  ).resolves.toEqual({
    id: 2,
    text: 'Hello, Sarah!',
  })
})
