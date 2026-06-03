import { substituteCommandVariables } from '@/lib/openchamberConfig';
import type { WorktreeMetadata } from '@/types/worktree';
import {
  deleteRemoteBranch,
  git,
} from '@/lib/gitApi';
import {
  clearWorktreeBootstrapState,
  markWorktreeBootstrapPending,
} from '@/lib/worktrees/worktreeBootstrap';
import { invalidateResolvedProjectRootCache, resolveProjectRoot } from '@/lib/worktrees/worktreeStatus';
import type {
  CreateGitWorktreePayload,
  GitWorktreeValidationResult,
} from '@/lib/api/types';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useConfigStore } from '@/stores/useConfigStore';

type WorktreeListEntry = {
  path?: string;
  branch?: string;
  head?: string;
  name?: string;
};

const deriveHeadStateFromWorktreeEntry = (entry: WorktreeListEntry): 'branch' | 'detached' | 'unborn' => {
  const branch = (entry.branch || '').trim();
  const head = (entry.head || '').trim();
  if (!branch) {
    if (!head) return 'unborn';
    return 'detached';
  }
  return 'branch';
};

const deriveCanonicalWorktreeFields = (
  entry: WorktreeListEntry,
  worktreePath: string,
): Pick<WorktreeMetadata, 'worktreeRoot' | 'worktreeStatus' | 'headState' | 'worktreeSource'> => {
  return {
    worktreeRoot: worktreePath,
    worktreeStatus: 'ready',
    headState: deriveHeadStateFromWorktreeEntry(entry),
    worktreeSource: 'existing',
  };
};

export type ProjectRef = { id: string; path: string };

const normalizePath = (value: string): string => {
  const replaced = value.replace(/\\/g, '/');
  if (replaced === '/') {
    return '/';
  }
  return replaced.length > 1 ? replaced.replace(/\/+$/, '') : replaced;
};

const slugifyWorktreeName = (value: string): string => {
  return value
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^heads\//, '')
    .replace(/\s+/g, '-')
    .replace(/^\/+|\/+$/g, '')
    .split('/').join('-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
};

const normalizeBranchName = (value: string): string => {
  return value
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^heads\//, '')
    .replace(/\s+/g, '-')
    .replace(/^\/+|\/+$/g, '');
};

const deriveSdkWorktreeNameFromDirectory = (directory: string): string => {
  const normalized = normalizePath(directory);
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
};

export const buildSdkStartCommand = (args: {
  projectDirectory: string;
  setupCommands: string[];
}): string | undefined => {
  const commands: string[] = [];

  for (const raw of args.setupCommands) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    commands.push(
      substituteCommandVariables(trimmed, { rootWorktreePath: args.projectDirectory })
    );
  }

  const joined = commands.filter(Boolean).join(' && ');
  return joined.trim().length > 0 ? joined : undefined;
};

// Exported for unit testing (toCreatePayload defaulting + D2 seed). Used internally below.
export const toCreatePayload = (args: {
  preferredName?: string;
  setupCommands?: string[];
  mode?: 'new' | 'existing';
  worktreeName?: string;
  branchName?: string;
  existingBranch?: string;
  startRef?: string;
  setUpstream?: boolean;
  upstreamRemote?: string;
  upstreamBranch?: string;
  ensureRemoteName?: string;
  ensureRemoteUrl?: string;
  siblingWorktree?: boolean;
}, projectDirectory: string): CreateGitWorktreePayload => {
  const mode = args.mode === 'existing' ? 'existing' : 'new';

  // The `args.branchName` fallback is intentional (decision D2): a branch-only caller still yields
  // `repo.<branch-slug>`. This applies in both sibling and default modes.
  const worktreeNameSeed = args.worktreeName ?? args.preferredName ?? args.branchName ?? '';
  const worktreeName = slugifyWorktreeName(worktreeNameSeed);

  const branchNameSeed = args.branchName ?? (mode === 'new' ? args.preferredName : undefined) ?? '';
  const branchName = normalizeBranchName(branchNameSeed);

  const existingBranch = normalizeBranchName(args.existingBranch ?? args.branchName ?? '');
  const startRef = (args.startRef || '').trim();

  const commands = Array.isArray(args.setupCommands) ? args.setupCommands : [];
  const startCommand = buildSdkStartCommand({
    projectDirectory,
    setupCommands: commands,
  });

  return {
    mode,
    ...(worktreeName ? { worktreeName } : {}),
    ...(branchName ? { branchName } : {}),
    ...(existingBranch ? { existingBranch } : {}),
    ...(startRef ? { startRef } : {}),
    ...(startCommand ? { startCommand } : {}),
    ...(args.setUpstream ? { setUpstream: true } : {}),
    ...(args.upstreamRemote ? { upstreamRemote: args.upstreamRemote } : {}),
    ...(args.upstreamBranch ? { upstreamBranch: args.upstreamBranch } : {}),
    ...(args.ensureRemoteName ? { ensureRemoteName: args.ensureRemoteName } : {}),
    ...(args.ensureRemoteUrl ? { ensureRemoteUrl: args.ensureRemoteUrl } : {}),
    ...((args.siblingWorktree ?? useConfigStore.getState().settingsWorktreeSiblingsEnabled) ? { siblingWorktree: true } : {}),
  };
};

// Cache worktree listings to avoid repeated git worktree list + rev-parse calls
const _worktreeListCache = new Map<string, { value: WorktreeMetadata[]; at: number }>();
const _worktreeListInflight = new Map<string, Promise<WorktreeMetadata[]>>();
const WORKTREE_LIST_CACHE_TTL = 30_000; // 30 seconds

export async function listProjectWorktrees(project: ProjectRef): Promise<WorktreeMetadata[]> {
  const projectDirectory = normalizePath(project.path);

  // Return cached if fresh
  const cached = _worktreeListCache.get(projectDirectory);
  if (cached && Date.now() - cached.at < WORKTREE_LIST_CACHE_TTL) {
    return cached.value;
  }

  // Dedup in-flight requests
  const inflight = _worktreeListInflight.get(projectDirectory);
  if (inflight) return inflight;

  const promise = (async (): Promise<WorktreeMetadata[]> => {
    const metadataProjectDirectory = await resolveProjectRoot(projectDirectory).catch(() => projectDirectory);
    const normalizedProjectDirectory = normalizePath(projectDirectory);

    const worktrees = await git.worktree.list(projectDirectory).catch(() => []);
    const results: WorktreeMetadata[] = worktrees
      .filter((entry) => typeof entry.path === 'string' && entry.path.trim().length > 0)
      .map((entry) => {
        const worktreePath = normalizePath(entry.path);
        const branch = (entry.branch || '').replace(/^refs\/heads\//, '').trim();
        const name = (entry.name || '').trim();

        // Derive canonical worktree metadata from worktree list entry
        const canonical = deriveCanonicalWorktreeFields(entry, worktreePath);

        return {
          source: 'sdk' as const,
          name: name || deriveSdkWorktreeNameFromDirectory(worktreePath),
          path: worktreePath,
          projectDirectory: metadataProjectDirectory,
          branch: branch,
          label: branch || name || deriveSdkWorktreeNameFromDirectory(worktreePath),
          worktreeRoot: canonical.worktreeRoot,
          worktreeStatus: canonical.worktreeStatus,
          headState: canonical.headState,
          worktreeSource: canonical.worktreeSource,
        };
      })
      .filter((entry) => normalizePath(entry.path) !== normalizedProjectDirectory);

    const sorted = results.sort((a, b) => {
      const aLabel = (a.label || a.branch || a.path).toLowerCase();
      const bLabel = (b.label || b.branch || b.path).toLowerCase();
      return aLabel.localeCompare(bLabel);
    });

    _worktreeListCache.set(projectDirectory, { value: sorted, at: Date.now() });
    return sorted;
  })().finally(() => {
    _worktreeListInflight.delete(projectDirectory);
  });

  _worktreeListInflight.set(projectDirectory, promise);
  return promise;
}

export type CreateWorktreeArgs = {
  preferredName?: string;
  setupCommands?: string[];
  mode?: 'new' | 'existing';
  worktreeName?: string;
  branchName?: string;
  existingBranch?: string;
  startRef?: string;
  setUpstream?: boolean;
  upstreamRemote?: string;
  upstreamBranch?: string;
  ensureRemoteName?: string;
  ensureRemoteUrl?: string;
  siblingWorktree?: boolean;
};

export async function createWorktree(project: ProjectRef, args: CreateWorktreeArgs): Promise<WorktreeMetadata> {
  const projectDirectory = normalizePath(project.path);
  const metadataProjectDirectory = await resolveProjectRoot(projectDirectory).catch(() => projectDirectory);
  const payload = toCreatePayload(args, projectDirectory);

  const created = await git.worktree.create(projectDirectory, payload);
  const returnedName = typeof created?.name === 'string' ? created.name : '';
  const returnedBranch = typeof created?.branch === 'string' ? created.branch : '';
  const returnedPath = typeof created?.path === 'string' ? created.path : '';

  if (!returnedName || !returnedPath) {
    throw new Error('Worktree create missing name/path');
  }

  const metadata: WorktreeMetadata = {
    source: 'sdk',
    name: returnedName,
    path: normalizePath(returnedPath),
    projectDirectory: metadataProjectDirectory,
    branch: returnedBranch,
    label: returnedBranch || returnedName,
    worktreeRoot: normalizePath(returnedPath),
    worktreeStatus: 'ready',
    headState: returnedBranch ? 'branch' : 'unborn',
    worktreeSource: 'created-for-session',
  };

  markWorktreeBootstrapPending(metadata.path);

  _worktreeListCache.delete(projectDirectory);
  // The new worktree changes the repo's worktree topology; drop cached root
  // resolutions so root-branch lookups re-resolve against the new layout.
  invalidateResolvedProjectRootCache();

  // Update sidebar store so new worktree appears immediately
  const sidebarProjectKey = projectDirectory;
  const currentByProject = useSessionUIStore.getState().availableWorktreesByProject;
  const updatedByProject = new Map(currentByProject);
  const existing = updatedByProject.get(sidebarProjectKey) ?? [];
  updatedByProject.set(sidebarProjectKey, [...existing, metadata]);
  useSessionUIStore.setState({
    availableWorktreesByProject: updatedByProject,
    availableWorktrees: [...useSessionUIStore.getState().availableWorktrees, metadata],
  });

  return metadata;
}

export async function validateWorktreeCreate(project: ProjectRef, args: CreateWorktreeArgs): Promise<GitWorktreeValidationResult> {
  const projectDirectory = project.path;
  const payload = toCreatePayload(args, projectDirectory);
  return git.worktree.validate(projectDirectory, payload);
}

export async function removeProjectWorktree(project: ProjectRef, worktree: WorktreeMetadata, options?: {
  deleteRemoteBranch?: boolean;
  deleteLocalBranch?: boolean;
  remoteName?: string;
}): Promise<void> {
  const projectDirectory = normalizePath(project.path);

  const deleteRemote = Boolean(options?.deleteRemoteBranch);
  const deleteLocalBranch = options?.deleteLocalBranch === true;
  const remoteName = options?.remoteName;
  const raw = await git.worktree.remove(projectDirectory, {
    directory: worktree.path,
    deleteLocalBranch,
  });
  if (!raw?.success) {
    throw new Error('Worktree removal failed');
  }

  clearWorktreeBootstrapState(worktree.path);

  _worktreeListCache.delete(normalizePath(project.path));
  // Removing a worktree changes the repo's worktree topology; drop cached root
  // resolutions so root-branch lookups re-resolve against the new layout.
  invalidateResolvedProjectRootCache();

  // Update sidebar store so removed worktree disappears immediately
  const normalizedWorktreePath = normalizePath(worktree.path);
  const sidebarProjectKey = projectDirectory;
  const currentByProject = useSessionUIStore.getState().availableWorktreesByProject;
  const updatedByProject = new Map(currentByProject);
  const projectWorktrees = updatedByProject.get(sidebarProjectKey) ?? [];
  updatedByProject.set(
    sidebarProjectKey,
    projectWorktrees.filter((w) => normalizePath(w.path) !== normalizedWorktreePath),
  );

  // Clean up worktreeMetadata for sessions in the removed worktree
  const currentMetadata = useSessionUIStore.getState().worktreeMetadata;
  const updatedMetadata = new Map(currentMetadata);
  for (const [sid, meta] of currentMetadata.entries()) {
    if (meta && normalizePath(meta.path) === normalizedWorktreePath) {
      updatedMetadata.delete(sid);
    }
  }

  useSessionUIStore.setState({
    availableWorktreesByProject: updatedByProject,
    availableWorktrees: useSessionUIStore.getState().availableWorktrees.filter(
      (w) => normalizePath(w.path) !== normalizedWorktreePath,
    ),
    worktreeMetadata: updatedMetadata,
  });

  const branchName = (worktree.branch || '').replace(/^refs\/heads\//, '').trim();
  if (deleteRemote && branchName) {
    await deleteRemoteBranch(projectDirectory, { branch: branchName, remote: remoteName }).catch(() => undefined);
  }
}
