import * as React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { RepositoryReferenceReviewer, SourceControlReadContext } from '@/lib/api/types';

const UNSUPPORTED = 'SOURCE_CONTROL_CAPABILITY_UNSUPPORTED';

export const useIssueAssigneeCandidates = (
  context: SourceControlReadContext,
  owner: string,
  repo: string,
) => {
  const { sourceControl } = useRuntimeAPIs();
  const [candidates, setCandidates] = React.useState<RepositoryReferenceReviewer[] | null>(null);

  React.useEffect(() => {
    let active = true;
    void sourceControl.referenceReviewers(context, { owner, repo }, 'assignee').then(
      (people) => { if (active) setCandidates(people); },
      (error) => {
        const refused = error instanceof Error && 'code' in error && error.code === UNSUPPORTED;
        if (active) setCandidates(refused ? null : []);
      },
    );
    return () => { active = false; };
  }, [context, owner, repo, sourceControl]);

  return { candidates, setCandidates };
};
