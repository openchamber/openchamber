import { useUIStore } from '@/stores/useUIStore';

const ISOLATED_SPACES_RELEASED = false;

export const isIsolatedSpacesPageVisible = (): boolean =>
  ISOLATED_SPACES_RELEASED || useUIStore.getState().isolatedSpacesEnabled;
