import type { SessionInfo } from '@opencode/client';
import { asNonEmptyString } from '../shared/guards.js';
import type { ControlClient } from './opencode-client.js';

type SessionRecord = SessionInfo & { directory?: string };

interface ResolvedSessionRecord {
  directory: string | null;
  session: SessionRecord | null;
}

export const resolveSessionRecord = async (
  getClient: (directory?: string | null) => Promise<ControlClient>,
  sessionID: string,
): Promise<ResolvedSessionRecord> => {
  try {
    const client = await getClient();
    let detail: SessionRecord | null = null;
    try {
      detail = await client.session.get({ sessionID }).catch(() => null);
    } catch {
      detail = null;
    }
    const direct = asNonEmptyString(detail?.location?.directory) || asNonEmptyString(detail?.directory);
    if (direct) return { directory: direct, session: detail };

    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const response = await client.session.list(cursor ? { cursor } : {});
      const sessions = Array.isArray(response?.data) ? response.data : [];
      const session = sessions.find((item) => item?.id === sessionID);
      if (session) return { directory: asNonEmptyString(session?.location?.directory) || null, session };
      const next = asNonEmptyString(response?.cursor?.next);
      if (!next || seenCursors.has(next)) return { directory: null, session: detail };
      seenCursors.add(next);
      cursor = next;
    }
  } catch {
    return { directory: null, session: null };
  }
};

export const resolveSessionDirectory = async (
  getClient: (directory?: string | null) => Promise<ControlClient>,
  sessionID: string,
) => (await resolveSessionRecord(getClient, sessionID)).directory;
