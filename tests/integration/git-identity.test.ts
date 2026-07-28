import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { verifyGitIdentity } from '../../src/evidence/git-identity.js'

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
}

function repositoryWithImplementation(): { repository: string; commit: string; tree: string } {
  const repository = mkdtempSync(join(tmpdir(), 'governance-git-'))
  git(repository, 'init', '-b', 'main')
  git(repository, 'config', 'user.email', 'test@example.com')
  git(repository, 'config', 'user.name', 'Test')
  mkdirSync(join(repository, 'src'))
  writeFileSync(join(repository, 'src', 'feature.ts'), 'export const value = 1\n')
  git(repository, 'add', 'src/feature.ts')
  git(repository, 'commit', '-m', 'implementation')
  const commit = git(repository, 'rev-parse', 'HEAD')
  const tree = git(repository, 'rev-parse', 'HEAD^{tree}')
  return { repository, commit, tree }
}

describe('Git identity verification', () => {
  it('accepts an evidence-only closure commit', () => {
    const state = repositoryWithImplementation()
    mkdirSync(join(state.repository, '.delivery', 'tasks', 'task-1'), { recursive: true })
    writeFileSync(join(state.repository, '.delivery', 'tasks', 'task-1', 'evidence.json'), '{}\n')
    git(state.repository, 'add', '.delivery/tasks/task-1/evidence.json')
    git(state.repository, 'commit', '-m', 'evidence')
    const closureCommit = git(state.repository, 'rev-parse', 'HEAD')

    expect(verifyGitIdentity({
      repository: state.repository,
      implementationCommit: state.commit,
      implementationTree: state.tree,
      closureCommit,
      allowedClosurePaths: ['.delivery/tasks/**'],
    })).toEqual({ valid: true, errors: [] })
  })

  it('rejects production changes after the implementation commit', () => {
    const state = repositoryWithImplementation()
    writeFileSync(join(state.repository, 'src', 'feature.ts'), 'export const value = 2\n')
    git(state.repository, 'add', 'src/feature.ts')
    git(state.repository, 'commit', '-m', 'post implementation change')

    expect(verifyGitIdentity({
      repository: state.repository,
      implementationCommit: state.commit,
      implementationTree: state.tree,
      closureCommit: git(state.repository, 'rev-parse', 'HEAD'),
      allowedClosurePaths: ['.delivery/tasks/**'],
    }).errors).toContain('CLOSURE_PATH_NOT_ALLOWED:src/feature.ts')
  })

  it('rejects a mismatched tree identity', () => {
    const state = repositoryWithImplementation()
    expect(verifyGitIdentity({
      repository: state.repository,
      implementationCommit: state.commit,
      implementationTree: 'f'.repeat(40),
      closureCommit: state.commit,
      allowedClosurePaths: [],
    }).errors).toContain('IMPLEMENTATION_TREE_MISMATCH')
  })
})
