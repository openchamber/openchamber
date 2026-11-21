import type { Session } from '@/lib/opencode/model';
import type { ConversationMetadata } from '@/lib/search/conversationSearch';
import type { WorktreeMetadata } from '@/types/worktree';
import type { DirectoryOwner } from './sessions/sessionOwnership';
import { normalizePath } from './utils';

type SearchProject = { id: string; label?: string; normalizedPath: string };
type ScopeInput = {
  projects: readonly SearchProject[];
  worktrees: ReadonlyMap<string, WorktreeMetadata[]>;
  knownDirectories: ReadonlySet<string>;
  isVSCode: boolean;
};

export function resolveSidebarSearchScope({ projects, worktrees, knownDirectories, isVSCode }: ScopeInput) {
  const knownDirectoryKeys = new Set([...knownDirectories].map((directory) => normalizePath(directory)));
  const roots = new Set<string>();
  for (const project of projects) {
    roots.add(project.normalizedPath);
    for (const worktree of worktrees.get(project.normalizedPath) ?? []) roots.add(normalizePath(worktree.path) ?? worktree.path);
  }
  const isAdmitted = (directory: string | null): boolean => {
    const normalized = normalizePath(directory);
    if (!normalized) return false;
    if (knownDirectoryKeys.has(normalized)) return true;
    if (isVSCode) return false;
    let candidate: string | null = normalized;
    while (candidate) {
      if (roots.has(candidate)) return true;
      const slash = candidate.lastIndexOf('/');
      candidate = slash > 0 ? candidate.slice(0, slash) : null;
    }
    return false;
  };
  const directories = isVSCode ? [...knownDirectories].sort() : undefined;
  return { directories, available: directories === undefined || directories.length > 0, isAdmitted };
}

export function sidebarSearchMetadata(input: {
  sessions: readonly Session[];
  isAdmitted: (directory: string | null) => boolean;
  owners: ReadonlyMap<string, DirectoryOwner>;
  projects: readonly SearchProject[];
  worktrees: ReadonlyMap<string, WorktreeMetadata[]>;
}): ConversationMetadata[] {
  const seen = new Set<string>();
  const projects = new Map(input.projects.map((project) => [project.id, project]));
  return input.sessions.flatMap((session) => {
    const directory = normalizePath(session.directory);
    const archived = Boolean(session.time?.archived);
    if (session.parentID || seen.has(session.id) || !input.isAdmitted(directory)) return [];
    seen.add(session.id);
    const owner = input.owners.get(session.id);
    const project = owner ? projects.get(owner.projectId) : undefined;
    const worktree = owner ? input.worktrees.get(project?.normalizedPath ?? owner.projectRoot)?.find((worktree) => normalizePath(worktree.path) === owner.scopeDirectory) : undefined;
    return [{ sessionId: session.id, title: session.title ?? '', directory, archived, updatedAt: session.time?.updated, projectLabel: project?.label ?? project?.normalizedPath.split('/').pop() ?? null, worktreeLabel: worktree?.branch ?? worktree?.name ?? null }];
  });
}
