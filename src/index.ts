import {
  encodePacket,
  decodePacket,
  type Packet as EngineIoPacket,
} from 'engine.io-parser'
import {
  Encoder,
  Decoder,
  PacketType,
  type Packet as SocketIoPacket,
} from 'socket.io-parser'
import {
  WebSocketProtocol,
  type WebSocketData,
  type WebSocketProtocolContext,
  type WebSocketProtocolMessageContext,
} from '@mswjs/interceptors/WebSocket'

const SESSION_ID = 'test'

/**
 * @note Advertise a heartbeat the client will never expect within
 * the lifetime of a test (the sum stays below the timer ceiling of 2^31 ms).
 * The client drops the connection unless it receives a ping within
 * `pingInterval + pingTimeout`, and a mocked server has no reason to ping.
 */
const PING_INTERVAL = 2_000_000_000
const PING_TIMEOUT = 100_000_000

const encoder = new Encoder()

function encodeEngineIoPacket(packet: EngineIoPacket): string {
  let encodedPacket = ''

  // The callback is invoked synchronously for text packets.
  encodePacket(packet, false, (result) => {
    if (typeof result === 'string') {
      encodedPacket = result
    }
  })

  return encodedPacket
}

function encodeSocketIoPacket(packet: SocketIoPacket): string {
  const [encodedPacket] = encoder.encode(packet)

  if (typeof encodedPacket !== 'string') {
    throw new Error('Binary Socket.IO packets are not supported')
  }

  return encodeEngineIoPacket({ type: 'message', data: encodedPacket })
}

/**
 * The Socket.IO protocol over WebSocket.
 *
 * Messages are Socket.IO events as JSON text: `'["event", ...args]'`.
 * The Engine.IO session and the protocol control packets are handled
 * by the protocol and never surface. Binary attachments are not supported.
 *
 * @example
 * // With Interceptors: applied to every Socket.IO connection.
 * new WebSocketInterceptor({ protocols: [new SocketIo()] })
 *
 * @example
 * // With Mock Service Worker: applied to the connections of this link.
 * const chat = ws.link('wss://example.com/chat', { protocol: new SocketIo() })
 *
 * chat.addEventListener('connection', ({ client }) => {
 *   client.addEventListener('message', (event) => {
 *     const [name, ...args] = JSON.parse(event.data)
 *   })
 *   client.send(JSON.stringify(['greeting', 'Hello, John!']))
 * })
 */
export class SocketIo extends WebSocketProtocol<string> {
  /**
   * The Socket.IO decoder is stateful (binary attachments span
   * multiple frames), so keep one per connection.
   */
  private readonly decoders = new WeakMap<object, Decoder>()

  public match({ client }: WebSocketProtocolContext): boolean {
    return client.url.searchParams.has('EIO')
  }

  public encode(message: string): string {
    return encodeSocketIoPacket({
      type: PacketType.EVENT,
      /**
       * @todo Support custom namespaces.
       */
      nsp: '/',
      data: JSON.parse(message),
    })
  }

  public decode(
    frame: WebSocketData,
    { connection }: WebSocketProtocolMessageContext,
  ): Iterator<string> | undefined {
    // Messages are always decoded as strings.
    if (typeof frame !== 'string') {
      return
    }

    const packet = decodePacket(frame, 'arraybuffer')

    // Ignore the Engine.IO control packets (open, ping, pong, etc).
    if (packet.type !== 'message') {
      return
    }

    const decoder = this.#getDecoder(connection)
    const events: Array<string> = []
    const collectEvent = (socketIoPacket: SocketIoPacket) => {
      // Ignore the Socket.IO control packets (connect, ack, etc).
      if (socketIoPacket.type === PacketType.EVENT) {
        events.push(JSON.stringify(socketIoPacket.data))
      }
    }

    decoder.on('decoded', collectEvent)
    decoder.add(packet.data)
    decoder.off('decoded', collectEvent)

    return events.values()
  }

  public *handshake(): Generator<string> {
    // Establish the Engine.IO session.
    yield encodeEngineIoPacket({
      type: 'open',
      data: JSON.stringify({
        sid: SESSION_ID,
        upgrades: [],
        pingInterval: PING_INTERVAL,
        pingTimeout: PING_TIMEOUT,
      }),
    })

    // Approve the connection to the default namespace.
    yield encodeSocketIoPacket({
      type: PacketType.CONNECT,
      nsp: '/',
      data: { sid: SESSION_ID },
    })
  }

  #getDecoder(connection: object): Decoder {
    let decoder = this.decoders.get(connection)

    if (!decoder) {
      decoder = new Decoder()
      this.decoders.set(connection, decoder)
    }

    return decoder
  }
}
