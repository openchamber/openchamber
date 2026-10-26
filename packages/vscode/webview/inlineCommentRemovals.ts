/**
 * Comments the user dropped before their draft reached this webview's store.
 *
 * Delivery is asynchronous on both sides: the extension holds a payload for a
 * panel that has not booted, and the handler that files the draft can wait
 * seconds for a directory to resolve. A removal can arrive anywhere in that
 * window, when there is no draft yet to remove. Recording it here lets the
 * delayed delivery recognise a comment that is no longer wanted, instead of
 * filing it as a chip the user already dropped and sending it with the next
 * message.
 *
 * Bounded because it is a tombstone list, not state: ids are unique per comment,
 * so entries are never revisited once their delivery window has passed.
 */

const REMEMBERED_REMOVALS = 50;

export function createRemovalTombstones(limit: number = REMEMBERED_REMOVALS) {
    const ids = new Set<string>();

    return {
        /** Records a removal, evicting the oldest once the bound is reached. */
        remember(draftId: string): void {
            if (!draftId) return;
            ids.add(draftId);
            if (ids.size > limit) {
                const oldest = ids.values().next();
                if (!oldest.done) ids.delete(oldest.value);
            }
        },

        /**
         * Whether this delivery should be dropped.
         *
         * Consumes the record: the window closes once the delayed delivery has
         * been refused, and a later comment reusing the id would be unrelated.
         */
        consume(draftId: string | undefined): boolean {
            if (!draftId || !ids.has(draftId)) return false;
            ids.delete(draftId);
            return true;
        },

        /** Number of removals currently remembered. Exposed for tests. */
        size(): number {
            return ids.size;
        },
    };
}
