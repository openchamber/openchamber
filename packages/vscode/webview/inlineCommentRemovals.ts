const REMEMBERED_REMOVALS = 50;

export function createRemovalTombstones(limit: number = REMEMBERED_REMOVALS) {
    const ids = new Set<string>();

    return {
        remember(draftId: string): void {
            if (!draftId) return;
            ids.add(draftId);
            if (ids.size > limit) {
                const oldest = ids.values().next();
                if (!oldest.done) ids.delete(oldest.value);
            }
        },

        consume(draftId: string | undefined): boolean {
            if (!draftId || !ids.has(draftId)) return false;
            ids.delete(draftId);
            return true;
        },

        size(): number {
            return ids.size;
        },
    };
}
