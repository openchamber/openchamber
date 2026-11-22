import { normalizePath } from '@/lib/pathNormalization';
import { formatDirectoryName } from '@/lib/utils';
import type { WorktreeMetadata } from '@/types/worktree';

type SessionLocationSuggestion = {
  path: string;
  label: string;
  /** Worktree branch, or null for a project root. */
  branch: string | null;
};

/** Expands a leading `~` against the home directory; other input is returned trimmed. */
export const expandSessionLocationInput = (value: string, homeDirectory: string | null | undefined): string => {
  const trimmed = value.trim();
  if (!homeDirectory) return trimmed;
  const home = homeDirectory.replace(/\/+$/, '');
  if (trimmed === '~') return home;
  if (trimmed.startsWith('~/')) return `${home}/${trimmed.slice(2)}`;
  return trimmed;
};

/**
 * Every project root and the worktrees discovered for it, without the
 * session's own folder. A worktree is named by its branch, so picking the
 * worktree that holds a ref is how a session is pointed at that ref.
 */
export const buildSessionLocationSuggestions = (args: {
  projects: ReadonlyArray<{ path: string; label?: string | null }>;
  worktreesByProject: ReadonlyMap<string, ReadonlyArray<WorktreeMetadata>>;
  currentDirectory: string | null;
}): SessionLocationSuggestion[] => {
  const current = normalizePath(args.currentDirectory ?? null);
  const seen = new Set<string>();
  const suggestions: SessionLocationSuggestion[] = [];
  const push = (suggestion: SessionLocationSuggestion) => {
    const path = normalizePath(suggestion.path);
    if (!path || path === current || seen.has(path)) return;
    seen.add(path);
    suggestions.push({ ...suggestion, path });
  };
  for (const project of args.projects) {
    const projectPath = normalizePath(project.path);
    if (!projectPath) continue;
    push({ path: projectPath, label: project.label?.trim() || formatDirectoryName(projectPath), branch: null });
    const worktrees = args.worktreesByProject.get(projectPath) ?? [];
    for (const worktree of worktrees) {
      if (worktree.worktreeStatus && worktree.worktreeStatus !== 'ready') continue;
      push({
        path: worktree.path,
        label: worktree.label || worktree.name || formatDirectoryName(worktree.path),
        branch: worktree.branch?.trim() || null,
      });
    }
  }
  return suggestions;
};
