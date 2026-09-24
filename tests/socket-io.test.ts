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

  const messages: Array<SocketIoMessage> = []
  const outgoingEvent = Promise.withResolvers<SocketIoMessage>()

  interceptor.on('connection', ({ client }) => {
    client.addEventListener('message', (event) => {
      messages.push(event.data)

      if (event.data.type === 'event') {
        outgoingEvent.resolve(event.data)
      }
    })
  })

  const ws = createSocketClient('wss://example.com')
  onTestFinished(() => {
    ws.close()
  })
  ws.emit('hello', 'John')

  await expect(outgoingEvent.promise).resolves.toEqual({
    type: 'event',
    namespace: '/',
    event: 'hello',
    args: ['John'],
  })
  expect(messages, 'exposes messages only, never frames').toEqual([
    { type: 'connect', namespace: '/', auth: undefined },
    { type: 'event', namespace: '/', event: 'hello', args: ['John'] },
  ])
})

it('encodes mocked incoming server events', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const incomingData = Promise.withResolvers<unknown>()

  interceptor.on('connection', ({ client }) => {
    client.addEventListener('message', (event) => {
      if (event.data.type === 'event' && event.data.event === 'hello') {
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
  onTestFinished(() => wsServer.close())

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
      if (event.data.type === 'event') {
        incomingServerData.resolve(event.data)
      }
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
    type: 'event',
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
  onTestFinished(() => wsServer.close())

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
      if (event.data.type !== 'event') {
        return
      }

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
    type: 'event',
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

it('acknowledges client events', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const outgoingEvent = Promise.withResolvers<SocketIoMessage>()

  interceptor.on('connection', ({ client }) => {
    client.addEventListener('message', (event) => {
      if (event.data.type === 'event' && event.data.id !== undefined) {
        outgoingEvent.resolve(event.data)
        client.send({
          type: 'ack',
          id: event.data.id,
          args: [`Hello, ${event.data.args[0]}!`],
        })
      }
    })
  })

  const ws = createSocketClient('wss://example.com')
  onTestFinished(() => {
    ws.close()
  })

  await expect(ws.emitWithAck('hello', 'John')).resolves.toBe('Hello, John!')
  await expect(
    outgoingEvent.promise,
    'the event carries its acknowledgement id',
  ).resolves.toEqual({
    type: 'event',
    namespace: '/',
    event: 'hello',
    args: ['John'],
    id: 0,
  })
})

it('receives acknowledgements of server events', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const acknowledgement = Promise.withResolvers<SocketIoMessage>()

  interceptor.on('connection', ({ client }) => {
    client.addEventListener('message', (event) => {
      if (event.data.type === 'connect') {
        client.send({ event: 'ping', args: [], id: 42 })
      }

      if (event.data.type === 'ack') {
        acknowledgement.resolve(event.data)
      }
    })
  })

  const ws = createSocketClient('wss://example.com')
  onTestFinished(() => {
    ws.close()
  })
  ws.on('ping', (callback) => callback('pong'))

  await expect(acknowledgement.promise).resolves.toEqual({
    type: 'ack',
    namespace: '/',
    id: 42,
    args: ['pong'],
  })
})

it('exposes the authentication payload of a namespace connection', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const connection = Promise.withResolvers<SocketIoMessage>()

  interceptor.on('connection', ({ client }) => {
    client.addEventListener('message', (event) => {
      if (event.data.type === 'connect') {
        connection.resolve(event.data)
      }
    })
  })

  const ws = createSocketClient('wss://example.com/admin', {
    auth: { token: 'abc-123' },
  })
  onTestFinished(() => {
    ws.close()
  })

  await expect(connection.promise).resolves.toEqual({
    type: 'connect',
    namespace: '/admin',
    auth: { token: 'abc-123' },
  })
})

it('rejects a namespace connection by policy', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const connectError = Promise.withResolvers<Error>()
  const onConnect = vi.fn()

  interceptor.on('connection', ({ socket }) => {
    socket.use((namespace, auth) => {
      const token =
        typeof auth === 'object' && auth !== null && 'token' in auth
          ? auth.token
          : undefined

      if (token !== 'valid') {
        const error = new Error('unauthorized')
        return Object.assign(error, { data: { namespace } })
      }

      return true
    })
  })

  const ws = createSocketClient('wss://example.com/admin', {
    auth: { token: 'invalid' },
  })
  onTestFinished(() => {
    ws.close()
  })
  ws.on('connect', onConnect)
  ws.on('connect_error', (error) => connectError.resolve(error))

  const error = await connectError.promise
  expect.soft(error.message).toBe('unauthorized')
  expect.soft(Reflect.get(error, 'data')).toEqual({ namespace: '/admin' })
  expect(onConnect, 'the client never connects').not.toHaveBeenCalled()
})

it('accepts a namespace connection by policy', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const connected = Promise.withResolvers<void>()

  interceptor.on('connection', ({ socket }) => {
    socket.use((_, auth) => {
      return typeof auth === 'object' &&
        auth !== null &&
        'token' in auth &&
        auth.token === 'valid'
        ? true
        : new Error('unauthorized')
    })
  })

  const ws = createSocketClient('wss://example.com/admin', {
    auth: { token: 'valid' },
  })
  onTestFinished(() => {
    ws.close()
  })
  ws.on('connect', () => connected.resolve())

  await expect(connected.promise).resolves.toBeUndefined()
})

it('exposes a namespace disconnection', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const disconnection = Promise.withResolvers<SocketIoMessage>()

  interceptor.on('connection', ({ client }) => {
    client.addEventListener('message', (event) => {
      if (event.data.type === 'disconnect') {
        disconnection.resolve(event.data)
      }
    })
  })

  const ws = createSocketClient('wss://example.com/chat')
  onTestFinished(() => {
    ws.close()
  })
  ws.on('connect', () => ws.disconnect())

  await expect(disconnection.promise).resolves.toEqual({
    type: 'disconnect',
    namespace: '/chat',
  })
})

it('disconnects a client from a namespace', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const reason = Promise.withResolvers<string>()

  interceptor.on('connection', ({ client, socket }) => {
    client.addEventListener('message', (event) => {
      if (event.data.type === 'event' && event.data.event === 'leave') {
        socket.of('/chat').disconnect()
      }
    })
  })

  const ws = createSocketClient('wss://example.com/chat')
  onTestFinished(() => {
    ws.close()
  })
  ws.on('disconnect', (disconnectReason) => reason.resolve(disconnectReason))
  ws.emit('leave')

  await expect(reason.promise).resolves.toBe('io server disconnect')
})

it('assigns a distinct session id to every connection', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const socketIds: Array<string> = []

  interceptor.on('connection', ({ socket }) => {
    socketIds.push(socket.id)
  })

  const first = createSocketClient('wss://example.com')
  onTestFinished(() => {
    first.close()
  })
  const second = createSocketClient('wss://example.com')
  onTestFinished(() => {
    second.close()
  })

  await expect.poll(() => first.id).toBeTypeOf('string')
  await expect.poll(() => second.id).toBeTypeOf('string')
  expect.soft(first.id, 'the clients get distinct ids').not.toBe(second.id)
  expect(socketIds, 'the handler sees the ids the clients got').toEqual([
    first.id,
    second.id,
  ])
})

it('exchanges events on a custom namespace', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const outgoingData = Promise.withResolvers<SocketIoMessage>()
  const incomingData = Promise.withResolvers<unknown>()

  interceptor.on('connection', ({ client }) => {
    client.addEventListener('message', (event) => {
      if (event.data.type !== 'event') {
        return
      }

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
    type: 'event',
    namespace: '/admin',
    event: 'hello',
    args: ['John'],
  })
  await expect(incomingData.promise).resolves.toBe('Hello from /admin!')
})

it('sends events to every socket in a room, including the sender', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const firstIncomingData = Promise.withResolvers<unknown>()
  const secondIncomingData = Promise.withResolvers<unknown>()

  interceptor.on('connection', ({ client, socket, io }) => {
    client.addEventListener('message', (event) => {
      if (event.data.type !== 'event') {
        return
      }

      const [room] = event.data.args

      if (event.data.event === 'join' && typeof room === 'string') {
        socket.join(room)
      }

      if (event.data.event === 'announce' && typeof room === 'string') {
        io.to(room).send({ event: 'news', args: ['hello lobby'] })
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

it('sends events to the other sockets in a room, excluding the sender', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const memberIncomingData = Promise.withResolvers<unknown>()
  const onSenderData = vi.fn<(message: unknown) => void>()

  interceptor.on('connection', ({ client, socket }) => {
    client.addEventListener('message', (event) => {
      if (event.data.type !== 'event') {
        return
      }

      const [room] = event.data.args

      if (event.data.event === 'join' && typeof room === 'string') {
        socket.join(room)
      }

      if (event.data.event === 'announce' && typeof room === 'string') {
        socket.to(room).send({ event: 'news', args: ['hello lobby'] })
      }
    })
  })

  const member = createSocketClient('wss://example.com')
  onTestFinished(() => {
    member.close()
  })
  const sender = createSocketClient('wss://example.com')
  onTestFinished(() => {
    sender.close()
  })
  member.on('news', (message) => memberIncomingData.resolve(message))
  sender.on('news', onSenderData)

  member.emit('join', 'lobby')
  sender.emit('join', 'lobby')
  sender.emit('announce', 'lobby')

  await expect(memberIncomingData.promise).resolves.toBe('hello lobby')
  expect(onSenderData).not.toHaveBeenCalled()
})

it('does not send room events to sockets outside the room', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const memberIncomingData = Promise.withResolvers<unknown>()
  const onOutsiderData = vi.fn<(message: unknown) => void>()

  interceptor.on('connection', ({ client, socket, io }) => {
    client.addEventListener('message', (event) => {
      if (event.data.type !== 'event') {
        return
      }

      const [room] = event.data.args

      if (event.data.event === 'join' && typeof room === 'string') {
        socket.join(room)
      }

      if (event.data.event === 'announce' && typeof room === 'string') {
        io.to(room).send({ event: 'news', args: ['hello lobby'] })
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

it('scopes rooms to their namespace', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const chatIncomingData = Promise.withResolvers<unknown>()
  const onDefaultData = vi.fn<(message: unknown) => void>()

  interceptor.on('connection', ({ client, socket, io }) => {
    client.addEventListener('message', (event) => {
      if (event.data.type !== 'event') {
        return
      }

      const [room] = event.data.args

      if (event.data.event === 'join' && typeof room === 'string') {
        socket.of(event.data.namespace ?? '/').join(room)
      }

      if (event.data.event === 'announce' && typeof room === 'string') {
        io.of('/chat')
          .to(room)
          .send({ event: 'news', args: ['hello chat'] })
      }
    })
  })

  const chat = createSocketClient('wss://example.com/chat')
  onTestFinished(() => {
    chat.close()
  })
  const other = createSocketClient('wss://example.com')
  onTestFinished(() => {
    other.close()
  })
  chat.on('news', (message) => chatIncomingData.resolve(message))
  other.on('news', onDefaultData)

  chat.emit('join', 'lobby')
  other.emit('join', 'lobby')
  chat.emit('announce', 'lobby')

  await expect(chatIncomingData.promise).resolves.toBe('hello chat')
  expect(
    onDefaultData,
    'the same room in another namespace is a different room',
  ).not.toHaveBeenCalled()
})

it('sends events to every socket of a namespace', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const firstIncomingData = Promise.withResolvers<unknown>()
  const secondIncomingData = Promise.withResolvers<unknown>()

  interceptor.on('connection', ({ client, io }) => {
    client.addEventListener('message', (event) => {
      if (event.data.type === 'event' && event.data.event === 'announce') {
        io.send({ event: 'news', args: ['hello everyone'] })
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

  await expect.poll(() => first.connected && second.connected).toBe(true)
  first.emit('announce')

  await expect(firstIncomingData.promise).resolves.toBe('hello everyone')
  await expect(secondIncomingData.promise).resolves.toBe('hello everyone')
})

it('broadcasts events to the other sockets of a namespace', async () => {
  const { createSocketClient } = await import('./socket.io-client.js')

  const otherIncomingData = Promise.withResolvers<unknown>()
  const onSenderData = vi.fn<(message: unknown) => void>()

  interceptor.on('connection', ({ client, socket }) => {
    client.addEventListener('message', (event) => {
      if (event.data.type === 'event' && event.data.event === 'announce') {
        socket.broadcast.send({ event: 'news', args: ['hello others'] })
      }
    })
  })

  const sender = createSocketClient('wss://example.com')
  onTestFinished(() => {
    sender.close()
  })
  const other = createSocketClient('wss://example.com')
  onTestFinished(() => {
    other.close()
  })
  sender.on('news', onSenderData)
  other.on('news', (message) => otherIncomingData.resolve(message))

  await expect.poll(() => sender.connected && other.connected).toBe(true)
  sender.emit('announce')

  await expect(otherIncomingData.promise).resolves.toBe('hello others')
  expect(onSenderData).not.toHaveBeenCalled()
})
