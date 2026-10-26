/**
 * OpenChamber-owned session routes: archive, unarchive, metadata, links.
 *
 * Archiving the sessions linked to a worktree one request at a time is what
 * made removing a worktree with many sessions take tens of seconds: every
 * session cost its own round trip and its own store reconciliation. This asks
 * the OpenChamber server to archive the whole batch next to OpenCode, so the
 * browser spends one request and reconciles once.
 *
 * The server sets archive state on OpenCode's record and keeps it in its own
 * archive file for sessions OpenCode cannot change (their directory is gone);
 * metadata is merge-patched onto OpenCode's record. The batch, the fallback and
 * the merge are OpenChamber's, so these are OpenChamber routes. Runtimes that do
 * not serve them answer with a stable unsupported status, and callers fall back
 * to a per-session path or report failure.
 */

import type { JsonValue, Metadata } from "@/lib/opencode/model"
import { z } from 'zod';

import { toStoredLinkedIssue, type LinkedIssue } from '@/lib/linkedIssues';
import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * The route answers with the archive stamps it stored, `{ id, archivedAt }`,
 * not session records: the caller applies each stamp to the session it
 * already holds.
 */
const archiveResponseSchema = z.object({
  archived: z.array(z.object({ id: z.string().min(1), archivedAt: z.number() })),
  failedIds: z.array(z.string().min(1)),
});

export type SessionArchiveStamp = { id: string; archivedAt: number };

export type SessionArchiveBatchResult =
  | { outcome: 'archived'; archived: SessionArchiveStamp[]; failedIds: string[] }
  | { outcome: 'unavailable'; reason: string };

export async function requestSessionArchiveBatch(
  directory: string,
  ids: string[],
  archivedAt: number,
): Promise<SessionArchiveBatchResult> {
  let response: Response;
  try {
    response = await runtimeFetch('/api/openchamber/sessions/archive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory, ids, archivedAt }),
      directory,
    });
  } catch (error) {
    return { outcome: 'unavailable', reason: error instanceof Error ? error.message : 'archive request failed' };
  }

  if (!response.ok) {
    return { outcome: 'unavailable', reason: `archive request failed with ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { outcome: 'unavailable', reason: error instanceof Error ? error.message : 'archive response was not JSON' };
  }

  const parsed = archiveResponseSchema.safeParse(body);
  if (!parsed.success) {
    // A body this layer cannot read is reported as unavailable rather than as
    // an empty success, so a caller never mistakes "the response made no
    // sense" for "nothing needed archiving" and drops the sessions.
    return { outcome: 'unavailable', reason: `malformed archive response: ${parsed.error.issues[0]?.message ?? 'unknown shape'}` };
  }

  return {
    outcome: 'archived',
    archived: parsed.data.archived,
    failedIds: parsed.data.failedIds,
  };
}

const unarchiveResponseSchema = z.object({
  restored: z.array(z.object({ id: z.string().min(1), archivedAt: z.null() })),
  failedIds: z.array(z.string().min(1)),
});

export type SessionUnarchiveBatchResult =
  | { outcome: 'restored'; restored: string[]; failedIds: string[] }
  | { outcome: 'unavailable'; reason: string };

/** Clears `time.archived` for a batch of sessions. Mirrors the archive route. */
export async function requestSessionUnarchiveBatch(ids: string[], directory?: string | null): Promise<SessionUnarchiveBatchResult> {
  let response: Response;
  try {
    response = await runtimeFetch('/api/openchamber/sessions/unarchive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
      directory,
    });
  } catch (error) {
    return { outcome: 'unavailable', reason: error instanceof Error ? error.message : 'unarchive request failed' };
  }

  if (!response.ok) {
    return { outcome: 'unavailable', reason: `unarchive request failed with ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { outcome: 'unavailable', reason: error instanceof Error ? error.message : 'unarchive response was not JSON' };
  }

  const parsed = unarchiveResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { outcome: 'unavailable', reason: `malformed unarchive response: ${parsed.error.issues[0]?.message ?? 'unknown shape'}` };
  }

  return {
    outcome: 'restored',
    restored: parsed.data.restored.map((entry) => entry.id),
    failedIds: parsed.data.failedIds,
  };
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);

const metadataResponseSchema = z.object({
  metadata: z.record(z.string(), jsonValueSchema),
});

/**
 * The session's folder no longer exists, so OpenCode refuses the write.
 * Mirrors `SESSION_DIRECTORY_MISSING_CODE` in
 * packages/web/server/lib/openchamber-sessions/routes.js and the VS Code bridge.
 */
const SESSION_DIRECTORY_MISSING_CODE = 'SESSION_DIRECTORY_MISSING';

const directoryMissingResponseSchema = z.object({
  code: z.literal(SESSION_DIRECTORY_MISSING_CODE),
});

export type SessionMetadataUpdateResult =
  | { outcome: 'updated'; metadata: Metadata }
  | { outcome: 'directory-missing'; reason: string }
  | { outcome: 'unavailable'; reason: string };

/**
 * Applies a JSON Merge Patch (RFC 7386) to a session's metadata: nested
 * objects merge key by key and `null` deletes. OpenCode only accepts metadata
 * at creation time, so the merged record lives with the OpenChamber server,
 * which folds it into every session record it serves. Resolves with the
 * session's full metadata after the patch.
 */
export async function requestSessionMetadataUpdate(
  sessionID: string,
  patch: Metadata,
  directory?: string | null,
): Promise<SessionMetadataUpdateResult> {
  let response: Response;
  try {
    response = await runtimeFetch(`/api/openchamber/sessions/${encodeURIComponent(sessionID)}/metadata`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch }),
      directory,
    });
  } catch (error) {
    return { outcome: 'unavailable', reason: error instanceof Error ? error.message : 'metadata request failed' };
  }

  if (!response.ok) {
    const reason = `metadata request failed with ${response.status}`;
    const errorBody: unknown = await response.json().catch(() => null);
    return directoryMissingResponseSchema.safeParse(errorBody).success
      ? { outcome: 'directory-missing', reason }
      : { outcome: 'unavailable', reason };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { outcome: 'unavailable', reason: error instanceof Error ? error.message : 'metadata response was not JSON' };
  }

  const parsed = metadataResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { outcome: 'unavailable', reason: `malformed metadata response: ${parsed.error.issues[0]?.message ?? 'unknown shape'}` };
  }

  return { outcome: 'updated', metadata: parsed.data.metadata };
}

export type SessionLinksUpdateResult =
  | { outcome: 'updated'; metadata: Metadata }
  | { outcome: 'unavailable'; reason: string };

/**
 * Links or unlinks items on a session through OpenChamber's own route. The
 * server decides the new `linked_issues` list from its own fresh read inside
 * the session's write queue, so this sends only the operation — never a whole
 * list that a stale client snapshot could overwrite concurrent links with.
 * Resolves with the session's full metadata after the operation.
 */
export async function requestSessionLinksUpdate(
  sessionID: string,
  entries: readonly LinkedIssue[],
  linked: boolean,
  directory?: string | null,
): Promise<SessionLinksUpdateResult> {
  let response: Response;
  try {
    response = await runtimeFetch(`/api/openchamber/sessions/${encodeURIComponent(sessionID)}/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: entries.map(toStoredLinkedIssue), linked }),
      directory,
    });
  } catch (error) {
    return { outcome: 'unavailable', reason: error instanceof Error ? error.message : 'links request failed' };
  }

  if (!response.ok) {
    return { outcome: 'unavailable', reason: `links request failed with ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { outcome: 'unavailable', reason: error instanceof Error ? error.message : 'links response was not JSON' };
  }

  const parsed = metadataResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { outcome: 'unavailable', reason: `malformed links response: ${parsed.error.issues[0]?.message ?? 'unknown shape'}` };
  }

  return { outcome: 'updated', metadata: parsed.data.metadata };
}
