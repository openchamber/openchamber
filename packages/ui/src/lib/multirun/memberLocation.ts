import { normalizePath } from '@/lib/pathNormalization';
import type { ProjectRef } from '@/lib/worktrees/worktreeManager';
import { checkoutHoldsDirectory, findWorktreeHoldingDirectory } from '@/lib/worktrees/worktreePaths';
import type { WorktreeMetadata } from '@/types/worktree';

export type RunMemberLocation = { project: ProjectRef; worktree: WorktreeMetadata | null };

export type RunMemberLocationSources = {
  projectPaths: readonly string[];
  known: WorktreeMetadata | undefined;
  legacyScope: string | null;
  projectRefFor: (path: string) => ProjectRef;
  listWorktrees: (project: ProjectRef) => Promise<WorktreeMetadata[]>;
};

export async function locateRunMember(directory: string, sources: RunMemberLocationSources): Promise<RunMemberLocation | null> {
  const { projectPaths, known } = sources;
  const holdsProject = (checkoutPath: string): boolean => projectPaths.some((projectPath) => checkoutHoldsDirectory(checkoutPath, projectPath));
  const knownProject = normalizePath(known?.projectDirectory);
  const knownCheckout = normalizePath(known?.path);
  if (known && knownProject && knownCheckout && checkoutHoldsDirectory(knownCheckout, directory)) {
    const isProjectCheckout = knownProject === knownCheckout || holdsProject(knownCheckout);
    return { project: sources.projectRefFor(knownProject), worktree: isProjectCheckout ? null : known };
  }
  if (projectPaths.includes(directory)) return { project: sources.projectRefFor(directory), worktree: null };
  const { legacyScope } = sources;
  const candidates = legacyScope ? [legacyScope, ...projectPaths.filter((path) => path !== legacyScope)] : projectPaths;
  for (const projectPath of candidates) {
    const project = sources.projectRefFor(projectPath);
    const worktrees = (await sources.listWorktrees(project))
      .filter((entry) => !holdsProject(normalizePath(entry.path) ?? entry.path));
    const worktree = findWorktreeHoldingDirectory(worktrees, directory);
    if (worktree) return { project, worktree };
  }
  return null;
}
