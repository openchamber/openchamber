import type { Session } from '@/lib/opencode/model';
import { getBtwOriginalSessionID } from '@/lib/sessionBtwMetadata';

/**
 * A session and the ones above it: the session a subagent or a `/btw` side chat
 * works under, and so on up. It stops at a session it cannot read. `/btw` links
 * are session metadata anyone can write, so a link that loops ends the walk.
 */
export const sessionLineage = async (
  sessionId: string,
  readSession: (sessionId: string) => Promise<Session | null | undefined>,
): Promise<Session[]> => {
  const lineage: Session[] = [];
  const visited = new Set<string>();
  let current: string | null | undefined = sessionId;
  while (current && !visited.has(current)) {
    visited.add(current);
    const session: Session | null | undefined = await readSession(current);
    if (!session) break;
    lineage.push(session);
    current = session.parentID ?? getBtwOriginalSessionID(session);
  }
  return lineage;
};

export const fileNameOf = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
