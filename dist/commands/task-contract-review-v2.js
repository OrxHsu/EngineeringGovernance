import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readTaskLedger } from '../state/ledger.js';
import { verifyContractReadinessArtifact } from '../state/contract-readiness.js';
export function verifyContractReview(reviewPathInput) {
    const reviewPath = realpathSync(resolve(reviewPathInput));
    const taskRoot = dirname(reviewPath);
    const projectRoot = realpathSync(resolve(taskRoot, '../../..'));
    const taskId = taskRoot.split('/').at(-1) ?? '';
    const result = verifyContractReadinessArtifact(projectRoot, taskId, reviewPath);
    if (result.contract !== undefined) {
        const ledger = readTaskLedger({
            projectRoot,
            taskId,
            contractDigest: result.contract.contractDigest,
            contractSha256: createHash('sha256').update(readFileSync(resolve(taskRoot, 'contract.yaml'))).digest('hex'),
            implementationOwner: result.contract.implementationOwner,
        });
        if (!ledger.valid)
            return { ...result, errors: [...result.errors, ...ledger.errors.map((error) => `CONTRACT_REVIEW_LEDGER_INVALID:${error}`)], valid: false };
        return ledger.currentState === undefined ? result : { ...result, state: ledger.currentState };
    }
    return result;
}
