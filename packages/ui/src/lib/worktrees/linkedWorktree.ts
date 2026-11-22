import type { WorktreeMetadata } from "@/types/worktree"
import { normalizePath } from "@/lib/pathNormalization"

/** Whether `directory` is one of the project's worktrees other than its root checkout. */
export const isLinkedWorktreeOfProject = (
  availableWorktreesByProject: ReadonlyMap<string, readonly WorktreeMetadata[]>,
  projectPath: string | null,
  directory: string | null,
): boolean => {
  const root = normalizePath(projectPath)
  const target = normalizePath(directory)
  if (!root || !target || target === root) return false
  for (const [key, worktrees] of availableWorktreesByProject) {
    if (normalizePath(key) !== root) continue
    return worktrees.some((worktree) => normalizePath(worktree.path) === target)
  }
  return false
}
