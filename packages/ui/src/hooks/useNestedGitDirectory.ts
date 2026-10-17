import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import {
  useEffectiveGitDirectory,
  useGitStore,
  useGitStatus,
  useIsGitRepo,
  useNestedRepoSelection,
  useNestedRepos,
  useStaleClearedSelections,
  type NestedRepoDiscovery,
} from '@/stores/useGitStore';

type UseNestedGitDirectoryOptions = {
  /** False defers all probing/discovery work while the surface is hidden. */
  enabled?: boolean;
  /**
   * Re-probe a cached "not a repository" root each time the surface becomes
   * enabled. For surfaces the user opens to look at git (Changes, Git), not
   * for ones that render alongside every session.
   */
  recheckOnOpen?: boolean;
};

/**
 * Whether nested repository discovery applies to a root. A root that is not a
 * repository has nested repositories to find. An unborn root repository (a
 * fresh `git init` with no commits) is a repository, but its `.git` does not
 * hide the directories below, so discovery runs for it too. An established
 * root hides everything below it, so discovery stays off and its resolution
 * keeps today's behavior.
 */
export const shouldDiscoverNestedRepositories = (
  rootIsGitRepo: boolean | null,
  rootIsUnborn: boolean,
): boolean => rootIsGitRepo === false || (rootIsGitRepo === true && rootIsUnborn);

/** Discovered repository paths, or `null` when discovery failed, is unsupported, or has not run. */
const discoveredRepositories = (discovery: NestedRepoDiscovery | undefined): string[] | null =>
  discovery !== undefined && discovery !== null && discovery !== 'unsupported'
    ? discovery.repositories
    : null;

type RepositoryOptionsInput = {
  root: string | null;
  rootIsGitRepo: boolean | null;
  rootIsUnborn: boolean;
  nestedRepos: NestedRepoDiscovery | undefined;
  nestedRepoSelection: string | null;
  /** Repositories whose selection already failed its probe; auto-select skips them. */
  staleClearedSelections?: ReadonlySet<string> | null;
};

/**
 * The options a repository picker should render, or `null` when no picker
 * belongs on the surface. An unborn root lists itself first, so switching to a
 * nested repository stays reversible. A non-repository root lists the
 * discovered repositories once a nested one is selected: auto-select picks the
 * first one, and until that lands resolution is still settling. With nothing
 * selected it lists them too once every discovered repository was already
 * stale-cleared: auto-select has no candidate left, so the picker is the only
 * way to re-pick one. A stored selection equal to the root is not a nested
 * selection and counts as none. Anything else (established root, failed or
 * unsupported discovery, no repositories) has no choice to offer.
 */
export const resolveRepositoryOptions = ({
  root,
  rootIsGitRepo,
  rootIsUnborn,
  nestedRepos,
  nestedRepoSelection,
  staleClearedSelections,
}: RepositoryOptionsInput): string[] | null => {
  const repositories = discoveredRepositories(nestedRepos);
  if (!repositories || repositories.length === 0) return null;
  if (rootIsUnborn) {
    return root ? [root, ...repositories] : null;
  }
  if (rootIsGitRepo !== false) return null;
  const hasSelection = Boolean(nestedRepoSelection && nestedRepoSelection !== root);
  // With nothing selected, auto-select is about to pick the first repository
  // that has not failed its probe. Once every one was stale-cleared there is
  // no candidate left, and the picker is the only way to re-pick one.
  const everyRepositoryStaleCleared = repositories.every((repository) =>
    staleClearedSelections?.has(repository),
  );
  return hasSelection || everyRepositoryStaleCleared ? repositories : null;
};

/**
 * Resolves the repository a git surface operates on when the project root may
 * not itself be an established git repository. Owns the full resolution flow:
 * probing the root, discovering nested repositories, auto-selecting the first
 * one, and dropping a selection whose repository disappeared.
 *
 * Consumers still fetch their own git data for the returned `gitDirectory`;
 * this hook only owns who that directory is.
 */
export const useNestedGitDirectory = (
  root: string | null,
  options: UseNestedGitDirectoryOptions = {},
) => {
  const { enabled = true, recheckOnOpen = false } = options;
  const { git } = useRuntimeAPIs();

  const rootIsGitRepo = useIsGitRepo(root);
  const rootStatus = useGitStatus(root);
  const rootIsUnborn = rootStatus?.unborn === true;
  const gitDirectory = useEffectiveGitDirectory(root);
  const nestedRepos = useNestedRepos(root);
  const nestedRepoSelection = useNestedRepoSelection(root);
  const staleClearedSelections = useStaleClearedSelections(root);

  // Probe of the resolved repository, used to detect a stale selection. Null
  // when there is nothing selected to probe.
  const selectedIsGitRepo = useIsGitRepo(
    gitDirectory && gitDirectory !== root ? gitDirectory : null,
  );

  const { ensureStatus, recheckRepository, ensureNestedRepos, selectNestedRepo, clearNestedRepoSelection } = useGitStore(
    useShallow((state) => ({
      ensureStatus: state.ensureStatus,
      recheckRepository: state.recheckRepository,
      ensureNestedRepos: state.ensureNestedRepos,
      selectNestedRepo: state.selectNestedRepo,
      clearNestedRepoSelection: state.clearNestedRepoSelection,
    })),
  );

  // Probe the root itself so nested-repo resolution never depends on some
  // other surface (e.g. the sidebar badge) having probed it first.
  React.useEffect(() => {
    if (!enabled || !root) return;
    if (rootIsGitRepo !== null) return;
    void ensureStatus(root, git);
  }, [enabled, ensureStatus, git, root, rootIsGitRepo]);

  // A cached "not a repository" answer may be stale: `git init` in a terminal
  // or by an agent leaves no event behind. A cached unborn answer goes stale
  // the same way once its first commit lands, and until a fresh probe sees it
  // the established-root behavior never takes effect. Opening the surface
  // checks both again, once per opening, so it never needs to poll.
  React.useEffect(() => {
    if (!recheckOnOpen || !enabled || !root) return;
    const directoryState = useGitStore.getState().directories.get(root);
    const cachedNotRepository = directoryState?.isGitRepo === false;
    const cachedUnborn = directoryState?.isGitRepo === true && directoryState.status?.unborn === true;
    if (!cachedNotRepository && !cachedUnborn) return;
    void recheckRepository(root, git);
  }, [enabled, git, recheckOnOpen, recheckRepository, root]);

  // Discover nested repositories once the root probe confirms it is not one,
  // or is an unborn repository whose `.git` hides nothing below it.
  React.useEffect(() => {
    if (!enabled || !root) return;
    if (!shouldDiscoverNestedRepositories(rootIsGitRepo, rootIsUnborn)) return;
    void ensureNestedRepos(root);
  }, [enabled, ensureNestedRepos, root, rootIsGitRepo, rootIsUnborn]);

  // Auto-select the first nested repository so the surface opens straight
  // into repository data; a picker (where rendered) switches between them.
  // Repositories whose selection already failed a probe are skipped: without
  // this, a corrupt repository (discovered via its .git entry but failing
  // git status) would be re-picked right after every stale-clear and loop
  // discovery + probe while the surface is visible. When every candidate has
  // failed, no selection is made — surfaces settle into their unresolved
  // state instead of churning requests. A manual picker pick is still free
  // to select anything; it gets probed like any other. An unborn root never
  // auto-selects: it is a repository the user may deliberately stay on.
  React.useEffect(() => {
    if (!enabled || !root) return;
    if (rootIsGitRepo !== false) return;
    const repositories = discoveredRepositories(nestedRepos);
    if (!repositories || repositories.length === 0) return;
    // A stored selection equal to the root is not a nested pick: the root
    // either stopped being a repository or never was one, so auto-select runs.
    if (nestedRepoSelection && nestedRepoSelection !== root) return;
    const candidates = staleClearedSelections
      ? repositories.filter((repository) => !staleClearedSelections.has(repository))
      : repositories;
    if (candidates.length === 0) return;
    selectNestedRepo(root, candidates[0]);
  }, [
    enabled,
    nestedRepos,
    nestedRepoSelection,
    root,
    rootIsGitRepo,
    selectNestedRepo,
    staleClearedSelections,
  ]);

  // A selected repository that is no longer a git repository is stale: drop
  // the selection and re-scan so resolution reflects the current tree. A
  // selection equal to the root is not a nested selection to recover.
  React.useEffect(() => {
    if (!enabled || !root || !nestedRepoSelection) return;
    if (nestedRepoSelection === root) return;
    if (!gitDirectory || gitDirectory === root) return;
    if (selectedIsGitRepo !== false) return;
    clearNestedRepoSelection(root);
    void ensureNestedRepos(root, { force: true });
  }, [
    clearNestedRepoSelection,
    enabled,
    ensureNestedRepos,
    gitDirectory,
    nestedRepoSelection,
    root,
    selectedIsGitRepo,
  ]);

  const repositoryOptions = resolveRepositoryOptions({
    root,
    rootIsGitRepo,
    rootIsUnborn,
    nestedRepos,
    nestedRepoSelection,
    staleClearedSelections,
  });

  return {
    rootIsGitRepo,
    rootIsUnborn,
    gitDirectory,
    nestedRepos,
    nestedRepoSelection,
    repositoryOptions,
  };
};
