import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';

export type HostedSurface = 'desktop' | 'mobile';

const MOBILE_SURFACE_MAX_WIDTH = 768;
export const TABLET_LAYOUT_MIN_SHORT_SIDE_PX = 600;
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

const isPhoneViewport = (): boolean => {
  if (typeof window === 'undefined') return false;
  const screenWidth = window.screen?.width;
  const screenHeight = window.screen?.height;
  const width = Math.min(
    window.innerWidth || Number.POSITIVE_INFINITY,
    screenWidth || Number.POSITIVE_INFINITY,
  );
  const viewportWidthMatches = Number.isFinite(width)
    && width <= MOBILE_SURFACE_MAX_WIDTH
    && isTouchOrCoarsePointer();
  const screenShortSideMatches = Number.isFinite(screenWidth)
    && screenWidth > 0
    && Number.isFinite(screenHeight)
    && screenHeight > 0
    && Math.min(screenWidth, screenHeight) < TABLET_LAYOUT_MIN_SHORT_SIDE_PX
    && window.matchMedia?.('(pointer: coarse)')?.matches === true;
  return viewportWidthMatches || screenShortSideMatches;
};

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

export const resolveHostedSurface = (): HostedSurface => {
  const surface = detectHostedSurface();
  if (typeof window !== 'undefined') {
    window.__OPENCHAMBER_SURFACE__ = surface;
  }
  return surface;
};

export const isMobileSurfaceRuntime = (): boolean => detectHostedSurface() === 'mobile';

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
