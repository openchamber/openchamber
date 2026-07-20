import type { VcsFileDiff } from '@opencode-ai/sdk/v2';
import type { VcsInfo } from '@opencode-ai/sdk/v2/client';

type BranchDiffResult = {
  data?: VcsFileDiff[];
  error?: unknown;
  response?: { status?: number };
};

type BranchDiffEntry = {
  path: string;
  index: string;
  working_dir: string;
  insertions: number;
  deletions: number;
  isNew: boolean;
  patch: string | null;
  readOnly: true;
};

const formatSdkError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const statusToGitCode = (status?: VcsFileDiff['status']): string => {
  if (status === 'added') return 'A';
  if (status === 'deleted') return 'D';
  return 'M';
};

const hasRenderablePatch = (patch: string | undefined): patch is string => {
  if (!patch?.trim()) return false;
  return /^diff --git /m.test(patch)
    || /^@@ /m.test(patch)
    || /^Binary files .+ differ$/m.test(patch)
    || /^GIT binary patch$/m.test(patch);
};

export const isBranchDiffAvailable = (vcs: VcsInfo | undefined): boolean => {
  const branch = vcs?.branch?.trim();
  const defaultBranch = vcs?.default_branch?.trim();
  return Boolean(branch && defaultBranch && branch !== defaultBranch);
};

export const loadBranchDiff = async (
  request: (
    input: { mode: 'branch'; context: number; directory: string },
    options?: { signal?: AbortSignal },
  ) => Promise<BranchDiffResult>,
  directory: string,
  signal?: AbortSignal,
): Promise<VcsFileDiff[]> => {
  const result = await request({ mode: 'branch', context: 3, directory }, { signal });
  if (result.error) {
    const status = result.response?.status;
    throw new Error(`Branch diff failed${status ? ` (${status})` : ''}: ${formatSdkError(result.error)}`);
  }
  if (!Array.isArray(result.data)) {
    throw new Error('Branch diff failed: empty response');
  }
  return result.data;
};

export const mapBranchDiffEntries = (diffs: VcsFileDiff[]): BranchDiffEntry[] =>
  diffs
    .filter((diff) => Boolean(diff.file?.trim()))
    .map((diff) => ({
      path: diff.file,
      index: '',
      working_dir: statusToGitCode(diff.status),
      insertions: diff.additions,
      deletions: diff.deletions,
      isNew: diff.status === 'added',
      patch: hasRenderablePatch(diff.patch) ? diff.patch : null,
      readOnly: true as const,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
