import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { canonicalDigest } from '../model/digest.js';
import { validateDocument } from '../policy/load.js';
import { externalSourceExtensionId, externalSourceExtensionVersion, } from './external-source.js';
const descriptorInputs = [{
        id: externalSourceExtensionId,
        version: externalSourceExtensionVersion,
        lifecycleHooks: ['start', 'verify', 'review', 'close', 'check', 'unadopt'],
        artifactKinds: ['external-source-use', 'external-source-release'],
    }];
const descriptors = descriptorInputs.map((descriptor) => ({
    ...descriptor,
    digest: canonicalDigest(descriptor),
}));
export function extensionDescriptor(id, version) {
    const descriptor = descriptors.find((candidate) => candidate.id === id && candidate.version === version);
    if (descriptor === undefined)
        throw new Error(`PROJECT_EXTENSION_UNKNOWN:${id}@${version}`);
    return structuredClone(descriptor);
}
export function loadProjectExtensions(projectPath) {
    const projectRoot = realpathSync(resolve(projectPath));
    const path = join(projectRoot, '.delivery', 'extensions.yaml');
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
        throw new Error('PROJECT_EXTENSIONS_MISSING_OR_UNSAFE');
    }
    const manifest = parse(readFileSync(path, 'utf8'));
    const schema = validateDocument('extensions-manifest', manifest);
    if (!schema.valid)
        throw new Error(`PROJECT_EXTENSIONS_INVALID:${schema.errors.join(',')}`);
    const keys = manifest.extensions.map((binding) => `${binding.id}@${binding.version}`);
    if (new Set(keys).size !== keys.length)
        throw new Error('PROJECT_EXTENSION_BINDINGS_DUPLICATED');
    if (JSON.stringify(keys) !== JSON.stringify([...keys].sort())) {
        throw new Error('PROJECT_EXTENSION_BINDINGS_NOT_CANONICAL');
    }
    return manifest.extensions.map((binding) => {
        const descriptor = extensionDescriptor(binding.id, binding.version);
        if (descriptor.digest !== binding.digest) {
            throw new Error(`PROJECT_EXTENSION_DIGEST_MISMATCH:${binding.id}@${binding.version}`);
        }
        return descriptor;
    });
}
