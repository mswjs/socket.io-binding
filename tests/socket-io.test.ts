// @vitest-environment node-websocket
import {
  WebSocketInterceptor,
  type WebSocketData,
} from '@mswjs/interceptors/WebSocket'
import { Server } from 'socket.io'
import { HttpServer } from '@open-draft/test-server/http'
import { DeferredPromise } from '@open-draft/deferred-promise'
import { SocketIo } from '../src/index.js'

const interceptor = new WebSocketInterceptor({
  protocols: [new SocketIo()],
})

const httpServer = new HttpServer()
const wsServer = new Server(httpServer['_http'])

function getWsUrl(): string {
  const url = new URL(httpServer.http.address.href)
  url.protocol = url.protocol.replace('http', 'ws')
  return url.href
}

beforeAll(async () => {
  interceptor.apply()
  await httpServer.listen()
})

afterEach(() => {
  interceptor.removeAllListeners()
})

afterAll(async () => {
  interceptor.dispose()
  await httpServer.close()
})

it('decodes outgoing client events', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const eventLog: Array<WebSocketData> = []
  const outgoingDataPromise = new DeferredPromise<WebSocketData>()

  interceptor.on('connection', ({ client }) => {
    client.addEventListener('message', (event) => {
      eventLog.push(event.data)
      outgoingDataPromise.resolve(event.data)
    })
  })

  const ws = createSocketClient('wss://example.com')
  ws.emit('hello', 'John')

  await expect(outgoingDataPromise).resolves.toBe('["hello","John"]')
  expect(eventLog, 'exposes no protocol packets').toEqual([
    '["hello","John"]',
  ])
})

it('encodes mocked incoming server events', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const incomingDataPromise = new DeferredPromise<WebSocketData>()

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
  ws.on('greetings', (message) => incomingDataPromise.resolve(message))

  await expect(incomingDataPromise).resolves.toBe('Hello, John!')
})

it('decodes incoming server events', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const incomingServerDataPromise = new DeferredPromise<WebSocketData>()
  const incomingClientDataPromise = new DeferredPromise<WebSocketData>()

  wsServer.on('connection', (client) => {
    client.on('hello', (name) => {
      client.emit('greeting', { id: 1, text: `Hello, ${name}!` })
    })
  })

  interceptor.on('connection', ({ server }) => {
    server.connect()

    server.addEventListener('message', (event) => {
      incomingServerDataPromise.resolve(event.data)
    })
  })

  const ws = createSocketClient(getWsUrl())
  ws.emit('hello', 'John')
  ws.on('greeting', (message) => {
    incomingClientDataPromise.resolve(message)
  })

  await expect(
    incomingServerDataPromise,
    'the interceptor gets the decoded event'
  ).resolves.toBe('["greeting",{"id":1,"text":"Hello, John!"}]')
  await expect(
    incomingClientDataPromise,
    'the Socket.IO client gets the original event'
  ).resolves.toEqual({
    id: 1,
    text: 'Hello, John!',
  })
})

it('modifies incoming server events', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const incomingServerDataPromise = new DeferredPromise<WebSocketData>()
  const incomingClientDataPromise = new DeferredPromise<WebSocketData>()

  wsServer.on('connection', (client) => {
    client.on('hello', (name) => {
      client.emit('greeting', { id: 1, text: `Hello, ${name}!` })
    })
  })

  interceptor.on('connection', ({ client, server }) => {
    server.connect()

    server.addEventListener('message', (event) => {
      incomingServerDataPromise.resolve(event.data)

      event.preventDefault()
      client.send(JSON.stringify(['greeting', { id: 2, text: 'Hello, Sarah!' }]))
    })
  })

  const ws = createSocketClient(getWsUrl())
  ws.emit('hello', 'John')
  ws.on('greeting', (message) => {
    incomingClientDataPromise.resolve(message)
  })

  await expect(
    incomingServerDataPromise,
    'the interceptor gets the original event'
  ).resolves.toBe('["greeting",{"id":1,"text":"Hello, John!"}]')
  await expect(
    incomingClientDataPromise,
    'the Socket.IO client gets the modified event'
  ).resolves.toEqual({
    id: 2,
    text: 'Hello, Sarah!',
  })
})
