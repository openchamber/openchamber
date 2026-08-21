import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { useAllSessionStatuses, useAllLiveSessions } from '@/sync/sync-context';
import { mergeSessionDirectoryMetadata, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionActivity } from '@/hooks/useSessionActivity';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';

export type SubagentSession = Session & {
  depth: number;
  phase: 'busy' | 'retry' | 'idle';
  elapsedMs: number | null;
};

const normalize = (value: string | null | undefined): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

const pathBelongsToRoot = (path: string, root: string): boolean => {
  const p = normalize(path);
  const r = normalize(root);
  return Boolean(p && r && (p === r || p.startsWith(`${r}/`)));
};

const findSessionRoot = (session: Session, roots: string[]): string | null => {
  const directory = normalize(resolveGlobalSessionDirectory(session));
  if (!directory) return null;
  for (const root of roots) {
    if (pathBelongsToRoot(directory, root)) return root;
  }
  return null;
};

const calculateDepth = (
  session: Session,
  sessionById: Map<string, Session>,
  cache: Map<string, number>,
  visiting = new Set<string>()
): number => {
  const id = session.id;
  if (cache.has(id)) return cache.get(id)!;
  if (visiting.has(id)) return 1;
  visiting.add(id);

  const parentID = (session as { parentID?: string }).parentID;
  if (!parentID) {
    cache.set(id, 0);
    return 0;
  }
  const parent = sessionById.get(parentID);
  if (!parent) {
    cache.set(id, 1);
    return 1;
  }
  const depth = 1 + calculateDepth(parent, sessionById, cache, visiting);
  cache.set(id, depth);
  return depth;
};

export const useSubagentSessions = (directory: string): SubagentSession[] => {
  const liveSessions = useAllLiveSessions();
  const globalActiveSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const allStatuses = useAllSessionStatuses();

  const sessions = React.useMemo(() => {
    const liveById = new Map(liveSessions.map((session) => [session.id, session]));
    const merged = globalActiveSessions.map((session) => {
      const liveSession = liveById.get(session.id);
      return liveSession ? mergeSessionDirectoryMetadata(liveSession, session) : session;
    });
    const seen = new Set(merged.map((session) => session.id));
    for (const session of liveSessions) {
      if (!seen.has(session.id)) merged.push(session);
    }
    return merged;
  }, [globalActiveSessions, liveSessions]);

  const roots = React.useMemo(() => [normalize(directory)].filter(Boolean), [directory]);

  return React.useMemo(() => {
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    const depthCache = new Map<string, number>();

    const result: SubagentSession[] = [];
    for (const session of sessions) {
      const parentID = (session as { parentID?: string }).parentID;
      if (!parentID) continue;

      const root = findSessionRoot(session, roots);
      if (!root) continue;

      const phase = allStatuses?.[session.id]?.type === 'busy'
        ? 'busy'
        : allStatuses?.[session.id]?.type === 'retry'
          ? 'retry'
          : 'idle';

      const updatedAt = (session as unknown as { time?: { updated?: number } }).time?.updated ?? 0;
      const createdAt = (session as unknown as { time?: { created?: number } }).time?.created ?? 0;
      const startTime = updatedAt || createdAt;
      const elapsedMs = startTime ? Date.now() - startTime : null;

      result.push({
        ...session,
        depth: calculateDepth(session, sessionById, depthCache),
        phase,
        elapsedMs,
      });
    }

    result.sort((a, b) => {
      if (a.phase !== 'idle' && b.phase === 'idle') return -1;
      if (a.phase === 'idle' && b.phase !== 'idle') return 1;
      const bTime = (b as unknown as { time?: { updated?: number } }).time?.updated ?? 0;
      const aTime = (a as unknown as { time?: { updated?: number } }).time?.updated ?? 0;
      return bTime - aTime;
    });

    return result;
  }, [sessions, roots, allStatuses]);
};

export const useSubagentSessionActivity = (sessionId: string, directory: string) => {
  return useSessionActivity(sessionId, directory);
};
