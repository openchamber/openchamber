import type { SidebarSessionLocation } from '@/components/session/sidebar/recent/sessionLocation';
import { isChatDirectoryForHome, isChatDirectoryPath } from '@/lib/chatDirectories';
import { normalizePath } from '@/lib/pathNormalization';
import { formatDirectoryName } from '@/lib/utils';
import type { SearchMetaItem } from './SearchMetaList';

export type ConversationResultProject = {
  id: string;
  label: string;
  icon?: string | null;
  color?: string | null;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
  iconBackground?: string | null;
};

export type ConversationResultContext = {
  project: ConversationResultProject | null;
  folderLabel: string | null;
  /** Absolute path of the unregistered folder, shown on hover. */
  folderPath?: string | null;
  branchLabel: string | null;
  worktreeFolder: string | null;
  /** Absolute path of the deleted worktree folder, shown on hover. */
  worktreePath?: string | null;
  spaceLabel: string | null;
  extras?: readonly SearchMetaItem[];
};

export const EMPTY_CONVERSATION_CONTEXT: ConversationResultContext = {
  project: null,
  folderLabel: null,
  branchLabel: null,
  worktreeFolder: null,
  spaceLabel: null,
};

export type ConversationContextInput = {
  location: SidebarSessionLocation | null | undefined;
  directory: string | null;
  /** Null when the row sits under its own project header, or the project is unknown. */
  project: ConversationResultProject | null;
  projectRoot: string | null;
  homeDirectory: string | null;
  /** Archive: the name of a deleted space. Replaces every other item. */
  folderOverride?: string | null;
  extras?: readonly SearchMetaItem[];
};

const lastFolderName = (path: string): string | null => formatDirectoryName(path, null) || null;

// A chat is not in any folder, so it gets no context at all.
const isChatDirectory = (directory: string | null, homeDirectory: string | null): boolean => (
  !directory || isChatDirectoryPath(directory) || isChatDirectoryForHome(directory, homeDirectory)
);

// The worktree folder names a session whose branch is unknown, outside the project root.
const worktreeFolderFor = (location: SidebarSessionLocation, directory: string | null, projectRoot: string | null): { label: string; path: string } | null => {
  const path = location.worktree?.path ?? directory;
  if (!path || location.branchLabel !== null || location.inSpace) return null;
  if (normalizePath(directory) === normalizePath(projectRoot)) return null;
  const label = lastFolderName(path);
  return label ? { label, path } : null;
};

export function conversationContextFromLocation({
  location,
  directory,
  project,
  projectRoot,
  homeDirectory,
  folderOverride,
  extras,
}: ConversationContextInput): ConversationResultContext {
  const context = contextWithoutExtras({ location, directory, project, projectRoot, homeDirectory, folderOverride });
  return extras ? { ...context, extras } : context;
}

function contextWithoutExtras({ location, directory, project, projectRoot, homeDirectory, folderOverride }: ConversationContextInput): ConversationResultContext {
  if (folderOverride) return { ...EMPTY_CONVERSATION_CONTEXT, folderLabel: folderOverride };
  if (location) {
    const worktree = worktreeFolderFor(location, directory, projectRoot);
    return {
      project,
      folderLabel: null,
      branchLabel: location.inSpace ? null : location.branchLabel,
      worktreeFolder: worktree?.label ?? null,
      worktreePath: worktree?.path ?? null,
      spaceLabel: location.inSpace ? location.branchLabel : null,
    };
  }
  if (isChatDirectory(directory, homeDirectory)) return EMPTY_CONVERSATION_CONTEXT;
  return { ...EMPTY_CONVERSATION_CONTEXT, folderLabel: formatDirectoryName(directory, homeDirectory) || null, folderPath: directory };
}
