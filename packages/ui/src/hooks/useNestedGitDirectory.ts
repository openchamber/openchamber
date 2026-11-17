import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { chooseAutoNestedRepo, discoversNestedRepos } from '@/lib/nestedRepositories';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import {
  useAutoNestedRepoSelection,
  useEffectiveGitDirectory,
  useGitRepoUnreadable,
  useGitStore,
  useIsGitRepo,
  useIsUnbornGitRepo,
  useNestedRepoSelection,
  useNestedRepos,
  useStaleClearedSelections,
} from '@/stores/useGitStore';

type UseNestedGitDirectoryOptions = {
  enabled?: boolean;
  recheckOnOpen?: boolean;
};

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
  const currentNestedRepos = useNestedRepos(
    gitDirectory && gitDirectory !== root ? gitDirectory : null,
  );
  const searchesCurrent = gitDirectory && gitDirectory !== root
    ? discoversNestedRepos(gitDirectory, homeDirectory)
    : false;

  const selectedIsGitRepo = useIsGitRepo(
    gitDirectory && gitDirectory !== root ? gitDirectory : null,
  );

  const rootUnreadable = useGitRepoUnreadable(root);
  const unreadable = rootUnreadable !== null && root ? { directory: root, message: rootUnreadable } : null;
  const selectedUnreadable = useGitRepoUnreadable(gitDirectory && gitDirectory !== root ? gitDirectory : null) !== null;

  const { ensureStatus, recheckRepository, ensureNestedRepos, selectNestedRepo, clearNestedRepoSelection } = useGitStore(
    useShallow((state) => ({
      ensureStatus: state.ensureStatus,
      recheckRepository: state.recheckRepository,
      ensureNestedRepos: state.ensureNestedRepos,
      selectNestedRepo: state.selectNestedRepo,
      clearNestedRepoSelection: state.clearNestedRepoSelection,
    })),
  );

  React.useEffect(() => {
    if (!enabled || !root) return;
    if (rootIsGitRepo !== null) return;
    void ensureStatus(root, git);
  }, [enabled, ensureStatus, git, root, rootIsGitRepo]);

  React.useEffect(() => {
    if (!recheckOnOpen || !enabled || !root) return;
    const rootState = useGitStore.getState().directories.get(root);
    if (rootState?.isGitRepo !== false && rootState?.status?.unborn !== true) return;
    void recheckRepository(root, git);
  }, [enabled, git, recheckOnOpen, recheckRepository, root]);

  React.useEffect(() => {
    if (!enabled || !root || !searchesNested) return;
    if (rootIsGitRepo === null) return;
    void ensureNestedRepos(root);
  }, [enabled, ensureNestedRepos, root, rootIsGitRepo, searchesNested]);

  React.useEffect(() => {
    if (!recheckOnOpen || !enabled || !root || !searchesNested) return;
    void ensureNestedRepos(root, { force: true });
  }, [enabled, ensureNestedRepos, recheckOnOpen, root, searchesNested]);

  React.useEffect(() => {
    if (!enabled || !gitDirectory || gitDirectory === root) return;
    if (!searchesCurrent) return;
    if (selectedIsGitRepo === null) return;
    void ensureNestedRepos(gitDirectory, { force: recheckOnOpen });
  }, [enabled, ensureNestedRepos, gitDirectory, recheckOnOpen, root, searchesCurrent, selectedIsGitRepo]);

  React.useEffect(() => {
    if (!enabled || !root) return;
    if (rootIsGitRepo !== false) return;
    if (!Array.isArray(nestedRepos) || nestedRepos.length === 0) return;
    if (nestedRepoSelection) return;
    const candidates = staleClearedSelections
      ? nestedRepos.filter((repository) => !staleClearedSelections.has(repository))
      : nestedRepos;
    // external: #5357 a repository hidden in a dot-directory stays in the picker but is never picked automatically.
    const autoPicked = chooseAutoNestedRepo(root, candidates);
    if (!autoPicked) return;
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

  // external: #4886 a root with no commits is not a root that auto-selects a nested repository.
  React.useEffect(() => {
    if (!enabled || !root || !autoSelected) return;
    if (rootIsGitRepo !== true || rootIsUnborn) return;
    selectNestedRepo(root, root);
  }, [autoSelected, enabled, root, rootIsGitRepo, rootIsUnborn, selectNestedRepo]);

  React.useEffect(() => {
    if (!enabled || !root || !nestedRepoSelection) return;
    if (!gitDirectory || gitDirectory === root) return;
    if (selectedIsGitRepo !== false && !selectedUnreadable) return;
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
    selectedUnreadable,
  ]);

  const discovered = Array.isArray(nestedRepos) && nestedRepos.length > 0 ? nestedRepos : null;
  const currentDiscovered = Array.isArray(currentNestedRepos) && currentNestedRepos.length > 0
    ? currentNestedRepos
    : null;
  const selectedRepository = gitDirectory && gitDirectory !== root ? gitDirectory : null;
  let repositoryOptions: string[] | null = null;
  if (selectedRepository) {
    const options = [
      ...(rootIsGitRepo === true && root ? [root] : []),
      ...(discovered ?? []),
      selectedRepository,
      ...(currentDiscovered ?? []),
    ];
    repositoryOptions = [...new Set(options)];
  } else if (discovered && root) {
    repositoryOptions = rootIsGitRepo === true ? [root, ...discovered] : discovered;
  }

  const repositoriesKnown = rootIsGitRepo !== null && (!searchesNested || nestedRepos !== undefined);

  return { rootIsGitRepo, gitDirectory, nestedRepos, nestedRepoSelection, repositoryOptions, repositoriesKnown, unreadable };
};
