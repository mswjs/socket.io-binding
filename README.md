## `@mswjs/socket.io-binding`

The Socket.IO protocol as a WebSocket extension for [`@mswjs/interceptors`](https://github.com/mswjs/interceptors) and [Mock Service Worker](https://github.com/mswjs/msw). Apply it to intercepted WebSocket connections to work with Socket.IO messages instead of the raw Engine.IO/Socket.IO frames.

## Motivation

Socket.IO implements its own protocol on top of WebSocket: a session handshake, a heartbeat, namespaces, acknowledgements, and a packet framing. Without the extension, an intercepted connection exposes the raw frames (e.g. `40`, `42["hello","John"]`), expects you to send them back the same way, and never completes the handshake a Socket.IO client waits for. With the extension, the connection speaks Socket.IO messages, and the session is established for you.

> **Only WebSocket transports reach a WebSocket extension.** Connect the Socket.IO client with `transports: ['websocket']`. A client that starts with HTTP long-polling never gets here.

## Install

```sh
npm install @mswjs/socket.io-binding
```

## Messages

A message is one of the following objects. The `namespace` is the default one (`/`) when omitted.

```ts
// An event. Carries an `id` when the sender expects an acknowledgement.
{ type?: 'event', namespace?: string, event: string, args: Array<unknown>, id?: number }
// An acknowledgement of the event with the given `id`.
{ type: 'ack', namespace?: string, id: number, args: Array<unknown> }
// A connection to a namespace, with the `auth` payload the client sent.
{ type: 'connect', namespace?: string, auth?: unknown }
// A rejected connection to a namespace.
{ type: 'connect_error', namespace?: string, error: unknown }
// A disconnection from a namespace.
{ type: 'disconnect', namespace?: string }
```

Events are the default: `client.send({ event: 'greeting', args: ['Hello!'] })`.

## Usage

### With Mock Service Worker

```js
import { ws } from 'msw'
import { SocketIo } from '@mswjs/socket.io-binding'

const chat = ws.link('wss://example.com/chat', { extensions: [new SocketIo()] })

export const handlers = [
  chat.addEventListener('connection', ({ client }) => {
    client.addEventListener('message', (event) => {
      if (event.data.type === 'event' && event.data.event === 'hello') {
        const [firstName] = event.data.args
        client.send({ event: 'greeting', args: [`Hello, ${firstName}!`] })
      }
    })
  }),
]
```

`client.send()`, `server.send()`, `chat.broadcast()`, and the `message` events all operate on Socket.IO messages. The extension encodes and decodes the frames behind the scenes.

### With Interceptors

The extension recognizes Socket.IO connections by their URL, so it applies to them automatically.

```js
import { WebSocketInterceptor } from '@mswjs/interceptors/WebSocket'
import { SocketIo } from '@mswjs/socket.io-binding'

const interceptor = new WebSocketInterceptor({
  extensions: [new SocketIo()],
})

interceptor.on('connection', ({ server }) => {
  server.connect()
  server.addEventListener('message', (event) => {
    console.log(event.data) // { type: 'event', namespace: '/', event: 'greeting', args: ['Hello, John!'] }
  })
})
```

### Acknowledgements

An event the client sent with a callback (`emit('hello', 'John', callback)` or `emitWithAck()`) carries an `id`. Acknowledge it with an `ack` message of the same `id`. Events you send with an `id` get acknowledged the same way.

```js
chat.addEventListener('connection', ({ client }) => {
  client.addEventListener('message', (event) => {
    if (event.data.type === 'event' && event.data.id !== undefined) {
      client.send({ type: 'ack', id: event.data.id, args: ['received'] })
    }
  })
})
```

### Namespaces

Every namespace a client connects to is accepted by default. The connection surfaces as a `connect` message with the `auth` payload the client sent. To accept or reject connections, register a policy on the client's `socket`. The rejection reaches the client as `connect_error`.

```js
chat.addEventListener('connection', ({ socket }) => {
  socket.use((namespace, auth) => {
    if (auth?.token !== 'valid') {
      return Object.assign(new Error('unauthorized'), { data: { namespace } })
    }
    return true
  })
})
```

The namespace of an event is a part of the event, both when receiving and when sending. A client leaving a namespace surfaces as a `disconnect` message, and `socket.of(namespace).disconnect()` disconnects the client from a namespace.

### Rooms

The connection event carries the client's `socket` and the mocked server `io`, mirroring Socket.IO. Rooms are scoped to their namespace. `socket.to()` and `socket.broadcast` exclude the sending socket, `io.to()` and `io.send()` include it.

```js
chat.addEventListener('connection', ({ client, socket, io }) => {
  client.addEventListener('message', (event) => {
    if (event.data.type !== 'event') {
      return
    }

    const [room] = event.data.args

    if (event.data.event === 'join') {
      socket.join(room) // The default namespace. Use `socket.of('/chat').join(room)` for others.
      socket.to(room).send({ event: 'joined', args: [socket.id] })
    }

    if (event.data.event === 'announce') {
      io.of('/chat')
        .to(room)
        .send({ event: 'news', args: ['Hello, room!'] })
    }
  })
})
```

Every socket leaves its rooms once the client disconnects.

## Limitations

Rooms and sockets are kept per extension instance and do not span multiple runtimes (e.g. multiple browser tabs). Namespace policies are synchronous. If you rely on any of these, open a pull request and implement them. Thank you.
