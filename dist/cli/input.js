import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
export function loadCliInput(inputPath) {
    const unresolvedPath = resolve(inputPath);
    if (!existsSync(unresolvedPath)
        || lstatSync(unresolvedPath).isSymbolicLink()
        || !lstatSync(unresolvedPath).isFile())
        throw new Error('CLI_INPUT_PATH_UNSAFE');
    const canonicalPath = realpathSync(unresolvedPath);
    if (!lstatSync(canonicalPath).isFile())
        throw new Error('CLI_INPUT_PATH_UNSAFE');
    return {
        unresolvedPath,
        canonicalPath,
        value: parse(readFileSync(canonicalPath, 'utf8')),
    };
}
export function requireActiveV2(value) {
    if (typeof value !== 'object'
        || value === null
        || !Object.hasOwn(value, 'schemaVersion')
        || value.schemaVersion !== 2)
        throw new Error('ACTIVE_COMMAND_REQUIRES_SCHEMA_VERSION_2');
}
