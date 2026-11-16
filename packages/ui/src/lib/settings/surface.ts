import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import type { SettingsSurface } from './registry';

export const SETTINGS_SURFACE_QUERY = 'surface';

export const getSettingsSurface = (): SettingsSurface => {
  try {
    if (isVSCodeRuntime()) return 'vscode';
    if (isDesktopShell()) return 'desktop';
    if (isCapacitorApp() || isMobileSurfaceRuntime()) return 'mobile';
  } catch {
    // The detectors read `window.location` and friends; outside a real
    // browser document (tests, SSR-like shells) the plain web kind applies.
  }
  return 'web';
};
