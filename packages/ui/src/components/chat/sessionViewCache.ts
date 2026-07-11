export type SessionViewSelection = {
    runtimeKey: string;
    sessionId: string;
    directory: string | null;
};

export type SessionViewCacheEntry = SessionViewSelection & {
    key: string;
    estimatedBytes: number;
};

export type SessionViewCacheLimits = {
    maxEntries: number;
    maxEstimatedBytes: number;
};

export type SessionViewRenderIntent = Readonly<{
    key: string | null;
    selection: SessionViewSelection | null;
}>;

export type SessionViewMaterialization = Readonly<{
    entry: SessionViewCacheEntry;
    intent: SessionViewRenderIntent;
}>;

export type SessionViewRenderState = {
    activeIntent: SessionViewRenderIntent;
    cacheNeedsTrim: boolean;
    cachedSessionViews: SessionViewCacheEntry[];
    pendingSessionView: SessionViewMaterialization | null;
};

const normalizeEstimatedBytes = (estimatedBytes: number): number => {
    if (!Number.isFinite(estimatedBytes) || estimatedBytes < 0) {
        return 0;
    }
    return Math.ceil(estimatedBytes);
};

const createSessionViewCacheEntry = (
    selection: SessionViewSelection,
    estimatedBytes: number,
): SessionViewCacheEntry => ({
    ...selection,
    key: createSessionViewKey(selection),
    estimatedBytes: normalizeEstimatedBytes(estimatedBytes),
});

export const createSessionViewKey = ({ runtimeKey, sessionId, directory }: SessionViewSelection): string => {
    return JSON.stringify([runtimeKey, directory ?? '', sessionId]);
};

export const createSessionViewRenderIntent = (
    selection: SessionViewSelection | null,
): SessionViewRenderIntent => ({
    key: selection ? createSessionViewKey(selection) : null,
    selection,
});

const enforceSessionViewCacheLimits = (
    entries: SessionViewCacheEntry[],
    activeKey: string,
    limits: SessionViewCacheLimits,
): SessionViewCacheEntry[] => {
    const maxEntries = Math.max(1, Math.floor(limits.maxEntries));
    const maxEstimatedBytes = Math.max(0, limits.maxEstimatedBytes);
    let totalEstimatedBytes = entries.reduce((total, entry) => total + entry.estimatedBytes, 0);
    if (entries.length <= maxEntries && totalEstimatedBytes <= maxEstimatedBytes) {
        return entries;
    }

    const next = [...entries];

    while (next.length > maxEntries || totalEstimatedBytes > maxEstimatedBytes) {
        const evictionIndex = next.findIndex((entry) => entry.key !== activeKey);
        if (evictionIndex === -1) {
            break;
        }

        const [evicted] = next.splice(evictionIndex, 1);
        totalEstimatedBytes -= evicted?.estimatedBytes ?? 0;
    }

    return next;
};

export const reconcileSessionViewCache = (
    entries: SessionViewCacheEntry[],
    selection: SessionViewSelection,
    limits: SessionViewCacheLimits,
    estimatedBytes: number,
): SessionViewCacheEntry[] => {
    const key = createSessionViewKey(selection);
    const existingIndex = entries.findIndex((entry) => entry.key === key);
    const existing = existingIndex >= 0 ? entries[existingIndex] : undefined;
    if (existing && existingIndex === entries.length - 1) {
        return enforceSessionViewCacheLimits(entries, key, limits);
    }
    const touchedEntry = existing
        ? existing
        : createSessionViewCacheEntry(selection, estimatedBytes);
    const next = existingIndex >= 0
        ? entries.filter((_, index) => index !== existingIndex)
        : [...entries];
    next.push(touchedEntry);

    return enforceSessionViewCacheLimits(next, key, limits);
};

export const updateSessionViewEstimate = (
    entries: SessionViewCacheEntry[],
    key: string,
    estimatedBytes: number,
    activeKey: string,
    limits: SessionViewCacheLimits,
): SessionViewCacheEntry[] => {
    const normalizedBytes = normalizeEstimatedBytes(estimatedBytes);
    const entryIndex = entries.findIndex((entry) => entry.key === key);
    if (entryIndex === -1) {
        return entries;
    }

    const current = entries[entryIndex];
    const next = current.estimatedBytes === normalizedBytes
        ? entries
        : entries.map((entry, index) => index === entryIndex
            ? { ...entry, estimatedBytes: normalizedBytes }
            : entry);

    return enforceSessionViewCacheLimits(next, activeKey, limits);
};

export const recordSessionViewEstimate = (
    entries: SessionViewCacheEntry[],
    key: string,
    estimatedBytes: number,
): SessionViewCacheEntry[] => {
    const normalizedBytes = normalizeEstimatedBytes(estimatedBytes);
    const entryIndex = entries.findIndex((entry) => entry.key === key);
    if (entryIndex === -1 || entries[entryIndex].estimatedBytes === normalizedBytes) {
        return entries;
    }
    return entries.map((entry, index) => index === entryIndex
        ? { ...entry, estimatedBytes: normalizedBytes }
        : entry);
};

export const resolveActiveSessionViewKey = (
    entries: SessionViewCacheEntry[],
    selectionKey: string | null,
): string | null => {
    if (!selectionKey) {
        return null;
    }
    return entries.some((entry) => entry.key === selectionKey) ? selectionKey : null;
};

export const applySessionViewSelectionIntent = (
    current: SessionViewRenderState,
    nextIntent: SessionViewRenderIntent,
    limits: SessionViewCacheLimits,
): SessionViewRenderState => {
    const cachedEntry = nextIntent.key
        ? current.cachedSessionViews.find((entry) => entry.key === nextIntent.key)
        : undefined;
    const cachedSessionViews = cachedEntry && nextIntent.selection
        ? reconcileSessionViewCache(
            current.cachedSessionViews,
            nextIntent.selection,
            limits,
            cachedEntry.estimatedBytes,
        )
        : enforceSessionViewCacheLimits(
            current.cachedSessionViews,
            nextIntent.key ?? '',
            limits,
        );
    const pendingSessionView = !cachedEntry
        && current.pendingSessionView?.intent === nextIntent
        ? current.pendingSessionView
        : null;

    if (
        current.activeIntent === nextIntent
        && !current.cacheNeedsTrim
        && cachedSessionViews === current.cachedSessionViews
        && pendingSessionView === current.pendingSessionView
    ) {
        return current;
    }

    return {
        activeIntent: nextIntent,
        cacheNeedsTrim: false,
        cachedSessionViews,
        pendingSessionView,
    };
};

export const materializeSessionViewRenderIntent = (
    current: SessionViewRenderState,
    scheduledIntent: SessionViewRenderIntent,
    latestIntent: SessionViewRenderIntent,
    estimatedBytes: number,
): SessionViewRenderState => {
    // Object identity is intentional: A -> B -> A creates a fresh second-A
    // intent even though its cache key matches the first A. `current` can be a
    // historical base state while React rebases lanes, so the independently
    // committed latest intent must agree before scheduled work can publish.
    if (
        latestIntent !== scheduledIntent
        || current.activeIntent !== scheduledIntent
        || !scheduledIntent.selection
    ) {
        return current;
    }

    if (current.cachedSessionViews.some((entry) => entry.key === scheduledIntent.key)) {
        return current;
    }

    const pendingSessionView: SessionViewMaterialization = {
        entry: createSessionViewCacheEntry(scheduledIntent.selection, estimatedBytes),
        intent: scheduledIntent,
    };
    if (current.pendingSessionView?.intent === scheduledIntent) {
        return current;
    }

    return {
        activeIntent: current.activeIntent,
        cacheNeedsTrim: current.cacheNeedsTrim,
        cachedSessionViews: current.cachedSessionViews,
        pendingSessionView,
    };
};

export const commitMaterializedSessionView = (
    current: SessionViewRenderState,
    committedIntent: SessionViewRenderIntent,
    limits: SessionViewCacheLimits,
): SessionViewRenderState => {
    const pending = current.pendingSessionView;
    if (
        current.activeIntent !== committedIntent
        || pending?.intent !== committedIntent
        || !committedIntent.selection
    ) {
        return current;
    }

    return {
        activeIntent: current.activeIntent,
        cacheNeedsTrim: false,
        cachedSessionViews: reconcileSessionViewCache(
            current.cachedSessionViews,
            committedIntent.selection,
            limits,
            pending.entry.estimatedBytes,
        ),
        pendingSessionView: null,
    };
};
