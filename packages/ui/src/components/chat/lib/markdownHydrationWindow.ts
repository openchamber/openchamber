export type MarkdownHydrationScrollDirection = 'backward' | 'forward' | null;

type MarkdownHydrationCandidatesInput = {
    entryKeys: readonly string[];
    mountedIndexes: readonly number[];
    visibleStartIndex: number;
    visibleEndIndex: number;
    scrollDirection: MarkdownHydrationScrollDirection;
    preloadEntries: number;
    hydratedKeys: ReadonlySet<string>;
};

export const createInitialMarkdownHydratedKeys = (entryKeys: readonly string[]): Set<string> => {
    const newestKey = entryKeys[entryKeys.length - 1];
    return newestKey ? new Set([newestKey]) : new Set();
};

/**
 * Live streaming already paints rich Markdown in the tail. When that turn
 * remounts into virtualized history it must stay hydrated immediately — otherwise
 * the deferred skeleton replaces finished content for a frame.
 */
export const ensureNewestMarkdownKeyHydrated = (
    hydratedKeys: Set<string>,
    entryKeys: readonly string[],
): Set<string> => {
    const newestKey = entryKeys[entryKeys.length - 1];
    if (!newestKey || hydratedKeys.has(newestKey)) {
        return hydratedKeys;
    }
    const next = new Set(hydratedKeys);
    next.add(newestKey);
    return next;
};

export const getMarkdownHydrationCandidates = ({
    entryKeys,
    mountedIndexes,
    visibleStartIndex,
    visibleEndIndex,
    scrollDirection,
    preloadEntries,
    hydratedKeys,
}: MarkdownHydrationCandidatesInput): string[] => {
    if (entryKeys.length === 0 || mountedIndexes.length === 0) {
        return [];
    }

    const mounted = new Set(mountedIndexes);
    const candidates: string[] = [];
    const queued = new Set<string>();
    const addIndex = (index: number) => {
        if (index < 0 || index >= entryKeys.length || !mounted.has(index)) {
            return;
        }
        const key = entryKeys[index];
        if (!key || hydratedKeys.has(key) || queued.has(key)) {
            return;
        }
        queued.add(key);
        candidates.push(key);
    };

    const lastIndex = entryKeys.length - 1;
    const start = Math.min(lastIndex, Math.max(0, Math.floor(visibleStartIndex)));
    const end = Math.min(lastIndex, Math.max(start, Math.floor(visibleEndIndex)));

    // The newest visible turn wins. Do not reverse DOM order; only reverse the
    // order in which rows are allowed to mount rich Markdown.
    for (let index = end; index >= start; index -= 1) {
        addIndex(index);
    }

    if (scrollDirection === 'backward') {
        const preloadCount = Math.max(0, Math.floor(preloadEntries));
        const preloadStart = Math.max(0, start - preloadCount);
        for (let index = start - 1; index >= preloadStart; index -= 1) {
            addIndex(index);
        }
    }

    return candidates;
};

export const pruneMarkdownHydratedKeys = (
    hydratedKeys: Set<string>,
    entryKeys: readonly string[],
): Set<string> => {
    const validKeys = new Set(entryKeys);
    let changed = false;
    const next = new Set<string>();
    for (const key of hydratedKeys) {
        if (validKeys.has(key)) {
            next.add(key);
        } else {
            changed = true;
        }
    }
    return changed ? next : hydratedKeys;
};
