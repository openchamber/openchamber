import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import type { SettingsSurface } from './registry';

/**
 * The query parameter that tells the server which surface kind a client is
 * (`/api/config/settings?surface=desktop`). A query parameter rather than a
 * header so the request stays CORS-simple: the packaged desktop shell and the
 * phone app are cross-origin to the server, and an older instance would refuse
 * an unknown header at preflight.
 */
export const SETTINGS_SURFACE_QUERY = 'surface';

/**
 * Which surface kind this client is, for the registry's per-surface profile
 * fields: a change made here is stored for this kind only. The phone app and
 * the hosted mobile shell are one kind — both are "the phone" to the user.
 */
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
