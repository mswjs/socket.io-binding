import {
  encodePayload,
  decodePayload,
  Packet as EngineIoPacket,
} from 'engine.io-parser'
import {
  Encoder,
  Decoder,
  PacketType as SocketIoPacketType,
} from 'socket.io-parser'
import {
  WebSocketRawData,
  WebSocketEventMap,
  WebSocketClientConnection,
  WebSocketServerConnection,
} from '@mswjs/interceptors/WebSocket'

const encoder = new Encoder()
const decoder = new Decoder()

class SocketIoConnection {
  constructor(
    private readonly connection:
      | WebSocketClientConnection
      | WebSocketServerConnection,
  ) {}

  public on(
    event: string,
    listener: (...data: Array<WebSocketRawData>) => void,
  ): void {
    this.connection.on('message', (message) => {
      const engineIoPackets = decodePayload(
        message.data,
        /**
         * @fixme Grab the binary type from somewhere.
         * Can try grabbing it from the WebSocket
         * instance but we can't reference it here.
         */
        'blob',
      )

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
            listener(...data)
          }
        })

        decoder.add(packet.data)
      }
    })
  }

  public send(...data: Array<WebSocketRawData>): void {
    this.emit('message', ...data)
  }

  public emit(event: string, ...data: Array<WebSocketRawData>): void {
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
      this.rawClient.send('40{"sid":"test"}')
    })

    this.server = new SocketIoConnection(this.rawServer)
    this.client = new SocketIoConnection(this.rawClient)
  }
}

/**
 * @example
 * interceptor.on('connection', (connection) => {
 *   const { client, server } = toSocketIoConnection(connection)
 *   client.on('hello', (firstName) => {
 *     client.emit('greetings', `Hello, ${firstName}!`)
 *   })
 * })
 */
export function toSocketIoConnection(
  connection: WebSocketEventMap['connection'][0],
) {
  return new SocketIoDuplexConnection(connection.client, connection.server)
}
