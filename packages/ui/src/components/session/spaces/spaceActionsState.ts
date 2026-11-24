
import { isSpaceActionUnavailable, isSpaceApplicable, runSpaceAction, spaceMenuActionsOf } from '@/lib/spaces/space-repair';
import { useProjectHasSetup } from '@/hooks/useProjectHasSetup';
import { useSpacesStore, type SpaceAction } from '@/lib/spaces/spaces-store';

export const pickSpaceAction = (spaceId: string, action: SpaceAction) => {
  if (action === 'remove') useSpacesStore.getState().openDeleteDialog(spaceId);
  else void runSpaceAction(spaceId, action);
};

export const useSpaceActions = (spaceId: string) => {
  const entry = useSpacesStore((state) => state.journey?.get(spaceId));
  const busy = useSpacesStore((state) => state.actions.get(spaceId)?.kind === 'running');
  return {
    actions: spaceMenuActionsOf(entry),
    applicable: isSpaceApplicable(entry),
    busy,
    unavailable: (action: SpaceAction) => isSpaceActionUnavailable(entry, action),
  };
};

export const useSpaceMenuActions = (spaceId: string) => {
  const state = useSpaceActions(spaceId);
  const projectDirectory = useSpacesStore((store) => store.journey?.get(spaceId)?.projectDirectory ?? null);
  const hasSetup = useProjectHasSetup(state.actions.includes('setup') ? projectDirectory : null);
  return { ...state, actions: hasSetup ? state.actions : state.actions.filter((action) => action !== 'setup') };
};

export const openSpaceApply = (spaceId: string) => useSpacesStore.getState().openApplyDialog(spaceId);
