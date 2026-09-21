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
  WebSocketExtension,
  type WebSocketData,
  type WebSocketClientHandle,
  type WebSocketExtensionContext,
  type WebSocketExtensionMessageContext,
} from '@mswjs/interceptors/WebSocket'

/**
 * A Socket.IO event as the handler sees it: its namespace
 * (the default one when omitted), its name, and its arguments.
 */
export interface SocketIoMessage {
  namespace?: string
  event: string
  args: Array<unknown>
}

const DEFAULT_NAMESPACE = '/'
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

function encodeEngineIoPacket(packet: EngineIoPacket): WebSocketData {
  let encodedPacket: WebSocketData = ''

  // The callback is invoked synchronously.
  encodePacket(packet, true, (result) => {
    encodedPacket = result
  })

  return encodedPacket
}

/**
 * Encode the given Socket.IO packet into its Engine.IO frames:
 * the text packet, followed by its binary attachments, if any.
 */
function* encodeSocketIoPacket(
  packet: SocketIoPacket,
): Generator<WebSocketData> {
  const [encodedPacket, ...attachments] = encoder.encode(packet)

  if (typeof encodedPacket === 'string') {
    yield encodeEngineIoPacket({ type: 'message', data: encodedPacket })
  }

  for (const attachment of attachments) {
    yield encodeEngineIoPacket({ type: 'message', data: attachment })
  }
}

/**
 * Decode the given frame into the Socket.IO packets it completes.
 * Binary attachments complete the packet that announced them,
 * which is why the decoder is stateful and must be kept per stream.
 */
function decodeSocketIoPackets(
  frame: WebSocketData,
  decoder: Decoder,
): Array<SocketIoPacket> {
  const engineIoPacket = decodePacket(frame, 'arraybuffer')

  // Engine.IO control packets (open, ping, pong, etc) carry no Socket.IO packet.
  if (engineIoPacket.type !== 'message') {
    return []
  }

  const packets: Array<SocketIoPacket> = []
  const collectPacket = (packet: SocketIoPacket) => {
    packets.push(packet)
  }

  decoder.on('decoded', collectPacket)
  decoder.add(engineIoPacket.data)
  decoder.off('decoded', collectPacket)

  return packets
}

function toSocketIoMessage(packet: SocketIoPacket): SocketIoMessage {
  const [event, ...args] = packet.data

  return {
    namespace: packet.nsp,
    event,
    args,
  }
}

type SocketIoRoomMembers = Map<
  string,
  Set<WebSocketClientHandle<SocketIoMessage>>
>

/**
 * The rooms of a Socket.IO connection: join and leave them,
 * and send events to every connection in a room.
 */
export class SocketIoRooms {
  constructor(
    private readonly client: WebSocketClientHandle<SocketIoMessage>,
    private readonly members: SocketIoRoomMembers,
  ) {}

  /**
   * Add this connection to the given room.
   * A closed connection leaves all of its rooms.
   */
  public join(room: string): void {
    let members = this.members.get(room)

    if (!members) {
      members = new Set()
      this.members.set(room, members)
    }

    if (!members.has(this.client)) {
      this.client.addEventListener('close', () => this.leave(room), {
        once: true,
      })
    }

    members.add(this.client)
  }

  /**
   * Remove this connection from the given room.
   */
  public leave(room: string): void {
    this.members.get(room)?.delete(this.client)
  }

  /**
   * Send events to every connection in the given room.
   */
  public to(room: string): { send(message: SocketIoMessage): void } {
    const members = this.members.get(room) ?? new Set()

    return {
      send(message) {
        for (const member of members) {
          member.send(message)
        }
      },
    }
  }
}

/**
 * The Socket.IO protocol as a WebSocket extension.
 *
 * Handlers see Socket.IO events (`{ namespace, event, args }`) instead of
 * Engine.IO/Socket.IO frames. The session (Engine.IO handshake, namespace
 * connects, heartbeat) is spoken by the extension on behalf of the mocked
 * server and never surfaces. Rooms are exposed on the connection event.
 *
 * @example
 * // With Interceptors: applied to every Socket.IO connection.
 * new WebSocketInterceptor({ extensions: [new SocketIo()] })
 *
 * @example
 * // With Mock Service Worker: applied to the connections of this link.
 * const chat = ws.link('wss://example.com/chat', { extensions: [new SocketIo()] })
 *
 * chat.addEventListener('connection', ({ client, rooms }) => {
 *   client.addEventListener('message', (event) => {
 *     if (event.data.event === 'join') {
 *       rooms.join(String(event.data.args[0]))
 *     }
 *   })
 *   rooms.to('lobby').send({ event: 'greeting', args: ['Hello, everyone!'] })
 * })
 */
export class SocketIo extends WebSocketExtension<
  SocketIoMessage,
  { rooms: SocketIoRooms }
> {
  /**
   * The Socket.IO decoder is stateful (binary attachments span
   * multiple frames), so keep one per connection.
   */
  private readonly decoders = new WeakMap<object, Decoder>()
  private readonly members: SocketIoRoomMembers = new Map()

  public match({
    client,
  }: WebSocketExtensionContext<SocketIoMessage>): boolean {
    // Socket.IO connections carry the Engine.IO protocol version.
    return client.url.searchParams.has('EIO')
  }

  public connect(): WebSocketData {
    // Establish the Engine.IO session.
    return encodeEngineIoPacket({
      type: 'open',
      data: JSON.stringify({
        sid: SESSION_ID,
        upgrades: [],
        pingInterval: PING_INTERVAL,
        pingTimeout: PING_TIMEOUT,
      }),
    })
  }

  public encode(message: SocketIoMessage): Generator<WebSocketData> {
    return encodeSocketIoPacket({
      type: PacketType.EVENT,
      nsp: message.namespace ?? DEFAULT_NAMESPACE,
      data: [message.event, ...message.args],
    })
  }

  public *decode(
    frame: WebSocketData,
    { connection }: WebSocketExtensionMessageContext<SocketIoMessage>,
  ): Generator<SocketIoMessage> {
    for (const packet of decodeSocketIoPackets(
      frame,
      this.#getDecoder(connection),
    )) {
      if (
        packet.type === PacketType.EVENT ||
        packet.type === PacketType.BINARY_EVENT
      ) {
        yield toSocketIoMessage(packet)
      }
    }
  }

  public *receive(frame: WebSocketData): Generator<WebSocketData> {
    if (typeof frame !== 'string') {
      return
    }

    const engineIoPacket = decodePacket(frame, 'arraybuffer')

    // Engine.IO v3 clients ping the server and expect a pong.
    if (engineIoPacket.type === 'ping') {
      yield encodeEngineIoPacket({ type: 'pong' })
      return
    }

    if (engineIoPacket.type !== 'message') {
      return
    }

    // Approve every namespace the client connects to.
    for (const packet of decodeSocketIoPackets(frame, new Decoder())) {
      if (packet.type === PacketType.CONNECT) {
        yield* encodeSocketIoPacket({
          type: PacketType.CONNECT,
          nsp: packet.nsp,
          data: { sid: SESSION_ID },
        })
      }
    }
  }

  public extend({ client }: WebSocketExtensionContext<SocketIoMessage>): {
    rooms: SocketIoRooms
  } {
    return {
      rooms: new SocketIoRooms(client, this.members),
    }
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
