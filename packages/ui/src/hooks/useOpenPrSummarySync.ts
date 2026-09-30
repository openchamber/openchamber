import React from 'react';
import type { GitHubAPI } from '@/lib/api/types';
import { useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';

// How often a shown open PR is re-asked, and the floor when the user comes
// back to the window: returning should feel current without letting quick
// focus toggles resend the batch.
const OPEN_PR_SUMMARY_INTERVAL_MS = 2 * 60_000;
// Slightly under the interval so a timer tick never finds the previous
// batch a few milliseconds too young and skips a whole round.
const OPEN_PR_SUMMARY_DUE_AGE_MS = OPEN_PR_SUMMARY_INTERVAL_MS - 10_000;
const OPEN_PR_SUMMARY_RETURN_MIN_AGE_MS = 15_000;

const isDocumentVisible = () => document.visibilityState === 'visible';

/**
 * Keeps the open PRs behind `keys` current through batched live summaries:
 * on a fixed cadence while the window is visible, and again when the user
 * returns to it. Entries without an open PR, and watched ones, are skipped by
 * the store, so callers pass every key they show.
 */
export function useOpenPrSummarySync(keys: string[], github: GitHubAPI | undefined, enabled: boolean) {
  const syncOpenPrSummaries = useGitHubPrStatusStore((state) => state.syncOpenPrSummaries);
  const keysRef = React.useRef(keys);

  const sync = React.useCallback((minAgeMs: number) => {
    if (!enabled || !github || !isDocumentVisible()) {
      return;
    }
    void syncOpenPrSummaries(keysRef.current, github, { minAgeMs });
  }, [enabled, github, syncOpenPrSummaries]);

  // New keys (a project expanded, a reload restored cached open PRs) are asked
  // about right away; keys seen recently wait for their cadence.
  React.useEffect(() => {
    keysRef.current = keys;
    sync(OPEN_PR_SUMMARY_DUE_AGE_MS);
  }, [keys, sync]);

  React.useEffect(() => {
    if (!enabled || !github) {
      return;
    }
    const timer = window.setInterval(() => sync(OPEN_PR_SUMMARY_DUE_AGE_MS), OPEN_PR_SUMMARY_INTERVAL_MS);
    const onReturn = () => sync(OPEN_PR_SUMMARY_RETURN_MIN_AGE_MS);
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    // Cached statuses restore asynchronously; ask about them once they land
    // instead of showing a stale restored PR until the first tick.
    const unsubscribeHydration = useGitHubPrStatusStore.persist.onFinishHydration(() => sync(OPEN_PR_SUMMARY_DUE_AGE_MS));
    return () => {
      unsubscribeHydration();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, [enabled, github, sync]);
}
