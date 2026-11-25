import { normalizePath as normalizePathImpl } from '@/lib/pathNormalization';
import type { WorktreeMetadata } from '@/types/worktree';

const normalizePath = (value: string | null | undefined): string => normalizePathImpl(value) ?? '';

type WorktreeListEntry = {
  path?: string;
  branch?: string;
  head?: string;
  name?: string;
  prunable?: boolean;
  title?: string;
  pinnedAt?: number;
  pinList?: string;
  integrateCheckout?: true;
  provenance?: WorktreeMetadata['provenance'];
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
    worktreeStatus: entry.prunable === true ? 'missing' : 'ready',
    headState: deriveHeadStateFromWorktreeEntry(entry),
    worktreeSource: 'existing',
  };
};

const deriveSdkWorktreeNameFromDirectory = (directory: string): string => {
  const normalized = normalizePath(directory);
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
};

export type ProjectWorktreeListing = { repositoryRoot: string; worktrees: WorktreeMetadata[]; integrateCheckouts: string[] };

const toWorktreeMetadata = (entry: WorktreeListEntry, repositoryRoot: string): WorktreeMetadata => {
  const worktreePath = normalizePath(entry.path);
  const branch = (entry.branch || '').replace(/^refs\/heads\//, '').trim();
  const name = (entry.name || '').trim();
  const pinned = (entry.pinnedAt ?? 0) > 0;
  const metadata: WorktreeMetadata = {
    source: 'sdk' as const,
    name: name || deriveSdkWorktreeNameFromDirectory(worktreePath),
    path: worktreePath,
    projectDirectory: repositoryRoot,
    branch,
    label: branch || name || deriveSdkWorktreeNameFromDirectory(worktreePath),
    ...deriveCanonicalWorktreeFields(entry, worktreePath),
    title: entry.title?.trim() || undefined,
    pinnedAt: pinned ? entry.pinnedAt : undefined,
    pinList: pinned ? entry.pinList || undefined : undefined,
  };
  if (entry.provenance) metadata.provenance = entry.provenance;
  return metadata;
};

export const toProjectWorktreeListing = (
  listed: readonly WorktreeListEntry[],
  projectDirectory: string,
  repositoryRoot: string,
): ProjectWorktreeListing => {
  const normalizedProjectDirectory = normalizePath(projectDirectory);
  const rows = listed.filter((entry) => typeof entry.path === 'string' && entry.path.trim().length > 0);
  const worktrees = rows
    .filter((entry) => entry.integrateCheckout !== true)
    .map((entry) => toWorktreeMetadata(entry, repositoryRoot))
    .filter((entry) => normalizePath(entry.path) !== normalizedProjectDirectory)
    .sort((a, b) => {
      const aLabel = (a.label || a.branch || a.path).toLowerCase();
      const bLabel = (b.label || b.branch || b.path).toLowerCase();
      return aLabel.localeCompare(bLabel);
    });
  const integrateCheckouts = rows.filter((entry) => entry.integrateCheckout === true).map((entry) => normalizePath(entry.path));
  return { repositoryRoot, worktrees, integrateCheckouts };
};
