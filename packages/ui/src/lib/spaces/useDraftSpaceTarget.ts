import { useShallow } from 'zustand/react/shallow';

import { draftSpaceTarget, type DraftSpaceTarget } from './space-creation-requests';
import { useSpacesStore } from './spaces-store';
import { useSessionUIStore } from '@/sync/session-ui-store';

/** Where the open draft runs commands while it waits for a new space; null for any other view. */
export const useDraftSpaceTarget = (): DraftSpaceTarget | null => {
  const requestId = useSessionUIStore((s) => (s.currentSessionId === null && s.newSessionDraft?.open ? s.newSessionDraft.pendingWorktreeRequestId ?? null : null));
  return useSpacesStore(useShallow((s) => draftSpaceTarget(requestId, s.journey)));
};
