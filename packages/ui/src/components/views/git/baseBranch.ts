export const branchRefLabel = (ref: string): string => ref.replace(/^refs\/(heads|remotes)\//, '').replace(/^remotes\//, '');

export const comparisonBaseBranchName = (ref: string, primaryRemote: string | null | undefined): string => {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  return primaryRemote && ref.startsWith(`${primaryRemote}/`) ? ref.slice(primaryRemote.length + 1) : ref;
};

export const deriveBaseBranch = (options: {
  remoteNames: ReadonlySet<string>;
  knownRemoteNames?: ReadonlySet<string>;
  localBranches: readonly string[];
  worktreeCreatedFromBranch?: string | null;
  rootBranchHint?: string | null;
  defaultBranch?: string | null;
  fallbackToConventional?: boolean;
  headBranch?: string | null;
}): string => {
  const {
    remoteNames,
    knownRemoteNames = remoteNames,
    localBranches,
    worktreeCreatedFromBranch,
    rootBranchHint,
    defaultBranch,
    fallbackToConventional = true,
    headBranch,
  } = options;

  const head = typeof headBranch === 'string' ? headBranch.trim() : '';

  const normalizeBaseCandidate = (value: string): string => {
    if (!value) {
      return '';
    }

    let normalized = value.trim();
    if (!normalized || normalized === 'HEAD') {
      return '';
    }

    if (localBranches.includes(normalized)) {
      return normalized;
    }

    if (normalized.startsWith('refs/heads/')) {
      normalized = normalized.slice('refs/heads/'.length);
    }
    if (normalized.startsWith('heads/')) {
      normalized = normalized.slice('heads/'.length);
    }
    if (normalized.startsWith('remotes/')) {
      normalized = normalized.slice('remotes/'.length);
    }

    const slashIndex = normalized.indexOf('/');
    if (slashIndex > 0) {
      const maybeRemote = normalized.slice(0, slashIndex);
      if (knownRemoteNames.has(maybeRemote)) {
        if (!remoteNames.has(maybeRemote)) return '';
        const withoutRemote = normalized.slice(slashIndex + 1).trim();
        if (withoutRemote) {
          normalized = withoutRemote;
        }
      }
    }

    return normalized;
  };

  const candidate = (value: unknown): string => {
    const normalized = normalizeBaseCandidate(typeof value === 'string' ? value : '');
    return normalized && normalized !== head ? normalized : '';
  };

  const fromMeta = candidate(worktreeCreatedFromBranch);
  if (fromMeta) return fromMeta;

  const fromHint = candidate(rootBranchHint);
  if (fromHint) return fromHint;

  const fromDefault = candidate(defaultBranch);
  if (fromDefault) return fromDefault;

  if (!fallbackToConventional) return '';
  if (localBranches.includes('main')) return 'main';
  if (localBranches.includes('master')) return 'master';
  if (localBranches.includes('develop')) return 'develop';
  return 'main';
};

export const hasResolvableBaseBranch = (options: {
  baseBranch: string;
  localBranches: readonly string[];
  remoteBranches: readonly string[];
}): boolean => {
  const { baseBranch, localBranches, remoteBranches } = options;
  if (localBranches.includes(baseBranch)) return true;
  return remoteBranches.some((branch) => {
    const slashIndex = branch.indexOf('/');
    return slashIndex > 0 && branch.slice(slashIndex + 1) === baseBranch;
  });
};

export const qualifyBaseRef = (candidate: string | null | undefined, options: {
  localBranches: readonly string[];
  remoteBranches: readonly string[];
  remoteNames: ReadonlySet<string>;
  primaryRemote: string | null | undefined;
}): string | null => {
  const { localBranches, remoteBranches, remoteNames, primaryRemote } = options;
  const trimmed = candidate?.trim() ?? '';
  if (trimmed.startsWith('refs/heads/')) {
    const local = trimmed.slice('refs/heads/'.length);
    return localBranches.includes(local) ? trimmed : null;
  }
  let branch = trimmed
    .replace(/^refs\/remotes\//, '')
    .replace(/^remotes\//, '');
  if (!branch) return null;
  const slashIndex = branch.indexOf('/');
  if (slashIndex > 0 && remoteNames.has(branch.slice(0, slashIndex)) && !localBranches.includes(branch)) {
    if (branch.slice(0, slashIndex) !== primaryRemote) return null;
    branch = branch.slice(slashIndex + 1);
  }
  if (primaryRemote && remoteBranches.includes(`${primaryRemote}/${branch}`)) return `${primaryRemote}/${branch}`;
  if (localBranches.includes(branch)) return `refs/heads/${branch}`;
  return null;
};

export const resolveRecordedBaseRef = (recorded: string, options: {
  localBranches: readonly string[];
  remoteBranches: readonly string[];
  headBranch: string;
}): string | null => {
  const { localBranches, remoteBranches, headBranch } = options;
  if (recorded.startsWith('refs/heads/')) {
    const local = recorded.slice('refs/heads/'.length);
    return local !== headBranch && localBranches.includes(local) ? recorded : null;
  }
  const name = recorded.replace(/^refs\/remotes\//, '');
  if (remoteBranches.includes(name)) return name;
  if (recorded === name && !name.includes('/') && name !== headBranch && localBranches.includes(name)) return `refs/heads/${name}`;
  return null;
};

export type BranchComparisonBaseSource = 'chosen' | 'pull-request' | 'created-from' | 'default';

export const resolveBranchComparisonBase = (candidates: {
  chosen: string | null;
  pullRequest: string | null;
  createdFrom: string | null;
  defaultBranch: string | null;
}, options: Parameters<typeof qualifyBaseRef>[1] & { headBranch: string }): { ref: string; source: BranchComparisonBaseSource } | null => {
  const order: Array<[BranchComparisonBaseSource, string | null]> = [
    ['chosen', candidates.chosen],
    ['pull-request', candidates.pullRequest],
    ['created-from', candidates.createdFrom],
    ['default', candidates.defaultBranch],
  ];
  for (const [source, candidate] of order) {
    const ref = qualifyBaseRef(candidate, options);
    if (!ref) continue;
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref.slice(`${options.primaryRemote}/`.length);
    if (branch !== options.headBranch) return { ref, source };
  }
  return null;
};
