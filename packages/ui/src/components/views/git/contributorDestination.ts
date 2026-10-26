import React from 'react';
import type { GitContributorDestinationCandidates } from '@/lib/api/types';
import { subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';

export type ContributorDestinationCandidate = Extract<
  GitContributorDestinationCandidates,
  { kind: 'contributor' }
>['candidates'][number];

export const getContributorDestinationLabelKey = (classification: ContributorDestinationCandidate['classification']) => {
  switch (classification) {
    case 'contributor-fork': return 'gitView.contributor.destination.contributor-fork';
    case 'own-fork': return 'gitView.contributor.destination.own-fork';
    case 'bound-repository': return 'gitView.contributor.destination.bound-repository';
    case 'other': return 'gitView.contributor.destination.other';
  }
};

export const useContributorDestinationChooser = () => {
  const pendingRef = React.useRef<((name: string | null) => void) | null>(null);
  const [candidates, setCandidates] = React.useState<ContributorDestinationCandidate[] | null>(null);

  const settle = (name: string | null) => {
    const resolve = pendingRef.current;
    pendingRef.current = null;
    setCandidates(null);
    resolve?.(name);
  };

  React.useEffect(() => {
    const cancel = () => {
      const resolve = pendingRef.current;
      pendingRef.current = null;
      setCandidates(null);
      resolve?.(null);
    };
    const unsubscribe = subscribeRuntimeEndpointWillChange(cancel);
    return () => {
      unsubscribe();
      cancel();
    };
  }, []);

  const choose = (nextCandidates: ContributorDestinationCandidate[]) => new Promise<string | null>((resolve) => {
    pendingRef.current?.(null);
    pendingRef.current = resolve;
    setCandidates(nextCandidates);
  });

  return { candidates, choose, settle };
};
