// Titles for the chat tabs of the context panel, read across every live
// directory: a chat tab may show a session from another project, so the
// panel's own directory is not enough.

type TitledSession = {
  id: string;
  title?: string | null;
  time?: { updated?: number } | null;
};

type SessionSlice = {
  session: readonly TitledSession[];
};

export const EMPTY_SESSION_TITLE_MAP: ReadonlyMap<string, string> = new Map<string, string>();

export const areTitleMapsEqual = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean => {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
};

const getSessionUpdatedAt = (session: TitledSession): number => {
  const updatedAt = session.time?.updated;
  return typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : 0;
};

// A project's store also holds its worktrees' sessions, so one session can
// appear in more than one store; the most recently updated copy wins, like
// findLiveSession does for the session itself.
export const buildSessionTitleMap = (states: Iterable<SessionSlice>, sessionIDs: readonly string[]): ReadonlyMap<string, string> => {
  if (sessionIDs.length === 0) return EMPTY_SESSION_TITLE_MAP;
  const wanted = new Set(sessionIDs);
  const updatedAtById = new Map<string, number>();
  const next = new Map<string, string>();
  for (const state of states) {
    for (const session of state.session) {
      if (!wanted.has(session.id)) continue;
      const title = session.title?.trim();
      if (!title) continue;
      const updatedAt = getSessionUpdatedAt(session);
      const seenAt = updatedAtById.get(session.id);
      if (seenAt !== undefined && seenAt > updatedAt) continue;
      updatedAtById.set(session.id, updatedAt);
      next.set(session.id, title);
    }
  }
  return next.size === 0 ? EMPTY_SESSION_TITLE_MAP : next;
};
