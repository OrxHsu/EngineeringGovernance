import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
function git(repository, args) {
    return execFileSync('git', ['-C', repository, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}
function dirtyPaths(repository) {
    const output = execFileSync('git', ['-C', repository, 'status', '--porcelain=v1', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return output
        .split('\0')
        .filter(Boolean)
        .map((entry) => entry.slice(3))
        .sort();
}
function discoverEntrypoints(repositoryRoot) {
    const candidates = ['AGENTS.md', 'CLAUDE.md', '.cursorrules'];
    return candidates.flatMap((target) => {
        const absolute = join(repositoryRoot, target);
        if (!existsSync(absolute))
            return [];
        const text = readFileSync(absolute, 'utf8');
        const marker = text.match(/<!-- generated-from: ([^\n]+) -->/);
        return [{ target, owningSource: marker?.[1] ?? target }];
    });
}
export function discoverProject(path) {
    const requestedPath = resolve(path);
    const repositoryRoot = git(requestedPath, ['rev-parse', '--show-toplevel']);
    return {
        requestedPath,
        repositoryRoot,
        dirtyPaths: dirtyPaths(repositoryRoot),
        agentEntrypoints: discoverEntrypoints(repositoryRoot),
    };
}
export function validateManagedPathOverlap(discovery, managedPaths) {
    const managed = new Set(managedPaths.map((path) => relative(discovery.repositoryRoot, join(discovery.repositoryRoot, path))));
    const errors = discovery.dirtyPaths
        .filter((path) => managed.has(path))
        .map((path) => `DIRTY_MANAGED_PATH:${path}`)
        .sort();
    return { valid: errors.length === 0, errors };
}
