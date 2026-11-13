import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { chooseAutoNestedRepo, discoversNestedRepos } from '@/lib/nestedRepositories';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import {
  useAutoNestedRepoSelection,
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
 * Resolves the repository a git surface operates on. Owns the full resolution
 * flow: probing the root, discovering the repositories under it (never in the
 * home directory), auto-selecting the first one when the root is no repository
 * (skipping ones under a dot-directory, #5357), and dropping a selection whose
 * repository disappeared.
 *
 * An established root is a repository the surface works in by default, but it
 * does not hide what is below it: its submodules and nested checkouts are
 * discovered for the picker, and an explicit selection among them keeps
 * applying. Only a root that is no repository auto-selects a nested
 * repository, because that root has nothing to show; a fresh `git init` is not
 * such a root (#4886), and a guess never outlives the root's own commits.
 *
 * Consumers still fetch their own git data for the returned `gitDirectory`;
 * this hook only owns who that directory is. `repositoryOptions` is what a
 * repository picker lists, or null when the surface has no choice to offer.
 * A selected repository is a root of its own: its own nested repositories are
 * discovered and listed next to it, one level down, so a chain of submodules
 * is walked a level at a time while the way back stays in the list.
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
  const autoSelected = useAutoNestedRepoSelection(root);
  const staleClearedSelections = useStaleClearedSelections(root);
  // Repositories under the repository the surface operates on, not under the
  // project root: once a submodule is selected, its own submodules have to be
  // reachable exactly like the root's are. Keyed on the selected directory so
  // both levels keep their own answer.
  const currentNestedRepos = useNestedRepos(
    gitDirectory && gitDirectory !== root ? gitDirectory : null,
  );
  const searchesCurrent = gitDirectory && gitDirectory !== root
    ? discoversNestedRepos(gitDirectory, homeDirectory)
    : false;

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

  // Discover the repositories under the root once its probe resolves. It is
  // what a non-repository root resolves through, and what the picker offers
  // next to an established root (its submodules included).
  React.useEffect(() => {
    if (!enabled || !root || !searchesNested) return;
    if (rootIsGitRepo === null) return;
    void ensureNestedRepos(root);
  }, [enabled, ensureNestedRepos, root, rootIsGitRepo, searchesNested]);

  // Discovery is a snapshot and nothing invalidates it: a submodule added from
  // a terminal or by an agent leaves no event behind, so a surface opened to
  // look at git scans again, once per opening. A cached list would otherwise
  // keep an added submodule out of the picker until the app restarts.
  React.useEffect(() => {
    if (!recheckOnOpen || !enabled || !root || !searchesNested) return;
    void ensureNestedRepos(root, { force: true });
  }, [enabled, ensureNestedRepos, recheckOnOpen, root, searchesNested]);

  // A selected repository is a root of its own: whatever it contains is what
  // its picker offers next, so a chain of submodules stays walkable one level
  // at a time instead of stopping at the first one.
  React.useEffect(() => {
    if (!enabled || !gitDirectory || gitDirectory === root) return;
    if (!searchesCurrent) return;
    if (selectedIsGitRepo === null) return;
    void ensureNestedRepos(gitDirectory, { force: recheckOnOpen });
  }, [enabled, ensureNestedRepos, gitDirectory, recheckOnOpen, root, searchesCurrent, selectedIsGitRepo]);

  // Auto-select the first nested repository so a root with no repository of
  // its own opens straight into repository data; a picker (where rendered)
  // switches between them. An established root starts on itself.
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
    const autoPicked = chooseAutoNestedRepo(root, candidates);
    if (!autoPicked) return;
    // A guess, not a pick: it is not persisted and yields to the root below.
    selectNestedRepo(root, autoPicked, { persist: false });
  }, [
    enabled,
    nestedRepos,
    nestedRepoSelection,
    root,
    rootIsGitRepo,
    selectNestedRepo,
    staleClearedSelections,
  ]);

  // A guess only holds while the root has nothing of its own to show. Once the
  // root's first commit lands, the root is what the user opened and the guess
  // goes; an explicit pick stays.
  React.useEffect(() => {
    if (!enabled || !root || !autoSelected) return;
    if (rootIsGitRepo !== true || rootIsUnborn) return;
    selectNestedRepo(root, root);
  }, [autoSelected, enabled, root, rootIsGitRepo, rootIsUnborn, selectNestedRepo]);

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
  const currentDiscovered = Array.isArray(currentNestedRepos) && currentNestedRepos.length > 0
    ? currentNestedRepos
    : null;
  const selectedRepository = gitDirectory && gitDirectory !== root ? gitDirectory : null;
  let repositoryOptions: string[] | null = null;
  if (selectedRepository) {
    // Inside a nested repository the picker keeps the way back (the root and
    // its repositories) next to that repository and its own, so the list only
    // ever grows by one level and never loses the level above it.
    const options = [
      ...(rootIsGitRepo === true && root ? [root] : []),
      ...(discovered ?? []),
      selectedRepository,
      ...(currentDiscovered ?? []),
    ];
    repositoryOptions = [...new Set(options)];
  } else if (discovered && root) {
    // An established root is one of the choices; a non-repository root is not.
    repositoryOptions = rootIsGitRepo === true ? [root, ...discovered] : discovered;
  }

  return { rootIsGitRepo, gitDirectory, nestedRepos, nestedRepoSelection, repositoryOptions };
};
