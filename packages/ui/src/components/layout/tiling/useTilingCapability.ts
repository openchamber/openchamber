import React from 'react';
import { isVSCodeRuntime, isWebRuntime } from '@/lib/desktop';
import { getPWADisplayMode } from '@/lib/pwa';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';

export type TilingRuntime = 'web' | 'desktop';

export type TilingCapabilityInput = {
  readonly runtime: TilingRuntime;
  readonly isMobile: boolean;
  readonly isPWA: boolean;
  readonly isVSCode: boolean;
  readonly isWide: boolean;
  readonly isFinePointer: boolean;
};

export const computeTilingCapability = (input: TilingCapabilityInput): boolean => (
  (input.runtime === 'web' || input.runtime === 'desktop')
  && input.isWide
  && input.isFinePointer
  && !input.isMobile
  && !input.isPWA
  && !input.isVSCode
);

const WIDE_VIEWPORT_QUERY = '(min-width: 700px)';
const FINE_POINTER_QUERY = '(pointer: fine)';

type TilingSignals = Pick<TilingCapabilityInput, 'isWide' | 'isFinePointer'>;

const readSignals = (): TilingSignals => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return { isWide: false, isFinePointer: false };
  }

  return {
    isWide: window.matchMedia(WIDE_VIEWPORT_QUERY).matches,
    isFinePointer: window.matchMedia(FINE_POINTER_QUERY).matches,
  };
};

const addMediaQueryListener = (query: MediaQueryList, listener: () => void): (() => void) => {
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }

  query.addListener(listener);
  return () => query.removeListener(listener);
};

export const useTilingCapability = (): boolean => {
  const [signals, setSignals] = React.useState<TilingSignals>(() => readSignals());
  const isMobile = isMobileSurfaceRuntime();
  const isPWA = getPWADisplayMode() !== 'browser';
  const isVSCode = isVSCodeRuntime();
  const runtime: TilingRuntime = isWebRuntime() ? 'web' : 'desktop';

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const update = () => setSignals(readSignals());
    const queries = [
      window.matchMedia(WIDE_VIEWPORT_QUERY),
      window.matchMedia(FINE_POINTER_QUERY),
    ];
    const cleanups = queries.map((query) => addMediaQueryListener(query, update));

    window.addEventListener('resize', update);
    update();

    return () => {
      window.removeEventListener('resize', update);
      for (const cleanup of cleanups) cleanup();
    };
  }, []);

  return computeTilingCapability({
    runtime,
    isMobile,
    isPWA,
    isVSCode,
    ...signals,
  });
};
