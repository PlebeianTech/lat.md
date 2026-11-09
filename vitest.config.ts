import { defineConfig } from 'vitest/config'
import { forkPoolOptions } from './src/fork/vitest-pool-options'

export default defineConfig({
  test: {
    // The cold WASM embedder build and a full `tsc --noEmit` run legitimately
    // exceed vitest's 5s default on slower runners (notably Windows CI). Give
    // heavy tests and their beforeAll hooks generous headroom.
    testTimeout: 30000,
    hookTimeout: 30000,
    poolOptions: forkPoolOptions,
  },
})
