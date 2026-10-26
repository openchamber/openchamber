export const branchRefLabel = (ref: string): string => ref.replace(/^refs\/(heads|remotes)\//, '').replace(/^remotes\//, '');

/** The branch a qualified comparison base names: `origin/feat` and `refs/heads/feat` are both `feat`. */
export const comparisonBaseBranchName = (ref: string, primaryRemote: string | null | undefined): string => {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  return primaryRemote && ref.startsWith(`${primaryRemote}/`) ? ref.slice(primaryRemote.length + 1) : ref;
};

/**
 * Derives the base ("target") branch a feature branch should compare and
 * merge against. Shared by GitView and the standalone pull-request surface so
 * both resolve the same base for the same repository state.
 */
export const deriveBaseBranch = (options: {
  /** Remotes authorized to supply the base branch. */
  remoteNames: ReadonlySet<string>;
  /** All repository remotes, used to reject a remote-qualified hint outside the binding. */
  knownRemoteNames?: ReadonlySet<string>;
  localBranches: readonly string[];
  worktreeCreatedFromBranch?: string | null;
  rootBranchHint?: string | null;
  /**
   * The repository's own default branch, read from a `remote/HEAD` symbolic
   * ref. Its own option rather than another hint: `rootBranchHint` means "the
   * branch the project root worktree is on", and a parameter that means two
   * things is one the next caller gets wrong.
   */
  defaultBranch?: string | null;
  /** Whether to guess a conventional branch when no repository authority resolves a base. */
  fallbackToConventional?: boolean;
  /**
   * The branch being compared. A branch is never its own base, so a candidate
   * equal to it is skipped — in a plain checkout `rootBranchHint` *is* the
   * current branch, and taking it produced a comparison with itself.
   */
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

  // Authoritative where the hints are guesses: this is what the repository says
  // its default branch is, so it outranks the conventional names below.
  const fromDefault = candidate(defaultBranch);
  if (fromDefault) return fromDefault;

  if (!fallbackToConventional) return '';
  if (localBranches.includes('main')) return 'main';
  if (localBranches.includes('master')) return 'master';
  if (localBranches.includes('develop')) return 'develop';
  return 'main';
};

/**
 * Whether a base branch can be resolved locally or through one of the active
 * remote-tracking refs. Callers must not offer comparisons against the `main`
 * fallback when that ref does not actually exist in the repository.
 *
 * `remoteBranches` are remote-relative (`origin/main`, `origin/feature/x`), so
 * the remote name is dropped and the rest compared whole. A suffix test matched
 * `origin/feature/main` for a base of `main`, which passes the check and then
 * fails the comparison it was meant to prevent.
 */
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

/**
 * The ref a comparison should actually name, for a base the person chose or
 * one detected for them.
 *
 * The range API honors refs literally: it never substitutes `origin/main` for
 * `main`, so a caller has to say which one it means. A bare name means the
 * branch a pull request merges into, which is the bound remote's copy, so the
 * remote-tracking ref wins and the local branch answers only when the remote
 * has none (a parent branch that was never pushed). An explicit `refs/heads/`
 * choice stays local. A repository answers to the remote it is bound to, so a
 * base on any other remote is a different project's branch with a familiar
 * name. Null means exactly that: no ref here is the base.
 */
export const qualifyBaseRef = (candidate: string | null | undefined, options: {
  localBranches: readonly string[];
  /** Remote-relative names, as `origin/main`. */
  remoteBranches: readonly string[];
  /** Every remote the repository configures, used to recognise a qualified hint. */
  remoteNames: ReadonlySet<string>;
  /** The remote this repository is bound to, if any. */
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

/** Where a branch comparison's base came from, most authoritative first. */
export type BranchComparisonBaseSource = 'chosen' | 'pull-request' | 'created-from' | 'default';

/**
 * The base a branch is compared against: the person's choice, else the base
 * of the branch's open pull request (what it will actually merge into, and the
 * parent of a stacked branch even after a rebase), else what the reflog says
 * the branch was created from, else the repository's default branch. Each
 * candidate is qualified, and one that names no ref here, or the branch
 * itself or its own remote copy, gives way to the next.
 */
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
    // The branch's own remote copy is not its base either.
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref.slice(`${options.primaryRemote}/`.length);
    if (branch !== options.headBranch) return { ref, source };
  }
  return null;
};
