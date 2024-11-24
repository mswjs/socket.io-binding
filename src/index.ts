import {
  encodePayload,
  decodePayload,
  type Packet as EngineIoPacket,
  type BinaryType,
} from 'engine.io-parser'
import {
  Encoder,
  Decoder,
  PacketType as SocketIoPacketType,
} from 'socket.io-parser'
import {
  WebSocketClientConnection,
  WebSocketServerConnection,
  type WebSocketConnectionData,
} from '@mswjs/interceptors/WebSocket'

const encoder = new Encoder()
const decoder = new Decoder()

type BoundMessageListener = (event: MessageEvent, ...data: Array<any>) => void

class SocketIoConnection {
  constructor(
    private readonly connection:
      | WebSocketClientConnection
      | WebSocketServerConnection,
  ) {}

  public on(event: string, listener: BoundMessageListener): void {
    const addEventListener = this.connection.addEventListener.bind(
      this.connection,
    ) as WebSocketClientConnection['addEventListener']

    addEventListener('message', function (messageEvent) {
      const binaryType: BinaryType =
        this.binaryType === 'blob'
          ? this.binaryType
          : typeof Buffer === 'undefined'
          ? 'arraybuffer'
          : 'nodebuffer'

      const rawData = messageEvent.data

      /**
       * Messages are always decoded as strings.
       * Technically, it should be safe to skip non-string messages.
       */
      if (typeof rawData !== 'string') {
        return
      }

      const engineIoPackets = decodePayload(rawData, binaryType)

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
      data: [event].concat(data),
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
    queueMicrotask(() => {
      try {
        // Accessing the "socket" property on the server
        // throws if the actual server connection hasn't been established.
        // If it doesn't throw, don't mock the namespace approval message.
        // That becomes the responsibility of the server.
        this.rawServer.socket.readyState
        return
      } catch {
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
      }
    })

    this.client = new SocketIoConnection(this.rawClient)
    this.server = new SocketIoConnection(this.rawServer)
  }
}

/**
 * @example
 * interceptor.on('connection', (connection) => {
 *   const { client, server } = toSocketIo(connection)
 *
 *   client.on('hello', (firstName) => {
 *     client.emit('greetings', `Hello, ${firstName}!`)
 *   })
 * })
 */
export function toSocketIo(connection: WebSocketConnectionData) {
  return new SocketIoDuplexConnection(connection.client, connection.server)
}
