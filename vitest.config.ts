import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    alias: {
      'vitest-environment-node-with-websockets':
        './vitest.node-with-websockets',
    },
  },
})
