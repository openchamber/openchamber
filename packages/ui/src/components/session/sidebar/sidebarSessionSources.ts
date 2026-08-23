import type { Session } from '@opencode-ai/sdk/v2';

export function mergeSidebarSessionSources(
  globalSessions: readonly Session[],
  liveSessions: readonly Session[],
): Session[] {
  const merged = [...globalSessions];
  const seenIds = new Set(merged.map((session) => session.id));
  const appendMissing = (sessions: readonly Session[]) => {
    sessions.forEach((session) => {
      if (seenIds.has(session.id)) return;
      seenIds.add(session.id);
      merged.push(session);
    });
  };

  appendMissing(liveSessions);
  return merged;
}
