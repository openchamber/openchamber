import type { Session } from '@opencode-ai/sdk/v2';
import type { WorktreeMetadata } from '@/types/worktree';

export type SessionNode = {
  session: Session;
  children: SessionNode[];
  worktree: WorktreeMetadata | null;
};

export type SessionGroupFolderScope = {
  scopeKey: string;
  directory: string | null;
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
  /**
   * Flat display groups merge sessions from the project root and every
   * worktree; their folders come from all of these scopes. When present, the
   * group section gathers folders across every listed scope (in order)
   * instead of reading the single folderScopeKey.
   */
  folderScopes?: SessionGroupFolderScope[];
  sessions: SessionNode[];
};

export type GroupSearchData = {
  filteredNodes: SessionNode[];
  matchedSessionCount: number;
  folderNameMatchCount: number;
  groupMatches: boolean;
  hasMatch: boolean;
};
