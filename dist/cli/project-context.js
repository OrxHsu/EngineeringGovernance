import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { governanceIdentity } from '../commands/adopt.js';
import { loadProjectExtensions } from '../extensions/registry.js';
import { validateProjectPolicy } from '../policy/load.js';
export function loadAdoptedProjectContext(projectPath) {
    const unresolvedProject = resolve(projectPath);
    if (!existsSync(unresolvedProject)
        || lstatSync(unresolvedProject).isSymbolicLink()
        || !lstatSync(unresolvedProject).isDirectory())
        throw new Error('PROJECT_PATH_UNSAFE');
    const projectRoot = realpathSync(unresolvedProject);
    const unresolvedPolicy = join(projectRoot, '.delivery', 'policy.yaml');
    if (!existsSync(unresolvedPolicy)
        || lstatSync(unresolvedPolicy).isSymbolicLink()
        || !lstatSync(unresolvedPolicy).isFile())
        throw new Error('PROJECT_POLICY_MISSING_OR_UNSAFE');
    const policyPath = realpathSync(unresolvedPolicy);
    if (policyPath !== unresolvedPolicy)
        throw new Error('PROJECT_POLICY_CANONICAL_PATH_MISMATCH');
    const policy = parse(readFileSync(policyPath, 'utf8'));
    const validation = validateProjectPolicy(policy);
    if (!validation.valid)
        throw new Error(`PROJECT_POLICY_INVALID:${validation.errors.join(',')}`);
    const identity = governanceIdentity();
    const adoptedIdentity = policy;
    if (adoptedIdentity.sopVersion !== identity.version || adoptedIdentity.sopDigest !== identity.digest) {
        throw new Error('PROJECT_POLICY_IDENTITY_MISMATCH');
    }
    return { projectRoot, projectExtensions: loadProjectExtensions(projectRoot) };
}
