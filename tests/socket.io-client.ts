/**
 * @note Import the `/dist/socket.io.js` file for testing ONLY.
 * This forces to import the Socket.IO client build meant for the
 * browser environment. Otherwise, it loads the Node.js one,
 * goes to "engine.io-client", and uses "ws" for WebSocket class
 * (ignores the global class because assumes itself in Node.js).
 */
import { Socket, type SocketOptions } from 'socket.io-client'
// @ts-expect-error Socket.IO shenanigans.
import { io } from 'socket.io-client/dist/socket.io.js'

export function createSocketClient(
  uri: string,
  options?: Pick<SocketOptions, 'auth'>,
): Socket {
  return io(uri, { transports: ['websocket'], ...options })
}
