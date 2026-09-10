import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      electron: path.resolve(__dirname, 'tests/mocks/electron.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
})