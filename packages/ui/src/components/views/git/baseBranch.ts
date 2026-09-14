export const branchRefLabel = (ref: string): string => ref.replace(/^refs\/(heads|remotes)\//, '').replace(/^remotes\//, '');

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
 * the repository's reflog reported.
 *
 * The range API honors refs literally: it never substitutes `origin/main` for
 * `main`, so a caller has to say which one it means. And a repository answers
 * to the remote it is bound to, so a base on any other remote is not a
 * comparison this repository can make — it is a different project's branch
 * with a familiar name. Null means exactly that: no ref here is the base.
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
  let branch = candidate?.trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\//, '')
    .replace(/^remotes\//, '') ?? '';
  if (!branch) return null;
  if (localBranches.includes(branch)) return `refs/heads/${branch}`;
  const slashIndex = branch.indexOf('/');
  if (slashIndex > 0 && remoteNames.has(branch.slice(0, slashIndex))) {
    if (branch.slice(0, slashIndex) !== primaryRemote) return null;
    branch = branch.slice(slashIndex + 1);
  }
  if (primaryRemote && remoteBranches.includes(`${primaryRemote}/${branch}`)) return `${primaryRemote}/${branch}`;
  return null;
};
