import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'

import { parse } from 'yaml'

export interface CliInputIdentity<T> {
  unresolvedPath: string
  canonicalPath: string
  value: T
}

export function loadCliInput<T>(inputPath: string): CliInputIdentity<T> {
  const unresolvedPath = resolve(inputPath)
  if (
    !existsSync(unresolvedPath)
    || lstatSync(unresolvedPath).isSymbolicLink()
    || !lstatSync(unresolvedPath).isFile()
  ) throw new Error('CLI_INPUT_PATH_UNSAFE')
  const canonicalPath = realpathSync(unresolvedPath)
  if (!lstatSync(canonicalPath).isFile()) throw new Error('CLI_INPUT_PATH_UNSAFE')
  return {
    unresolvedPath,
    canonicalPath,
    value: parse(readFileSync(canonicalPath, 'utf8')) as T,
  }
}

export function requireActiveV2<T>(value: T): asserts value is T & { schemaVersion: 2 } {
  if (
    typeof value !== 'object'
    || value === null
    || !Object.hasOwn(value, 'schemaVersion')
    || (value as { schemaVersion?: unknown }).schemaVersion !== 2
  ) throw new Error('ACTIVE_COMMAND_REQUIRES_SCHEMA_VERSION_2')
}
