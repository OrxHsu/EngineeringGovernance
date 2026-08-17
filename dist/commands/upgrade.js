import { planAdoption } from './adopt.js';
export function planUpgrade(project, options = {}) {
    return planAdoption(project, { ...options, allowExpectedManagedDirty: true });
}
