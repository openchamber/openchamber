import { normalizePath } from '@/lib/pathNormalization';
import type { WalkthroughHunk, WalkthroughSource } from '@/lib/walkthrough/types';

export type WorkingTreeSide = 'working' | 'staged';

export type ReviewedFilesScope =
  | { kind: 'working-tree'; scope: WorkingTreeSide }
  | { kind: 'branch'; baseRef: string; headRef: string }
  | { kind: 'commit'; hash: string }
  | { kind: 'pr'; number: number; sourceRepo?: { owner: string; repo: string } }
  | { kind: 'turn'; sessionId: string; turnId?: string };

export interface ReviewedFileFingerprint {
  meta?: string;
  patchHash?: string;
  walkthroughHash?: string;
}

interface DiffFileLike {
  path: string;
  index: string;
  working_dir: string;
  previousPath?: string;
  insertions: number;
  deletions: number;
}

export const reviewedFilesScopeFromWalkthrough = (
  source: Exclude<WalkthroughSource, { kind: 'working-tree'; scope: 'all' }>,
): ReviewedFilesScope => {
  switch (source.kind) {
    case 'working-tree':
      return { kind: 'working-tree', scope: source.scope === 'staged' ? 'staged' : 'working' };
    case 'branch':
      return { kind: 'branch', baseRef: source.baseRef, headRef: source.headRef };
    case 'commit':
      return { kind: 'commit', hash: source.hash };
    case 'pr':
      return { kind: 'pr', number: source.number, sourceRepo: source.sourceRepo };
  }
};

export const reviewedFilesScopeKey = (
  runtimeKey: string,
  directory: string,
  scope: ReviewedFilesScope,
): string => {
  const normalizedDirectory = normalizePath(directory);
  switch (scope.kind) {
    case 'working-tree':
      return `${runtimeKey}\0${normalizedDirectory}\0working-tree:${scope.scope}`;
    case 'branch':
      return `${runtimeKey}\0${normalizedDirectory}\0branch:${scope.baseRef}\0${scope.headRef}`;
    case 'commit':
      return `${runtimeKey}\0${normalizedDirectory}\0commit:${scope.hash}`;
    case 'pr': {
      const repo = scope.sourceRepo ? `${scope.sourceRepo.owner}/${scope.sourceRepo.repo}` : '';
      return `${runtimeKey}\0${normalizedDirectory}\0pr:${repo}\0${scope.number}`;
    }
    case 'turn':
      return `${runtimeKey}\0${normalizedDirectory}\0turn:${scope.sessionId}\0${scope.turnId ?? 'latest'}`;
  }
};

const hashReviewedContent = (input: string): string => {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code ^ (i & 0xff);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
};

export const buildWalkthroughFileFingerprints = (
  hunks: readonly WalkthroughHunk[],
): Map<string, ReviewedFileFingerprint> => {
  const byPath = new Map<string, WalkthroughHunk[]>();
  for (const hunk of hunks) {
    const list = byPath.get(hunk.path);
    if (list) list.push(hunk);
    else byPath.set(hunk.path, [hunk]);
  }
  const result = new Map<string, ReviewedFileFingerprint>();
  for (const [path, fileHunks] of byPath) {
    const payload = fileHunks
      .map((hunk) => `${hunk.status}\0${hunk.oldPath ?? ''}\0${hunk.patch}`)
      .join('\0\0');
    result.set(path, { walkthroughHash: hashReviewedContent(payload) });
  }
  return result;
};

export const buildWalkthroughWorkingTreeFingerprints = (
  hunks: readonly WalkthroughHunk[],
) => {
  const workingHunks: WalkthroughHunk[] = [];
  const stagedHunks: WalkthroughHunk[] = [];
  for (const hunk of hunks) {
    if (hunk.scope === 'staged') stagedHunks.push(hunk);
    else workingHunks.push(hunk);
  }
  return {
    working: buildWalkthroughFileFingerprints(workingHunks),
    staged: buildWalkthroughFileFingerprints(stagedHunks),
  };
};

export const buildDiffFileFingerprint = (
  file: DiffFileLike,
  options?: {
    revision?: string;
    patch?: string;
    original?: string;
    modified?: string;
  },
): ReviewedFileFingerprint => {
  const meta = options?.revision
    ? `rev:${options.revision}`
    : `st:${file.index}:${file.working_dir}:${file.previousPath ?? ''}:${file.insertions}:${file.deletions}`;

  let patchHash: string | undefined;
  if (options?.patch !== undefined) {
    patchHash = hashReviewedContent(options.patch);
  } else if (options?.original !== undefined || options?.modified !== undefined) {
    patchHash = hashReviewedContent(`${options.original ?? ''}\0${options.modified ?? ''}`);
  }

  return patchHash ? { meta, patchHash } : { meta };
};

export const doesReviewedFingerprintMatch = (
  stored: ReviewedFileFingerprint,
  current?: ReviewedFileFingerprint,
): boolean => {
  if (!current) return true;
  if (stored.meta !== undefined && current.meta !== undefined && stored.meta !== current.meta) {
    return false;
  }
  if (stored.patchHash !== undefined && current.patchHash !== undefined && stored.patchHash !== current.patchHash) {
    return false;
  }
  if (
    stored.walkthroughHash !== undefined
    && current.walkthroughHash !== undefined
    && stored.walkthroughHash !== current.walkthroughHash
  ) {
    return false;
  }
  return true;
};

export const mergeReviewedFingerprint = (
  stored: ReviewedFileFingerprint,
  current: ReviewedFileFingerprint,
): ReviewedFileFingerprint | null => {
  let changed = false;
  const next: ReviewedFileFingerprint = { ...stored };
  if (next.meta === undefined && current.meta !== undefined) {
    next.meta = current.meta;
    changed = true;
  }
  if (next.patchHash === undefined && current.patchHash !== undefined) {
    next.patchHash = current.patchHash;
    changed = true;
  }
  if (next.walkthroughHash === undefined && current.walkthroughHash !== undefined) {
    next.walkthroughHash = current.walkthroughHash;
    changed = true;
  }
  return changed ? next : null;
};
