import { normalizePath } from '@/lib/pathNormalization';

type ComposerAgentDirectoryInput = {
  sessionId: string | null;
  /** `getDirectoryForSession(sessionId)` result; `null` when there is no session. */
  sessionDirectory: string | null;
  /** Whether the session identity exists in the sync or global session stores. */
  sessionIsKnown: boolean;
  draft: {
    open: boolean;
    bootstrapPendingDirectory?: string | null;
    directoryOverride?: string | null;
    /** Generated chat scratch directory the materialized draft will send to. */
    preparedChatDirectory?: string | null;
  } | null;
};

/**
 * The directory a composer's agent scope belongs to, resolved from its
 * session/draft identity. Tri-state by design:
 *
 * - a path — that directory's own list;
 * - `null` — a known session has no project directory; its send falls back to
 *   the client's current directory, so only the no-directory list applies and
 *   the ambient project must not leak in;
 * - `undefined` — the identity or target directory is not known yet, so
 *   callers fail open.
 *
 * Drafts are never `null`: a chat draft sends to its generated scratch
 * directory, and `listAgents(null)` would resolve the client's ambient project
 * (where the user came from) instead of that send target.
 *
 * Kept pure so the decision is unit-testable without rendering.
 */
export const resolveComposerAgentDirectory = (input: ComposerAgentDirectoryInput): string | null | undefined => {
  if (input.sessionId) {
    const directory = normalizePath(input.sessionDirectory);
    if (directory) return directory;
    // A session we can already see but that resolves no directory is a real
    // "no project directory" answer; only an identity we cannot see yet is
    // unknown and must fail open.
    return input.sessionIsKnown ? null : undefined;
  }

  if (input.draft?.open) {
    // First target that resolves wins: a worktree bootstrap in flight, an
    // explicit override, then the generated chat scratch directory. If none
    // resolves, the scope is unknown and the caller fails open rather than
    // reading the ambient directory the send does not target.
    return normalizePath(input.draft.bootstrapPendingDirectory)
      ?? normalizePath(input.draft.directoryOverride)
      ?? normalizePath(input.draft.preparedChatDirectory)
      ?? undefined;
  }

  return undefined;
};
