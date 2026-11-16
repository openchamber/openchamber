export const asNonEmptyString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');
export const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
