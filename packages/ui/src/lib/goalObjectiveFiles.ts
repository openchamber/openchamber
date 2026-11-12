import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

const ObjectiveResponseSchema = z.object({ content: z.string() });

// File-backed goal objectives: the text lives in a server-side file keyed by
// the session id (one goal per session; a new goal overwrites the old file).
// The metadata only carries an `objectiveFile: true` flag so it stays light
// for session.updated fanout.

const objectiveUrl = (sessionId: string): string =>
  `/api/goals/objective/${encodeURIComponent(sessionId)}`;

/** Write the session's objective file; false when the write did not land. */
export async function writeGoalObjectiveFile(sessionId: string, content: string): Promise<boolean> {
  try {
    const response = await runtimeFetch(objectiveUrl(sessionId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Best-effort delete; a failure leaves an orphaned file the next goal overwrites. */
export function deleteGoalObjectiveFile(sessionId: string): void {
  void runtimeFetch(objectiveUrl(sessionId), { method: 'DELETE' }).catch(() => undefined);
}

/** Fetch the file-backed objective text; null when unavailable. */
export async function fetchGoalObjectiveContent(sessionId: string): Promise<string | null> {
  try {
    const response = await runtimeFetch(objectiveUrl(sessionId));
    if (!response.ok) return null;
    const parsed = ObjectiveResponseSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data.content : null;
  } catch {
    return null;
  }
}
