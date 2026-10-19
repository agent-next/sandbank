import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Resolve @sandbank.dev/core from source so tests run without a prior core build
export default defineConfig({
  resolve: {
    alias: {
      '@sandbank.dev/core': resolve(__dirname, '../core/src/index.ts'),
    },
  },
  test: {
    testTimeout: 120_000,
  },
})
