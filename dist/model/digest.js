import { createHash } from 'node:crypto';
function canonical(value) {
    if (Array.isArray(value))
        return value.map(canonical);
    if (typeof value !== 'object' || value === null)
        return value;
    return Object.fromEntries(Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]));
}
export function canonicalDigest(value) {
    return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
