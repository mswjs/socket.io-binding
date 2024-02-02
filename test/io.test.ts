/**
 * @vitest-environment node-with-websockets
 */
import {
  WebSocketInterceptor,
  WebSocketRawData,
} from '@mswjs/interceptors/WebSocket'
import { Server } from 'socket.io'
import { HttpServer } from '@open-draft/test-server/http'
import { DeferredPromise } from '@open-draft/deferred-promise'
import { createSocketIoConnection, toSocketIoConnection } from '../src/io'

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

afterAll(async () => {
  interceptor.dispose()
  await httpServer.close()
})

it('intercepts custom outgoing client event', async () => {
  const { createSocketClient } = await import('./usage')

  const eventLog: Array<string> = []
  const outgoingDataPromise = new DeferredPromise<WebSocketRawData>()

  interceptor.once('connection', ({ client }) => {
    client.on('message', (event) => eventLog.push(event.data))

    const io = createSocketIoConnection(client)

    io.on('hello', (name) => {
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
  const { createSocketClient } = await import('./usage')

  const eventLog: Array<string> = []
  const incomingDataPromise = new DeferredPromise<WebSocketRawData>()

  interceptor.once('connection', ({ client }) => {
    console.log('CONNECT')

    client.on('message', (event) => eventLog.push(event.data))

    const io = createSocketIoConnection(client)

    io.on('hello', (name) => {
      io.emit('greetings', `Hello, ${name}!`)
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
  const { createSocketClient } = await import('./usage')

  const incomingServerDataPromise = new DeferredPromise<WebSocketRawData>()
  const incomingClientDataPromise = new DeferredPromise<WebSocketRawData>()

  wsServer.on('connection', (client) => {
    client.on('hello', (name) => {
      client.emit('greeting', { id: 1, text: `Hello, ${name}!` })
    })
  })

  interceptor.once('connection', (connection) => {
    connection.server.connect()

    // Forward the raw outgoing client events
    // to the server to establish a Socket.IO connection.
    connection.client.on('message', (event) => {
      connection.server.send(event.data)
    })

    const io = createSocketIoConnection(connection.server)

    io.on('greeting', (message) => {
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
  const { createSocketClient } = await import('./usage')

  const incomingServerDataPromise = new DeferredPromise<WebSocketRawData>()
  const incomingClientDataPromise = new DeferredPromise<WebSocketRawData>()

  wsServer.on('connection', (client) => {
    client.on('hello', (name) => {
      client.emit('greeting', { id: 1, text: `Hello, ${name}!` })
    })
  })

  interceptor.once('connection', (connection) => {
    const io = toSocketIoConnection(connection)

    connection.server.connect()

    // Forward the raw outgoing client events.
    // Socket.IO will be encoding/decoding those by itself.
    connection.client.on('message', (event) => {
      console.log('[i,raw] from client:', event.data)
      connection.server.send(event.data)
    })

    io.server.on('greeting', (message) => {
      console.log('[i] from server:', message)

      incomingServerDataPromise.resolve(message)

      /**
       * @fixme Forward the original "event" instance
       * so its default can be prevented (cancel forwarding).
       */
      /**
       * @fixme How to prevent forwarding for multi-events?
       * (e.g. receiving Blob from the server). There will be
       * multiple "message" events dispatched.
       */

      // event.preventDefault()
      // io.client.emit('greeting', { id: 2, text: 'Hello, Sarah!' })
    })
  })

  const ws = createSocketClient(getWsUrl())
  ws.emit('hello', 'John')
  ws.on('greeting', (message) => {
    console.log('CLIENT greeting', { message })

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
