export function normalizeConversationProjectPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '');
  return (normalized || '/').toLocaleLowerCase();
}

type ScopeWorktree = { path: string; label?: string | null; name?: string | null; branch?: string | null };

/**
 * A worktree filter names one worktree: its full path, or exactly its label,
 * name or branch. Never a substring, so `/worktrees/task` leaves `/worktrees/task-old` out.
 */
export function matchesConversationWorktreeScope(scope: string, worktree: ScopeWorktree): boolean {
  const value = scope.trim().toLocaleLowerCase();
  if (!value) return false;
  if (normalizeConversationProjectPath(scope.trim()) === normalizeConversationProjectPath(worktree.path)) return true;
  return [worktree.label, worktree.name, worktree.branch].some((candidate) => candidate?.trim().toLocaleLowerCase() === value);
}

export function matchesConversationProjectScope(scope: string, projectPath: string, projectLabel?: string): boolean {
  const normalizedScope = normalizeConversationProjectPath(scope);
  const fallbackLabel = projectPath.split('/').filter(Boolean).at(-1) ?? projectPath;
  return normalizedScope === normalizeConversationProjectPath(projectPath)
    || (projectLabel ?? fallbackLabel).trim().toLocaleLowerCase() === scope.trim().toLocaleLowerCase();
}
