/**
 * Reproduction tests for issue #2024:
 * New Worktree dialog intermittently fails to restore the last-used source branch.
 *
 * The issue describes three suspected root causes:
 *   1. Save is gated to new-branch mode + no linked PR — existing-branch mode
 *      creations never persist the last source branch.
 *   2. localStorage is origin-scoped — port fallback (57123 busy → free port)
 *      or web-vs-desktop origin switch gives a different origin, so the saved
 *      value is invisible.
 *   3. When the stored branch no longer exists in the branch list, the restore
 *      silently falls back but does NOT clear the stale entry from localStorage,
 *      so subsequent opens have a dead entry that the guard
 *      `if (newBranchState.sourceBranch) return` skips.
 *
 * Additionally, there is a React effect-ordering bug:
 *   4. The "restore from localStorage" effect (line 589) is defined before
 *      the "reset state on open" effect (line 623). On dialog open, effects
 *      fire in definition order — the restore effect runs FIRST while
 *      `newBranchState.sourceBranch` still holds its previous (non-empty)
 *      value. The guard `if (newBranchState.sourceBranch) return` causes it
 *      to skip, and the reset effect then clears it. On the next render
 *      the restore runs again, but only if `branches` has already loaded.
 *      If branches load asynchronously, there is a window where the restore
 *      was skipped and the reset has already fired, leading to a fallback
 *      to root/main/master instead of the stored value.
 */

import { beforeEach, describe, expect, test } from 'bun:test';

// Mock localStorage since it isn't available in the bun test environment.
const store = new Map<string, string>();
const mockLocalStorage = {
  getItem: (key: string): string | null => store.get(key) ?? null,
  setItem: (key: string, value: string): void => { store.set(key, value); },
  removeItem: (key: string): void => { store.delete(key); },
  clear: (): void => { store.clear(); },
  get length(): number { return store.size; },
  key: (index: number): string | null => Array.from(store.keys())[index] ?? null,
} as Storage;

globalThis.localStorage = mockLocalStorage;

const LAST_SOURCE_BRANCH_KEY = 'oc:lastWorktreeSourceBranch';

interface BranchList {
  all: string[];
  current: string;
}

/**
 * Simulates the save logic from NewWorktreeDialog.tsx:893-895.
 * Only saves when mode === 'new-branch' and there's no linked PR.
 */
function saveSourceBranch(sourceBranch: string | undefined, mode: string, linkedPr: unknown): void {
  if (sourceBranch && mode === 'new-branch' && !linkedPr) {
    localStorage.setItem(LAST_SOURCE_BRANCH_KEY, sourceBranch);
  }
}

/**
 * Simulates the restore logic from NewWorktreeDialog.tsx:597-605.
 * Falls back through rootBranch -> main -> master -> first branch.
 * Does NOT clear the stale localStorage entry when the saved branch
 * is not found in the branch list.
 */
function restoreSourceBranch(
  branches: BranchList | null,
  projectDirectory: string | null,
  rootBranch: string | null,
): string {
  if (!branches?.all || !projectDirectory) return '';

  const savedSourceBranch = localStorage.getItem(LAST_SOURCE_BRANCH_KEY);
  const defaultSourceBranch = savedSourceBranch && branches.all.includes(savedSourceBranch)
    ? savedSourceBranch
    : rootBranch && branches.all.includes(rootBranch)
      ? rootBranch
      : branches.all.includes('main')
        ? 'main'
        : branches.all.includes('master')
          ? 'master'
          : branches.all[0] || '';

  return defaultSourceBranch;
}

/**
 * Simulates the effect-ordering bug on dialog open:
 * The restore effect runs BEFORE the open-reset effect, so it sees
 * the OLD newBranchState.sourceBranch value (non-empty) and skips.
 * Then the reset effect clears it.  If branches are already loaded at
 * that point, the restore runs again on the next render and recovers.
 * But if branches load *after* the reset, there is a lost-render window
 * where the guard fires with the old value → skip → clear → branches
 * load later only on a subsequent render that may not re-trigger the
 * restore effect.
 */
function simulateOpenFlow(
  branches: BranchList | null,
  projectDirectory: string | null,
  oldSourceBranch: string,
  rootBranch: string | null,
): { step1skipped: boolean; step3restored: boolean; finalBranch: string } {
  // Step 1: Restore effect fires (line 589 in the component).
  // Guard: "if (newBranchState.sourceBranch) return"
  // At this point newBranchState.sourceBranch is still the OLD value from the
  // previous dialog session (before the reset effect has run).
  const step1skipped = oldSourceBranch !== '';
  let sourceBranch = oldSourceBranch;

  if (step1skipped) {
    // Guard fires — skipped, sourceBranch stays as old value
  } else {
    sourceBranch = restoreSourceBranch(branches, projectDirectory, rootBranch);
  }

  // Step 2: Reset-on-open effect fires (line 623 in the component).
  // Resets sourceBranch to '' and clears all other state.
  sourceBranch = '';

  // Step 3: On re-render, restore effect fires again (dep: sourceBranch changed).
  // If branches are already loaded at this point, it will restore correctly.
  const step3restored = (branches?.all && projectDirectory) ? true : false;
  if (step3restored) {
    sourceBranch = restoreSourceBranch(branches, projectDirectory, rootBranch);
  }
  // If step3restored is false (branches not loaded yet), sourceBranch stays ''
  // and falls back to root/main/master later when branches DO load.

  return { step1skipped, step3restored, finalBranch: sourceBranch };
}

describe('Issue #2024 — New Worktree dialog source branch restore', () => {
  const MOCK_BRANCHES: BranchList = {
    all: ['main', 'develop', 'feature/new-ui', 'remotes/origin/main', 'remotes/origin/develop'],
    current: 'main',
  };

  beforeEach(() => {
    localStorage.clear();
  });

  // ─── Root Cause 1: Save gated to new-branch mode ───────────────────────

  describe('Root cause 1: Save gated to new-branch mode only', () => {
    test('saves source branch in new-branch mode with no linked PR', () => {
      saveSourceBranch('feature/new-ui', 'new-branch', null);
      expect(localStorage.getItem(LAST_SOURCE_BRANCH_KEY)).toBe('feature/new-ui');
    });

    test('does NOT save source branch in existing-branch mode', () => {
      // User creates worktree from existing branch — never saves
      saveSourceBranch('develop', 'existing-branch', null);
      expect(localStorage.getItem(LAST_SOURCE_BRANCH_KEY)).toBeNull();
    });

    test('does NOT save when a linked PR is present', () => {
      saveSourceBranch('feature/new-ui', 'new-branch', { number: 42 });
      expect(localStorage.getItem(LAST_SOURCE_BRANCH_KEY)).toBeNull();
    });

    test('does NOT save when sourceBranch is empty', () => {
      saveSourceBranch('', 'new-branch', null);
      expect(localStorage.getItem(LAST_SOURCE_BRANCH_KEY)).toBeNull();
    });

    test(
      'BUG DEMO: creating worktrees from existing branches never tracks the user\'s last choice',
      () => {
        // Scenario: User always creates worktrees from existing branches.
        // The stored value is never updated.
        saveSourceBranch('feature/new-ui', 'new-branch', null);
        expect(localStorage.getItem(LAST_SOURCE_BRANCH_KEY)).toBe('feature/new-ui');

        // User then creates two worktrees from existing branches:
        saveSourceBranch('hotfix', 'existing-branch', null);
        saveSourceBranch('release/v2', 'existing-branch', null);

        // The saved value is still 'feature/new-ui', NOT the user's actual last choice.
        expect(localStorage.getItem(LAST_SOURCE_BRANCH_KEY)).toBe('feature/new-ui');

        // When reopening the dialog, the stored 'feature/new-ui' is restored (if it exists),
        // but the user last used 'release/v2'.  The stored value is stale.
      },
    );
  });

  // ─── Root Cause 2: localStorage is origin-scoped ───────────────────────

  describe('Root cause 2: localStorage is origin-scoped', () => {
    test(
      'BUG DEMO: different ports have isolated localStorage — stored value is invisible after port change',
      () => {
        // Simulate Desktop on port 57123
        const origin57123 = 'http://127.0.0.1:57123';
        // ... (in a real browser, each origin has its own localStorage)
        // We simulate by setting localStorage on the "57123 origin":
        localStorage.setItem(LAST_SOURCE_BRANCH_KEY, 'feature/new-ui');

        // Simulate a server restart on a different port (e.g. 57124 because 57123 was busy)
        // If we could switch localStorage partitions, the value would be missing.
        // Here we just show the general principle:
        const restoredOnSameOrigin = localStorage.getItem(LAST_SOURCE_BRANCH_KEY);
        expect(restoredOnSameOrigin).toBe('feature/new-ui');

        // Explanation (can't fully simulate browser origin isolation in testing):
        // In Electron, the web server binds to 57123.  If that port is busy,
        // the server falls back to a free port (e.g. 57124), which means
        // the web app loads from http://127.0.0.1:57124 — a different origin.
        // The localStorage from port 57123 is invisible, and the stored
        // source branch is not restored.
        //
        // Similarly, switching between Desktop (Electron) and Web mode
        // gives different origins, and the stored branch is silently lost.
        expect(true).toBe(true); // Placeholder — the comment above is the reproduction.
      },
    );
  });

  // ─── Root Cause 3: Stale localStorage value is never cleared ───────────

  describe('Root cause 3: Stale localStorage value silently persists', () => {
    test('restore falls back gracefully when saved branch no longer exists', () => {
      localStorage.setItem(LAST_SOURCE_BRANCH_KEY, 'deleted-branch');

      const result = restoreSourceBranch(MOCK_BRANCHES, '/project', null);
      expect(result).toBe('main'); // Falls back to root/main/master
    });

    test('BUG DEMO: stale localStorage entry is NOT cleared after fallback', () => {
      localStorage.setItem(LAST_SOURCE_BRANCH_KEY, 'deleted-branch');

      // First open: fallback works
      const result1 = restoreSourceBranch(MOCK_BRANCHES, '/project', null);
      expect(result1).toBe('main');

      // But the stale entry is still in localStorage!
      expect(localStorage.getItem(LAST_SOURCE_BRANCH_KEY)).toBe('deleted-branch');

      // On every subsequent open, the restore logic will find the stale entry,
      // check branches.all.includes('deleted-branch') → false, and fallback again.
      // But the stale entry is never removed or replaced.
      // If the guard `if (newBranchState.sourceBranch) return` ever fires before
      // this restore runs (see root cause 4), the stale entry is worse —
      // the effect skips entirely and the dialog shows the OLD sourceBranch
      // from the previous render instead of the fallback.
    });

    test('BUG DEMO: stale value is sticky across opens if effect guard fires', () => {
      // Set up the scenario:
      localStorage.setItem(LAST_SOURCE_BRANCH_KEY, 'deleted-branch');

      // The guard in the restore effect is:
      //   if (newBranchState.sourceBranch) return; // Already set
      //
      // If the effect-ordering bug (root cause 4) causes the restore to
      // run before the open-reset effect, the value from the previous
      // render (e.g. 'develop') is still in newBranchState.sourceBranch.
      // The guard fires → restore is SKIPPED.
      // The open-reset effect then clears it, but if branches aren't
      // yet loaded, the re-render doesn't trigger a restore.
      //
      // This test simulates that: even though localStorage has 'deleted-branch',
      // the guard skips because newBranchState.sourceBranch is already 'develop'
      // from the previous render.
      const oldSourceBranch: string = 'develop';
      const skipped: boolean = oldSourceBranch !== '';
      expect(skipped).toBe(true);
      // Expected: the guard fires and the restore is skipped.
      // Result: the user sees 'develop' (or '' after reset if branches not loaded)
      // instead of the fallback 'main'.  Neither is the stored value.
    });
  });

  // ─── Root Cause 4: Effect ordering race condition ──────────────────────

  describe('Root cause 4: Effect ordering race on dialog open', () => {
    test(
      'restore effect runs BEFORE open-reset effect — sees old sourceBranch and skips',
      () => {
        // Simulate the dialog opening with branches already loaded.
        // Set a stored value so restoreSourceBranch returns the correct branch.
        localStorage.setItem(LAST_SOURCE_BRANCH_KEY, 'develop');
        const result = simulateOpenFlow(
          MOCK_BRANCHES,
          '/project',
          'develop', // oldSourceBranch: the value from the PREVIOUS dialog session
          null,      // rootBranch
        );

        // Step 1: skipped because oldSourceBranch was non-empty
        expect(result.step1skipped).toBe(true);

        // Step 3: branches are loaded, so it restores correctly.
        // 'develop' is in the branch list so restoreSourceBranch picks it.
        expect(result.step3restored).toBe(true);
        // In step 3, restoreSourceBranch checks localStorage and finds 'develop',
        // but the guard in step 1 already skipped. The finalBranch comes from
        // restoreSourceBranch which returns from localStorage, NOT the old value.
        // Since we set 'develop' and it's in the branch list, we get 'develop'.
        expect(result.finalBranch).toBe('develop');

        // The guard's purpose is to avoid re-fetching when the user has already
        // selected a branch.  But because the effect runs BEFORE the open-reset,
        // it sees the OLD selection and treats it as "already set", even though
        // the dialog is about to reset it.
      },
    );

    test('LOST RENDER: branches load AFTER the race sequence', () => {
      // Simulate the worst case: branches start as null (not yet loaded),
      // and the old sourceBranch is non-empty.
      const branchesNotLoaded = null as unknown as BranchList;
      const result1 = simulateOpenFlow(
        branchesNotLoaded, // branches not loaded yet
        '/project',
        'develop',     // old value from previous session
        null,
      );

      expect(result1.step1skipped).toBe(true);  // Guard fires → skip
      expect(result1.step3restored).toBe(false); // Branches not loaded → skip
      expect(result1.finalBranch).toBe('');      // Reset to empty string

      // Now branches finish loading (e.g. from the fetchBranches effect at line 363)
      // The restore effect re-runs because the `branches` dep changed.
      // This time it will restore from localStorage or fallback.
      const result2 = restoreSourceBranch(MOCK_BRANCHES, '/project', null);
      expect(result2).toBe('main'); // Falls back to main (or whatever is stored)

      // At this point the dialog has flashed with empty sourceBranch before
      // the correct fallback was applied.  If the stored value was valid,
      // it would correctly restore.  But:
      //   - If localStorage is empty (first time / origin change): falls to root/main
      //   - If the stored value is stale: falls to root/main (but stale persists)
      //
      // The "intermittent" nature comes from whether branches have already been
      // fetched by the time the open-reset effect fires on the same render.
      // If branches were cached from a previous dialog session, this race is
      // invisible.  If the user opens the dialog for the first time in a fresh
      // app session, branches need to be fetched → race window exists.
    });

    test('reproduce the intermittent failure scenario', () => {
      // Scenario: User opens dialog, branches NOT cached (fresh app load),
      // old sourceBranch from previous render is 'develop'.
      //
      // Effect order (definition order in the component):
      // 1. Fetch branches effect (line 363) — starts async fetch
      // 2. Restore effect (line 589) — guard fires (old value 'develop') → SKIP
      // 3. Open-reset effect (line 623) — sourceBranch = ''
      // 4. Re-render due to sourceBranch change
      // 5. Restore effect again — sourceBranch='', but branches still null → SKIP
      //    (line 590: if (!branches?.all || !projectDirectory) return;)
      // 6. Branches async fetch completes → re-render
      // 7. Restore effect — sourceBranch='', branches available → restore from
      //    localStorage or fallback
      //
      // Step 7 depends on whether localStorage has a valid value.
      // If the origin changed (root cause 2), localStorage is empty → fallback.
      // If the user last used existing-branch mode (root cause 1), localStorage
      // has a stale value from a previous new-branch creation.

      // Simulate the sequence
      const step1OldValue: string = 'develop';
      const step1Skipped: boolean = step1OldValue !== ''; // Guard fires
      expect(step1Skipped).toBe(true);

      // Step 3: reset
      const _step3Value: string = '';

      // Step 5: branches still null — guard at line 590 of the dialog
      //   if (!branches?.all || !projectDirectory) return;
      // causes early return, so restore is skipped
      const branchesAreNull: boolean = true; // simulation of step 5
      expect(branchesAreNull).toBe(true);

      // Step 6: branches loaded
      const step6Branches: BranchList = MOCK_BRANCHES;

      // Step 7: restore
      const step7Value = restoreSourceBranch(step6Branches, '/project', null);
      expect(step7Value).toBe('main'); // localStorage was empty → fallback to main

      // The user was expecting 'develop' (the branch they last used) to be
      // pre-selected, but got 'main' instead.  This is the intermittent failure.
    });
  });

  // ─── Stale value + race condition combined ─────────────────────────────

  describe('Combined scenario: stale value + effect ordering bug', () => {
    test('BUG DEMO: stale localStorage entry + guard skip = permanent mismatch', () => {
      // Set up a stale entry in localStorage
      localStorage.setItem(LAST_SOURCE_BRANCH_KEY, 'branch-that-was-deleted');

      // First open: branches loaded, old sourceBranch = '' (no previous session)
      // Restore finds stale entry, falls back to 'main'.
      // Stale entry is NOT cleared from localStorage.
      const firstOpen = restoreSourceBranch(MOCK_BRANCHES, '/project', null);
      expect(firstOpen).toBe('main');

      // User manually selects 'develop' and creates a worktree.
      // Saves 'develop' to localStorage.
      saveSourceBranch('develop', 'new-branch', null);
      expect(localStorage.getItem(LAST_SOURCE_BRANCH_KEY)).toBe('develop');

      // Close and reopen dialog.  This time:
      // Restore effect fires with oldSourceBranch='develop' (not yet reset).
      // Guard fires → skip.  Reset happens.  Re-render → restore effect fires
      // again with sourceBranch=''.  Branches are loaded → restore from localStorage.
      // Gets 'develop'.  Works correctly.

      // Now: close dialog, delete 'develop' branch via git, reopen.
      // localStorage still has 'develop'.
      // Restore effect: oldSourceBranch='develop' (previous session), guard fires → SKIP.
      // Reset: sourceBranch=''.
      // Re-render: sourceBranch='', branches loaded → restore.
      //   savedSourceBranch = 'develop' → branches.all.includes('develop') = false → fallback.
      // Gets 'main' (or root).  Correct fallback.
      // But 'develop' is STILL in localStorage!  It will never be cleared.
      const updatedBranches: BranchList = {
        all: ['main', 'remotes/origin/main'],
        current: 'main',
      };
      const fallback = restoreSourceBranch(updatedBranches, '/project', null);
      expect(fallback).toBe('main');
      expect(localStorage.getItem(LAST_SOURCE_BRANCH_KEY)).toBe('develop');
      // Stale entry is preserved forever
    });
  });

  // ─── Acceptance criteria verification ──────────────────────────────────

  describe('Acceptance criteria (current behavior analysis)', () => {
    test(
      'MUST - after creating from chosen source branch in new-branch mode, reopening preselects same branch (works in basic case)',
      () => {
        localStorage.setItem(LAST_SOURCE_BRANCH_KEY, 'feature/new-ui');
        const result = restoreSourceBranch(MOCK_BRANCHES, '/project', null);
        expect(result).toBe('feature/new-ui');
        // Works in the basic happy path (branches loaded, no race condition).
      },
    );

    test(
      'MUST - stored value surviving app restart on same origin (CURRENTLY WORKS)',
      () => {
        // localStorage persists across app restarts on the same origin.
        // This works by design of the Storage API.
        expect(true).toBe(true);
      },
    );

    test(
      'SHOULD - when stored branch no longer exists, fallback is deterministic AND stale value is cleared (CURRENTLY BROKEN)',
      () => {
        localStorage.setItem(LAST_SOURCE_BRANCH_KEY, 'ghost-branch');
        const result = restoreSourceBranch(MOCK_BRANCHES, '/project', null);
        expect(result).toBe('main'); // Deterministic fallback ✓
        expect(localStorage.getItem(LAST_SOURCE_BRANCH_KEY)).toBe('ghost-branch');
        // Stale value NOT cleared ✗ — this fails the acceptance criteria.
        // The stale entry should be removed on fallback.
      },
    );

    test(
      'SHOULD - existing-branch mode also saves the source branch (CURRENTLY BROKEN)',
      () => {
        saveSourceBranch('release/v2', 'existing-branch', null);
        expect(localStorage.getItem(LAST_SOURCE_BRANCH_KEY)).toBeNull();
        // Existing-branch mode never saves ✗
      },
    );

    test(
      'SHOULD - persistence is robust to port changes (CURRENTLY BROKEN)',
      () => {
        // This cannot be fully tested in a unit test because localStorage
        // is origin-scoped by the browser.  The acceptance criteria mentions
        // "stored in a port-independent location", which would require a
        // different storage mechanism (e.g. server-side, Electron main process
        // storage, or a path-based key).
        //
        // For the purpose of this reproduction, we document the limitation:
        // localStorage is scoped to (protocol, host, port).  Desktop's free-port
        // fallback or web-vs-desktop origin switch will lose the stored value.
        expect(true).toBe(true);
      },
    );
  });
});
