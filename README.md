## `@mswjs/socket.io-binding`

## Motivation

This package is intended as a wrapper over the `WebSocketInterceptor` from [`@mswjs/interceptors`](https://github.com/mswjs/interceptors). It provides automatic encoding and decoding of messages, letting you work with the Socket.IO clients and servers as you are used to.

```js
import { WebSocketInterceptor } from '@mswjs/interceptor'
import { bind } from '@mswjs/socket.io-binding'

const interceptor = new WebSocketInterceptor()

interceptor.on('connection', ({ client, server }) => {
  client.on('message', (event) => {
    // Socket.IO implements their custom messaging protocol.
    // This means that the "raw" event data you get will be
    // encoded: e.g. "40", "42['message', 'Hello, John!']".
    console.log(event.data)
  })

  const io = bind({ client, server })

  io.client.on('greeting', (event, message) => {
    // Using the wrapper, you get the decoded messages,
    // as well as support for custom event listeners.
    console.log(message) // "Hello, John!"
  })
})
```

> You can also use this package with [Mock Service Worker](https://github.com/mswjs/msw) directly.

## Limitations

This wrapper is not meant to provide full feature parity with the Socket.IO client API. Some features may be missing (like rooms, namespaces, broadcasting). If you rely of any of the missing features, open a pull request and implement it. Thank you.

> Note that feature parity only concerns the _connection wrapper_. You can still use the entire of the Socket.IO feature set in the actual application code.

## Install

```sh
npm i @mswjs/socket.io-binding
```

## Examples

### Using with Mock Service Worker

```js
import { ws } from 'msw'
import { bind } from '@mswjs/socket.io-binding'

const chat = ws.url('wss://example.com')

export const handlers = [
  ws.on('connection', ({ client, server }) => {
    const io = bind({ client, server })

    io.on('hello', (event, name) => {
      console.log('client sent hello:', name)
    })
  }),
]
```
