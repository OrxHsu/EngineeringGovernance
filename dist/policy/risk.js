const rank = { R0: 0, R1: 1, R2: 2, R3: 3 };
const highRiskSignals = [
    'authentication',
    'authorization',
    'privacy',
    'security',
    'migration',
    'destructive',
    'payments',
    'production',
    'deployment',
    'remoteMutation',
    'externalCommunication',
    'restrictedRuntime',
];
const mediumRiskSignals = [
    'userVisible',
    'crossModule',
    'multiRepository',
    'persistentData',
];
export function highestRisk(risks) {
    return risks.reduce((highest, risk) => rank[risk] > rank[highest] ? risk : highest, 'R0');
}
export function classifyRisk(signals) {
    const matches = [];
    if (highRiskSignals.some((signal) => signals[signal] === true))
        matches.push('R3');
    if (mediumRiskSignals.some((signal) => signals[signal] === true))
        matches.push('R2');
    if (signals.mutation === true && signals.classificationComplete !== true)
        matches.push('R2');
    if (signals.localEdit === true || signals.mutation === true)
        matches.push('R1');
    if (signals.readOnly === true)
        matches.push('R0');
    if (signals.projectMinimum)
        matches.push(signals.projectMinimum);
    return highestRisk(matches);
}
