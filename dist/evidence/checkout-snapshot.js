import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalDigest } from '../model/digest.js';
function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
function git(repository, arguments_, encoding = 'utf8') {
    return execFileSync('git', ['-C', repository, ...arguments_], {
        encoding: encoding === 'buffer' ? 'buffer' : encoding,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
    });
}
function untrackedFiles(repository) {
    const output = git(repository, ['ls-files', '--others', '--exclude-standard', '-z'], 'buffer');
    return output.toString('utf8').split('\0').filter(Boolean).sort().map((path) => {
        const absolute = join(repository, path);
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) {
            return { path, type: 'symlink', sha256: sha256(readlinkSync(absolute)) };
        }
        if (!stat.isFile())
            throw new Error(`CHECKOUT_UNTRACKED_PATH_UNSUPPORTED:${path}`);
        return { path, type: 'file', sha256: sha256(readFileSync(absolute)) };
    });
}
export function captureCheckoutSnapshot(input) {
    const repository = realpathSync(input.path);
    const head = git(repository, ['rev-parse', 'HEAD']).trim();
    const tree = git(repository, ['rev-parse', 'HEAD^{tree}']).trim();
    const trackedDiff = git(repository, ['diff', '--binary', 'HEAD', '--'], 'buffer');
    const trackedPaths = git(repository, ['diff', '--name-only', '-z', 'HEAD', '--'], 'buffer')
        .toString('utf8').split('\0').filter(Boolean).sort();
    const trackedDiffSha256 = sha256(trackedDiff);
    const untracked = untrackedFiles(repository);
    return {
        id: input.id,
        repository,
        head,
        tree,
        trackedDiffSha256,
        trackedPaths,
        untracked,
        statusDigest: canonicalDigest({ trackedDiffSha256, trackedPaths, untracked }),
    };
}
export function captureRepositorySet(repositories) {
    return [...repositories]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(captureCheckoutSnapshot);
}
