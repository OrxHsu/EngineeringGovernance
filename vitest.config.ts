import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', '.worktrees/**'],
    maxWorkers: process.env.CI === 'true' ? 4 : 1,
    testTimeout: 30_000,
  },
})
