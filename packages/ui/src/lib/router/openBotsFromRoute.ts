import { isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { useUIStore } from '@/stores/useUIStore';
import type { BotsRouteTarget } from './types';

/** Shared query/native-link application. Mobile must provide its own shell opener. */
export function openBotsFromRoute(target: BotsRouteTarget, openMobileBots?: () => void): void {
  if (isVSCodeRuntime() || (isMobileSurfaceRuntime() && !openMobileBots)) return;
  const ui = useUIStore.getState();
  if (ui.isSettingsDialogOpen) ui.setSettingsDialogOpen(false);
  ui.setBotsPageTarget(target);
  if (openMobileBots) openMobileBots();
  else ui.setBotsPageOpen(true);
}
