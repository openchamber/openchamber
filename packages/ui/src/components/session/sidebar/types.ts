import type { Session } from '@/lib/opencode/model';
import type { WorktreeMetadata } from '@/types/worktree';
import type { SpaceMark } from '@/lib/spaces/spaces-store';

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
  space?: SpaceMark;
  directory: string | null;
  folderScopeKey?: string | null;
  folderScopes?: SessionGroupFolderScope[];
  draftTarget?: 'chat' | 'project';
  emptyMessage?: string;
  sessions: SessionNode[];
};
