import type { Project as OpenCodeProject, Session } from '@/lib/opencode/model';
import { getNormalizedParentDirectory, normalizePath } from '@/lib/pathNormalization';
import type { SpaceMark } from '@/lib/spaces/spaces-store';

type Project = {
  id: string;
  normalizedPath: string;
};

type Worktree = {
  path: string;
};

type SessionProjectMetadata = {
  id?: string | null;
  worktree?: string | null;
};

export type SessionOwnershipRecord = Session & {
  directory?: string | null;
  projectID?: string | null;
  project?: SessionProjectMetadata | null;
};

type AuthoritativeOpenCodeProject = Pick<OpenCodeProject, 'id' | 'worktree'>;

export type DirectoryOwner = {
  projectId: string;
  projectRoot: string;
  scopeDirectory: string;
  kind: 'project' | 'worktree' | 'space';
  /** The isolated space that owns the scope, for `kind: 'space'`. */
  spaceId?: string;
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
  if (shouldReplaceOwner(owners.get(directory), candidate)) {
    owners.set(directory, candidate);
  }
};

const resolveSessionDirectory = (session: SessionOwnershipRecord): string | null => {
  return normalizePath(session.directory) ?? normalizePath(session.project?.worktree);
};

const getOpenCodeProjectId = (session: SessionOwnershipRecord): string | null => {
  return session.projectID || session.project?.id || null;
};

export const createSessionOwnershipIndex = (
  sessions: SessionOwnershipRecord[],
  projects: Project[],
  availableWorktreesByProject: Map<string, Worktree[]>,
  isVSCode: boolean,
  archivedSessions: SessionOwnershipRecord[] = [],
  authoritativeProjects: readonly AuthoritativeOpenCodeProject[] = [],
  spaces: readonly SpaceMark[] = [],
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

  // An isolated space belongs to the registered project it was made for, as the host resolved
  // it from the space's label; a space whose project is not registered here owns nothing, so
  // its sessions stay out of every project, as any session without an owner does. VS Code never
  // has spaces (decision 16 of the design).
  if (!isVSCode) {
    for (const space of spaces) {
      const projectRoot = normalizePath(space.projectDirectory);
      const directory = normalizePath(space.directory);
      const project = projectRoot ? projectByRoot.get(projectRoot) : undefined;
      if (!project || !projectRoot || !directory) continue;
      setOwner(ownerByDirectory, directory, {
        projectId: project.id,
        projectRoot,
        scopeDirectory: directory,
        kind: 'space',
        spaceId: space.id,
      });
    }
  }

  // OpenCode project IDs are not OpenChamber's path-derived project IDs. Only
  // project metadata whose canonical worktree is itself a configured root can
  // bridge the two namespaces. Conflicting metadata stays unresolved.
  const canonicalOwnerByOpenCodeProjectId = new Map<string, DirectoryOwner | null>();
  const authoritativeProjectIds = new Set<string>();
  const registerCanonicalOwner = (openCodeProjectId: string, worktree: string | null | undefined): void => {
    const canonicalRoot = normalizePath(worktree ?? null);
    const project = canonicalRoot ? projectByRoot.get(canonicalRoot) : undefined;
    const candidate = project && canonicalRoot ? {
      projectId: project.id,
      projectRoot: canonicalRoot,
      scopeDirectory: canonicalRoot,
      kind: 'project' as const,
    } : null;
    if (!canonicalOwnerByOpenCodeProjectId.has(openCodeProjectId)) {
      canonicalOwnerByOpenCodeProjectId.set(openCodeProjectId, candidate);
      return;
    }
    const existing = canonicalOwnerByOpenCodeProjectId.get(openCodeProjectId);
    if (!existing || !candidate || existing.projectRoot !== candidate.projectRoot) {
      canonicalOwnerByOpenCodeProjectId.set(openCodeProjectId, null);
    }
  };

  for (const project of authoritativeProjects) {
    if (!project.id) continue;
    authoritativeProjectIds.add(project.id);
    registerCanonicalOwner(project.id, project.worktree);
  }
  for (const session of [...sessions, ...archivedSessions]) {
    const openCodeProjectId = session.project?.id;
    if (!openCodeProjectId || authoritativeProjectIds.has(openCodeProjectId)) continue;
    const canonicalRoot = normalizePath(session.project?.worktree ?? null);
    if (!canonicalRoot || !projectByRoot.has(canonicalRoot)) continue;
    registerCanonicalOwner(openCodeProjectId, session.project?.worktree);
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

    const visited: string[] = [];
    let current: string | null = directory;
    let owner: DirectoryOwner | null = null;
    while (current) {
      if (resolvedOwners.has(current)) {
        owner = resolvedOwners.get(current) ?? null;
        break;
      }
      visited.push(current);
      owner = ownerByDirectory.get(current) ?? null;
      if (owner) break;
      current = getNormalizedParentDirectory(current);
    }
    for (const visitedDirectory of visited) {
      resolvedOwners.set(visitedDirectory, owner);
    }
    return owner;
  };

  const bucket = (
    input: SessionOwnershipRecord[],
    target: Map<string, Session[]>,
    scopeTarget?: Map<string, Set<string>>,
  ): void => {
    for (const session of input) {
      const exactOwner = resolveOwner(resolveSessionDirectory(session));
      const owner = exactOwner ?? (!isVSCode
        ? canonicalOwnerByOpenCodeProjectId.get(getOpenCodeProjectId(session) ?? '') ?? null
        : null);
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
