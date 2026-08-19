import type { ProjectRef } from '@/lib/worktrees/worktreeManager';
import type { WorktreeMetadata } from '@/types/worktree';
import { normalizePath } from '@/lib/pathNormalization';

export type SessionWorktreeMenuTarget = {
  metadata: WorktreeMetadata;
  isPrimary: boolean;
  isCurrent: boolean;
};

export type StartSessionWorktreeMenuLoadArgs = {
  projectId: string | null;
  sourceDirectory: string | null;
  currentWorktree: WorktreeMetadata | null;
};

export type StartSessionWorktreeMenuLoadResult = {
  cachedTargets: SessionWorktreeMenuTarget[];
  refreshTargets: Promise<SessionWorktreeMenuTarget[]>;
};

type SessionWorktreeMenuState = {
  refreshState: 'loading' | 'error' | null;
  showNewWorktreeAction: boolean;
};

type StartSessionWorktreeMenuLoadDependencies = {
  projects: ReadonlyArray<ProjectRef>;
  rawWorktreesByProjectRef: { current: RawWorktreesByProjectScope };
  getPublishedWorktreesByProject: () => Map<string, WorktreeMetadata[]>;
  resolveProject: (directory: string) => ProjectRef | null;
  listProjectWorktrees: (project: ProjectRef, options: { force: true }) => Promise<WorktreeMetadata[]>;
  partitionWorktreesByRegisteredProject: (
    projects: ReadonlyArray<Pick<ProjectRef, 'path'>>,
    worktreesByProject: ReadonlyMap<string, WorktreeMetadata[]>,
  ) => Map<string, WorktreeMetadata[]>;
  worktreeMapsEqual: (
    a: Map<string, WorktreeMetadata[]>,
    b: Map<string, WorktreeMetadata[]>,
  ) => boolean;
  recordWorktreesSeen: (paths: Iterable<string | null | undefined>, seenAt: number) => void;
  publishTopology: (next: {
    availableWorktrees: WorktreeMetadata[];
    availableWorktreesByProject: Map<string, WorktreeMetadata[]>;
  }) => void;
  getRuntimeKey: () => string;
  now: () => number;
  projectRootBranch: string | null;
};

type RequestRediscovery = () => void;

export type RawWorktreesByProjectScope = {
  runtimeKey: string | null;
  revision: number;
  worktreesByProject: Map<string, WorktreeMetadata[]>;
};

export const markRawWorktreesByProjectMutation = (
  rawWorktreesByProjectRef: { current: RawWorktreesByProjectScope },
  runtimeKey: string,
): number => {
  if (rawWorktreesByProjectRef.current.runtimeKey !== runtimeKey) {
    return rawWorktreesByProjectRef.current.revision;
  }
  rawWorktreesByProjectRef.current = {
    ...rawWorktreesByProjectRef.current,
    revision: rawWorktreesByProjectRef.current.revision + 1,
  };
  return rawWorktreesByProjectRef.current.revision;
};

const cloneWorktreesByProject = (
  worktreesByProject: ReadonlyMap<string, WorktreeMetadata[]>,
): Map<string, WorktreeMetadata[]> => {
  return new Map(
    [...worktreesByProject.entries()].map(([projectPath, worktrees]) => [projectPath, worktrees.map((worktree) => cloneMetadata(worktree))]),
  );
};

export const ensureRawWorktreesByProjectScope = (args: {
  rawWorktreesByProjectRef: { current: RawWorktreesByProjectScope };
  publishedWorktreesByProject: Map<string, WorktreeMetadata[]>;
  runtimeKey: string;
}): RawWorktreesByProjectScope => {
  const shouldReseed = args.rawWorktreesByProjectRef.current.runtimeKey !== args.runtimeKey
    || (args.rawWorktreesByProjectRef.current.worktreesByProject.size === 0 && args.publishedWorktreesByProject.size > 0);

  if (shouldReseed) {
    args.rawWorktreesByProjectRef.current = {
      runtimeKey: args.runtimeKey,
      revision: args.rawWorktreesByProjectRef.current.runtimeKey === args.runtimeKey
        ? args.rawWorktreesByProjectRef.current.revision
        : 0,
      worktreesByProject: cloneWorktreesByProject(args.publishedWorktreesByProject),
    };
  }

  return args.rawWorktreesByProjectRef.current;
};

const compareLinkedTargets = (a: SessionWorktreeMenuTarget, b: SessionWorktreeMenuTarget): number => {
  const aLabel = a.metadata.branch || a.metadata.name || a.metadata.label || a.metadata.path;
  const bLabel = b.metadata.branch || b.metadata.name || b.metadata.label || b.metadata.path;
  const labelCompare = aLabel.localeCompare(bLabel, undefined, { sensitivity: 'base' });
  if (labelCompare !== 0) {
    return labelCompare;
  }

  return a.metadata.path.localeCompare(b.metadata.path, undefined, { sensitivity: 'base' });
};

const buildFallbackLabel = (path: string): string => {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
};

const cloneMetadata = (metadata: WorktreeMetadata): WorktreeMetadata => ({
  ...metadata,
  path: normalizePath(metadata.path) ?? metadata.path,
  projectDirectory: normalizePath(metadata.projectDirectory) ?? metadata.projectDirectory,
  worktreeRoot: normalizePath(metadata.worktreeRoot ?? metadata.path) ?? metadata.worktreeRoot,
});

const buildSyntheticWorktreeMetadata = (args: {
  path: string;
  projectDirectory: string;
  currentWorktree: WorktreeMetadata | null;
  projectRootBranch?: string | null;
}): WorktreeMetadata => {
  const { currentWorktree, path, projectDirectory, projectRootBranch } = args;
  const currentPath = normalizePath(currentWorktree?.path ?? null);
  const isCurrentPath = currentPath === path;
  const syntheticBranch = isCurrentPath ? (currentWorktree?.branch ?? '') : (projectRootBranch ?? '');

  const syntheticMetadata: WorktreeMetadata = {
    path,
    projectDirectory,
    branch: syntheticBranch,
    label: isCurrentPath
      ? (currentWorktree?.label || currentWorktree?.branch || currentWorktree?.name || buildFallbackLabel(path))
      : (projectRootBranch || buildFallbackLabel(path)),
    name: isCurrentPath ? currentWorktree?.name : undefined,
    worktreeRoot: isCurrentPath
      ? (normalizePath(currentWorktree?.worktreeRoot ?? path) ?? path)
      : path,
    worktreeStatus: isCurrentPath
      ? (currentWorktree?.worktreeStatus ?? 'ready')
      : 'ready',
    worktreeSource: isCurrentPath
      ? (currentWorktree?.worktreeSource ?? 'existing')
      : 'existing',
    headState: isCurrentPath ? currentWorktree?.headState : (projectRootBranch ? 'branch' : undefined),
  };

  return isCurrentPath && currentWorktree
    ? { ...currentWorktree, ...syntheticMetadata }
    : syntheticMetadata;
};

export const buildSessionWorktreeMenuTargets = (args: {
  projectPath: string | null;
  discoveredWorktrees: ReadonlyArray<WorktreeMetadata>;
  sourceDirectory: string | null;
  currentWorktree: WorktreeMetadata | null;
  projectRootBranch?: string | null;
}): SessionWorktreeMenuTarget[] => {
  const normalizedProjectPath = normalizePath(args.projectPath ?? null);
  const normalizedSourceDirectory = normalizePath(args.sourceDirectory ?? null)
    ?? normalizePath(args.currentWorktree?.path ?? null);
  const discoveredPrimaryPath = normalizePath(
    args.discoveredWorktrees.find((worktree) => normalizePath(worktree.projectDirectory ?? null))?.projectDirectory ?? null,
  );
  const currentPrimaryPath = normalizePath(args.currentWorktree?.projectDirectory ?? null);
  const primaryPath = discoveredPrimaryPath ?? currentPrimaryPath ?? normalizedProjectPath;

  const targetsByPath = new Map<string, SessionWorktreeMenuTarget>();
  const pushTarget = (target: SessionWorktreeMenuTarget): void => {
    const normalizedPath = normalizePath(target.metadata.path ?? null);
    if (!normalizedPath || targetsByPath.has(normalizedPath)) {
      return;
    }
    targetsByPath.set(normalizedPath, {
      ...target,
      metadata: cloneMetadata({
        ...target.metadata,
        path: normalizedPath,
      }),
    });
  };

  for (const worktree of args.discoveredWorktrees) {
    const normalizedPath = normalizePath(worktree.path ?? null);
    if (!normalizedPath) {
      continue;
    }
    pushTarget({
      metadata: cloneMetadata({
        ...worktree,
        path: normalizedPath,
        projectDirectory: normalizePath(worktree.projectDirectory ?? null) ?? primaryPath ?? normalizedProjectPath ?? normalizedPath,
      }),
      isPrimary: primaryPath === normalizedPath,
      isCurrent: normalizedSourceDirectory === normalizedPath,
    });
  }

  if (primaryPath && !targetsByPath.has(primaryPath)) {
    pushTarget({
      metadata: buildSyntheticWorktreeMetadata({
        path: primaryPath,
        projectDirectory: primaryPath,
        currentWorktree: args.currentWorktree,
        projectRootBranch: args.projectRootBranch,
      }),
      isPrimary: true,
      isCurrent: normalizedSourceDirectory === primaryPath,
    });
  }

  if (normalizedSourceDirectory && !targetsByPath.has(normalizedSourceDirectory)) {
    pushTarget({
      metadata: buildSyntheticWorktreeMetadata({
        path: normalizedSourceDirectory,
        projectDirectory: primaryPath ?? normalizedProjectPath ?? normalizedSourceDirectory,
        currentWorktree: args.currentWorktree,
        projectRootBranch: args.projectRootBranch,
      }),
      isPrimary: primaryPath === normalizedSourceDirectory,
      isCurrent: true,
    });
  }

  const primaryTargets: SessionWorktreeMenuTarget[] = [];
  const linkedTargets: SessionWorktreeMenuTarget[] = [];
  for (const target of targetsByPath.values()) {
    if (target.isPrimary) {
      primaryTargets.push(target);
      continue;
    }
    linkedTargets.push(target);
  }

  primaryTargets.sort((a, b) => a.metadata.path.localeCompare(b.metadata.path, undefined, { sensitivity: 'base' }));
  linkedTargets.sort(compareLinkedTargets);
  return [...primaryTargets, ...linkedTargets];
};

export const startSessionWorktreeMenuLoad = (
  args: StartSessionWorktreeMenuLoadArgs,
  deps: StartSessionWorktreeMenuLoadDependencies,
): StartSessionWorktreeMenuLoadResult => {
  const runtimeKey = deps.getRuntimeKey();
  const publishedWorktreesByProject = deps.getPublishedWorktreesByProject();
  const rawScope = ensureRawWorktreesByProjectScope({
    rawWorktreesByProjectRef: deps.rawWorktreesByProjectRef,
    publishedWorktreesByProject,
    runtimeKey,
  });
  const projectById = args.projectId
    ? deps.projects.find((candidate) => candidate.id === args.projectId) ?? null
    : null;
  const project = projectById ?? (args.sourceDirectory ? deps.resolveProject(args.sourceDirectory) : null);
  const normalizedProjectPath = normalizePath(project?.path ?? null);
  const cachedTargets = buildSessionWorktreeMenuTargets({
    projectPath: normalizedProjectPath,
    discoveredWorktrees: normalizedProjectPath
      ? (rawScope.worktreesByProject.get(normalizedProjectPath) ?? [])
      : [],
    sourceDirectory: args.sourceDirectory,
    currentWorktree: args.currentWorktree,
    projectRootBranch: deps.projectRootBranch,
  });

  return {
    cachedTargets,
    refreshTargets: (async () => {
      if (!project || !normalizedProjectPath) {
        throw new Error('Unable to resolve worktree project');
      }

      const refreshedWorktrees = await deps.listProjectWorktrees(project, { force: true });

      if (deps.getRuntimeKey() !== runtimeKey) {
        throw new Error('Runtime changed during worktree refresh');
      }

      const currentRawScope = ensureRawWorktreesByProjectScope({
        rawWorktreesByProjectRef: deps.rawWorktreesByProjectRef,
        publishedWorktreesByProject: deps.getPublishedWorktreesByProject(),
        runtimeKey,
      });
      const nextRawTopology = cloneWorktreesByProject(currentRawScope.worktreesByProject);
      const nextProjectWorktrees = [...refreshedWorktrees]
        .map((worktree) => cloneMetadata(worktree))
        .sort((a, b) => compareLinkedTargets(
          { metadata: a, isPrimary: false, isCurrent: false },
          { metadata: b, isPrimary: false, isCurrent: false },
        ));

      const refreshedRepositoryRoot = normalizePath(
        nextProjectWorktrees.find((worktree) => normalizePath(worktree.projectDirectory ?? null))?.projectDirectory
          ?? args.currentWorktree?.projectDirectory
          ?? project.path,
      );
      const matchingProjectPaths = new Set<string>([normalizedProjectPath]);
      for (const [projectPath, worktrees] of nextRawTopology.entries()) {
        const repositoryRoot = normalizePath(
          worktrees.find((worktree) => normalizePath(worktree.projectDirectory ?? null))?.projectDirectory ?? projectPath,
        );
        if (repositoryRoot && repositoryRoot === refreshedRepositoryRoot) {
          matchingProjectPaths.add(projectPath);
        }
      }
      for (const projectPath of matchingProjectPaths) {
        if (nextProjectWorktrees.length === 0) {
          nextRawTopology.delete(projectPath);
          continue;
        }
        nextRawTopology.set(projectPath, nextProjectWorktrees.map((worktree) => cloneMetadata(worktree)));
      }

      markRawWorktreesByProjectMutation(deps.rawWorktreesByProjectRef, runtimeKey);
      deps.rawWorktreesByProjectRef.current = {
        runtimeKey,
        revision: deps.rawWorktreesByProjectRef.current.revision,
        worktreesByProject: nextRawTopology,
      };

      const partitionedWorktreesByProject = deps.partitionWorktreesByRegisteredProject(deps.projects, nextRawTopology);
      const allWorktrees = [...partitionedWorktreesByProject.values()].flat();
      deps.recordWorktreesSeen(allWorktrees.map((worktree) => worktree.path), deps.now());

      const latestPublishedWorktreesByProject = deps.getPublishedWorktreesByProject();
      if (!deps.worktreeMapsEqual(partitionedWorktreesByProject, latestPublishedWorktreesByProject)) {
        deps.publishTopology({
          availableWorktrees: allWorktrees,
          availableWorktreesByProject: partitionedWorktreesByProject,
        });
      }

      return buildSessionWorktreeMenuTargets({
        projectPath: normalizedProjectPath,
        discoveredWorktrees: nextProjectWorktrees,
        sourceDirectory: args.sourceDirectory,
        currentWorktree: args.currentWorktree,
        projectRootBranch: deps.projectRootBranch,
      });
    })(),
  };
};

export const commitDiscoveredRawWorktreesByProject = (args: {
  rawWorktreesByProjectRef: { current: RawWorktreesByProjectScope };
  runtimeKey: string;
  capturedRevision: number;
  nextRawWorktreesByProject: Map<string, WorktreeMetadata[]>;
  publishedWorktreesByProject: Map<string, WorktreeMetadata[]>;
  partitionWorktreesByRegisteredProject: StartSessionWorktreeMenuLoadDependencies['partitionWorktreesByRegisteredProject'];
  projects: ReadonlyArray<Pick<ProjectRef, 'id' | 'path'>>;
  worktreeMapsEqual: StartSessionWorktreeMenuLoadDependencies['worktreeMapsEqual'];
  recordWorktreesSeen: StartSessionWorktreeMenuLoadDependencies['recordWorktreesSeen'];
  publishTopology: StartSessionWorktreeMenuLoadDependencies['publishTopology'];
  requestRediscovery: RequestRediscovery;
  now: () => number;
}): boolean => {
  if (args.rawWorktreesByProjectRef.current.runtimeKey !== args.runtimeKey) {
    return false;
  }
  if (args.rawWorktreesByProjectRef.current.revision !== args.capturedRevision) {
    args.requestRediscovery();
    return false;
  }
  const partitionedWorktreesByProject = args.partitionWorktreesByRegisteredProject(args.projects, args.nextRawWorktreesByProject);
  const allWorktrees = [...partitionedWorktreesByProject.values()].flat();
  args.recordWorktreesSeen(allWorktrees.map((worktree) => worktree.path), args.now());
  args.rawWorktreesByProjectRef.current = {
    runtimeKey: args.runtimeKey,
    revision: args.capturedRevision,
    worktreesByProject: new Map(args.nextRawWorktreesByProject),
  };
  if (!args.worktreeMapsEqual(partitionedWorktreesByProject, args.publishedWorktreesByProject)) {
    args.publishTopology({
      availableWorktrees: allWorktrees,
      availableWorktreesByProject: partitionedWorktreesByProject,
    });
  }
  return true;
};

export const getSessionWorktreeMenuState = (args: {
  targets: ReadonlyArray<SessionWorktreeMenuTarget>;
  isRefreshing: boolean;
  loadFailed: boolean;
}): SessionWorktreeMenuState => {
  return {
    refreshState: args.isRefreshing
      ? 'loading'
      : (args.loadFailed && args.targets.length === 0 ? 'error' : null),
    showNewWorktreeAction: true,
  };
};
