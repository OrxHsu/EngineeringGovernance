export function validateException(input, now) {
    const errors = [];
    if (input.ruleClass === 'non_waivable' || input.ruleClass === 'user_authorization_required') {
        errors.push('EXCEPTION_RULE_CLASS_FORBIDDEN');
    }
    if (input.approvedBy.trim().length === 0)
        errors.push('EXCEPTION_APPROVAL_MISSING');
    if (input.scope.length === 0)
        errors.push('EXCEPTION_SCOPE_MISSING');
    if (input.compensatingControls.length === 0) {
        errors.push('EXCEPTION_COMPENSATING_CONTROLS_MISSING');
    }
    if (input.status !== 'active')
        errors.push('EXCEPTION_INACTIVE');
    const issuedAt = Date.parse(input.issuedAt);
    const expiresAt = Date.parse(input.expiresAt);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt >= expiresAt) {
        errors.push('EXCEPTION_TIME_RANGE_INVALID');
    }
    else if (now.getTime() >= expiresAt) {
        errors.push('EXCEPTION_EXPIRED');
    }
    const uniqueErrors = [...new Set(errors)].sort();
    return { valid: uniqueErrors.length === 0, errors: uniqueErrors };
}
