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

    const childIds = sessions
        .filter((session) => session.parentID === currentSessionId)
        .map((session) => session.id);

    return [currentSessionId, ...childIds];
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
