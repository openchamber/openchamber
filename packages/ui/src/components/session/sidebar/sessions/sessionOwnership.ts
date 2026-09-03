import type { Session } from '@opencode-ai/sdk/v2';
import { canonicalizePathIdentity, normalizePath } from '@/lib/pathNormalization';

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
  const identity = canonicalizePathIdentity(directory);
  if (!identity) return;
  if (shouldReplaceOwner(owners.get(identity), candidate)) {
    owners.set(identity, candidate);
  }
};

const resolveSessionDirectory = (session: Session): string | null => {
  const record = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };
  return normalizePath(record.directory) ?? normalizePath(record.project?.worktree);
};

const getParentDirectory = (directory: string): string | null => {
  if (directory === '/' || /^[A-Z]:\/?$/.test(directory)) {
    return null;
  }
  const separator = directory.lastIndexOf('/');
  if (separator < 0) return null;
  if (separator === 0) return '/';
  if (separator === 2 && /^[A-Z]:\//.test(directory)) return directory.slice(0, 3);
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
    const projectRootIdentity = canonicalizePathIdentity(projectRoot);
    if (!projectRootIdentity) continue;
    const existingProject = projectByRoot.get(projectRootIdentity);
    if (!existingProject || project.id.localeCompare(existingProject.id) < 0) {
      projectByRoot.set(projectRootIdentity, project);
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
      const projectRootIdentity = projectRoot ? canonicalizePathIdentity(projectRoot) : null;
      const project = projectRootIdentity ? projectByRoot.get(projectRootIdentity) : undefined;
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
    const directoryIdentity = canonicalizePathIdentity(directory);
    if (!directoryIdentity) return null;
    if (resolvedOwners.has(directoryIdentity)) {
      return resolvedOwners.get(directoryIdentity) ?? null;
    }

    if (isVSCode) {
      const owner = ownerByDirectory.get(directoryIdentity) ?? null;
      resolvedOwners.set(directoryIdentity, owner);
      return owner;
    }

    const visited: string[] = [];
    let current: string | null = directory;
    let owner: DirectoryOwner | null = null;
    while (current) {
      const currentIdentity = canonicalizePathIdentity(current);
      if (!currentIdentity) break;
      if (resolvedOwners.has(currentIdentity)) {
        owner = resolvedOwners.get(currentIdentity) ?? null;
        break;
      }
      visited.push(currentIdentity);
      owner = ownerByDirectory.get(currentIdentity) ?? null;
      if (owner) break;
      current = getParentDirectory(current);
    }
    for (const visitedDirectory of visited) {
      resolvedOwners.set(visitedDirectory, owner);
    }
    return owner;
  };

  const bucket = (
    input: Session[],
    target: Map<string, Session[]>,
    scopeTarget?: Map<string, Set<string>>,
  ): void => {
    for (const session of input) {
      const owner = resolveOwner(resolveSessionDirectory(session));
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
