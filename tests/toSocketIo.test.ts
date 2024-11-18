// @vitest-environment node-websocket
import {
  WebSocketInterceptor,
  type WebSocketData,
} from '@mswjs/interceptors/WebSocket'
import { Server } from 'socket.io'
import { HttpServer } from '@open-draft/test-server/http'
import { DeferredPromise } from '@open-draft/deferred-promise'
import { toSocketIo } from '../src/index.js'

const interceptor = new WebSocketInterceptor()

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

it('intercepts custom outgoing client event', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const eventLog: Array<WebSocketData> = []
  const outgoingDataPromise = new DeferredPromise<WebSocketData>()

  interceptor.on('connection', (connection) => {
    connection.client.addEventListener('message', (event) => {
      eventLog.push(event.data)
    })

    const { client } = toSocketIo(connection)

    client.on('hello', (event, name) => {
      outgoingDataPromise.resolve(name)
    })
  })

  const ws = createSocketClient('wss://example.com')
  ws.emit('hello', 'John')

  // Must expose the decoded event payload.
  expect(await outgoingDataPromise).toBe('John')
  // Must emit proper outgoing client messages.
  expect(eventLog).toEqual(['40', '42["hello","John"]'])
})

it('sends a mocked custom incoming server event', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const eventLog: Array<WebSocketData> = []
  const incomingDataPromise = new DeferredPromise<WebSocketData>()

  interceptor.on('connection', (connection) => {
    connection.client.addEventListener('message', (event) => {
      eventLog.push(event.data)
    })

    const { client } = toSocketIo(connection)

    client.on('hello', (event, name) => {
      client.emit('greetings', `Hello, ${name}!`)
    })
  })

  const ws = createSocketClient('wss://example.com')
  ws.emit('hello', 'John')
  ws.on('greetings', (message) => incomingDataPromise.resolve(message))

  // Must emit proper outgoing server messages.
  expect(await incomingDataPromise).toBe('Hello, John!')
  // Must expose the decoded event payload.
  expect(eventLog).toEqual(['40', '42["hello","John"]'])
})

it('intercepts incoming server event', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const incomingServerDataPromise = new DeferredPromise<WebSocketData>()
  const incomingClientDataPromise = new DeferredPromise<WebSocketData>()

  wsServer.on('connection', (client) => {
    client.on('hello', (name) => {
      client.emit('greeting', { id: 1, text: `Hello, ${name}!` })
    })
  })

  interceptor.on('connection', (connection) => {
    connection.server.connect()

    // Forward the raw outgoing client events
    // to the server to establish a Socket.IO connection.
    connection.client.addEventListener('message', (event) => {
      connection.server.send(event.data)
    })

    const { server } = toSocketIo(connection)

    server.on('greeting', (event, message) => {
      incomingServerDataPromise.resolve(message)
    })
  })

  const ws = createSocketClient(getWsUrl())
  ws.emit('hello', 'John')
  ws.on('greeting', (message) => {
    incomingClientDataPromise.resolve(message)
  })

  expect(await incomingServerDataPromise).toEqual({
    id: 1,
    text: 'Hello, John!',
  })
  expect(await incomingClientDataPromise).toEqual({
    id: 1,
    text: 'Hello, John!',
  })
})

it('modifies incoming server event', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const incomingServerDataPromise = new DeferredPromise<WebSocketData>()
  const incomingClientDataPromise = new DeferredPromise<WebSocketData>()

  wsServer.on('connection', (client) => {
    client.on('hello', (name) => {
      client.emit('greeting', { id: 1, text: `Hello, ${name}!` })
    })
  })

  interceptor.on('connection', (connection) => {
    const io = toSocketIo(connection)

    connection.server.connect()

    // Forward the raw outgoing client events.
    // Socket.IO will be encoding/decoding those by itself.
    connection.client.addEventListener('message', (event) => {
      connection.server.send(event.data)
    })

    io.server.on('greeting', (event, message) => {
      incomingServerDataPromise.resolve(message)

      event.preventDefault()
      io.client.emit('greeting', { id: 2, text: 'Hello, Sarah!' })
    })
  })

  const ws = createSocketClient(getWsUrl())
  ws.emit('hello', 'John')
  ws.on('greeting', (message) => {
    incomingClientDataPromise.resolve(message)
  })

  // The interceptor gets the original incoming message.
  expect(await incomingServerDataPromise).toEqual({
    id: 1,
    text: 'Hello, John!',
  })
  // The WebSocket client gets the modified incoming message.
  expect(await incomingClientDataPromise).toEqual({
    id: 2,
    text: 'Hello, Sarah!',
  })
})
