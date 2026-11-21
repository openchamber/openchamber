import * as React from 'react';
import { fetchEligibleScheduledTaskTargets } from '@/lib/scheduledTasksApi';
import { useGlobalSessionsStore, refreshGlobalSessions } from '@/stores/useGlobalSessionsStore';
import { useAllLiveSessions } from '@/sync/sync-context';
import { scheduledTaskTargetCandidates, scheduledTaskTargetLoad } from './scheduledTaskTargetResults';

type Eligibility =
  | { status: 'idle' | 'loading' | 'error' }
  | { status: 'ready'; ids: ReadonlySet<string>; coversCache: boolean; projectId: string };

export function useScheduledTaskTargets({ open, projectId }: { open: boolean; projectId: string }) {
  const globalSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const archivedGlobalSessions = useGlobalSessionsStore((state) => state.archivedSessions);
  const liveSessions = useAllLiveSessions();
  const cacheStatus = useGlobalSessionsStore((state) => state.status);
  const cacheLoaded = useGlobalSessionsStore((state) => state.hasLoaded);
  const candidates = React.useMemo(() => scheduledTaskTargetCandidates(globalSessions, archivedGlobalSessions, liveSessions), [globalSessions, archivedGlobalSessions, liveSessions]);
  const candidatesKey = React.useMemo(
    () => candidates.map((session) => `${session.id}:${session.directory ?? ''}`).sort().join('\n'),
    [candidates],
  );
  const candidatesRef = React.useRef(candidates);
  candidatesRef.current = candidates;
  const [stored, setEligibility] = React.useState<Eligibility>({ status: 'idle' });
  const eligibility: Eligibility = stored.status === 'ready' && stored.projectId !== projectId ? { status: 'loading' } : stored;
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    if (!open || !projectId || !candidatesKey) {
      setEligibility({ status: 'idle' });
      return undefined;
    }
    const controller = new AbortController();
    const coversCache = cacheLoaded;
    setEligibility((current) => (current.status === 'ready' && current.coversCache && current.projectId === projectId ? current : { status: 'loading' }));
    fetchEligibleScheduledTaskTargets(
      projectId,
      candidatesRef.current.map((session) => ({ sessionId: session.id, directory: session.directory ?? '' })),
      controller.signal,
    ).then(
      (ids) => {
        if (!controller.signal.aborted) setEligibility({ status: 'ready', ids, coversCache, projectId });
      },
      () => {
        if (!controller.signal.aborted) setEligibility({ status: 'error' });
      },
    );
    return () => controller.abort();
  }, [open, projectId, candidatesKey, attempt, cacheLoaded]);

  React.useEffect(() => {
    if (open) void refreshGlobalSessions().catch(() => undefined);
  }, [open]);

  const load = scheduledTaskTargetLoad({
    eligibility: eligibility.status,
    eligibilityCoversCache: eligibility.status === 'ready' && eligibility.coversCache,
    cacheLoaded,
    cacheStatus,
    hasCandidates: candidates.length > 0,
  });
  const eligible = React.useMemo(
    () => (eligibility.status === 'ready' ? candidates.filter((session) => eligibility.ids.has(session.id)) : []),
    [candidates, eligibility],
  );
  const known = React.useMemo(() => [...candidates, ...archivedGlobalSessions], [candidates, archivedGlobalSessions]);
  const retry = React.useCallback(() => {
    setAttempt((value) => value + 1);
    void refreshGlobalSessions().catch(() => undefined);
  }, []);

  return { known, eligible, load, retry };
}
