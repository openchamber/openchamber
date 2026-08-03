import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { getStoredMobileLayoutPreference } from '@/lib/mobileLayoutPreference';

export type HostedSurface = 'desktop' | 'mobile';

declare global {
  interface Window {
    __OPENCHAMBER_SURFACE__?: HostedSurface;
  }
}

const MOBILE_SURFACE_MAX_WIDTH = 768;

const isTouchOrCoarsePointer = (): boolean => {
  if (typeof window === 'undefined') return false;

  const coarsePointer = typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(hover: none)').matches
    : false;
  const touchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0;
  return coarsePointer || touchPoints > 0;
};

/**
 * Single authority for the mobile-vs-desktop surface decision.
 *
 * Priority: explicit stamp (set once at boot) → URL override → Capacitor
 * shell (always the mobile surface) → desktop shells → phone heuristic
 * gated by the stored mobile layout preference.
 */
export const detectHostedSurface = (): HostedSurface => {
  if (typeof window === 'undefined') return 'desktop';

  const explicitSurface = window.__OPENCHAMBER_SURFACE__;
  if (explicitSurface === 'mobile' || explicitSurface === 'desktop') {
    return explicitSurface;
  }

  const override = new URLSearchParams(window.location.search).get('surface');
  if (override === 'mobile' || override === 'desktop') {
    return override;
  }

  if (isCapacitorApp()) return 'mobile';
  if (isDesktopShell() || isVSCodeRuntime()) return 'desktop';

  const width = Math.min(
    window.innerWidth || Number.POSITIVE_INFINITY,
    window.screen?.width || Number.POSITIVE_INFINITY,
  );
  const likelyPhone = Number.isFinite(width)
    && width <= MOBILE_SURFACE_MAX_WIDTH
    && isTouchOrCoarsePointer();
  return likelyPhone && getStoredMobileLayoutPreference() === 'new' ? 'mobile' : 'desktop';
};

/**
 * Decides the surface once and stamps it on `window` so every later
 * `isMobileSurfaceRuntime()` call (perf tuning, sync paging, device info)
 * reads the same stable answer instead of re-running viewport heuristics.
 */
export const resolveHostedSurface = (): HostedSurface => {
  const surface = detectHostedSurface();
  if (typeof window !== 'undefined') {
    window.__OPENCHAMBER_SURFACE__ = surface;
  }
  return surface;
};

export const isMobileSurfaceRuntime = (): boolean => detectHostedSurface() === 'mobile';
