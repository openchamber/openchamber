import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

const ObjectiveResponseSchema = z.object({ content: z.string() });
// `length` arrived in 2026-10; an older server answers `{ ok: true }` alone.
// `versionId` (the recorded history version, null when unchanged) arrived with
// #1830; an older server omits it.
const WriteResponseSchema = z.object({
  length: z.number().int().nonnegative().optional(),
  versionId: z.string().nullable().optional(),
}).catch({});
// What an OpenChamber server from before the goal length setting keeps of an objective.
const LEGACY_SERVER_OBJECTIVE_LIMIT = 5_000;

// File-backed goal objectives: the text lives in a server-side file keyed by
// the session id (one goal per session; a new goal overwrites the old file).
// The metadata only carries an `objectiveFile: true` flag so it stays light
// for session.updated fanout.

const objectiveUrl = (sessionId: string): string =>
  `/api/goals/objective/${encodeURIComponent(sessionId)}`;

export type GoalObjectiveFileWrite =
  | { saved: false }
  /** `truncated`: the server kept less than was sent, so the goal lost its end. */
  | { saved: true; truncated: boolean; versionId: string | null };

/**
 * Write the session's objective file. `record: false` restores the file
 * without recording a history version — an internal rollback, not a save.
 */
export async function writeGoalObjectiveFile(
  sessionId: string,
  content: string,
  { record = true }: { record?: boolean } = {},
): Promise<GoalObjectiveFileWrite> {
  try {
    const response = await runtimeFetch(objectiveUrl(sessionId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record ? { content } : { content, record: false }),
    });
    if (!response.ok) return { saved: false };
    const { length, versionId } = WriteResponseSchema.parse(await response.json().catch(() => ({})));
    const kept = length ?? Math.min(content.trim().length, LEGACY_SERVER_OBJECTIVE_LIMIT);
    return { saved: true, truncated: kept < content.trim().length, versionId: versionId ?? null };
  } catch {
    return { saved: false };
  }
}

/** Drop one recorded version; a rolled-back save must not read as history. */
export async function deleteGoalObjectiveVersion(sessionId: string, versionId: string): Promise<void> {
  await runtimeFetch(`${versionsUrl(sessionId)}/${encodeURIComponent(versionId)}`, { method: 'DELETE' })
    .catch(() => undefined);
}

/** Best-effort delete; a failure leaves an orphaned file the next goal overwrites. */
export function deleteGoalObjectiveFile(sessionId: string): void {
  void runtimeFetch(objectiveUrl(sessionId), { method: 'DELETE' }).catch(() => undefined);
}

/**
 * The objective file read as a snapshot: `content` when a file was read,
 * `missing` only when the server answered 404 (its confirmed-absence
 * answer), and `unavailable` for every other failure — a transient error is
 * not evidence that no file exists, and a caller that needs to restore or
 * delete the file must be able to tell the two apart.
 */
export type GoalObjectiveSnapshot =
  | { kind: 'content'; content: string }
  | { kind: 'missing' }
  | { kind: 'unavailable' };

export async function fetchGoalObjectiveSnapshot(sessionId: string): Promise<GoalObjectiveSnapshot> {
  try {
    const response = await runtimeFetch(objectiveUrl(sessionId));
    if (response.status === 404) return { kind: 'missing' };
    if (!response.ok) return { kind: 'unavailable' };
    const parsed = ObjectiveResponseSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? { kind: 'content', content: parsed.data.content } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** Fetch the file-backed objective text; null when unavailable. */
export async function fetchGoalObjectiveContent(sessionId: string): Promise<string | null> {
  const snapshot = await fetchGoalObjectiveSnapshot(sessionId);
  return snapshot.kind === 'content' ? snapshot.content : null;
}

// --- Objective version history (#1830) ------------------------------------
// The server records a version on every save that changes the text, capped at
// 20 with the oldest pruned. Listing carries no text; one version's text is
// fetched on demand. A restore is an ordinary save of the older text, so it
// appends the restored text as a new version instead of rewriting the past.

const VersionListSchema = z.object({
  versions: z.array(z.object({ id: z.string(), savedAt: z.number() })),
});
const VersionContentSchema = z.object({ id: z.string(), savedAt: z.number(), content: z.string() });

export type GoalObjectiveVersion = z.infer<typeof VersionListSchema>['versions'][number];

const versionsUrl = (sessionId: string): string =>
  `/api/goals/objective/${encodeURIComponent(sessionId)}/versions`;

/**
 * The retained versions, newest first. An empty list is a confirmed answer;
 * null means the list could not be read (an older server without the route,
 * or a transient failure), which a caller must not show as "no history".
 */
export async function fetchGoalObjectiveVersions(sessionId: string): Promise<GoalObjectiveVersion[] | null> {
  try {
    const response = await runtimeFetch(versionsUrl(sessionId));
    if (!response.ok) return null;
    const parsed = VersionListSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data.versions : null;
  } catch {
    return null;
  }
}

/** One version's text, or null when it is gone or unreadable. */
export async function fetchGoalObjectiveVersionContent(sessionId: string, versionId: string): Promise<string | null> {
  try {
    const response = await runtimeFetch(`${versionsUrl(sessionId)}/${encodeURIComponent(versionId)}`);
    if (!response.ok) return null;
    const parsed = VersionContentSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data.content : null;
  } catch {
    return null;
  }
}
