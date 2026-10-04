import React from 'react';
import type { SourceControlAPI } from '@/lib/api/types';
import type { GitLabThreadRef } from '@/lib/linkedIssues';
import { useGitLabLinkedStateStore } from '@/stores/useGitLabLinkedStateStore';
import { getSourceControlAuthKey, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';

// The same cadence as GitHub's linked PRs and issues: every two minutes while
// the window is visible, and when the user comes back to it.
const INTERVAL_MS = 2 * 60_000;
const DUE_AGE_MS = INTERVAL_MS - 10_000;
const RETURN_MIN_AGE_MS = 15_000;

const isDocumentVisible = () => document.visibilityState === 'visible';

/**
 * Keeps the state of the GitLab merge requests and issues linked to the
 * sessions on screen current. Only instances with a connected account are
 * asked; an instance whose account has not been checked yet is checked once,
 * so a sidebar opened before any GitLab project still colours its links.
 */
export function useGitLabLinkedStateSync(
  refs: readonly GitLabThreadRef[],
  sourceControl: Pick<SourceControlAPI, 'gitlabSummaries' | 'authStatus'> | undefined,
): void {
  const instances = React.useMemo(() => [...new Set(refs.map((ref) => ref.instance))].sort(), [refs]);
  const instanceKey = instances.join('\n');
  const connectedKey = useSourceControlAuthStore((state) => instances
    .filter((instance) => state.entries[getSourceControlAuthKey({ provider: 'gitlab', instance })]?.status?.connected === true)
    .join('\n'));
  const refsRef = React.useRef(refs);

  React.useEffect(() => {
    if (!sourceControl) return;
    const auth = useSourceControlAuthStore.getState();
    for (const instance of instanceKey ? instanceKey.split('\n') : []) {
      const identity = { provider: 'gitlab' as const, instance };
      if (!auth.entries[getSourceControlAuthKey(identity)]?.hasChecked) void auth.refreshStatus(sourceControl, identity);
    }
  }, [instanceKey, sourceControl]);

  const sync = React.useCallback((minAgeMs: number) => {
    if (!sourceControl || !connectedKey || !isDocumentVisible()) return;
    const connected = new Set(connectedKey.split('\n'));
    const asked = refsRef.current.filter((ref) => connected.has(ref.instance));
    if (asked.length > 0) void useGitLabLinkedStateStore.getState().sync(asked, sourceControl, minAgeMs);
  }, [connectedKey, sourceControl]);

  // Newly shown links are asked about right away; known ones wait their turn.
  React.useEffect(() => {
    refsRef.current = refs;
    sync(DUE_AGE_MS);
  }, [refs, sync]);

  React.useEffect(() => {
    if (!sourceControl || !connectedKey) return;
    const timer = window.setInterval(() => sync(DUE_AGE_MS), INTERVAL_MS);
    const onReturn = () => sync(RETURN_MIN_AGE_MS);
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, [connectedKey, sourceControl, sync]);
}
