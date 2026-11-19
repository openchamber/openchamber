const MAX_SUBAGENT_SESSIONS = 50;

interface OpenPushTag {
  sessionId?: string | undefined;
  nid?: string | null | undefined;
  skipTurnStart?: boolean | undefined;
}

interface SessionPushClearingDependencies {
  openPushTags: Map<string, OpenPushTag | null | undefined>;
  sessionClearedAt: Map<string, number>;
  sessionClearedAtLimit: number;
  keepNewest: (map: Map<string, number>, limit: number) => void;
  restoredOpenPushTags: Promise<void>;
  clearPushTags: (tags: string[]) => void;
  persistOpenPushTags: () => void;
  dropPendingShareAnswers: (sessionId: string, turnStart: boolean) => void;
  collectDescendantSessions: (ancestorId: string, candidateIds: string[]) => Promise<string[] | null>;
  locationScopedSessionIds?: readonly string[];
}

export const createSessionPushClearing = ({
  openPushTags,
  sessionClearedAt,
  sessionClearedAtLimit,
  keepNewest,
  restoredOpenPushTags,
  clearPushTags,
  persistOpenPushTags,
  dropPendingShareAnswers,
  collectDescendantSessions,
  locationScopedSessionIds = [],
}: SessionPushClearingDependencies) => {
  const openSessionIdsExcept = (sessionId: string): string[] => {
    const candidates: string[] = [];
    for (const open of [...openPushTags.values()].reverse()) {
      const candidate = open?.sessionId;
      if (!candidate || candidate === sessionId || locationScopedSessionIds.includes(candidate)) continue;
      if (!candidates.includes(candidate)) candidates.push(candidate);
      if (candidates.length >= MAX_SUBAGENT_SESSIONS) break;
    }
    return candidates;
  };

  const clearSession = async (sessionId: string, turnStart: boolean): Promise<void> => {
    sessionClearedAt.delete(sessionId);
    sessionClearedAt.set(sessionId, Date.now());
    keepNewest(sessionClearedAt, sessionClearedAtLimit);
    dropPendingShareAnswers(sessionId, turnStart);
    await restoredOpenPushTags;
    const tags: string[] = [];
    for (const [tag, open] of openPushTags) {
      if (open?.sessionId !== sessionId) continue;
      if (turnStart && open.skipTurnStart) {
        open.skipTurnStart = false;
        persistOpenPushTags();
        continue;
      }
      tags.push(tag);
    }
    clearPushTags(tags);
  };

  const clearSubagents = async (sessionId: string): Promise<string[]> => {
    await restoredOpenPushTags;
    const candidates = openSessionIdsExcept(sessionId);
    if (candidates.length === 0) return [];
    const nidsAtStart = new Map<string, string | null>();
    for (const [tag, open] of openPushTags) nidsAtStart.set(tag, open?.nid ?? null);

    const descendants = await collectDescendantSessions(sessionId, candidates);
    if (!descendants) return [];

    const clearedSessions: string[] = [];
    const tags: string[] = [];
    for (const descendant of descendants) {
      sessionClearedAt.delete(descendant);
      sessionClearedAt.set(descendant, Date.now());
      dropPendingShareAnswers(descendant, false);
      let cleared = false;
      for (const [tag, open] of openPushTags) {
        if (open?.sessionId !== descendant) continue;
        if (!nidsAtStart.has(tag) || nidsAtStart.get(tag) !== (open.nid ?? null)) continue;
        tags.push(tag);
        cleared = true;
      }
      if (cleared) clearedSessions.push(descendant);
    }
    keepNewest(sessionClearedAt, sessionClearedAtLimit);
    clearPushTags(tags);
    return clearedSessions;
  };

  return async (sessionId: string, { turnStart = false, withSubagents = false }: { turnStart?: boolean; withSubagents?: boolean } = {}): Promise<string[]> => {
    if (!sessionId) return [];
    await clearSession(sessionId, turnStart);
    if (!withSubagents) return [];
    return clearSubagents(sessionId);
  };
};
