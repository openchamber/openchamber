import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { chooseAutoNestedRepo, discoversNestedRepos } from '@/lib/nestedRepositories';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import {
  useEffectiveGitDirectory,
  useGitStore,
  useIsGitRepo,
  useIsUnbornGitRepo,
  useNestedRepoSelection,
  useNestedRepos,
  useStaleClearedSelections,
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
 * Resolves the repository a git surface operates on when the project root may
 * not itself be a git repository. Owns the full resolution flow: probing the
 * root, discovering nested repositories (never in the home directory),
 * auto-selecting the first one that is not under a dot-directory (#5357), and
 * dropping a selection whose repository
 * disappeared.
 *
 * A root repository with no commits yet (a fresh `git init`, #4886) hides
 * nothing below it: discovery keeps running, a nested selection keeps
 * applying, and the picker offers the root next to the nested repositories.
 * It is a repository the user may mean to work in, so nothing is
 * auto-selected for it.
 *
 * Consumers still fetch their own git data for the returned `gitDirectory`;
 * this hook only owns who that directory is. `repositoryOptions` is what a
 * repository picker lists, or null when the surface has no choice to offer.
 */
export const useNestedGitDirectory = (
  root: string | null,
  options: UseNestedGitDirectoryOptions = {},
) => {
  const { enabled = true, recheckOnOpen = false } = options;
  const { git } = useRuntimeAPIs();
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const searchesNested = root ? discoversNestedRepos(root, homeDirectory) : false;

  const rootIsGitRepo = useIsGitRepo(root);
  const rootIsUnborn = useIsUnbornGitRepo(root);
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
  // or by an agent leaves no event behind. So may a cached "no commits yet"
  // answer once the first commit lands while a nested repository is shown.
  // Opening the surface checks again, once per opening, so it never needs to
  // poll.
  React.useEffect(() => {
    if (!recheckOnOpen || !enabled || !root) return;
    const rootState = useGitStore.getState().directories.get(root);
    if (rootState?.isGitRepo !== false && rootState?.status?.unborn !== true) return;
    void recheckRepository(root, git);
  }, [enabled, git, recheckOnOpen, recheckRepository, root]);

  // Discover nested repositories once the root probe confirms it is not one,
  // or is one with no commits yet.
  React.useEffect(() => {
    if (!enabled || !root || !searchesNested) return;
    if (rootIsGitRepo !== false && !rootIsUnborn) return;
    void ensureNestedRepos(root);
  }, [enabled, ensureNestedRepos, root, rootIsGitRepo, rootIsUnborn, searchesNested]);

  // Auto-select the first nested repository so the surface opens straight
  // into repository data; a picker (where rendered) switches between them.
  // Repositories whose selection already failed a probe are skipped: without
  // this, a corrupt repository (discovered via its .git entry but failing
  // git status) would be re-picked right after every stale-clear and loop
  // discovery + probe while the surface is visible. When every candidate has
  // failed, no selection is made — surfaces settle into their unresolved
  // state instead of churning requests. A manual picker pick is still free
  // to select anything; it gets probed like any other.
  React.useEffect(() => {
    if (!enabled || !root) return;
    if (rootIsGitRepo !== false) return;
    if (!Array.isArray(nestedRepos) || nestedRepos.length === 0) return;
    if (nestedRepoSelection) return;
    const candidates = staleClearedSelections
      ? nestedRepos.filter((repository) => !staleClearedSelections.has(repository))
      : nestedRepos;
    // A repository hidden inside a dot-directory is tooling that carries a
    // `.git` (`~/.oh-my-zsh`), so it stays in the picker but is never the
    // automatic pick (#5357).
    const autoSelected = chooseAutoNestedRepo(root, candidates);
    if (!autoSelected) return;
    selectNestedRepo(root, autoSelected);
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
  // the selection and re-scan so resolution reflects the current tree.
  React.useEffect(() => {
    if (!enabled || !root || !nestedRepoSelection) return;
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

  const discovered = Array.isArray(nestedRepos) && nestedRepos.length > 0 ? nestedRepos : null;
  let repositoryOptions: string[] | null = null;
  if (discovered && root && rootIsUnborn) repositoryOptions = [root, ...discovered];
  else if (discovered && rootIsGitRepo === false) repositoryOptions = discovered;

  return { rootIsGitRepo, gitDirectory, nestedRepos, nestedRepoSelection, repositoryOptions };
};
