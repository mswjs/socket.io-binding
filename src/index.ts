import {
  encodePayload,
  decodePayload,
  Packet as EngineIoPacket,
  BinaryType,
} from 'engine.io-parser'
import {
  Encoder,
  Decoder,
  PacketType as SocketIoPacketType,
} from 'socket.io-parser'
import {
  WebSocketEventMap,
  WebSocketClientConnection,
  WebSocketServerConnection,
} from '@mswjs/interceptors/WebSocket'

const encoder = new Encoder()
const decoder = new Decoder()

type BoundMessageListener = (
  // @ts-expect-error Bug in @types/node: Missing annotation
  event: MessageEvent,
  ...data: Array<any>
) => void

class SocketIoConnection {
  constructor(
    private readonly connection:
      | WebSocketClientConnection
      | WebSocketServerConnection,
  ) {}

  public on(event: string, listener: BoundMessageListener): void {
    this.connection.on('message', function (messageEvent) {
      const binaryType: BinaryType =
        this.binaryType === 'blob'
          ? this.binaryType
          : typeof Buffer === 'undefined'
          ? 'arraybuffer'
          : 'nodebuffer'

      const engineIoPackets = decodePayload(messageEvent.data, binaryType)

      /**
       * @todo Check if this works correctly with
       * Blob and ArrayBuffer data.
       */
      if (engineIoPackets.every((packet) => packet.type !== 'message')) {
        return
      }

      for (const packet of engineIoPackets) {
        decoder.once('decoded', (decodedSocketIoPacket) => {
          /**
           * @note Ignore any non-event messages.
           * To forward all Socket.IO messages one must listen
           * to the raw outgoing client events:
           * client.on('message', (event) => server.send(event.data))
           */
          if (decodedSocketIoPacket.type !== SocketIoPacketType.EVENT) {
            return
          }

          const [sentEvent, ...data] = decodedSocketIoPacket.data

          if (sentEvent === event) {
            listener.call(undefined, messageEvent, ...data)
          }
        })

        decoder.add(packet.data)
      }
    })
  }

  public send(...data: Array<any>): void {
    this.emit('message', ...data)
  }

  public emit(event: string, ...data: Array<any>): void {
    /**
     * @todo Check if this correctly encodes Blob
     * and ArrayBuffer data.
     */
    const encodedSocketIoPacket = encoder.encode({
      type: SocketIoPacketType.EVENT,
      /**
       * @todo Support custom namespaces.
       */
      nsp: '/',
      data: [event, ...data],
    })

    const engineIoPackets = encodedSocketIoPacket.map<EngineIoPacket>(
      (packet) => {
        return {
          type: 'message',
          data: packet,
        }
      },
    )

    // Encode the payload in multiple sends
    // because Socket.IO represents Blob/Buffer
    // data with 2 "message" events dispatched.
    encodePayload(engineIoPackets, (encodedPayload) => {
      this.connection.send(encodedPayload)
    })
  }
}

class SocketIoDuplexConnection {
  public client: SocketIoConnection
  public server: SocketIoConnection

  constructor(
    readonly rawClient: WebSocketClientConnection,
    readonly rawServer: WebSocketServerConnection,
  ) {
    // First, decide whether the "open" connection event
    // and the namespace approval event should be mocked.
    queueMicrotask(() => {
      if (this.rawServer.readyState !== -1) {
        return
      }

      this.rawClient.send(
        '0' +
          JSON.stringify({
            sid: 'test',
            upgrades: [],
            pingInterval: 25000,
            pingTimeout: 5000,
          }),
      )
      this.rawClient.send('40' + JSON.stringify({ sid: 'test' }))
    })

    this.server = new SocketIoConnection(this.rawServer)
    this.client = new SocketIoConnection(this.rawClient)
  }
}

/**
 * @example
 * interceptor.on('connection', (connection) => {
 *   const { client, server } = bind(connection)
 *   client.on('hello', (firstName) => {
 *     client.emit('greetings', `Hello, ${firstName}!`)
 *   })
 * })
 */
export function bind(connection: WebSocketEventMap['connection'][0]) {
  return new SocketIoDuplexConnection(connection.client, connection.server)
}
