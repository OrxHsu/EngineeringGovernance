import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
function repositoryProjectId(projectRoot) {
    try {
        const commonDirectory = execFileSync('git', ['-C', projectRoot, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        const absolute = resolve(projectRoot, commonDirectory);
        return basename(absolute) === '.git' ? basename(dirname(absolute)) : basename(projectRoot);
    }
    catch {
        return basename(projectRoot) || 'project';
    }
}
function isProjTravWorkspace(projectRoot) {
    return [
        'Docs/AGENTS.md',
        'Docs/rules/workspace-agent-entrypoint.md',
        'Docs/rules/backend-agent-rules.md',
        'Docs/rules/ios-agent-rules.md',
        'projtrav-server',
        'projtrav-ios',
    ].every((path) => existsSync(join(projectRoot, path)));
}
function isEngineeringGovernance(projectRoot) {
    return [
        'CORE_INVARIANTS.md',
        'DEVELOPMENT_SOP.md',
        'RISK_CLASSIFICATION.md',
        'VERSION',
    ].every((path) => existsSync(join(projectRoot, path)));
}
function isNoMeWorkspace(projectRoot) {
    return [
        'AGENTS.md',
        'Docs/ODD.md',
        'project.yml',
    ].every((path) => existsSync(join(projectRoot, path)));
}
export function adoptionProfile(projectRoot) {
    if (isProjTravWorkspace(projectRoot)) {
        return {
            projectId: 'projtrav-v1',
            adapters: [
                {
                    tool: 'canonical-workspace-rules',
                    source: 'Docs/AGENTS.md',
                    targets: ['Docs/AGENTS.md'],
                },
                {
                    tool: 'workspace-agents',
                    source: 'Docs/rules/workspace-agent-entrypoint.md',
                    targets: ['AGENTS.md'],
                },
                {
                    tool: 'backend-agents',
                    source: 'Docs/rules/backend-agent-rules.md',
                    targets: ['projtrav-server/AGENTS.md', 'projtrav-server/.cursorrules'],
                },
                {
                    tool: 'ios-agents',
                    source: 'Docs/rules/ios-agent-rules.md',
                    targets: ['projtrav-ios/AGENTS.md', 'projtrav-ios/.cursorrules'],
                },
            ],
        };
    }
    if (isNoMeWorkspace(projectRoot)) {
        return {
            projectId: 'nome-v2',
            adapters: [{ tool: 'generic-agents', source: 'AGENTS.md', targets: ['AGENTS.md'] }],
        };
    }
    return {
        projectId: isEngineeringGovernance(projectRoot)
            ? 'engineering-governance'
            : repositoryProjectId(projectRoot),
        adapters: [{ tool: 'generic-agents', source: 'AGENTS.md', targets: ['AGENTS.md'] }],
    };
}
