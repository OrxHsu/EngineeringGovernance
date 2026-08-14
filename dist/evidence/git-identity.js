import { execFileSync } from 'node:child_process';
function git(repository, args) {
    return execFileSync('git', ['-C', repository, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}
function exists(repository, object) {
    try {
        git(repository, ['cat-file', '-e', object]);
        return true;
    }
    catch {
        return false;
    }
}
function isAncestor(repository, ancestor, descendant) {
    try {
        git(repository, ['merge-base', '--is-ancestor', ancestor, descendant]);
        return true;
    }
    catch {
        return false;
    }
}
function pathAllowed(path, patterns) {
    return patterns.some((pattern) => {
        if (pattern.endsWith('/**')) {
            const prefix = pattern.slice(0, -3);
            return path === prefix || path.startsWith(`${prefix}/`);
        }
        return path === pattern;
    });
}
export function verifyGitIdentity(input) {
    const errors = [];
    if (!exists(input.repository, `${input.implementationCommit}^{commit}`)) {
        return { valid: false, errors: ['IMPLEMENTATION_COMMIT_MISSING'] };
    }
    if (!exists(input.repository, `${input.closureCommit}^{commit}`)) {
        return { valid: false, errors: ['CLOSURE_COMMIT_MISSING'] };
    }
    const actualTree = git(input.repository, ['rev-parse', `${input.implementationCommit}^{tree}`]);
    if (actualTree !== input.implementationTree)
        errors.push('IMPLEMENTATION_TREE_MISMATCH');
    if (!isAncestor(input.repository, input.implementationCommit, input.closureCommit)) {
        errors.push('IMPLEMENTATION_NOT_ANCESTOR_OF_CLOSURE');
    }
    else if (input.implementationCommit !== input.closureCommit) {
        const output = git(input.repository, [
            'diff',
            '--name-only',
            `${input.implementationCommit}..${input.closureCommit}`,
        ]);
        for (const path of output.split('\n').filter(Boolean)) {
            if (!pathAllowed(path, input.allowedClosurePaths)) {
                errors.push(`CLOSURE_PATH_NOT_ALLOWED:${path}`);
            }
        }
    }
    const uniqueErrors = [...new Set(errors)].sort();
    return { valid: uniqueErrors.length === 0, errors: uniqueErrors };
}
