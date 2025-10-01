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
  type Packet as SocketIoPacket,
} from 'socket.io-parser'
import type { WebSocketHandlerConnection } from 'msw'
import type {
  WebSocketClientConnectionProtocol,
  WebSocketServerConnectionProtocol,
} from '@mswjs/interceptors/WebSocket'

const encoder = new Encoder()
const decoder = new Decoder()

interface SocketIoMessageDetails {
  namespace: string
}

interface SocketIoMessageEvent<T = any> extends MessageEvent<T> {
  socketio: SocketIoMessageDetails
}

type BoundMessageListener = (
  event: SocketIoMessageEvent,
  ...data: Array<any>
) => void
type ConnectionAuthorizer = (
  namespace: string,
  auth: Record<string, unknown>,
) => boolean | Promise<boolean>

function createSocketIoMessageEvent(
  event: MessageEvent,
  details: SocketIoMessageDetails,
): SocketIoMessageEvent {
  return new Proxy(event, {
    get(target, property, receiver) {
      if (property === 'socketio') {
        return details
      }

      return Reflect.get(target, property, receiver)
    },
    has(target, property) {
      if (property === 'socketio') {
        return true
      }

      return Reflect.has(target, property)
    },
  }) as SocketIoMessageEvent
}

class SocketIoConnection {
  constructor(
    private readonly connection:
      | WebSocketClientConnectionProtocol
      | WebSocketServerConnectionProtocol,
  ) {}

  public _onSocketIoPacket(
    callback: (messageEvent: MessageEvent, packet: SocketIoPacket) => void,
  ): void {
    const addEventListener = this.connection.addEventListener.bind(
      this.connection,
    ) as WebSocketClientConnectionProtocol['addEventListener']

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
          callback(messageEvent, decodedSocketIoPacket)
        })

        decoder.add(packet.data)
      }
    })
  }

  public on(event: string, listener: BoundMessageListener): void {
    this._onSocketIoPacket((messageEvent, decodedSocketIoPacket) => {
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
        // Create a proxy wrapper around the original MessageEvent object,
        // adding a `socketio` property with our namespace details.
        const extendedEvent = createSocketIoMessageEvent(messageEvent, {
          namespace: decodedSocketIoPacket.nsp,
        })

        listener.call(undefined, extendedEvent, ...data)
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

  private hasAuthorizer = false

  constructor(
    readonly rawClient: WebSocketClientConnectionProtocol,
    readonly rawServer: WebSocketServerConnectionProtocol,
  ) {
    queueMicrotask(() => {
      // If the actual server connection hasn't been established yet, send
      // a mock Engine.IO handshake.
      if (!this.hasUpstreamServer()) {
        // Set a default authorizer that always allows connections.
        if (!this.hasAuthorizer) {
          this.setAuthorizer(() => true)
        }

        this.sendMockEngineIoOpen()
      }
    })

    this.client = new SocketIoConnection(this.rawClient)
    this.server = new SocketIoConnection(this.rawServer)
  }

  private hasUpstreamServer(): boolean {
    try {
      // Accessing the "socket" property on the server throws if the actual
      // server connection hasn't been established.
      Reflect.get(this.rawServer, 'socket').readyState
      return true
    } catch {
      return false
    }
  }

  public setAuthorizer(authorizer: ConnectionAuthorizer): void {
    this.client._onSocketIoPacket((_event, packet) => {
      if (packet.type !== SocketIoPacketType.CONNECT) {
        return
      }

      Promise.resolve(authorizer(packet.nsp, packet.data)).then((allowed) => {
        // Allow the authorizer to bounce connections before the actual server
        // even sees it.
        if (!allowed) {
          this.sendMockSocketIoConnectError(packet.nsp, 'Not authorized')
          return
        }

        this.sendMockSocketIoConnect(packet.nsp)
      })
    })

    this.hasAuthorizer = true
  }

  private sendMockEngineIoOpen(): void {
    const openPacket: EngineIoPacket = {
      type: 'open',
      data: JSON.stringify({
        sid: 'test',
        upgrades: [],
        pingInterval: 25000,
        pingTimeout: 5000,
      }),
    }

    encodePayload([openPacket], (encodedPayload) => {
      this.rawClient.send(encodedPayload)
    })
  }

  private sendMockSocketIoConnect(namespace: string): void {
    this.sendSocketIoPacket({
      type: SocketIoPacketType.CONNECT,
      nsp: namespace,
      data: { sid: 'test' },
    })
  }

  private sendMockSocketIoConnectError(
    namespace: string,
    message: string,
  ): void {
    this.sendSocketIoPacket({
      type: SocketIoPacketType.CONNECT_ERROR,
      nsp: namespace,
      data: { message },
    })
  }

  private sendSocketIoPacket(packet: SocketIoPacket): void {
    const socketIoPackets = encoder.encode(packet)

    const engineIoPackets = socketIoPackets.map<EngineIoPacket>((encoded) => {
      return {
        type: 'message',
        data: encoded,
      }
    })

    encodePayload(engineIoPackets, (encodedPayload) => {
      this.rawClient.send(encodedPayload)
    })
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
export function toSocketIo(connection: WebSocketHandlerConnection) {
  return new SocketIoDuplexConnection(connection.client, connection.server)
}
