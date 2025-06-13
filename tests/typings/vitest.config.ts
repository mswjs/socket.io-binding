import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    root: './tests/typings',
    globals: true,
    typecheck: {
      enabled: true,
      checker: 'tsc',
      include: ['./**/*.test-d.ts'],
    },
  },
})
