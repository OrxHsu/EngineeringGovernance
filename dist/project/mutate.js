import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { basename, dirname, join } from 'node:path';
function digest(content) {
    return createHash('sha256').update(content).digest('hex');
}
function currentDigest(path) {
    if (!existsSync(path))
        return null;
    if (lstatSync(path).isSymbolicLink())
        throw new Error(`MANAGED_PATH_IS_SYMLINK:${path}`);
    return digest(readFileSync(path));
}
export function assertPlannedGuardsUnchanged(guards) {
    for (const guard of guards) {
        if (currentDigest(guard.path) !== guard.beforeDigest) {
            throw new Error(`MANAGED_FILE_CHANGED:${guard.path}`);
        }
    }
}
function atomicWrite(write) {
    const parent = dirname(write.path);
    mkdirSync(parent, { recursive: true });
    const temporary = join(parent, `.${basename(write.path)}.sop-${process.pid}-${randomUUID()}`);
    const mode = write.mode ?? (existsSync(write.path) ? lstatSync(write.path).mode & 0o777 : 0o644);
    let descriptor;
    try {
        descriptor = openSync(temporary, 'wx', mode);
        if (typeof write.after === 'string')
            writeFileSync(descriptor, write.after, 'utf8');
        else
            writeFileSync(descriptor, write.after);
        fchmodSync(descriptor, mode);
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(temporary, write.path);
    }
    finally {
        if (descriptor !== undefined)
            closeSync(descriptor);
        if (existsSync(temporary))
            unlinkSync(temporary);
    }
}
export function applyPlannedWrites(writes, options) {
    if (options.dryRun)
        return { applied: [] };
    for (const write of writes) {
        if (currentDigest(write.path) !== write.beforeDigest) {
            throw new Error(`MANAGED_FILE_CHANGED:${write.path}`);
        }
    }
    const applied = [];
    for (const write of writes) {
        atomicWrite(write);
        applied.push(write.path);
    }
    return { applied };
}
