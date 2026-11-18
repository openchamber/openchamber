import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { panelContentDirectory } from './space-creation-requests';
import { isSpaceDirectory } from './space-route';
import { useDraftSpaceTarget } from './useDraftSpaceTarget';

export const useGitPanelInSpace = (): boolean => isSpaceDirectory(panelContentDirectory(useDraftSpaceTarget(), useEffectiveDirectory()));
