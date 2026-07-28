import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, relative } from 'node:path'

import { expect, it } from 'vitest'

import { planAdoption } from '../../src/commands/adopt.js'
import { testRunnerBundle } from '../helpers/runner-bundle.js'

const projTrav = '/Users/xgh/Documents/VibeCoding/ProjTrav_V1'
const projTravServer = `${projTrav}/projtrav-server`
const projTravIos = `${projTrav}/projtrav-ios`
const noMe = '/Users/xgh/Documents/VibeCoding/NoMe_V2'

function gitStatus(repository: string): string {
  return execFileSync('git', ['-C', repository, 'status', '--porcelain=v1', '-z'], {
    encoding: 'utf8',
  })
}

function digest(path: string): string | null {
  if (!existsSync(path)) return null
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function snapshot(repository: string, paths: string[]): object {
  return {
    status: gitStatus(repository),
    files: Object.fromEntries(paths.map((path) => [path, digest(`${repository}/${path}`)])),
  }
}

it.runIf(process.env.REAL_PROJECT_DRY_RUN === '1')(
  'plans real project adoption through canonical sources without mutation',
  () => {
    const runnerBundlePath = testRunnerBundle()
    const runnerName = basename(runnerBundlePath)
    const projTravPaths = [
      'Docs/AGENTS.md',
      'Docs/rules/workspace-agent-entrypoint.md',
      'Docs/rules/backend-agent-rules.md',
      'Docs/rules/ios-agent-rules.md',
      'AGENTS.md',
      'projtrav-server/AGENTS.md',
      'projtrav-server/.cursorrules',
      'projtrav-ios/AGENTS.md',
      'projtrav-ios/.cursorrules',
      '.delivery/policy.yaml',
      '.delivery/extensions.yaml',
      `.delivery/runtime/${runnerName}`,
      '.delivery/bin/check-delivery-policy.sh',
    ]
    const noMePaths = [
      'AGENTS.md',
      '.delivery/policy.yaml',
      '.delivery/extensions.yaml',
      `.delivery/runtime/${runnerName}`,
      '.delivery/bin/check-delivery-policy.sh',
    ]
    const before = {
      projTrav: snapshot(projTrav, projTravPaths),
      projTravServer: snapshot(projTravServer, ['AGENTS.md', '.cursorrules']),
      projTravIos: snapshot(projTravIos, ['AGENTS.md', '.cursorrules']),
      noMe: snapshot(noMe, noMePaths),
    }

    const projTravPlan = planAdoption(projTrav, { runnerBundlePath })
    const noMePlan = planAdoption(noMe, { runnerBundlePath })
    expect(projTravPlan.writes.map((write) => relative(projTrav, write.path))).toEqual([
      '.delivery/policy.yaml',
      '.delivery/extensions.yaml',
      'Docs/AGENTS.md',
      'Docs/rules/workspace-agent-entrypoint.md',
      'Docs/rules/backend-agent-rules.md',
      'Docs/rules/ios-agent-rules.md',
      `.delivery/runtime/${runnerName}`,
      '.delivery/bin/check-delivery-policy.sh',
    ])
    expect(projTravPlan.writes.map((write) => write.path)).not.toContain(`${projTrav}/AGENTS.md`)
    expect(projTravPlan.generatedTargets.map((target) => relative(projTrav, target.path))).toEqual([
      'AGENTS.md',
      'projtrav-server/AGENTS.md',
      'projtrav-server/.cursorrules',
      'projtrav-ios/AGENTS.md',
      'projtrav-ios/.cursorrules',
    ])
    expect(noMePlan.writes.map((write) => relative(noMe, write.path))).toEqual([
      '.delivery/policy.yaml',
      '.delivery/extensions.yaml',
      'AGENTS.md',
      `.delivery/runtime/${runnerName}`,
      '.delivery/bin/check-delivery-policy.sh',
    ])

    expect({
      projTrav: snapshot(projTrav, projTravPaths),
      projTravServer: snapshot(projTravServer, ['AGENTS.md', '.cursorrules']),
      projTravIos: snapshot(projTravIos, ['AGENTS.md', '.cursorrules']),
      noMe: snapshot(noMe, noMePaths),
    }).toEqual(before)
  },
)
