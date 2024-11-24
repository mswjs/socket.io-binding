import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    alias: {
      'vitest-environment-node-websocket': './vitest.node-websocket',
    },
  },
})
