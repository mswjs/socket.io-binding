import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./src/index.ts'],
  format: 'esm',
  outDir: './build',
  clean: true,
  dts: { sourcemap: true },
  tsconfig: './tsconfig.src.json',
  sourcemap: true,
  fixedExtension: false,
})
