/** Parse added/removed line counts from a unified diff string */
export const parsePatchStats = (patch: string): { added: number; removed: number } => {
    let added = 0;
    let removed = 0;
    for (const line of patch.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    return { added, removed };
};

/** Parse a numeric count from an unknown value */
export const parseCount = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
    if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) return Math.max(0, parsed);
    }
    return null;
};
