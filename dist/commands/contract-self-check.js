import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { validateDocument } from '../policy/load.js';
import { createSelfReviewRequest, finalizeSelfReview, } from '../review/mutual-review.js';
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(value, keys) {
    return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function safeDocument(pathInput) {
    const path = realpathSync(resolve(pathInput));
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())
        throw new Error('SELF_REVIEW_FILE_UNSAFE');
    const raw = readFileSync(path);
    return { path, raw, value: parse(raw.toString('utf8')) };
}
function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
function responseValue(value) {
    if (!record(value) || !exactKeys(value, ['durationSeconds', 'dimensions', 'overallStatus', 'knownIssues'])) {
        throw new Error('SELF_REVIEW_RESPONSE_SCHEMA_INVALID');
    }
    return value;
}
export function contractSelfCheck(inputPath, responsePath, reviewedAt) {
    const inputDocument = safeDocument(inputPath);
    const inputSchema = validateDocument('task-start-input', inputDocument.value);
    if (!inputSchema.valid || !record(inputDocument.value)) {
        throw new Error(`SELF_REVIEW_INPUT_INVALID:${inputSchema.errors.join(',')}`);
    }
    const request = createSelfReviewRequest(inputDocument.value, sha256(inputDocument.raw));
    if (responsePath === undefined)
        return request;
    const response = responseValue(safeDocument(responsePath).value);
    const attachment = finalizeSelfReview(inputDocument.value, response, reviewedAt);
    const augmentedInput = { ...inputDocument.value, ...attachment };
    const augmentedSchema = validateDocument('task-start-input', augmentedInput);
    if (!augmentedSchema.valid)
        throw new Error(`SELF_REVIEW_AUGMENTED_INPUT_INVALID:${augmentedSchema.errors.join(',')}`);
    return { request, ...attachment, augmentedInput };
}
