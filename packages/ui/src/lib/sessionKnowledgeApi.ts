/**
 * Project knowledge a session still owes, as decided by the server.
 *
 * The client neither assembles this text nor tracks what it has sent. It used
 * to do both, which meant a session started without a UI got nothing, and a
 * conversation that was compacted kept a tab-local belief that the agent still
 * had context the summary had just removed.
 *
 * Nothing here throws. A message must go out even when its background cannot
 * be fetched: sending without the block costs the agent some context, failing
 * the send costs the user their message.
 */

import { runtimeFetch } from './runtime-fetch';

interface SessionKnowledge {
  /** Empty when the session already carries what it needs. */
  text: string;
  /** Reported back once the message carrying the text has actually gone out. */
  signature: string;
}

const EMPTY: SessionKnowledge = { text: '', signature: '' };

export const fetchSessionKnowledge = async (
  directory: string | null,
  sessionId: string | null,
): Promise<SessionKnowledge> => {
  if (!directory) {
    return EMPTY;
  }

  try {
    const params = new URLSearchParams({ directory });
    if (sessionId) {
      params.set('sessionId', sessionId);
    }
    const response = await runtimeFetch(`/api/session-knowledge?${params.toString()}`, {
      cache: 'no-store',
    });
    if (!response.ok) {
      return EMPTY;
    }
    const payload = await response.json() as Partial<SessionKnowledge> | null;
    return {
      text: typeof payload?.text === 'string' ? payload.text : '',
      signature: typeof payload?.signature === 'string' ? payload.signature : '',
    };
  } catch {
    return EMPTY;
  }
};

/**
 * Recorded after the send resolves, never before: a failed send must carry the
 * block again rather than assume the agent already saw it.
 */
export const reportSessionKnowledgeDelivered = async (
  directory: string | null,
  sessionId: string | null,
  signature: string,
): Promise<void> => {
  if (!directory || !sessionId || !signature) {
    return;
  }

  try {
    await runtimeFetch('/api/session-knowledge/delivered', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory, sessionId, signature }),
    });
  } catch {
    // Only means the block may be sent once more.
  }
};

export interface SessionKnowledgeSummary {
  notes: Array<{ id: string; body: string }>;
  plans: Array<{ id: string; title: string }>;
  memory: { global: number; project: number };
}

const EMPTY_SUMMARY: SessionKnowledgeSummary = { notes: [], plans: [], memory: { global: 0, project: 0 } };

/** What the session is carrying, for display. Never throws; shows nothing instead. */
export const fetchSessionKnowledgeSummary = async (
  directory: string | null,
): Promise<SessionKnowledgeSummary> => {
  if (!directory) {
    return EMPTY_SUMMARY;
  }

  try {
    const response = await runtimeFetch(
      `/api/session-knowledge/summary?${new URLSearchParams({ directory }).toString()}`,
      { cache: 'no-store' },
    );
    if (!response.ok) {
      return EMPTY_SUMMARY;
    }
    const payload = await response.json() as Partial<SessionKnowledgeSummary> | null;
    return {
      notes: Array.isArray(payload?.notes) ? payload.notes : [],
      plans: Array.isArray(payload?.plans) ? payload.plans : [],
      memory: {
        global: typeof payload?.memory?.global === 'number' ? payload.memory.global : 0,
        project: typeof payload?.memory?.project === 'number' ? payload.memory.project : 0,
      },
    };
  } catch {
    return EMPTY_SUMMARY;
  }
};
