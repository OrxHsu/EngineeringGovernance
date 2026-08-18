import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { canonicalDigest } from '../model/digest.js';
import { implementationOwnersOf } from '../model/ownership.js';
import { validateDocument } from '../policy/load.js';
import { validateHardenedTaskContract } from '../policy/task-contract.js';
import { verifyHardenedCandidate, } from '../commands/task-verify-v2.js';
import { readTaskLedger } from '../state/ledger.js';
import { PRE_GATE_POLICY_DIGEST, verifyContractReadinessArtifact } from '../state/contract-readiness.js';
import { readAccountabilityEvents, withAccountabilityReadScope } from '../accountability/derive.js';
import { policyDigestAllowedForProject } from '../accountability/registry.js';
import { legacyManifestTaskIds, loadLegacyCompatibilityManifest, verifyLegacyTaskCompatibility, } from './legacy-compatibility.js';
const terminalTaskStates = new Set(['CLOSED', 'CANCELLED', 'SUPERSEDED']);
function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
function canonicalReferences(value) {
    if (!Array.isArray(value) || value.some((item) => (typeof item !== 'object' || item === null || Array.isArray(item))))
        return undefined;
    return [...value]
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
function validateBoundArtifactSet(input) {
    const candidateReferences = canonicalReferences(input.candidateValue);
    const verificationReferences = canonicalReferences(input.verificationValue);
    if (candidateReferences === undefined || verificationReferences === undefined
        || JSON.stringify(candidateReferences) !== JSON.stringify(verificationReferences)) {
        input.errors.push(`TASK_GRAPH_VERIFICATION_${input.label}_ARTIFACT_SET_MISMATCH:${input.taskId}`);
        return;
    }
    for (const reference of verificationReferences) {
        try {
            if (typeof reference.path !== 'string' || typeof reference.sha256 !== 'string')
                throw new Error('invalid');
            const unresolved = resolve(reference.path);
            if (lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isFile())
                throw new Error('unsafe');
            const path = realpathSync(unresolved);
            const relativePath = relative(input.taskRoot, path);
            if (!relativePath.startsWith(`${input.directory}/`) || sha256(readFileSync(path)) !== reference.sha256) {
                throw new Error('mismatch');
            }
        }
        catch {
            input.errors.push(`TASK_GRAPH_VERIFICATION_${input.label}_ARTIFACT_INVALID:${input.taskId}`);
        }
    }
}
function projectPolicyIdentity(projectRoot) {
    const path = join(projectRoot, '.delivery', 'policy.yaml');
    try {
        if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
            return undefined;
        }
        const policy = parse(readFileSync(path, 'utf8'));
        if (typeof policy.sopVersion !== 'string' || typeof policy.sopDigest !== 'string') {
            return undefined;
        }
        return { version: policy.sopVersion, digest: policy.sopDigest };
    }
    catch {
        return undefined;
    }
}
function structuredFiles(taskRoot, taskId, errors) {
    const files = [];
    const visit = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => (left.name.localeCompare(right.name)))) {
            const path = join(directory, entry.name);
            const relativePath = relative(taskRoot, path);
            if (entry.isSymbolicLink()) {
                errors.push(`TASK_GRAPH_ARTIFACT_UNSAFE:${taskId}:${relativePath}`);
            }
            else if (entry.isDirectory()) {
                visit(path);
            }
            else if (entry.isFile() && ['.json', '.yaml', '.yml'].includes(extname(entry.name))) {
                files.push(path);
            }
        }
    };
    visit(taskRoot);
    return files;
}
function candidateArtifacts(taskRoot, taskId, errors) {
    const candidates = [];
    for (const path of structuredFiles(taskRoot, taskId, errors)) {
        if (path === join(taskRoot, 'contract.yaml'))
            continue;
        let value;
        try {
            value = parse(readFileSync(path, 'utf8'));
        }
        catch {
            continue;
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            continue;
        const record = value;
        if (record.schemaVersion !== 2 || !validateDocument('candidate', record).valid)
            continue;
        candidates.push({ path, value: record });
        if (record.taskId !== taskId) {
            errors.push(`TASK_GRAPH_CROSS_TASK_ARTIFACT:${taskId}:${relative(taskRoot, path)}:${String(record.taskId)}`);
        }
    }
    if (candidates.length > 1)
        errors.push(`TASK_GRAPH_DUPLICATE_CANDIDATE:${taskId}`);
    return candidates;
}
function verificationArtifacts(taskRoot, taskId, errors) {
    const verifications = [];
    for (const path of structuredFiles(taskRoot, taskId, errors)) {
        let value;
        try {
            value = parse(readFileSync(path, 'utf8'));
        }
        catch {
            continue;
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            continue;
        const record = value;
        if (record.artifactType !== 'sop-candidate-verification-v2')
            continue;
        const schema = validateDocument('verification', record);
        if (!schema.valid || record.schemaVersion !== 2) {
            errors.push(`TASK_GRAPH_VERIFICATION_INVALID:${taskId}:${relative(taskRoot, path)}`);
            continue;
        }
        verifications.push({ path, value: record });
        if (record.taskId !== taskId) {
            errors.push(`TASK_GRAPH_CROSS_TASK_ARTIFACT:${taskId}:${relative(taskRoot, path)}:${String(record.taskId)}`);
        }
    }
    if (verifications.length > 1)
        errors.push(`TASK_GRAPH_DUPLICATE_VERIFICATION:${taskId}`);
    return verifications;
}
function reviewArtifacts(taskRoot, taskId, errors) {
    const reviews = [];
    for (const path of structuredFiles(taskRoot, taskId, errors)) {
        let value;
        try {
            value = parse(readFileSync(path, 'utf8'));
        }
        catch {
            continue;
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            continue;
        const record = value;
        if (record.artifactType !== 'sop-review-v2')
            continue;
        const schema = validateDocument('review', record);
        if (!schema.valid || record.schemaVersion !== 2) {
            errors.push(`TASK_GRAPH_REVIEW_INVALID:${taskId}:${relative(taskRoot, path)}`);
            continue;
        }
        reviews.push({ path, value: record });
        if (record.taskId !== taskId) {
            errors.push(`TASK_GRAPH_CROSS_TASK_ARTIFACT:${taskId}:${relative(taskRoot, path)}:${String(record.taskId)}`);
        }
    }
    if (reviews.length > 1)
        errors.push(`TASK_GRAPH_DUPLICATE_REVIEW:${taskId}`);
    if (reviews.filter((review) => review.value.decision === 'ACCEPTED').length > 1) {
        errors.push(`TASK_GRAPH_DUPLICATE_ACCEPTED_REVIEW:${taskId}`);
    }
    return reviews;
}
function contractReadinessArtifacts(taskRoot, taskId, errors) {
    const artifacts = [];
    for (const path of structuredFiles(taskRoot, taskId, errors)) {
        let value;
        try {
            value = parse(readFileSync(path, 'utf8'));
        }
        catch {
            continue;
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            continue;
        const record = value;
        if (record.artifactType !== 'sop-contract-review-v2')
            continue;
        const schema = validateDocument('contract-review', record);
        if (!schema.valid || record.schemaVersion !== 2) {
            errors.push(`TASK_GRAPH_CONTRACT_REVIEW_INVALID:${taskId}:${relative(taskRoot, path)}`);
            continue;
        }
        artifacts.push({ path, value: record });
        if (record.taskId !== taskId) {
            errors.push(`TASK_GRAPH_CROSS_TASK_ARTIFACT:${taskId}:${relative(taskRoot, path)}:${String(record.taskId)}`);
        }
    }
    if (artifacts.length > 1)
        errors.push(`TASK_GRAPH_DUPLICATE_CONTRACT_REVIEW:${taskId}`);
    return artifacts;
}
function validateContractReadinessGraph(input) {
    if (input.contract.contractReadiness?.required !== true) {
        const initial = input.events[0];
        const isExplicitPreGateHistory = input.contract.contractReadiness === undefined
            && input.contract.sopVersion === '2.0.0'
            && input.contract.policyDigest === PRE_GATE_POLICY_DIGEST
            && initial?.sequence === 1
            && initial.from === null
            && initial.to === 'DEFINED';
        if (input.contract.risk === 'R2' || input.contract.risk === 'R3') {
            if (!isExplicitPreGateHistory)
                input.errors.push(`TASK_GRAPH_MARKERLESS_CONTRACT_NOT_GRANDFATHERED:${input.taskId}`);
        }
        if (input.readinessArtifacts.length > 0)
            input.errors.push(`TASK_GRAPH_ORPHAN_CONTRACT_REVIEW:${input.taskId}`);
        return;
    }
    const canonicalPath = join(input.taskRoot, 'contract-review.yaml');
    const artifact = input.readinessArtifacts.find((item) => item.path === canonicalPath);
    if (input.readinessArtifacts.some((item) => item.path !== canonicalPath)) {
        input.errors.push(`TASK_GRAPH_CONTRACT_REVIEW_CANONICAL_PATH_MISMATCH:${input.taskId}`);
    }
    const stateRequiresReview = input.events.some((event) => event.to === 'IN_PROGRESS' || event.from === 'IN_PROGRESS');
    if (artifact === undefined) {
        if (stateRequiresReview)
            input.errors.push(`TASK_GRAPH_CONTRACT_REVIEW_MISSING:${input.taskId}`);
        return;
    }
    const verification = verifyContractReadinessArtifact(input.projectRoot, input.taskId, artifact.path);
    if (!verification.valid) {
        input.errors.push(...verification.errors.map((error) => `TASK_GRAPH_CONTRACT_REVIEW_INVALID:${input.taskId}:${error}`));
    }
    else if (stateRequiresReview && verification.review?.decision !== 'ACCEPTED') {
        input.errors.push(`TASK_GRAPH_CONTRACT_REVIEW_NOT_ACCEPTED:${input.taskId}`);
    }
    const containsOwnLedgerReference = (value) => {
        if (Array.isArray(value))
            return value.some(containsOwnLedgerReference);
        if (typeof value !== 'object' || value === null)
            return false;
        const record = value;
        if (record.kind === 'record' && record.path === `.delivery/tasks/${input.taskId}/ledger.jsonl`)
            return true;
        return Object.values(record).some(containsOwnLedgerReference);
    };
    if (!stateRequiresReview
        && verification.review?.decision === 'ACCEPTED'
        && containsOwnLedgerReference(artifact.value)) {
        input.errors.push(`TASK_GRAPH_CONTRACT_REVIEW_LEDGER_PREFIX_NOT_ADVANCED:${input.taskId}`);
    }
    if (!stateRequiresReview)
        return;
    const inProgress = input.events.find((event) => event.to === 'IN_PROGRESS');
    const expectedRef = {
        kind: 'contract-review',
        path: relative(input.projectRoot, canonicalPath),
        sha256: sha256(readFileSync(canonicalPath)),
    };
    if (inProgress === undefined || JSON.stringify(inProgress.artifactRefs) !== JSON.stringify([expectedRef])) {
        input.errors.push(`TASK_GRAPH_CONTRACT_REVIEW_EVENT_REF_MISMATCH:${input.taskId}`);
    }
}
function closureArtifacts(taskRoot, taskId, errors) {
    const closures = [];
    for (const path of structuredFiles(taskRoot, taskId, errors)) {
        let value;
        try {
            value = parse(readFileSync(path, 'utf8'));
        }
        catch {
            continue;
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            continue;
        const record = value;
        if (record.artifactType !== 'sop-closure-v2')
            continue;
        const schema = validateDocument('closure', record);
        if (!schema.valid || record.schemaVersion !== 2) {
            errors.push(`TASK_GRAPH_CLOSURE_INVALID:${taskId}:${relative(taskRoot, path)}`);
            continue;
        }
        closures.push({ path, value: record });
        if (record.taskId !== taskId) {
            errors.push(`TASK_GRAPH_CROSS_TASK_ARTIFACT:${taskId}:${relative(taskRoot, path)}:${String(record.taskId)}`);
        }
    }
    if (closures.length > 1)
        errors.push(`TASK_GRAPH_DUPLICATE_CLOSURE:${taskId}`);
    return closures;
}
function validateCurrentCandidate(input) {
    const candidateEvent = [...input.events].reverse().find((event) => event.to === 'CANDIDATE');
    const canonicalCandidatePath = join(input.taskRoot, 'candidate.yaml');
    const candidate = input.candidates.find((artifact) => artifact.path === canonicalCandidatePath);
    if (candidateEvent === undefined) {
        if (input.candidates.length > 0)
            input.errors.push(`TASK_GRAPH_ORPHAN_CANDIDATE:${input.taskId}`);
        return;
    }
    if (candidate === undefined) {
        input.errors.push(`TASK_GRAPH_CURRENT_CANDIDATE_MISSING:${input.taskId}`);
        return;
    }
    for (const artifact of input.candidates) {
        if (artifact.path !== canonicalCandidatePath) {
            input.errors.push(`TASK_GRAPH_CANDIDATE_CANONICAL_PATH_MISMATCH:${input.taskId}:${relative(input.taskRoot, artifact.path)}`);
        }
    }
    const expectedContract = {
        path: realpathSync(input.contractPath),
        sha256: sha256(input.contractRaw),
    };
    if (JSON.stringify(candidate.value.contract) !== JSON.stringify(expectedContract)) {
        input.errors.push(`TASK_GRAPH_CANDIDATE_CONTRACT_REF_MISMATCH:${input.taskId}`);
    }
    const evidencePath = join(input.taskRoot, 'evidence.json');
    let evidenceSha256;
    try {
        if (lstatSync(evidencePath).isSymbolicLink() || !lstatSync(evidencePath).isFile()) {
            throw new Error('unsafe');
        }
        evidenceSha256 = sha256(readFileSync(evidencePath));
        const expectedEvidence = { path: realpathSync(evidencePath), sha256: evidenceSha256 };
        if (JSON.stringify(candidate.value.evidence) !== JSON.stringify(expectedEvidence)) {
            input.errors.push(`TASK_GRAPH_CANDIDATE_EVIDENCE_REF_MISMATCH:${input.taskId}`);
        }
        const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
        const schema = validateDocument('evidence', evidence);
        if (!schema.valid || evidence.schemaVersion !== 2) {
            input.errors.push(`TASK_GRAPH_EVIDENCE_INVALID:${input.taskId}`);
        }
        else if (evidence.taskId !== input.taskId || evidence.contractDigest !== input.contractDigest) {
            input.errors.push(`TASK_GRAPH_EVIDENCE_ANCESTRY_MISMATCH:${input.taskId}`);
        }
    }
    catch {
        input.errors.push(`TASK_GRAPH_CURRENT_EVIDENCE_MISSING_OR_UNSAFE:${input.taskId}`);
    }
    if (evidenceSha256 === undefined)
        return;
    const expectedReferences = [
        {
            kind: 'candidate',
            path: relative(input.projectRoot, canonicalCandidatePath),
            sha256: sha256(readFileSync(canonicalCandidatePath)),
        },
        {
            kind: 'evidence',
            path: relative(input.projectRoot, evidencePath),
            sha256: evidenceSha256,
        },
    ].sort((left, right) => left.kind.localeCompare(right.kind));
    const actualReferences = candidateEvent.artifactRefs
        .filter((reference) => reference.kind === 'candidate' || reference.kind === 'evidence')
        .sort((left, right) => left.kind.localeCompare(right.kind));
    if (JSON.stringify(actualReferences) !== JSON.stringify(expectedReferences)) {
        input.errors.push(`TASK_GRAPH_CURRENT_CANDIDATE_REF_MISMATCH:${input.taskId}`);
    }
}
function validateCurrentReview(input) {
    const reviewEvent = [...input.events].reverse().find((event) => (event.to === 'ACCEPTED' || event.to === 'REPAIR_REQUIRED'));
    if (reviewEvent === undefined) {
        if (input.reviews.length > 0) {
            input.errors.push(`TASK_GRAPH_ORPHAN_REVIEW:${input.taskId}`);
        }
        return;
    }
    const latestCandidateEvent = [...input.events].reverse().find((event) => event.to === 'CANDIDATE');
    if (latestCandidateEvent !== undefined && latestCandidateEvent.sequence > reviewEvent.sequence) {
        if (input.reviews.length > 0 || input.verifications.length > 0) {
            input.errors.push(`TASK_GRAPH_STALE_REVIEW_ARTIFACT:${input.taskId}`);
        }
        return;
    }
    const reviewPath = join(input.taskRoot, 'review.yaml');
    const verificationPath = join(input.taskRoot, 'verification.json');
    const review = input.reviews.find((artifact) => artifact.path === reviewPath);
    const verification = input.verifications.find((artifact) => artifact.path === verificationPath);
    const candidate = input.candidates.find((artifact) => (artifact.path === join(input.taskRoot, 'candidate.yaml')));
    if (review === undefined) {
        input.errors.push(`TASK_GRAPH_CURRENT_REVIEW_MISSING:${input.taskId}`);
        return;
    }
    if (verification === undefined || candidate === undefined) {
        input.errors.push(`TASK_GRAPH_ORPHAN_REVIEW:${input.taskId}`);
        return;
    }
    if (review.value.decision !== reviewEvent.to) {
        input.errors.push(`TASK_GRAPH_REVIEW_STATE_MISMATCH:${input.taskId}`);
    }
    const contractReference = {
        path: realpathSync(input.contractPath),
        sha256: sha256(input.contractRaw),
        digest: input.contractDigest,
    };
    const candidateReference = {
        path: candidate.path,
        sha256: sha256(readFileSync(candidate.path)),
        digest: canonicalDigest(candidate.value),
    };
    const verificationReference = {
        path: verification.path,
        sha256: sha256(readFileSync(verification.path)),
    };
    if (JSON.stringify(review.value.contract) !== JSON.stringify(contractReference)) {
        input.errors.push(`TASK_GRAPH_REVIEW_CONTRACT_REF_MISMATCH:${input.taskId}`);
    }
    if (JSON.stringify(review.value.candidate) !== JSON.stringify(candidateReference)) {
        input.errors.push(`TASK_GRAPH_REVIEW_CANDIDATE_REF_MISMATCH:${input.taskId}`);
    }
    if (JSON.stringify(review.value.verification) !== JSON.stringify(verificationReference)) {
        input.errors.push(`TASK_GRAPH_REVIEW_VERIFICATION_REF_MISMATCH:${input.taskId}`);
    }
    const expectedReferences = [
        {
            kind: 'review',
            path: relative(input.projectRoot, review.path),
            sha256: sha256(readFileSync(review.path)),
        },
        {
            kind: 'verification',
            path: relative(input.projectRoot, verification.path),
            sha256: sha256(readFileSync(verification.path)),
        },
    ].sort((left, right) => left.kind.localeCompare(right.kind));
    const actualReferences = reviewEvent.artifactRefs
        .filter((reference) => reference.kind === 'review' || reference.kind === 'verification')
        .sort((left, right) => left.kind.localeCompare(right.kind));
    if (JSON.stringify(actualReferences) !== JSON.stringify(expectedReferences)) {
        input.errors.push(`TASK_GRAPH_CURRENT_REVIEW_REF_MISMATCH:${input.taskId}`);
    }
}
function validateVerificationGraph(input) {
    if (input.verifications.length === 0)
        return;
    const candidate = input.candidates.find((artifact) => (artifact.path === join(input.taskRoot, 'candidate.yaml')));
    if (candidate === undefined) {
        input.errors.push(`TASK_GRAPH_ORPHAN_VERIFICATION:${input.taskId}`);
        return;
    }
    const verificationPath = join(input.taskRoot, 'verification.json');
    const verification = input.verifications.find((artifact) => artifact.path === verificationPath);
    if (verification === undefined) {
        input.errors.push(`TASK_GRAPH_VERIFICATION_CANONICAL_PATH_MISMATCH:${input.taskId}`);
        return;
    }
    for (const artifact of input.verifications) {
        if (artifact.path !== verificationPath) {
            input.errors.push(`TASK_GRAPH_VERIFICATION_CANONICAL_PATH_MISMATCH:${input.taskId}:${relative(input.taskRoot, artifact.path)}`);
        }
    }
    const expectedContract = {
        path: realpathSync(input.contractPath),
        sha256: sha256(input.contractRaw),
        digest: input.contractDigest,
    };
    const expectedCandidate = {
        path: candidate.path,
        sha256: sha256(readFileSync(candidate.path)),
        digest: canonicalDigest(candidate.value),
    };
    if (JSON.stringify(verification.value.contract) !== JSON.stringify(expectedContract)) {
        input.errors.push(`TASK_GRAPH_VERIFICATION_CONTRACT_REF_MISMATCH:${input.taskId}`);
    }
    if (JSON.stringify(verification.value.candidate) !== JSON.stringify(expectedCandidate)) {
        input.errors.push(`TASK_GRAPH_VERIFICATION_CANDIDATE_REF_MISMATCH:${input.taskId}`);
    }
    if (JSON.stringify(verification.value.evidence) !== JSON.stringify(candidate.value.evidence)) {
        input.errors.push(`TASK_GRAPH_VERIFICATION_EVIDENCE_REF_MISMATCH:${input.taskId}`);
    }
    validateBoundArtifactSet({
        taskRoot: input.taskRoot,
        taskId: input.taskId,
        label: 'AUTHORIZATION',
        directory: 'authorizations',
        candidateValue: candidate.value.authorizationArtifacts,
        verificationValue: verification.value.authorizationArtifacts,
        errors: input.errors,
    });
    validateBoundArtifactSet({
        taskRoot: input.taskRoot,
        taskId: input.taskId,
        label: 'EXTENSION',
        directory: 'extensions',
        candidateValue: candidate.value.extensionArtifacts,
        verificationValue: verification.value.extensionArtifacts,
        errors: input.errors,
    });
    const verifiedAt = verification.value.verifiedAt;
    if (typeof verifiedAt !== 'string') {
        input.errors.push(`TASK_GRAPH_VERIFICATION_RECOMPUTATION_FAILED:${input.taskId}:TIME_INVALID`);
        return;
    }
    const recomputed = verifyHardenedCandidate(candidate.value, {
        candidatePath: candidate.path,
        evidenceVerificationTime: new Date(verifiedAt),
        requireCandidateState: false,
        runnerIdentity: { version: input.contract.sopVersion, digest: input.contract.policyDigest },
    });
    if (!recomputed.valid || recomputed.verificationArtifact === undefined) {
        input.errors.push(`TASK_GRAPH_VERIFICATION_RECOMPUTATION_FAILED:${input.taskId}:${recomputed.errors.join('|')}`);
    }
    else if (canonicalDigest(recomputed.verificationArtifact) !== canonicalDigest(verification.value)) {
        input.errors.push(`TASK_GRAPH_VERIFICATION_RECOMPUTATION_MISMATCH:${input.taskId}`);
    }
}
function validateClosureGraph(input) {
    const acceptedEvent = [...input.events].reverse().find((event) => event.to === 'ACCEPTED');
    if (input.closures.length === 0) {
        if (input.currentState === 'CLOSED')
            input.errors.push(`TASK_GRAPH_CURRENT_CLOSURE_MISSING:${input.taskId}`);
        return;
    }
    if (acceptedEvent === undefined) {
        input.errors.push(`TASK_GRAPH_ORPHAN_CLOSURE:${input.taskId}`);
        return;
    }
    const closurePath = join(input.taskRoot, 'closure.yaml');
    const closure = input.closures.find((artifact) => artifact.path === closurePath);
    if (closure === undefined) {
        input.errors.push(`TASK_GRAPH_CLOSURE_CANONICAL_PATH_MISMATCH:${input.taskId}`);
        return;
    }
    for (const artifact of input.closures) {
        if (artifact.path !== closurePath) {
            input.errors.push(`TASK_GRAPH_CLOSURE_CANONICAL_PATH_MISMATCH:${input.taskId}:${relative(input.taskRoot, artifact.path)}`);
        }
    }
    const candidate = input.candidates.find((artifact) => artifact.path === join(input.taskRoot, 'candidate.yaml'));
    const verification = input.verifications.find((artifact) => artifact.path === join(input.taskRoot, 'verification.json'));
    const review = input.reviews.find((artifact) => artifact.path === join(input.taskRoot, 'review.yaml'));
    if (candidate === undefined || verification === undefined || review === undefined) {
        input.errors.push(`TASK_GRAPH_ORPHAN_CLOSURE:${input.taskId}`);
        return;
    }
    const expectedContract = {
        path: realpathSync(input.contractPath),
        sha256: sha256(input.contractRaw),
        digest: input.contractDigest,
    };
    const expectedCandidate = {
        path: candidate.path,
        sha256: sha256(readFileSync(candidate.path)),
        digest: canonicalDigest(candidate.value),
    };
    const expectedVerification = {
        path: verification.path,
        sha256: sha256(readFileSync(verification.path)),
    };
    const expectedReview = { path: review.path, sha256: sha256(readFileSync(review.path)) };
    if (JSON.stringify(closure.value.contract) !== JSON.stringify(expectedContract)) {
        input.errors.push(`TASK_GRAPH_CLOSURE_CONTRACT_REF_MISMATCH:${input.taskId}`);
    }
    if (JSON.stringify(closure.value.candidate) !== JSON.stringify(expectedCandidate)) {
        input.errors.push(`TASK_GRAPH_CLOSURE_CANDIDATE_REF_MISMATCH:${input.taskId}`);
    }
    if (JSON.stringify(closure.value.verification) !== JSON.stringify(expectedVerification)) {
        input.errors.push(`TASK_GRAPH_CLOSURE_VERIFICATION_REF_MISMATCH:${input.taskId}`);
    }
    if (JSON.stringify(closure.value.review) !== JSON.stringify(expectedReview)) {
        input.errors.push(`TASK_GRAPH_CLOSURE_REVIEW_REF_MISMATCH:${input.taskId}`);
    }
    if (closure.value.acceptedEventDigest !== acceptedEvent.eventDigest) {
        input.errors.push(`TASK_GRAPH_STALE_CLOSURE:${input.taskId}`);
    }
    if (input.currentState === 'CLOSED') {
        const closureEvent = input.events.at(-1);
        const expectedReference = {
            kind: 'closure',
            path: relative(input.projectRoot, closure.path),
            sha256: sha256(readFileSync(closure.path)),
        };
        const actualReferences = closureEvent?.artifactRefs.filter((reference) => reference.kind === 'closure') ?? [];
        if (actualReferences.length !== 1 || JSON.stringify(actualReferences[0]) !== JSON.stringify(expectedReference)) {
            input.errors.push(`TASK_GRAPH_CURRENT_CLOSURE_REF_MISMATCH:${input.taskId}`);
        }
    }
}
function validateProjectTaskGraphWithinAccountabilityScope(projectPath) {
    const projectRoot = realpathSync(resolve(projectPath));
    const policyIdentity = projectPolicyIdentity(projectRoot);
    const tasksRoot = join(projectRoot, '.delivery', 'tasks');
    if (existsSync(tasksRoot) && (lstatSync(tasksRoot).isSymbolicLink() || !lstatSync(tasksRoot).isDirectory())) {
        return { valid: false, errors: ['TASK_GRAPH_ROOT_UNSAFE'], tasks: [] };
    }
    const errors = [];
    let policy;
    let legacyManifest;
    try {
        const policyPath = join(projectRoot, '.delivery', 'policy.yaml');
        policy = existsSync(policyPath) ? parse(readFileSync(policyPath, 'utf8')) : undefined;
        const mapping = policy?.artifactMapping;
        if (typeof mapping === 'object' && mapping !== null && !Array.isArray(mapping)
            && mapping['accountability.ruleset'] !== undefined) {
            readAccountabilityEvents(projectRoot);
        }
    }
    catch (error) {
        errors.push(`TASK_GRAPH_ACCOUNTABILITY_INVALID:${error instanceof Error ? error.message : 'UNKNOWN'}`);
    }
    legacyManifest = loadLegacyCompatibilityManifest(projectRoot, policy);
    errors.push(...legacyManifest.errors);
    if (!existsSync(tasksRoot)) {
        if (legacyManifest.entries.size > 0)
            errors.push('TASK_GRAPH_LEGACY_TASK_ROOT_MISSING');
        const uniqueErrors = [...new Set(errors)].sort();
        return { valid: uniqueErrors.length === 0, errors: uniqueErrors, tasks: [] };
    }
    const compatibilityTaskIds = new Set();
    const tasks = [];
    const entries = readdirSync(tasksRoot, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
            errors.push(`TASK_GRAPH_DIRECTORY_UNSAFE:${entry.name}`);
            continue;
        }
        const taskRoot = join(tasksRoot, entry.name);
        const contractPath = join(taskRoot, 'contract.yaml');
        if (!existsSync(contractPath)
            || lstatSync(contractPath).isSymbolicLink()
            || !lstatSync(contractPath).isFile()) {
            errors.push(`TASK_GRAPH_CONTRACT_MISSING_OR_UNSAFE:${entry.name}`);
            continue;
        }
        let contractRecord;
        const contractRaw = readFileSync(contractPath);
        try {
            const parsed = parse(contractRaw.toString('utf8'));
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
                throw new Error('invalid');
            contractRecord = parsed;
        }
        catch {
            errors.push(`TASK_GRAPH_CONTRACT_UNREADABLE:${entry.name}`);
            continue;
        }
        const legacyEntry = legacyManifest.valid ? legacyManifest.entries.get(entry.name) : undefined;
        if (legacyEntry !== undefined) {
            let compatibility;
            try {
                compatibility = verifyLegacyTaskCompatibility({
                    projectRoot,
                    taskId: entry.name,
                    taskRoot,
                    contract: contractRecord,
                    contractRaw,
                    entry: legacyEntry,
                    compatibilityTaskIds: new Set(legacyManifest.entries.keys()),
                });
            }
            catch {
                compatibility = { valid: false, errors: ['LEGACY_COMPATIBILITY_UNREADABLE'] };
            }
            if (legacyEntry.successor !== undefined && legacyManifest.entries.has(legacyEntry.successor.taskId)) {
                compatibility.valid = false;
                compatibility.errors.push('SUCCESSOR_COMPATIBILITY_CYCLE');
            }
            if (compatibility.valid) {
                compatibilityTaskIds.add(entry.name);
                tasks.push({
                    taskId: entry.name,
                    schemaVersion: 2,
                    mode: 'legacy-inspect-only',
                    state: 'INSPECT_ONLY',
                });
                continue;
            }
            errors.push(...compatibility.errors.map((error) => `TASK_GRAPH_LEGACY_COMPATIBILITY_INVALID:${entry.name}:${error}`));
        }
        const contract = contractRecord;
        const schema = validateDocument('task-contract', contract);
        if (!schema.valid) {
            errors.push(...schema.errors.map((error) => (`TASK_GRAPH_CONTRACT_INVALID:${entry.name}:${error}`)));
            continue;
        }
        const { contractDigest: recordedDigest, ...unsignedContract } = contractRecord;
        if (canonicalDigest(unsignedContract) !== recordedDigest) {
            errors.push(`TASK_GRAPH_CONTRACT_DIGEST_MISMATCH:${entry.name}`);
        }
        if (contract.taskId !== entry.name) {
            errors.push(`TASK_GRAPH_DIRECTORY_ID_MISMATCH:${entry.name}:${contract.taskId}`);
        }
        if (contract.schemaVersion !== 2) {
            tasks.push({
                taskId: entry.name,
                schemaVersion: Number(contract.schemaVersion),
                mode: 'legacy-inspect-only',
                state: 'INSPECT_ONLY',
            });
            continue;
        }
        const semantic = validateHardenedTaskContract(contract);
        if (!semantic.valid) {
            errors.push(...semantic.errors.map((error) => (`TASK_GRAPH_CONTRACT_SEMANTIC_INVALID:${entry.name}:${error}`)));
        }
        const contractDigest = contract.contractDigest;
        const ledger = readTaskLedger({
            projectRoot,
            taskId: entry.name,
            contractDigest,
            contractSha256: sha256(contractRaw),
            implementationOwners: implementationOwnersOf(contract),
        });
        errors.push(...ledger.errors.map((error) => `TASK_GRAPH_LEDGER_INVALID:${entry.name}:${error}`));
        if (policyIdentity !== undefined
            && (contract.sopVersion !== policyIdentity.version || !policyDigestAllowedForProject(projectRoot, contract.policyDigest))
            && (ledger.currentState === undefined || !terminalTaskStates.has(ledger.currentState))) {
            errors.push(`TASK_GRAPH_CONTRACT_POLICY_IDENTITY_MISMATCH:${entry.name}`);
        }
        const candidates = candidateArtifacts(taskRoot, entry.name, errors);
        const verifications = verificationArtifacts(taskRoot, entry.name, errors);
        const reviews = reviewArtifacts(taskRoot, entry.name, errors);
        const contractReadinessReviews = contractReadinessArtifacts(taskRoot, entry.name, errors);
        const closures = closureArtifacts(taskRoot, entry.name, errors);
        if (ledger.valid) {
            validateCurrentCandidate({
                projectRoot,
                taskRoot,
                taskId: entry.name,
                contractPath,
                contractRaw,
                contractDigest,
                events: ledger.events,
                candidates,
                errors,
            });
            validateContractReadinessGraph({
                projectRoot,
                taskRoot,
                taskId: entry.name,
                contract,
                events: ledger.events,
                ...(ledger.currentState === undefined ? {} : { currentState: ledger.currentState }),
                readinessArtifacts: contractReadinessReviews,
                errors,
            });
            validateVerificationGraph({
                taskRoot,
                taskId: entry.name,
                contract,
                contractPath,
                contractRaw,
                contractDigest,
                candidates,
                verifications,
                errors,
            });
            validateCurrentReview({
                projectRoot,
                taskRoot,
                taskId: entry.name,
                contractPath,
                contractRaw,
                contractDigest,
                events: ledger.events,
                candidates,
                verifications,
                reviews,
                errors,
            });
            validateClosureGraph({
                projectRoot,
                taskRoot,
                taskId: entry.name,
                contractPath,
                contractRaw,
                contractDigest,
                ...(ledger.currentState === undefined ? {} : { currentState: ledger.currentState }),
                events: ledger.events,
                candidates,
                verifications,
                reviews,
                closures,
                errors,
            });
        }
        if (ledger.currentState !== undefined) {
            tasks.push({
                taskId: entry.name,
                schemaVersion: 2,
                mode: 'canonical',
                state: ledger.currentState,
            });
        }
    }
    if (legacyManifest.valid) {
        for (const taskId of legacyManifestTaskIds(legacyManifest)) {
            if (!compatibilityTaskIds.has(taskId)) {
                errors.push(`TASK_GRAPH_LEGACY_MANIFEST_TASK_UNVERIFIED:${taskId}`);
            }
        }
    }
    const uniqueErrors = [...new Set(errors)].sort();
    return { valid: uniqueErrors.length === 0, errors: uniqueErrors, tasks };
}
export function validateProjectTaskGraph(projectPath) {
    return withAccountabilityReadScope(() => validateProjectTaskGraphWithinAccountabilityScope(projectPath));
}
