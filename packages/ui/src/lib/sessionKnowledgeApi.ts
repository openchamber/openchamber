/**
 * Project knowledge for a session, as decided by the server.
 *
 * The client neither assembles project knowledge nor tracks what the session was told.
 * Before a send it asks the server to write the knowledge into the session's
 * OpenCode instruction entries; OpenCode tells the agent what changed and keeps
 * it through compaction, revert and fork.
 * VS Code writes the response-style entry through the SDK because it connects
 * directly to OpenCode and has no OpenChamber knowledge route.
 *
 * Nothing here throws. A message must go out even when its background cannot
 * be written: sending without it costs the agent some context, failing the
 * send costs the user their message.
 */

import { z } from 'zod';

import { runtimeFetch } from './runtime-fetch';
import { getRuntimeKey } from './runtime-switch';
import { isVSCodeRuntime } from './desktop';
import { opencodeClient } from './opencode/client';

interface SessionKnowledgeSyncBody {
  directory: string;
  sessionId: string;
  responseStyleInstruction?: string | null;
}

/**
 * Awaited before the prompt request, so the agent reads the knowledge with the
 * message. Goes to the server that owns the session, which for a session in an
 * isolated space is the one inside the space.
 */
export const syncSessionKnowledge = async (
  directory: string | null | undefined,
  sessionId: string | null | undefined,
  responseStyleInstruction?: string | null,
  expectedRuntimeKey = getRuntimeKey(),
): Promise<void> => {
  if (!directory || !sessionId) return;
  if (expectedRuntimeKey !== getRuntimeKey()) return;
  invalidateSummary(directory, sessionId);
  try {
    if (isVSCodeRuntime()) {
      if (responseStyleInstruction !== undefined) {
        await opencodeClient.setResponseStyleInstruction(directory, sessionId, responseStyleInstruction);
      }
      return;
    }
    const body: SessionKnowledgeSyncBody = { directory, sessionId };
    if (responseStyleInstruction !== undefined) body.responseStyleInstruction = responseStyleInstruction;
    await runtimeFetch('/api/session-knowledge/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      directory,
    });
  } catch {
    // Only means this message goes without its background.
  }
};

export interface SessionKnowledgeSummary {
  notes: Array<{ id: string; body: string }>;
  plans: Array<{ id: string; title: string }>;
  memory: { global: number; project: number };
}

const EMPTY_SUMMARY: SessionKnowledgeSummary = { notes: [], plans: [], memory: { global: 0, project: 0 } };

// Several panels ask for the same session's summary at the same moment when a
// session opens. One request serves all of them, and its answer stays good for
// a few seconds; local pin changes drop it immediately.
const SUMMARY_FRESH_MS = 5_000;
const summaryCache = new Map<string, { at: number; request: Promise<SessionKnowledgeSummary> }>();
const summaryCacheKey = (directory: string, sessionId: string | null | undefined): string => (
  `${directory}\u0000${sessionId ?? ''}`
);

const invalidateSummary = (directory: string, sessionId: string | null | undefined): void => {
  summaryCache.delete(summaryCacheKey(directory, sessionId));
};

/** What the session is carrying, for display. Never throws; shows nothing instead. */
export const fetchSessionKnowledgeSummary = (
  directory: string | null,
  sessionId?: string | null,
): Promise<SessionKnowledgeSummary> => {
  if (!directory) {
    return Promise.resolve(EMPTY_SUMMARY);
  }
  const key = summaryCacheKey(directory, sessionId);
  const cached = summaryCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < SUMMARY_FRESH_MS) {
    return cached.request;
  }
  const request = requestSessionKnowledgeSummary(directory, sessionId);
  summaryCache.set(key, { at: now, request });
  return request;
};

const requestSessionKnowledgeSummary = async (
  directory: string,
  sessionId?: string | null,
): Promise<SessionKnowledgeSummary> => {
  try {
    const params = new URLSearchParams({ directory });
    if (sessionId) params.set('sessionId', sessionId);
    const response = await runtimeFetch(
      `/api/session-knowledge/summary?${params.toString()}`,
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

export type SessionProjectContextPins = { notes: string[]; plans: string[] };

const sessionProjectContextPinsResponseSchema = z.object({
  pins: z.object({ notes: z.array(z.string()), plans: z.array(z.string()) }),
});

export const setSessionProjectContextPin = async (
  directory: string,
  sessionId: string,
  kind: 'note' | 'plan',
  id: string,
  pinned: boolean,
): Promise<SessionProjectContextPins | null> => {
  invalidateSummary(directory, sessionId);
  try {
    const response = await runtimeFetch('/api/session-knowledge/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory, sessionId, kind, id, pinned }),
      directory,
    });
    if (!response.ok) return null;
    return sessionProjectContextPinsResponseSchema.parse(await response.json()).pins;
  } catch {
    return null;
  }
};
