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
 * A Socket.IO event. The default namespace ("/") when omitted.
 * Carries an `id` when the sender expects an acknowledgement.
 */
export interface SocketIoEventMessage {
  type?: 'event'
  namespace?: string
  event: string
  args: Array<unknown>
  id?: number
}

/**
 * An acknowledgement of the event with the given `id`.
 */
export interface SocketIoAckMessage {
  type: 'ack'
  namespace?: string
  id: number
  args: Array<unknown>
}

/**
 * A connection to a namespace, with the `auth` payload the client sent.
 */
export interface SocketIoConnectMessage {
  type: 'connect'
  namespace?: string
  auth?: unknown
}

/**
 * A rejected connection to a namespace.
 */
export interface SocketIoConnectErrorMessage {
  type: 'connect_error'
  namespace?: string
  error: unknown
}

/**
 * A disconnection from a namespace (the WebSocket stays open).
 */
export interface SocketIoDisconnectMessage {
  type: 'disconnect'
  namespace?: string
}

export type SocketIoMessage =
  | SocketIoEventMessage
  | SocketIoAckMessage
  | SocketIoConnectMessage
  | SocketIoConnectErrorMessage
  | SocketIoDisconnectMessage

/**
 * Decides whether a client may connect to a namespace.
 * Return `true` to accept, or an error to reject with
 * (its `message` and `data` reach the client's `connect_error`).
 */
export type SocketIoNamespacePolicy = (
  namespace: string,
  auth: unknown,
) => true | Error

const DEFAULT_NAMESPACE = '/'

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

function toSocketIoMessage(
  packet: SocketIoPacket,
): SocketIoMessage | undefined {
  switch (packet.type) {
    case PacketType.EVENT:
    case PacketType.BINARY_EVENT: {
      const [event, ...args] = packet.data
      const message: SocketIoEventMessage = {
        type: 'event',
        namespace: packet.nsp,
        event,
        args,
      }

      if (packet.id !== undefined) {
        message.id = packet.id
      }

      return message
    }

    case PacketType.ACK:
    case PacketType.BINARY_ACK: {
      if (packet.id === undefined) {
        return undefined
      }

      return {
        type: 'ack',
        namespace: packet.nsp,
        id: packet.id,
        args: packet.data,
      }
    }

    case PacketType.CONNECT: {
      return { type: 'connect', namespace: packet.nsp, auth: packet.data }
    }

    case PacketType.CONNECT_ERROR: {
      return {
        type: 'connect_error',
        namespace: packet.nsp,
        error: packet.data,
      }
    }

    case PacketType.DISCONNECT: {
      return { type: 'disconnect', namespace: packet.nsp }
    }
  }
}

function toSocketIoPacket(message: SocketIoMessage): SocketIoPacket {
  const nsp = message.namespace ?? DEFAULT_NAMESPACE

  switch (message.type) {
    case 'ack': {
      return { type: PacketType.ACK, nsp, id: message.id, data: message.args }
    }

    case 'connect': {
      return { type: PacketType.CONNECT, nsp, data: message.auth }
    }

    case 'connect_error': {
      return { type: PacketType.CONNECT_ERROR, nsp, data: message.error }
    }

    case 'disconnect': {
      return { type: PacketType.DISCONNECT, nsp }
    }

    default: {
      const packet: SocketIoPacket = {
        type: PacketType.EVENT,
        nsp,
        data: [message.event, ...message.args],
      }

      if (message.id !== undefined) {
        packet.id = message.id
      }

      return packet
    }
  }
}

function toConnectError(error: Error): SocketIoConnectErrorMessage['error'] {
  return {
    message: error.message,
    data: 'data' in error ? error.data : undefined,
  }
}

/**
 * Where events can be sent to: every socket of a room or a namespace.
 */
export interface SocketIoTarget {
  send(message: SocketIoEventMessage): void
}

type SocketIoRoomMembers = Map<string, Set<SocketIoNamespaceSocket>>

/**
 * The mocked Socket.IO server: every socket connected through
 * this extension, across all connections. Sending to a room or
 * a namespace here includes the sending socket, like `io.to()`.
 */
export class SocketIoServer {
  readonly #sockets = new Map<string, Set<SocketIoNamespaceSocket>>()
  readonly #rooms = new Map<string, SocketIoRoomMembers>()

  /**
   * The given namespace of the server.
   */
  public of(namespace: string): SocketIoNamespace {
    return new SocketIoNamespace(this, namespace)
  }

  /**
   * Send an event to every socket in the given room of the default namespace.
   */
  public to(room: string): SocketIoTarget {
    return this.of(DEFAULT_NAMESPACE).to(room)
  }

  /**
   * Send an event to every socket of the default namespace.
   */
  public send(message: SocketIoEventMessage): void {
    this.of(DEFAULT_NAMESPACE).send(message)
  }

  /** @internal */
  public socketsOf(namespace: string): Set<SocketIoNamespaceSocket> {
    let sockets = this.#sockets.get(namespace)

    if (!sockets) {
      sockets = new Set()
      this.#sockets.set(namespace, sockets)
    }

    return sockets
  }

  /** @internal */
  public membersOf(
    namespace: string,
    room: string,
  ): Set<SocketIoNamespaceSocket> {
    let rooms = this.#rooms.get(namespace)

    if (!rooms) {
      rooms = new Map()
      this.#rooms.set(namespace, rooms)
    }

    let members = rooms.get(room)

    if (!members) {
      members = new Set()
      rooms.set(room, members)
    }

    return members
  }
}

/**
 * A namespace of the mocked server.
 */
export class SocketIoNamespace implements SocketIoTarget {
  constructor(
    private readonly server: SocketIoServer,
    public readonly name: string,
  ) {}

  /**
   * Send an event to every socket in the given room.
   */
  public to(room: string): SocketIoTarget {
    const sockets = this.server.membersOf(this.name, room)

    return {
      send(message) {
        for (const socket of sockets) {
          socket.send(message)
        }
      },
    }
  }

  /**
   * Send an event to every socket of this namespace.
   */
  public send(message: SocketIoEventMessage): void {
    for (const socket of this.server.socketsOf(this.name)) {
      socket.send(message)
    }
  }
}

/**
 * The socket a client has in a namespace: its rooms, and the
 * events to the other sockets. Sending to a room or broadcasting
 * here excludes this socket, like `socket.to()`.
 */
export class SocketIoNamespaceSocket {
  public readonly rooms = new Set<string>()

  constructor(
    private readonly server: SocketIoServer,
    private readonly client: WebSocketClientHandle<SocketIoMessage>,
    public readonly namespace: string,
  ) {}

  /**
   * Send an event to this socket.
   */
  public send(message: SocketIoEventMessage): void {
    this.client.send({ ...message, namespace: this.namespace })
  }

  /**
   * Add this socket to the given room.
   */
  public join(room: string): void {
    this.rooms.add(room)
    this.server.membersOf(this.namespace, room).add(this)
  }

  /**
   * Remove this socket from the given room.
   */
  public leave(room: string): void {
    this.rooms.delete(room)
    this.server.membersOf(this.namespace, room).delete(this)
  }

  /**
   * Send an event to every other socket in the given room.
   */
  public to(room: string): SocketIoTarget {
    const members = this.server.membersOf(this.namespace, room)

    return {
      send: (message) => {
        for (const member of members) {
          if (member !== this) {
            member.send(message)
          }
        }
      },
    }
  }

  /**
   * Send an event to every other socket of this namespace.
   */
  public get broadcast(): SocketIoTarget {
    const sockets = this.server.socketsOf(this.namespace)

    return {
      send: (message) => {
        for (const socket of sockets) {
          if (socket !== this) {
            socket.send(message)
          }
        }
      },
    }
  }

  /**
   * Disconnect this socket from its namespace.
   */
  public disconnect(): void {
    this.client.send({ type: 'disconnect', namespace: this.namespace })
    this.detach()
  }

  /** @internal */
  public attach(): void {
    this.server.socketsOf(this.namespace).add(this)
  }

  /** @internal */
  public detach(): void {
    for (const room of this.rooms) {
      this.leave(room)
    }

    this.server.socketsOf(this.namespace).delete(this)
  }
}

/**
 * The client side of a connection as the mocked server sees it:
 * its session id, its socket in every namespace, and the policy
 * deciding which namespaces it may connect to.
 */
export class SocketIoSocket {
  public readonly id = globalThis.crypto.randomUUID()
  readonly #namespaces = new Map<string, SocketIoNamespaceSocket>()
  readonly #policies: Array<SocketIoNamespacePolicy> = []

  constructor(
    private readonly server: SocketIoServer,
    private readonly client: WebSocketClientHandle<SocketIoMessage>,
  ) {
    client.addEventListener('close', () => this.detach(), { once: true })
  }

  /**
   * The socket of this client in the given namespace.
   */
  public of(namespace: string): SocketIoNamespaceSocket {
    let socket = this.#namespaces.get(namespace)

    if (!socket) {
      socket = new SocketIoNamespaceSocket(this.server, this.client, namespace)
      this.#namespaces.set(namespace, socket)
    }

    return socket
  }

  /**
   * Decide whether this client may connect to a namespace.
   * Every namespace is accepted without a policy.
   */
  public use(policy: SocketIoNamespacePolicy): void {
    this.#policies.push(policy)
  }

  /**
   * The rooms of this client in the default namespace.
   */
  public get rooms(): Set<string> {
    return this.of(DEFAULT_NAMESPACE).rooms
  }

  public join(room: string): void {
    this.of(DEFAULT_NAMESPACE).join(room)
  }

  public leave(room: string): void {
    this.of(DEFAULT_NAMESPACE).leave(room)
  }

  public to(room: string): SocketIoTarget {
    return this.of(DEFAULT_NAMESPACE).to(room)
  }

  public get broadcast(): SocketIoTarget {
    return this.of(DEFAULT_NAMESPACE).broadcast
  }

  /** @internal */
  public authorize(namespace: string, auth: unknown): true | Error {
    for (const policy of this.#policies) {
      const verdict = policy(namespace, auth)

      if (verdict !== true) {
        return verdict
      }
    }

    return true
  }

  /** @internal */
  public detach(namespace?: string): void {
    if (namespace !== undefined) {
      this.#namespaces.get(namespace)?.detach()
      return
    }

    for (const socket of this.#namespaces.values()) {
      socket.detach()
    }
  }
}

/**
 * The Socket.IO protocol as a WebSocket extension.
 *
 * Handlers see Socket.IO messages (events, acknowledgements, namespace
 * connections and disconnections) instead of Engine.IO/Socket.IO frames.
 * The session (Engine.IO handshake, namespace connects, heartbeat) is
 * spoken by the extension on behalf of the mocked server and never
 * surfaces. The connection event carries the client's `socket` and the
 * mocked server `io`.
 *
 * @note Only WebSocket transports reach a WebSocket extension.
 * Clients must connect with `transports: ['websocket']`.
 *
 * @example
 * // With Interceptors: applied to every Socket.IO connection.
 * new WebSocketInterceptor({ extensions: [new SocketIo()] })
 *
 * @example
 * // With Mock Service Worker: applied to the connections of this link.
 * const chat = ws.link('wss://example.com/chat', { extensions: [new SocketIo()] })
 *
 * chat.addEventListener('connection', ({ client, socket, io }) => {
 *   client.addEventListener('message', (event) => {
 *     if (event.data.type === 'event' && event.data.event === 'join') {
 *       socket.join(String(event.data.args[0]))
 *     }
 *   })
 *   io.to('lobby').send({ event: 'greeting', args: ['Hello, everyone!'] })
 * })
 */
export class SocketIo extends WebSocketExtension<
  SocketIoMessage,
  { socket: SocketIoSocket; io: SocketIoServer }
> {
  public readonly io = new SocketIoServer()

  /**
   * The Socket.IO decoder is stateful (binary attachments span
   * multiple frames), so keep one per connection.
   */
  readonly #decoders = new WeakMap<object, Decoder>()
  readonly #sockets = new WeakMap<object, SocketIoSocket>()

  public match({
    client,
  }: WebSocketExtensionContext<SocketIoMessage>): boolean {
    // Socket.IO connections carry the Engine.IO protocol version.
    return client.url.searchParams.has('EIO')
  }

  public encode(message: SocketIoMessage): Generator<WebSocketData> {
    return encodeSocketIoPacket(toSocketIoPacket(message))
  }

  public *decode(
    frame: WebSocketData,
    { connection }: WebSocketExtensionMessageContext<SocketIoMessage>,
  ): Generator<SocketIoMessage> {
    for (const packet of decodeSocketIoPackets(
      frame,
      this.#getDecoder(connection),
    )) {
      const message = toSocketIoMessage(packet)

      if (message) {
        yield message
      }
    }
  }

  public connect({
    client,
  }: WebSocketExtensionContext<SocketIoMessage>): WebSocketData {
    // Establish the Engine.IO session.
    return encodeEngineIoPacket({
      type: 'open',
      data: JSON.stringify({
        sid: this.#getSocket(client).id,
        upgrades: [],
        pingInterval: PING_INTERVAL,
        pingTimeout: PING_TIMEOUT,
      }),
    })
  }

  public *receive(
    frame: WebSocketData,
    { client }: WebSocketExtensionContext<SocketIoMessage>,
  ): Generator<WebSocketData> {
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

    const socket = this.#getSocket(client)

    for (const packet of decodeSocketIoPackets(frame, new Decoder())) {
      if (packet.type === PacketType.CONNECT) {
        const verdict = socket.authorize(packet.nsp, packet.data)

        if (verdict instanceof Error) {
          yield* encodeSocketIoPacket({
            type: PacketType.CONNECT_ERROR,
            nsp: packet.nsp,
            data: toConnectError(verdict),
          })
          continue
        }

        socket.of(packet.nsp).attach()
        yield* encodeSocketIoPacket({
          type: PacketType.CONNECT,
          nsp: packet.nsp,
          data: { sid: socket.id },
        })
      }

      if (packet.type === PacketType.DISCONNECT) {
        socket.detach(packet.nsp)
      }
    }
  }

  public extend({ client }: WebSocketExtensionContext<SocketIoMessage>): {
    socket: SocketIoSocket
    io: SocketIoServer
  } {
    return { socket: this.#getSocket(client), io: this.io }
  }

  #getDecoder(connection: object): Decoder {
    let decoder = this.#decoders.get(connection)

    if (!decoder) {
      decoder = new Decoder()
      this.#decoders.set(connection, decoder)
    }

    return decoder
  }

  #getSocket(client: WebSocketClientHandle<SocketIoMessage>): SocketIoSocket {
    let socket = this.#sockets.get(client)

    if (!socket) {
      socket = new SocketIoSocket(this.io, client)
      this.#sockets.set(client, socket)
    }

    return socket
  }
}
