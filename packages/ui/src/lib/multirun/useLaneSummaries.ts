import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { createLaneCache, loadLaneDiffStat, loadLaneLastTurn, type LaneDiffStat, type LaneLastTurn } from './laneData';

export type LaneReplyState = { state: 'loading' } | { state: 'ready'; text: string; error: string | null } | { state: 'error' };
export type LaneDiffState = { state: 'none' } | { state: 'loading' } | { state: 'ready'; stat: LaneDiffStat } | { state: 'error' };
export type LaneSummary = { reply: LaneReplyState; diff: LaneDiffState };

export type LaneSummaryInput = {
  sessionId: string;
  session: Session | undefined;
  /** Worktree whose changes belong to this member; null when it shares a directory. */
  worktreePath: string | null;
};

const replyCache = createLaneCache<LaneLastTurn>();
const diffCache = createLaneCache<LaneDiffStat>();

const LOADING: LaneSummary = { reply: { state: 'loading' }, diff: { state: 'loading' } };

/**
 * Final reply and worktree changes of each member, read once per finished
 * turn: a member's `time.idle` changes when a turn ends, which is the only
 * moment its reply or diff can have settled. Busy members keep what was last
 * read. A read failure is its own state, never an empty reply or zero changes.
 * A response is applied only while it answers the member's latest request, so
 * a slow older read never overwrites a newer one.
 */
export function useLaneSummaries(
  members: readonly LaneSummaryInput[],
  activeSessionIds: ReadonlySet<string>,
): ReadonlyMap<string, LaneSummary> {
  const [summaries, setSummaries] = React.useState<ReadonlyMap<string, LaneSummary>>(new Map());
  const requestedRef = React.useRef(new Map<string, string>());
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  React.useEffect(() => {
    const apply = (sessionId: string, token: string, patch: Partial<LaneSummary>) => {
      if (!mountedRef.current || requestedRef.current.get(sessionId) !== token) return;
      setSummaries((current) => new Map(current).set(sessionId, { ...(current.get(sessionId) ?? LOADING), ...patch }));
    };
    for (const member of members) {
      const session = member.session;
      if (!session || activeSessionIds.has(member.sessionId)) continue;
      const token = replyCache.tokenFor(member.sessionId, `${session.time.idle ?? 0}:${member.worktreePath ?? ''}`);
      if (requestedRef.current.get(member.sessionId) === token) continue;
      requestedRef.current.set(member.sessionId, token);

      const cachedReply = replyCache.get(member.sessionId, token);
      if (cachedReply !== undefined) {
        apply(member.sessionId, token, { reply: { state: 'ready', ...cachedReply } });
      } else {
        loadLaneLastTurn(member.sessionId, session.directory).then(
          (turn) => {
            replyCache.set(member.sessionId, token, turn);
            apply(member.sessionId, token, { reply: { state: 'ready', ...turn } });
          },
          () => apply(member.sessionId, token, { reply: { state: 'error' } }),
        );
      }

      const worktreePath = member.worktreePath;
      if (!worktreePath) {
        apply(member.sessionId, token, { diff: { state: 'none' } });
        continue;
      }
      const cachedDiff = diffCache.get(member.sessionId, token);
      if (cachedDiff) {
        apply(member.sessionId, token, { diff: { state: 'ready', stat: cachedDiff } });
      } else {
        loadLaneDiffStat(worktreePath).then(
          (stat) => {
            diffCache.set(member.sessionId, token, stat);
            apply(member.sessionId, token, { diff: { state: 'ready', stat } });
          },
          () => apply(member.sessionId, token, { diff: { state: 'error' } }),
        );
      }
    }
  }, [activeSessionIds, members]);

  return summaries;
}
