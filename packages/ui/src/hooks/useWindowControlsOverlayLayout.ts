import React from 'react';
import { isWebRuntime } from '@/lib/desktop';

type WindowControlsOverlayArea = {
  x: number;
  width: number;
  height: number;
};

type WindowControlsOverlayLike = {
  visible: boolean;
  getTitlebarAreaRect: () => WindowControlsOverlayArea;
  addEventListener?: (type: 'geometrychange', listener: () => void) => void;
  removeEventListener?: (type: 'geometrychange', listener: () => void) => void;
};

type NavigatorWithWindowControlsOverlay = Navigator & {
  windowControlsOverlay?: WindowControlsOverlayLike;
};

const clampPx = (value: number): string => {
  if (!Number.isFinite(value)) {
    return '0px';
  }
  return `${Math.max(0, Math.round(value))}px`;
};

const applyOverlayInsets = (
  root: HTMLElement,
  leftInsetPx: number,
  rightInsetPx: number,
  titlebarHeightPx: number,
) => {
  root.style.setProperty('--oc-wco-left-inset', clampPx(leftInsetPx));
  root.style.setProperty('--oc-wco-right-inset', clampPx(rightInsetPx));
  root.style.setProperty('--oc-wco-titlebar-height', clampPx(titlebarHeightPx));
};

export const useWindowControlsOverlayLayout = () => {
  React.useEffect(() => {
    if (typeof window === 'undefined' || !isWebRuntime()) {
      return;
    }

    const root = document.documentElement;
    const mediaQuery = typeof window.matchMedia === 'function'
      ? window.matchMedia('(display-mode: window-controls-overlay)')
      : null;
    const navigatorWithOverlay = window.navigator as NavigatorWithWindowControlsOverlay;
    const overlay = navigatorWithOverlay.windowControlsOverlay;

    const updateGeometry = () => {
      if (!overlay || !mediaQuery?.matches || !overlay.visible) {
        applyOverlayInsets(root, 0, 0, 0);
        return;
      }

      const rect = overlay.getTitlebarAreaRect();
      const leftInset = Math.max(0, Number(rect.x) || 0);
      const width = Math.max(0, Number(rect.width) || 0);
      const titlebarHeight = Math.max(0, Number(rect.height) || 0);
      const rightInset = Math.max(0, window.innerWidth - (leftInset + width));

      applyOverlayInsets(root, leftInset, rightInset, titlebarHeight);
    };

    const handleMediaQueryChange = () => {
      updateGeometry();
    };

    updateGeometry();

    window.addEventListener('resize', updateGeometry);
    window.addEventListener('focus', updateGeometry);

    if (mediaQuery) {
      if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', handleMediaQueryChange);
      } else if (typeof mediaQuery.addListener === 'function') {
        mediaQuery.addListener(handleMediaQueryChange);
      }
    }

    if (overlay && typeof overlay.addEventListener === 'function') {
      overlay.addEventListener('geometrychange', updateGeometry);
    }

    return () => {
      window.removeEventListener('resize', updateGeometry);
      window.removeEventListener('focus', updateGeometry);

      if (mediaQuery) {
        if (typeof mediaQuery.removeEventListener === 'function') {
          mediaQuery.removeEventListener('change', handleMediaQueryChange);
        } else if (typeof mediaQuery.removeListener === 'function') {
          mediaQuery.removeListener(handleMediaQueryChange);
        }
      }

      if (overlay && typeof overlay.removeEventListener === 'function') {
        overlay.removeEventListener('geometrychange', updateGeometry);
      }
    };
  }, []);
};
