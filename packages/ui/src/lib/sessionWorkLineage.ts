import { z } from 'zod';
import type { Session } from '@/lib/opencode/model';
import { isVSCodeRuntime } from '@/lib/desktop';
import { normalizePath } from '@/lib/pathNormalization';
import { getOriginalSessionID, isReviewSession } from '@/lib/sessionReviewMetadata';

/**
 * Which session a sidebar row nests under.
 *
 * A subagent nests under the run that spawned it (`parentID`, OpenCode's own
 * lineage). A root session that grew out of another one in the same folder
 * nests under that one too, so the work they share reads as one entry: an
 * auto-review under the session it reviews, a fork (a promoted `/btw` side
 * conversation included) under its source, and a session another session's
 * agent started through the openchamber tool under that session.
 *
 * The folder decides first. A session that runs in another worktree or folder
 * belongs to the work of that folder and stays a root there, whatever it grew
 * out of. A multi-run lane stays a root as well: the run row owns its lanes.
 *
 * VS Code nests by `parentID` alone. This is display lineage only. OpenCode's `parentID` still decides what the
 * server treats as a subsession (archive cascade on restore, the Archive page).
 */

const originSchema = z.object({ openchamber: z.object({ originSessionID: z.string().trim().min(1) }) });
const openchamberNamespaceSchema = z.object({ openchamber: z.record(z.string(), z.json()) });

/** The session an agent dispatched this one from, as the server recorded it. */
const getDispatchOriginSessionId = (session: Session): string | null => (
  originSchema.safeParse(session.metadata).data?.openchamber.originSessionID ?? null
);

/** The session this root session grew out of, before checking where either lives. */
const getSessionOriginId = (session: Session): string | null => {
  if (isReviewSession(session)) return getOriginalSessionID(session);
  const forkSource = session.fork?.sessionID?.trim();
  if (forkSource) return forkSource;
  return getDispatchOriginSessionId(session);
};

// A present marker is enough: a fork inherits its source's marker and is still
// kept out of the run (see `lib/multirun/identity.ts`).
const isMultiRunLane = (session: Session): boolean => Object.hasOwn(
  openchamberNamespaceSchema.safeParse(session.metadata).data?.openchamber ?? {},
  'multirun',
);

const sameFolder = (left: Session, right: Session): boolean => {
  const leftDirectory = normalizePath(left.directory ?? null);
  return leftDirectory !== null && leftDirectory === normalizePath(right.directory ?? null);
};

/**
 * The session `session` nests under, or null for a root. `lookup` answers for
 * the sessions the caller lists; an origin it does not know (not loaded, in
 * another project) leaves the session a root.
 */
export const resolveSessionNestingParentId = (
  session: Session,
  lookup: (sessionId: string) => Session | undefined,
): string | null => {
  if (session.parentID) return session.parentID;
  // VS Code keeps its sidebar as it was: OpenCode's own nesting only.
  if (isVSCodeRuntime() || session.time?.archived || isMultiRunLane(session)) return null;
  const originId = getSessionOriginId(session);
  if (!originId || originId === session.id) return null;
  const origin = lookup(originId);
  if (!origin || origin.time?.archived || !sameFolder(session, origin)) return null;
  // Origins chain (a review of a fork of a dispatched session). Metadata can
  // record a loop, and a link that closes one back to this session is refused.
  const seen = new Set<string>([session.id]);
  let current: Session | undefined = origin;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const next = current.parentID ?? getSessionOriginId(current);
    if (!next) return originId;
    if (seen.has(next)) return next === session.id ? null : originId;
    current = lookup(next);
  }
  return originId;
};
