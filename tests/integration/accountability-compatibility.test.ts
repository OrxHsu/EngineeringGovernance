import { describe, expect, it } from 'vitest'

import { validateProjectTaskGraph } from '../../src/project/task-graph.js'

describe('beta1 compatibility', () => {
  it.skipIf(process.env.CI === 'true')('keeps the current task graph checkable without rewriting historical tasks', () => {
    const result = validateProjectTaskGraph(process.cwd())
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  }, 30_000)
})
