## `@mswjs/socket.io-binding`

The Socket.IO protocol as a WebSocket protocol for [`@mswjs/interceptors`](https://github.com/mswjs/interceptors) and [Mock Service Worker](https://github.com/mswjs/msw). Apply it to intercepted WebSocket connections to work with Socket.IO events instead of the raw Engine.IO/Socket.IO frames.

## Motivation

Socket.IO implements its own protocol on top of WebSocket: a session handshake, a heartbeat, and a packet framing. Without the protocol, an intercepted connection exposes the raw frames (e.g. `40`, `42["hello","John"]`), expects you to send them back the same way, and never completes the handshake a mocked Socket.IO client waits for. With the protocol, the connection speaks Socket.IO events, and the session is established for you.

An event is represented as the JSON text of its `[event, ...args]` tuple.

## Install

```sh
npm install @mswjs/socket.io-binding
```

## Usage

### With Mock Service Worker

```js
import { ws } from 'msw'
import { SocketIo } from '@mswjs/socket.io-binding'

const chat = ws.link('wss://example.com/chat', { protocol: new SocketIo() })

export const handlers = [
  chat.addEventListener('connection', ({ client }) => {
    client.addEventListener('message', (event) => {
      const [name, firstName] = JSON.parse(event.data)

      if (name === 'hello') {
        client.send(JSON.stringify(['greeting', `Hello, ${firstName}!`]))
      }
    })
  }),
]
```

### With Interceptors

The protocol recognizes Socket.IO connections by their URL, so it applies to them automatically.

```js
import { WebSocketInterceptor } from '@mswjs/interceptors/WebSocket'
import { SocketIo } from '@mswjs/socket.io-binding'

const interceptor = new WebSocketInterceptor({
  protocols: [new SocketIo()],
})

interceptor.on('connection', ({ server }) => {
  server.connect()
  server.addEventListener('message', (event) => {
    console.log(event.data) // '["greeting","Hello, John!"]'
  })
})
```

## Limitations

The protocol supports the default namespace and text events only. Custom namespaces, acknowledgements, and binary attachments are not supported. If you rely on any of these, open a pull request and implement them. Thank you.
