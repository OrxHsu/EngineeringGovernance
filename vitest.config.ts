import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', '.worktrees/**'],
    maxWorkers: 1,
    testTimeout: 30_000,
  },
})
