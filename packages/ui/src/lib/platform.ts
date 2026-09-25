import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';

/** True when running inside the native Capacitor shell (iOS/Android app), not the web/PWA. */
export const isCapacitorApp = (): boolean => {
  if (typeof window === 'undefined') return false;
  const capacitor = (window as typeof window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return capacitor?.isNativePlatform?.() === true || window.location.protocol === 'capacitor:';
};

/**
 * True when running inside the native Capacitor shell on an iPad.
 * Capacitor reports 'ios' for both iPhone and iPad; iPadOS WKWebView
 * masquerades as macOS Safari, so the only reliable tell is a Mac-like
 * platform with real touch points (or a legacy explicit iPad UA).
 */
export const isIPadApp = (): boolean => {
  if (typeof window === 'undefined' || !isCapacitorApp()) return false;
  if (getClientPlatform() !== 'ios') return false;
  const userAgent = navigator.userAgent || '';
  const maxTouchPoints = navigator.maxTouchPoints ?? 0;
  return /iPad/i.test(userAgent)
    || (/Macintosh|MacIntel/i.test(userAgent) && maxTouchPoints > 1);
};

export type ClientPlatform = 'ios' | 'android' | 'vscode' | 'desktop' | 'web';

/**
 * The runtime surface this client is. Used by the push presence model: only 'ios'/'android'
 * count as mobile (push recipients); everything else is an interactive surface that suppresses
 * mobile push while visible.
 */
export const getClientPlatform = (): ClientPlatform => {
  if (typeof window !== 'undefined') {
    const capacitor = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor;
    const native = capacitor?.getPlatform?.();
    if (native === 'ios' || native === 'android') return native;
  }
  if (isVSCodeRuntime()) return 'vscode';
  if (isDesktopShell()) return 'desktop';
  return 'web';
};
