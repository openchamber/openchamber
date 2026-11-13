import * as React from 'react';
import { useRepositoryReadContext } from '@/components/references/referenceSources';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { isVSCodeRuntime } from '@/lib/desktop';
import { getRepositoryThreadRef, type LinkedIssue } from '@/lib/linkedIssues';
import { supportsGitHubAutomation } from '@/lib/source-control/githubAutomation';
import { useRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey } from '@/lib/runtime-switch';

/** `true` in a stack, `false` authoritatively not in one, `null` unknown (loading, failed, unread). */
export type StackMembership = boolean | null;

export const pullMembershipKey = (owner: string, repo: string, number: number): string => `${owner}/${repo}#${number}`.toLowerCase();

/** The follow chip hides only for a PR known to be outside every stack that the session does not already follow. */
export const shouldShowStackFollow = (membership: StackMembership, following: boolean): boolean => following || membership !== false;

/**
 * One stack membership read per repository among the session's linked PRs,
 * instead of one stack read per row. A failed read leaves its repository
 * unknown, never "not stacked".
 */
export function useLinkedPullStackMembership(linked: readonly LinkedIssue[], directory: string | null) {
  const { sourceControl } = useRuntimeAPIs();
  const bound = useRepositoryReadContext(directory);
  const context = bound && bound !== 'missing' && supportsGitHubAutomation(bound) ? bound : null;
  const matcher = useRepositoryUrlMatcher();
  const groups = React.useMemo(() => {
    const byRepo = new Map<string, { owner: string; repo: string; numbers: number[] }>();
    for (const entry of linked) {
      const ref = getRepositoryThreadRef(entry, matcher);
      if (!ref || !supportsGitHubAutomation(ref) || ref.thread !== 'pull') continue;
      const key = `${ref.owner}/${ref.repo}`.toLowerCase();
      const group = byRepo.get(key) ?? { owner: ref.owner, repo: ref.repo, numbers: [] };
      if (!group.numbers.includes(ref.number) && group.numbers.length < 50) group.numbers.push(ref.number);
      byRepo.set(key, group);
    }
    return Array.from(byRepo.values());
  }, [linked, matcher]);
  const groupsKey = JSON.stringify([getRuntimeKey(), context, groups]);
  const [revision, refresh] = React.useReducer((value: number) => value + 1, 0);
  const [state, setState] = React.useState<{ key: string; members: Map<string, boolean> }>({ key: '', members: new Map() });

  React.useEffect(() => {
    if (!context || groups.length === 0 || isVSCodeRuntime()) return;
    let active = true;
    const runtime = getRuntimeKey();
    void Promise.allSettled(groups.map((group) => sourceControl.githubPullStackMembership(context, group).then((answer) => ({ group, answer }))))
      .then((settled) => {
        if (!active || getRuntimeKey() !== runtime) return;
        const members = new Map<string, boolean>();
        for (const outcome of settled) {
          if (outcome.status !== 'fulfilled' || !outcome.value.answer.connected) continue;
          const { group, answer } = outcome.value;
          for (const [number, member] of Object.entries(answer.members)) {
            if (member !== null) members.set(pullMembershipKey(group.owner, group.repo, Number(number)), member);
          }
        }
        setState({ key: groupsKey, members });
      });
    return () => { active = false; };
  }, [context, groups, groupsKey, revision, sourceControl]);

  React.useEffect(() => {
    if (!context || groups.length === 0) return;
    return subscribeOpenchamberEvents((event) => {
      if (event.type === 'event-stream-ready' || (event.type === 'source-control-activity' && event.directory === context.directory)) refresh();
    });
  }, [context, groups.length]);

  return React.useCallback((owner: string, repo: string, number: number): StackMembership => (
    state.key === groupsKey ? state.members.get(pullMembershipKey(owner, repo, number)) ?? null : null
  ), [groupsKey, state]);
}
