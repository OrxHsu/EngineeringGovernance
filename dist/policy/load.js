import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
const schemaPaths = {
    'project-policy': new URL('../../schemas/project-policy.schema.json', import.meta.url),
    'task-contract': new URL('../../schemas/task-contract.schema.json', import.meta.url),
    candidate: new URL('../../schemas/candidate.schema.json', import.meta.url),
    evidence: new URL('../../schemas/evidence.schema.json', import.meta.url),
    review: new URL('../../schemas/review.schema.json', import.meta.url),
    closure: new URL('../../schemas/closure.schema.json', import.meta.url),
    exception: new URL('../../schemas/exception.schema.json', import.meta.url),
    authorization: new URL('../../schemas/authorization.schema.json', import.meta.url),
    'task-event': new URL('../../schemas/task-event.schema.json', import.meta.url),
    'execution-receipt': new URL('../../schemas/execution-receipt.schema.json', import.meta.url),
    verification: new URL('../../schemas/verification.schema.json', import.meta.url),
    'replay-verification': new URL('../../schemas/replay-verification.schema.json', import.meta.url),
    'extensions-manifest': new URL('../../schemas/extensions-manifest.schema.json', import.meta.url),
    'external-source-use': new URL('../../schemas/external-source-use.schema.json', import.meta.url),
    'external-source-release': new URL('../../schemas/external-source-release.schema.json', import.meta.url),
    'contract-review': new URL('../../schemas/contract-review.schema.json', import.meta.url),
    'prior-review-finding': new URL('../../schemas/prior-review-finding.schema.json', import.meta.url),
    'release-record': new URL('../../schemas/release-record.schema.json', import.meta.url),
};
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validators = new Map();
function validatorFor(kind) {
    const cached = validators.get(kind);
    if (cached)
        return cached;
    const schema = JSON.parse(readFileSync(schemaPaths[kind], 'utf8'));
    const validator = ajv.compile(schema);
    validators.set(kind, validator);
    return validator;
}
function describeError(error) {
    const path = error.instancePath || '/';
    const missing = typeof error.params.missingProperty === 'string'
        ? `:${error.params.missingProperty}`
        : '';
    return `${path}${missing} ${error.keyword} ${error.message ?? 'invalid'}`;
}
export function validateDocument(kind, input) {
    const validator = validatorFor(kind);
    const valid = validator(input);
    if (valid)
        return { valid: true, errors: [] };
    return {
        valid: false,
        errors: (validator.errors ?? []).map(describeError).sort(),
    };
}
export function validateProjectPolicy(input) {
    return validateDocument('project-policy', input);
}
