## `@mswjs/socket.io-binding`

The Socket.IO protocol as a WebSocket extension for [`@mswjs/interceptors`](https://github.com/mswjs/interceptors) and [Mock Service Worker](https://github.com/mswjs/msw). Apply it to intercepted WebSocket connections to work with Socket.IO events instead of the raw Engine.IO/Socket.IO frames.

## Motivation

Socket.IO implements its own protocol on top of WebSocket: a session handshake, a heartbeat, namespaces, and a packet framing. Without the extension, an intercepted connection exposes the raw frames (e.g. `40`, `42["hello","John"]`), expects you to send them back the same way, and never completes the handshake a Socket.IO client waits for. With the extension, the connection speaks Socket.IO events, and the session is established for you.

An event is represented as an object:

```ts
interface SocketIoMessage {
  namespace?: string // The default namespace ("/") when omitted.
  event: string
  args: Array<unknown>
}
```

## Install

```sh
npm install @mswjs/socket.io-binding
```

## Usage

### With Mock Service Worker

```js
import { ws } from 'msw'
import { SocketIo } from '@mswjs/socket.io-binding'

const chat = ws.link('wss://example.com/chat', { extensions: [new SocketIo()] })

export const handlers = [
  chat.addEventListener('connection', ({ client }) => {
    client.addEventListener('message', (event) => {
      const { event: name, args } = event.data

      if (name === 'hello') {
        const [firstName] = args
        client.send({ event: 'greeting', args: [`Hello, ${firstName}!`] })
      }
    })
  }),
]
```

`client.send()`, `server.send()`, `chat.broadcast()`, and the `message` events all operate on Socket.IO events. The extension encodes and decodes the frames behind the scenes.

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
    console.log(event.data) // { namespace: '/', event: 'greeting', args: ['Hello, John!'] }
  })
})
```

### Namespaces

The extension approves every namespace a client connects to. The namespace of an event is a part of the event, both when receiving and when sending.

```js
chat.addEventListener('connection', ({ client }) => {
  client.addEventListener('message', (event) => {
    if (event.data.namespace === '/admin') {
      client.send({
        namespace: '/admin',
        event: 'greeting',
        args: ['Hello, admin!'],
      })
    }
  })
})
```

### Rooms

The extension exposes the rooms of a connection on the connection event. A connection leaves all of its rooms once closed.

```js
chat.addEventListener('connection', ({ client, rooms }) => {
  client.addEventListener('message', (event) => {
    const { event: name, args } = event.data

    if (name === 'join') {
      const [room] = args
      rooms.join(room)
      rooms.to(room).send({ event: 'joined', args: [room] })
    }
  })
})
```

## Limitations

Acknowledgements are not supported. Rooms are kept per extension instance and do not span multiple runtimes (e.g. multiple browser tabs). If you rely on any of these, open a pull request and implement them. Thank you.
