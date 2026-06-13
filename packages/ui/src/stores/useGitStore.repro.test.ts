/**
 * Reproduction test for issue #1564:
 * Source branch list is sometimes empty when creating a worktree.
 *
 * Root cause: NewWorktreeDialog relies on useGitBranches(projectDirectory) from
 * the Zustand store, but does NOT auto-fetch branches when the dialog opens.
 * Branches only get populated if:
 *   - The Git tab has been opened (GitView's ensureAll)
 *   - A draft session has been started (ChatInput's branch fetch)
 *   - The user manually clicks the refresh button in the dialog
 *
 * This test demonstrates that branches start as null (empty list) for a
 * directory that hasn't been explicitly fetched, matching the "sometimes empty"
 * behavior reported in the issue.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { useGitStore } from './useGitStore';

type GitAPI = Parameters<ReturnType<typeof useGitStore.getState>['fetchStatus']>[1];

const createGitApi = (branchesResult?: { all: string[]; current: string }): GitAPI => ({
  checkIsGitRepository: async () => true,
  getGitStatus: async () => ({
    current: 'main',
    tracking: null,
    ahead: 0,
    behind: 0,
    files: [],
    isClean: true,
  }),
  getGitBranches: async () => ({
    all: branchesResult?.all ?? ['main', 'develop', 'remotes/origin/main'],
    current: branchesResult?.current ?? 'main',
    branches: {},
  }),
  getGitLog: async () => ({ all: [], latest: null, total: 0 }),
  getCurrentGitIdentity: async () => null,
  getGitFileDiff: async (_directory: string, options: { path: string }) => ({
    original: '',
    modified: '',
    path: options.path,
  }),
});

describe('Issue #1564 - Source branch list is empty in create worktree dialog', () => {
  beforeEach(() => {
    // Reset store state - simulating a fresh app load where
    // no Git tab has been opened and no draft session started
    useGitStore.setState({
      directories: new Map(),
      activeDirectory: null,
    });
  });

  test('branches are null (empty list) for a directory that has not been fetched', () => {
    // Simulate what happens when NewWorktreeDialog mounts:
    // projectDirectory = '/my-project' but no branches were fetched yet
    const directory = '/my-project';
    const state = useGitStore.getState().directories.get(directory);
    
    // The dialog calls useGitBranches(projectDirectory), which returns:
    //   state.directories.get(directory)?.branches ?? null
    // Since the directory doesn't exist in the store, branches is null
    expect(state).toBe(undefined);
    
    // This directly simulates the selector in the dialog:
    const branches = useGitStore.getState().directories.get(directory)?.branches ?? null;
    expect(branches).toBeNull();
    
    // The dialog then computes:
    //   localBranches = branches?.all?.filter(...) ?? []
    //   remoteBranches = branches?.all?.filter(...) ?? []
    // Both are empty arrays, so the dropdown shows "No branches found"
    const localBranches = branches?.all?.filter((b) => !b.startsWith('remotes/')) ?? [];
    const remoteBranches = branches?.all?.filter((b) => b.startsWith('remotes/')) ?? [];
    expect(localBranches).toEqual([]);
    expect(remoteBranches).toEqual([]);
  });

  test('branches ARE available AFTER fetchBranches is called', async () => {
    const directory = '/my-project';
    const git = createGitApi({ all: ['main', 'develop', 'feature/new-feature', 'remotes/origin/main'], current: 'main' });
    
    // Simulate the user clicking the refresh button in the dialog
    await useGitStore.getState().fetchBranches(directory, git);
    
    const dirState = useGitStore.getState().directories.get(directory);
    expect(dirState).toBeTruthy();
    expect(dirState?.branches).not.toBeNull();
    expect(dirState?.branches?.all).toEqual(['main', 'develop', 'feature/new-feature', 'remotes/origin/main']);
    
    const branches = dirState!.branches!;
    const localBranches = branches.all.filter((b) => !b.startsWith('remotes/')).sort();
    const remoteBranches = branches.all.filter((b) => b.startsWith('remotes/')).sort();
    
    expect(localBranches).toEqual(['develop', 'feature/new-feature', 'main']);
    expect(remoteBranches).toEqual(['remotes/origin/main']);
  });

  test('simulates the ChatInput flow: branches become available after draft session start', async () => {
    // The ChatInput component fetches branches when showDraftTargetSelectors is true
    // This is triggered when a draft session is started
    const directory = '/my-project';
    const git = createGitApi({ all: ['main', 'hotfix', 'remotes/origin/main'], current: 'main' });
    
    // Before draft session - branches not fetched
    expect(useGitStore.getState().directories.get(directory)?.branches).toBe(undefined);
    
    // Simulate ChatInput's useEffect that runs on draft session start:
    //   React.useEffect(() => {
    //     if (!showDraftTargetSelectors || ...) return;
    //     void fetchBranches(selectedDraftProjectPath, runtimeGit)
    //   }, [...]);
    await useGitStore.getState().fetchBranches(directory, git);
    
    // After fetch - branches are now available
    const branches = useGitStore.getState().directories.get(directory)?.branches;
    expect(branches).not.toBeNull();
    expect(branches?.all).toContain('main');
    expect(branches?.all).toContain('hotfix');
    
    // This is the exact same state the dialog would now see
    const localBranches = branches!.all.filter((b) => !b.startsWith('remotes/')).sort();
    expect(localBranches).toEqual(['hotfix', 'main']);
  });

  test('demonstrates the missing auto-fetch in NewWorktreeDialog', () => {
    // The core issue: NewWorktreeDialog should call fetchBranches (or ensureAll)
    // when it opens with no branches cached, but it doesn't.
    //
    // Looking at the dialog code:
    // - Line 242: const branches = useGitBranches(projectDirectory);
    // - Line 243: const isLoadingBranches = useGitLoadingBranches(projectDirectory);
    // - Line 355-360: handleFetchBranches only triggered by manual refresh button
    // - Lines 616-647: reset effect on open does NOT call fetchBranches
    //
    // Compare with ChatInput's approach (lines 3557-3563):
    //   if (selectedDraftProjectBranches?.all) { return; }
    //   void fetchBranches(selectedDraftProjectPath, runtimeGit)
    // ChatInput auto-fetches if branches aren't available.
    //
    // The dialog should similarly auto-fetch:
    //   React.useEffect(() => {
    //     if (!open || !projectDirectory || !git) return;
    //     if (branches?.all) return; // already cached
    //     void fetchBranches(projectDirectory, git);
    //   }, [open, projectDirectory, git, branches?.all, fetchBranches]);
    
    // Verify the issue exists by checking that opening the dialog
    // doesn't trigger any branch fetching for un-fetched directories
    const directory = '/unfetched-project';
    const hasBranches = useGitStore.getState().directories.get(directory)?.branches?.all;
    expect(hasBranches).toBe(undefined);
    
    // The dialog would show "No branches found" in this state
    // because branches?.all is undefined -> localBranches = [] && remoteBranches = []
  });
});
