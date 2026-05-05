export type MobileKeyboardMode = 'native' | 'resize-content';

export const MOBILE_KEYBOARD_MODE_STORAGE_KEY = 'openchamber.mobileKeyboardMode';
export const VIEWPORT_META_SELECTOR = 'meta[name="viewport"]';
export const VIEWPORT_CONTENT_BASE = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover';

export const supportsMobileKeyboardResizeContent = (): boolean => {
  if (typeof navigator === 'undefined') {
    return true;
  }

  const userAgent = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const maxTouchPoints = navigator.maxTouchPoints ?? 0;
  const isIOS = /iPhone|iPad|iPod/i.test(userAgent)
    || ((/Macintosh|MacIntel/i.test(userAgent) || /MacIntel/i.test(platform)) && maxTouchPoints > 1);

  return !isIOS;
};

const getSupportedMobileKeyboardMode = (mode: MobileKeyboardMode): MobileKeyboardMode => {
  if (mode === 'resize-content' && !supportsMobileKeyboardResizeContent()) {
    return 'native';
  }
  return mode;
};

export function normalizeMobileKeyboardMode(value: unknown): MobileKeyboardMode;
export function normalizeMobileKeyboardMode(value: unknown, fallback: MobileKeyboardMode): MobileKeyboardMode;
export function normalizeMobileKeyboardMode(value: unknown, fallback: undefined): MobileKeyboardMode | undefined;
export function normalizeMobileKeyboardMode(
  value: unknown,
  fallback: MobileKeyboardMode | undefined = 'native',
): MobileKeyboardMode | undefined {
  if (value === 'native' || value === 'resize-content') {
    return value;
  }
  return fallback;
}

export const getViewportContentForMobileKeyboardMode = (value: unknown): string => {
  const mode = getSupportedMobileKeyboardMode(normalizeMobileKeyboardMode(value));
  return mode === 'resize-content'
    ? `${VIEWPORT_CONTENT_BASE}, interactive-widget=resizes-content`
    : VIEWPORT_CONTENT_BASE;
};

export const getStoredMobileKeyboardMode = (): MobileKeyboardMode => {
  if (typeof window === 'undefined') {
    return 'native';
  }

  try {
    return getSupportedMobileKeyboardMode(normalizeMobileKeyboardMode(localStorage.getItem(MOBILE_KEYBOARD_MODE_STORAGE_KEY)));
  } catch {
    return 'native';
  }
};

export const setStoredMobileKeyboardMode = (value: unknown): MobileKeyboardMode => {
  const mode = getSupportedMobileKeyboardMode(normalizeMobileKeyboardMode(value));

  if (typeof window !== 'undefined') {
    try {
      if (mode === 'native') {
        localStorage.removeItem(MOBILE_KEYBOARD_MODE_STORAGE_KEY);
      } else {
        localStorage.setItem(MOBILE_KEYBOARD_MODE_STORAGE_KEY, mode);
      }
    } catch {
      // Ignore storage failures in restricted browsing contexts.
    }
  }

  return mode;
};

export const applyMobileKeyboardMode = (value: unknown): MobileKeyboardMode => {
  const mode = setStoredMobileKeyboardMode(value);

  if (typeof document === 'undefined') {
    return mode;
  }

  document.documentElement.setAttribute('data-oc-mobile-keyboard-mode', mode);

  const viewportMeta = document.querySelector(VIEWPORT_META_SELECTOR);
  if (viewportMeta instanceof HTMLMetaElement) {
    const nextContent = getViewportContentForMobileKeyboardMode(mode);
    if (viewportMeta.getAttribute('content') !== nextContent) {
      viewportMeta.setAttribute('content', nextContent);
    }
  }

  return mode;
};
