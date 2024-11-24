import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['./src/index.ts'],
  format: 'esm',
  outDir: './build',
  clean: true,
  dts: true,
  sourcemap: true,
})
