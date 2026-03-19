interface SessionLinkRecord {
    id: string;
    parentID?: string;
}

export const collectVisibleSessionIdsForBlockingRequests = (
    sessions: SessionLinkRecord[] | undefined,
    currentSessionId: string | null,
): string[] => {
    if (!currentSessionId) return [];
    if (!Array.isArray(sessions) || sessions.length === 0) return [currentSessionId];

    const current = sessions.find((session) => session.id === currentSessionId);
    if (!current) return [currentSessionId];

    // Opencode parity: when viewing a child session, permission/question prompts are handled in parent thread.
    if (current.parentID) {
        return [];
    }

    const childrenByParent = new Map<string, string[]>();
    for (const session of sessions) {
        if (!session.parentID) {
            continue;
        }
        const existing = childrenByParent.get(session.parentID) ?? [];
        existing.push(session.id);
        childrenByParent.set(session.parentID, existing);
    }

    const scoped = [currentSessionId];
    const seen = new Set(scoped);
    for (const sessionId of scoped) {
        const children = childrenByParent.get(sessionId) ?? [];
        for (const childId of children) {
            if (seen.has(childId)) {
                continue;
            }
            seen.add(childId);
            scoped.push(childId);
        }
    }

    return scoped;
};

export const flattenBlockingRequests = <T extends { id: string }>(
    source: Map<string, T[]>,
    sessionIds: string[],
): T[] => {
    if (sessionIds.length === 0) return [];
    const seen = new Set<string>();
    const result: T[] = [];

    for (const sessionId of sessionIds) {
        const entries = source.get(sessionId);
        if (!entries || entries.length === 0) continue;
        for (const entry of entries) {
            if (seen.has(entry.id)) continue;
            seen.add(entry.id);
            result.push(entry);
        }
    }

    return result;
};
