import { describe, expect, it } from 'vitest'

import { recoveryStepForStanding } from '../../src/accountability/recovery.js'

describe('beta3 recovery stages', () => {
  it('requires one clean task per intermediate stage and two from suspension', () => {
    expect(recoveryStepForStanding('WARNING')).toMatchObject({ to: 'GOOD_STANDING', cleanTasksRequired: 1 })
    expect(recoveryStepForStanding('WATCH')).toMatchObject({ to: 'WARNING', cleanTasksRequired: 1 })
    expect(recoveryStepForStanding('PROBATION')).toMatchObject({ to: 'WATCH', cleanTasksRequired: 1 })
    expect(recoveryStepForStanding('SUSPENDED')).toMatchObject({ to: 'PROBATION', cleanTasksRequired: 2 })
    expect(recoveryStepForStanding('GOOD_STANDING')).toBeNull()
  })
})
