import React from 'react';
import { useBackgroundShellsStore } from '@/sync/background-shells';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import type { SessionAttentionState } from '@/stores/sidebarLayout';
import type { SessionLiveState } from './sidebarZones';
import { isSessionUnread } from '@/sync/session-unread';

/** A top-level session whose live state the zones need, with its subsessions. */
export type LiveStateCandidate = { id: string; treeIds: readonly string[] };

const EMPTY_STATES: ReadonlyMap<string, SessionLiveState> = new Map();
const SEPARATOR = '\u0001';

/**
 * The live state of each candidate, from the live channels only: the
 * cross-directory request index (a subagent's request blocks its whole
 * family), the global busy index and background commands, the outcome the
 * server recorded for the session's last turn, and unseen finished turns.
 *
 * Each store is read through a selector that returns a string, so a store
 * publishing for unrelated sessions re-renders nothing; the map changes only
 * when a candidate's state does. These stores publish on lifecycle events
 * (a turn starts or ends, a request arrives or is answered), never per
 * streamed token.
 */
export const useSidebarLiveStates = (
  candidates: readonly LiveStateCandidate[],
  options: { enabled: boolean; readUnread: boolean },
): ReadonlyMap<string, SessionLiveState> => {
  const { enabled, readUnread } = options;
  const blocking = useGlobalBlockingRequestsStore(React.useCallback((state) => {
    if (!enabled) return '';
    const entries: string[] = [];
    for (const candidate of candidates) {
      let kind: 'p' | 'q' | null = null;
      for (const id of candidate.treeIds) {
        const pending = state.bySession.get(id);
        if (!pending) continue;
        if (pending.permissions.length > 0) {
          kind = 'p';
          break;
        }
        if (pending.forms.length > 0 || pending.pages.length > 0) kind = 'q';
      }
      if (kind) entries.push(`${candidate.id}=${kind}`);
    }
    return entries.join(SEPARATOR);
  }, [candidates, enabled]));
  const running = useGlobalSessionStatusStore(React.useCallback((state) => {
    if (!enabled || state.activeSessionIds.size === 0) return '';
    return candidates
      .filter((candidate) => candidate.treeIds.some((id) => state.activeSessionIds.has(id)))
      .map((candidate) => candidate.id)
      .join(SEPARATOR);
  }, [candidates, enabled]));
  // A session idling while a command it started in the background runs is still at work.
  const shells = useBackgroundShellsStore(React.useCallback((state) => {
    if (!enabled || state.sessionIds.size === 0) return '';
    return candidates
      .filter((candidate) => state.sessionIds.has(candidate.id))
      .map((candidate) => candidate.id)
      .join(SEPARATOR);
  }, [candidates, enabled]));
  const outcomes = useGlobalSessionsStore(React.useCallback((state) => {
    if (!enabled) return '';
    const entries: string[] = [];
    for (const candidate of candidates) {
      const outcome = state.entityById.get(candidate.id)?.outcome;
      if (outcome === 'failed') entries.push(`${candidate.id}=e`);
      else if (outcome === 'interrupted') entries.push(`${candidate.id}=s`);
    }
    return entries.join(SEPARATOR);
  }, [candidates, enabled]));
  // Unread is the session's own state (upstream session-unread: unseen turn or a mark).
  const unread = useGlobalSessionsStore(React.useCallback((state) => {
    if (!enabled || !readUnread) return '';
    return candidates
      .filter((candidate) => isSessionUnread(state.entityById.get(candidate.id)))
      .map((candidate) => candidate.id)
      .join(SEPARATOR);
  }, [candidates, enabled, readUnread]));

  return React.useMemo(() => {
    if (!enabled || candidates.length === 0) return EMPTY_STATES;
    const toEntries = (signature: string): Map<string, string> => new Map(
      signature ? signature.split(SEPARATOR).map((entry) => {
        const [id = '', value = ''] = entry.split('=');
        return [id, value];
      }) : [],
    );
    const blockingById = toEntries(blocking);
    const runningIds = new Set([...toEntries(running).keys(), ...toEntries(shells).keys()]);
    const outcomeById = toEntries(outcomes);
    const unreadIds = new Set(toEntries(unread).keys());
    const states = new Map<string, SessionLiveState>();
    for (const candidate of candidates) {
      const pending = blockingById.get(candidate.id);
      const outcome = outcomeById.get(candidate.id);
      // A request waits on the user even while the turn is open, so it
      // comes first; a run in progress outranks how the last one ended.
      let state: SessionAttentionState = 'idle';
      if (pending === 'p') state = 'approval';
      else if (pending === 'q') state = 'question';
      else if (runningIds.has(candidate.id)) state = 'running';
      else if (outcome === 'e') state = 'error';
      else if (outcome === 's') state = 'stopped';
      states.set(candidate.id, { state, unread: unreadIds.has(candidate.id) });
    }
    return states;
  }, [blocking, candidates, enabled, outcomes, running, shells, unread]);
};
