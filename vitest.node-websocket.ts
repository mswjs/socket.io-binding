/**
 * HappyDOM environment superset that has a global WebSocket API.
 */
import { type Environment, builtinEnvironments } from 'vitest/environments'
import { WebSocket } from 'undici'

export default <Environment>{
  name: 'node-websocket',
  transformMode: 'ssr',
  async setup(global, options) {
    const { teardown } = await builtinEnvironments.node.setup(global, options)

    if (typeof global.WebSocket === 'undefined') {
      Object.defineProperty(global, 'WebSocket', {
        value: WebSocket,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }

    return {
      teardown,
    }
  },
}
