import type { Session } from '@opencode-ai/sdk/v2';
import type { WorktreeMetadata } from '@/types/worktree';

export type SessionSummaryMeta = {
  additions?: number | string | null;
  deletions?: number | string | null;
  files?: number | null;
  diffs?: Array<{ additions?: number | string | null; deletions?: number | string | null }>;
};

export type SessionNode = {
  session: Session;
  children: SessionNode[];
  worktree: WorktreeMetadata | null;
};

export type SessionGroup = {
  id: string;
  label: string;
  branch: string | null;
  description: string | null;
  isMain: boolean;
  isArchivedBucket?: boolean;
  worktree: WorktreeMetadata | null;
  directory: string | null;
  folderScopeKey?: string | null;
  sessions: SessionNode[];
};

export type GroupSearchData = {
  filteredNodes: SessionNode[];
  matchedSessionCount: number;
  folderNameMatchCount: number;
  groupMatches: boolean;
  hasMatch: boolean;
};

/**
 * Session may have parent ID stored under different field names across API versions.
 * This type union allows type-safe access to all known variants.
 */
type SessionWithParentId = Session & {
  parentID?: string | null;
  parentId?: string | null;
  parent_session_id?: string | null;
};

/**
 * Returns the parent session ID from a session, checking all known field names.
 * Returns undefined if no parent ID is found.
 */
export function getSessionParentId(session: Session): string | null | undefined {
  const s = session as SessionWithParentId;
  return s.parentID ?? s.parentId ?? s.parent_session_id;
}

/**
 * Returns true if the session is a subtask (has a parent session).
 */
export function isSubtaskSession(session: Session): boolean {
  return Boolean(getSessionParentId(session));
}
