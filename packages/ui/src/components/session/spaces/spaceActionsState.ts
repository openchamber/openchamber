// What the action surfaces of a space share: its menu and sheet (`SpaceActions.tsx`) and the
// buttons of its row in the lists of spaces (`SpaceRow.tsx`).

import { isSpaceActionUnavailable, isSpaceApplicable, runSpaceAction, spaceMenuActionsOf } from '@/lib/spaces/space-repair';
import { useSpacesStore, type SpaceAction } from '@/lib/spaces/spaces-store';

/** Runs an action picked from a menu, a sheet or a button; delete opens its confirmation instead. */
export const pickSpaceAction = (spaceId: string, action: SpaceAction) => {
  if (action === 'remove') useSpacesStore.getState().openDeleteDialog(spaceId);
  else void runSpaceAction(spaceId, action);
};

/** The actions a space offers now, whether its work can be applied, and whether one runs already. */
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

export const openSpaceApply = (spaceId: string) => useSpacesStore.getState().openApplyDialog(spaceId);
