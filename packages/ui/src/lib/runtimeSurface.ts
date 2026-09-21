import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';

export type HostedSurface = 'desktop' | 'mobile';

declare global {
  interface Window {
    __OPENCHAMBER_SURFACE__?: HostedSurface;
  }
}

const MOBILE_SURFACE_MAX_WIDTH = 768;
const SURFACE_SWITCH_DEBOUNCE_MS = 800;

const isTouchOrCoarsePointer = (): boolean => {
  if (typeof window === 'undefined') return false;

  const coarsePointer = typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(hover: none)').matches
    : false;
  const touchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0;
  return coarsePointer || touchPoints > 0;
};

const hasSurfaceUrlOverride = (): boolean => {
  if (typeof window === 'undefined') return false;
  const override = new URLSearchParams(window.location.search).get('surface');
  return override === 'mobile' || override === 'desktop';
};

/** Viewport half of the surface decision; re-evaluated on resize by the watcher. */
const isPhoneViewport = (): boolean => {
  if (typeof window === 'undefined') return false;
  const width = Math.min(
    window.innerWidth || Number.POSITIVE_INFINITY,
    window.screen?.width || Number.POSITIVE_INFINITY,
  );
  return Number.isFinite(width)
    && width <= MOBILE_SURFACE_MAX_WIDTH
    && isTouchOrCoarsePointer();
};

/**
 * Single authority for the mobile-vs-desktop surface decision.
 *
 * Priority: explicit stamp (set once at boot) → URL override → Capacitor
 * shell (always the mobile surface) → desktop shells → phone heuristic.
 */
const detectHostedSurface = (): HostedSurface => {
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

  return isPhoneViewport() ? 'mobile' : 'desktop';
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

/**
 * The surface is stamped once at boot, so a browser window that crosses the
 * phone threshold after load would otherwise keep the wrong app shell (the
 * app trees, stores, and sync bootstrap differ, so an in-place switch is not
 * safe). Watch for the viewport heuristic disagreeing with the stamp and
 * reload — the same mechanism a surface change has always used — once the
 * resize settles. Fixed shells never switch: Capacitor is always mobile,
 * desktop/VS Code shells are always desktop, and an explicit ?surface=
 * override wins over the heuristic.
 */
export const watchHostedSurfaceViewport = (): (() => void) => {
  if (typeof window === 'undefined') return () => {};
  if (isCapacitorApp() || isDesktopShell() || isVSCodeRuntime()) return () => {};
  if (hasSurfaceUrlOverride()) return () => {};

  let timeout: ReturnType<typeof setTimeout> | null = null;
  const handleResize = () => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      timeout = null;
      const stamped = window.__OPENCHAMBER_SURFACE__;
      const desired: HostedSurface = isPhoneViewport() ? 'mobile' : 'desktop';
      if (stamped && stamped !== desired) {
        window.__OPENCHAMBER_SURFACE__ = undefined;
        window.location.reload();
      }
    }, SURFACE_SWITCH_DEBOUNCE_MS);
  };

  window.addEventListener('resize', handleResize);
  return () => {
    if (timeout) clearTimeout(timeout);
    window.removeEventListener('resize', handleResize);
  };
};
