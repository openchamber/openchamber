import { isDesktopShell } from '@/lib/desktop';

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

  if (isDesktopShell()) return 'desktop';

  const width = window.innerWidth || window.screen?.width || 0;
  return width > 0 && width <= MOBILE_SURFACE_MAX_WIDTH && isTouchOrCoarsePointer()
    ? 'mobile'
    : 'desktop';
};

export const isMobileSurfaceRuntime = (): boolean => detectHostedSurface() === 'mobile';
