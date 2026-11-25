import { isPendingDraftWorktreeRequest } from '@/lib/worktrees/pendingDraftWorktree';
import { isSpaceCreationRequest } from './space-creation-requests';
import { spaceOfTarget, type SpaceTarget } from './space-model-offer';
import { useSpacesStore } from './spaces-store';

type ParallelRunPlace = { kind: 'host' } | { kind: 'preparing' } | { kind: 'space'; directory: string };

export const parallelRunPlaceOf = (target: SpaceTarget): ParallelRunPlace => {
  if (isSpaceCreationRequest(target.requestId) && isPendingDraftWorktreeRequest(target.requestId)) return { kind: 'preparing' };
  const space = spaceOfTarget(target);
  if (!space) return { kind: isSpaceCreationRequest(target.requestId) ? 'preparing' : 'host' };
  if (useSpacesStore.getState().journey?.get(space.spaceId)?.state === 'preparing') return { kind: 'preparing' };
  return { kind: 'space', directory: space.directory };
};
