import type { Session } from '@opencode-ai/sdk/v2';
import { normalizePath } from '@/lib/pathNormalization';

type Project = {
  id: string;
  normalizedPath: string;
};

type Worktree = {
  path: string;
};

export type DirectoryOwner = {
  projectId: string;
  projectRoot: string;
  scopeDirectory: string;
  kind: 'project' | 'worktree';
};

export type SessionOwnershipIndex = {
  bySessionId: Map<string, DirectoryOwner>;
  sessionsByProject: Map<string, Session[]>;
  archivedSessionsByProject: Map<string, Session[]>;
  sessionsByScope: Map<string, Set<string>>;
  directoryResolutions: number;
};

const shouldReplaceOwner = (existing: DirectoryOwner | undefined, candidate: DirectoryOwner): boolean => {
  if (!existing) return true;
  if (candidate.kind !== existing.kind) {
    return candidate.kind === 'project';
  }
  if (candidate.projectRoot.length !== existing.projectRoot.length) {
    return candidate.projectRoot.length > existing.projectRoot.length;
  }
  return candidate.projectId.localeCompare(existing.projectId) < 0;
};

const setOwner = (owners: Map<string, DirectoryOwner>, directory: string, candidate: DirectoryOwner): void => {
  const existing = owners.get(directory);
  if (shouldReplaceOwner(existing, candidate)) {
    owners.set(directory, candidate);
  }
};

const resolveSessionDirectory = (session: Session): string | null => {
  const record = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };

  const directory = normalizePath(record.directory);
  if (directory) {
    return directory;
  }
  return normalizePath(record.project?.worktree);
};

const getParentDirectory = (directory: string): string | null => {
  if (directory === '/' || /^[A-Z]:\/$/.test(directory)) {
    return null;
  }
  const separator = directory.lastIndexOf('/');
  if (separator < 0) {
    return null;
  }
  if (separator === 0) {
    return '/';
  }
  return directory.slice(0, separator);
};

export const createSessionOwnershipIndex = (
  sessions: Session[],
  projects: Project[],
  availableWorktreesByProject: Map<string, Worktree[]>,
  isVSCode: boolean,
  archivedSessions: Session[] = [],
): SessionOwnershipIndex => {
  const ownerByDirectory = new Map<string, DirectoryOwner>();
  const projectByRoot = new Map<string, Project>();

  for (const project of projects) {
    const projectRoot = normalizePath(project.normalizedPath);
    if (!projectRoot) continue;
    const existingProject = projectByRoot.get(projectRoot);
    if (!existingProject || project.id.localeCompare(existingProject.id) < 0) {
      projectByRoot.set(projectRoot, project);
    }
    setOwner(ownerByDirectory, projectRoot, {
      projectId: project.id,
      projectRoot,
      scopeDirectory: projectRoot,
      kind: 'project',
    });
  }

  if (!isVSCode) {
    for (const [projectPath, worktrees] of availableWorktreesByProject) {
      const projectRoot = normalizePath(projectPath);
      const project = projectRoot ? projectByRoot.get(projectRoot) : undefined;
      if (!project || !projectRoot) continue;
      for (const worktree of worktrees) {
        const directory = normalizePath(worktree.path);
        if (!directory) continue;
        setOwner(ownerByDirectory, directory, {
          projectId: project.id,
          projectRoot,
          scopeDirectory: directory,
          kind: 'worktree',
        });
      }
    }
  }

  const resolvedOwners = new Map<string, DirectoryOwner | null>();
  const bySessionId = new Map<string, DirectoryOwner>();
  const sessionsByProject = new Map<string, Session[]>();
  const archivedSessionsByProject = new Map<string, Session[]>();
  const sessionsByScope = new Map<string, Set<string>>();

  const resolveOwner = (directory: string | null): DirectoryOwner | null => {
    if (!directory) return null;
    if (resolvedOwners.has(directory)) {
      return resolvedOwners.get(directory) ?? null;
    }

    if (isVSCode) {
      const owner = ownerByDirectory.get(directory) ?? null;
      resolvedOwners.set(directory, owner);
      return owner;
    }

    let current: string | null = directory;
    while (current) {
      const owner = ownerByDirectory.get(current);
      if (owner) {
        resolvedOwners.set(directory, owner);
        return owner;
      }
      current = getParentDirectory(current);
    }
    resolvedOwners.set(directory, null);
    return null;
  };

  const bucket = (
    input: Session[],
    target: Map<string, Session[]>,
    scopeTarget?: Map<string, Set<string>>,
  ) => {
    for (const session of input) {
      const directory = resolveSessionDirectory(session);
      const owner = resolveOwner(directory);
      if (!owner) continue;
      bySessionId.set(session.id, owner);
      const projectSessions = target.get(owner.projectId);
      if (projectSessions) {
        projectSessions.push(session);
      } else {
        target.set(owner.projectId, [session]);
      }
      if (!scopeTarget) continue;
      const scopeSessions = scopeTarget.get(owner.scopeDirectory);
      if (scopeSessions) {
        scopeSessions.add(session.id);
      } else {
        scopeTarget.set(owner.scopeDirectory, new Set([session.id]));
      }
    }
  };

  bucket(sessions, sessionsByProject, sessionsByScope);
  bucket(archivedSessions, archivedSessionsByProject);

  return {
    bySessionId,
    sessionsByProject,
    archivedSessionsByProject,
    sessionsByScope,
    directoryResolutions: resolvedOwners.size,
  };
};
