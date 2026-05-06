import React from 'react';
import { isDesktopShell } from '@/lib/desktop';

export type DeviceType = 'desktop' | 'mobile' | 'tablet';

export interface DeviceInfo {
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  deviceType: DeviceType;
  screenWidth: number;
  breakpoint: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  hasTouchInput: boolean;
  hasTouchOnlyPointer: boolean;
}

export const CSS_DEVICE_VARIABLES = {
  IS_MOBILE: 'var(--is-mobile)',
  DEVICE_TYPE: 'var(--device-type)',
  HAS_TOUCH_INPUT: 'var(--has-touch-input)',
} as const;

export const BREAKPOINTS = {
  xs: 0,
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1536,
} as const;

const getNavigatorDeviceHints = (maxTouchPoints: number) => {
  if (typeof navigator === 'undefined') {
    return { isExplicitTablet: false };
  }

  const userAgent = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const isIPad = /iPad/i.test(userAgent)
    || ((/Macintosh|MacIntel/i.test(userAgent) || /MacIntel/i.test(platform)) && maxTouchPoints > 1);
  const isAndroidTablet = /Android/i.test(userAgent) && !/Mobile/i.test(userAgent);
  const isGenericTablet = /Tablet/i.test(userAgent);

  return { isExplicitTablet: isIPad || isAndroidTablet || isGenericTablet };
};

const setRootDeviceAttributes = (
  isTauriShellRuntime: boolean,
  deviceType: DeviceType,
  hasTouchInput: boolean,
) => {
  if (typeof window === 'undefined') {
    return;
  }

  const root = document.documentElement;
  const isMobile = deviceType === 'mobile';
  const isTablet = deviceType === 'tablet';

  root.classList.remove('device-mobile', 'device-tablet', 'device-desktop');
  root.classList.add(
    deviceType === 'mobile'
      ? 'device-mobile'
      : deviceType === 'tablet'
        ? 'device-tablet'
        : 'device-desktop'
  );

  if (isTauriShellRuntime) {
    root.classList.add('desktop-runtime');
    root.style.setProperty('--is-mobile', '0');
    root.style.setProperty('--device-type', 'desktop');
    root.style.setProperty('--font-scale', '1');
    root.style.setProperty('--has-coarse-pointer', '0');
    root.style.setProperty('--has-touch-input', '0');
    root.classList.remove('mobile-pointer');
  } else {
    root.classList.remove('desktop-runtime');
    root.style.setProperty('--is-mobile', isMobile ? '1' : '0');
    root.style.setProperty('--device-type', deviceType);
    root.style.setProperty('--font-scale', isMobile ? '0.9' : isTablet ? '0.95' : '1');
    root.style.setProperty('--has-coarse-pointer', hasTouchInput ? '1' : '0');
    root.style.setProperty('--has-touch-input', hasTouchInput ? '1' : '0');
    if (hasTouchInput) {
      root.classList.add('mobile-pointer');
    } else {
      root.classList.remove('mobile-pointer');
    }
  }
};

export function getDeviceInfo(): DeviceInfo {
  const width = window.innerWidth;
  const supportsMatchMedia = typeof window.matchMedia === 'function';
  const pointerQuery = supportsMatchMedia ? window.matchMedia('(pointer: coarse)') : null;
  const hoverQuery = supportsMatchMedia ? window.matchMedia('(hover: none)') : null;
  const prefersCoarsePointer = pointerQuery?.matches ?? false;
  const noHover = hoverQuery?.matches ?? false;
  const maxTouchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0;
  const isDesktopShellRuntime = isDesktopShell();
  const { isExplicitTablet } = getNavigatorDeviceHints(maxTouchPoints);

  const hasTouchInput = prefersCoarsePointer || noHover || maxTouchPoints > 0;
  const hasTouchOnlyPointer = prefersCoarsePointer || noHover;

  const isTabletWidth = width > BREAKPOINTS.md && width <= BREAKPOINTS.lg;
  const isMobileWidth = width <= BREAKPOINTS.md;

  let isMobile = hasTouchInput && isMobileWidth;
  let isTablet = hasTouchInput && !isMobile && (isTabletWidth || isExplicitTablet);
  let isDesktop = !hasTouchInput || (!isTablet && width > BREAKPOINTS.lg);
  let deviceType: DeviceType = 'desktop';

  if (isDesktopShellRuntime) {
    isMobile = false;
    isTablet = false;
    isDesktop = true;
    deviceType = 'desktop';
  } else if (isMobile) {
    deviceType = 'mobile';
  } else if (isTablet) {
    deviceType = 'tablet';
  } else {
    isDesktop = true;
    deviceType = 'desktop';
  }

  setRootDeviceAttributes(isDesktopShellRuntime, deviceType, hasTouchInput);

  let breakpoint: keyof typeof BREAKPOINTS = 'xs';
  for (const [key, value] of Object.entries(BREAKPOINTS)) {
    if (width >= value) {
      breakpoint = key as keyof typeof BREAKPOINTS;
    }
  }

  return {
    isMobile,
    isTablet,
    isDesktop,
    deviceType,
    screenWidth: width,
    breakpoint,
    hasTouchInput,
    hasTouchOnlyPointer,
  };
}

export function isMobileDeviceViaCSS(): boolean {
  if (typeof window === 'undefined') return false;

  if (typeof window !== 'undefined' && isDesktopShell()) {
    return false;
  }

  const root = document.documentElement;
  const isMobileValue = root.style.getPropertyValue('--is-mobile') ||
                        getComputedStyle(root).getPropertyValue('--is-mobile');

  return isMobileValue === '1' || isMobileValue === 'true';
}

export const isStandalonePwaRuntime = (): boolean => {
  if (typeof window === 'undefined') return false;

  const standaloneNavigator = navigator as Navigator & { standalone?: boolean };
  return Boolean(
    standaloneNavigator.standalone === true
    || window.matchMedia?.('(display-mode: standalone)')?.matches
    || window.matchMedia?.('(display-mode: fullscreen)')?.matches
  );
};

export const isTabletStandalonePwaRuntime = (): boolean => {
  if (typeof window === 'undefined' || isDesktopShell()) return false;

  const maxTouchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0;
  return isStandalonePwaRuntime() && maxTouchPoints > 0 && window.innerWidth > BREAKPOINTS.md;
};

export function useTabletStandalonePwaRuntime(): boolean {
  const [value, setValue] = React.useState<boolean>(() => isTabletStandalonePwaRuntime());

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const update = () => setValue(isTabletStandalonePwaRuntime());
    const standaloneQuery = window.matchMedia?.('(display-mode: standalone)');
    const fullscreenQuery = window.matchMedia?.('(display-mode: fullscreen)');

    update();
    window.addEventListener('resize', update);
    window.addEventListener('focus', update);

    const addQueryListener = (query: MediaQueryList | undefined) => {
      if (!query) return;
      if (typeof query.addEventListener === 'function') {
        query.addEventListener('change', update);
      } else if (typeof query.addListener === 'function') {
        query.addListener(update);
      }
    };
    const removeQueryListener = (query: MediaQueryList | undefined) => {
      if (!query) return;
      if (typeof query.removeEventListener === 'function') {
        query.removeEventListener('change', update);
      } else if (typeof query.removeListener === 'function') {
        query.removeListener(update);
      }
    };

    addQueryListener(standaloneQuery);
    addQueryListener(fullscreenQuery);

    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('focus', update);
      removeQueryListener(standaloneQuery);
      removeQueryListener(fullscreenQuery);
    };
  }, []);

  return value;
}

export function useDeviceInfo(): DeviceInfo {
  const [deviceInfo, setDeviceInfo] = React.useState<DeviceInfo>(() => {
    if (typeof window === 'undefined') {
      return {
        isMobile: false,
        isTablet: false,
        isDesktop: true,
        deviceType: 'desktop',
        screenWidth: 1024,
        breakpoint: 'lg',
        hasTouchInput: false,
        hasTouchOnlyPointer: false,
      };
    }
    return getDeviceInfo();
  });

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    let debounceTimer: ReturnType<typeof setTimeout>;
    const handleResize = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        setDeviceInfo(getDeviceInfo());
      }, 150);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      clearTimeout(debounceTimer);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const pointerQuery = window.matchMedia('(pointer: coarse)');
    const hoverQuery = window.matchMedia('(hover: none)');

    const handlePointerChange = () => {
      setDeviceInfo(getDeviceInfo());
    };

    const cleanups: Array<() => void> = [];

    const attachListener = (query: MediaQueryList | null) => {
      if (!query) {
        return;
      }
      if (typeof query.addEventListener === 'function') {
        query.addEventListener('change', handlePointerChange);
        cleanups.push(() => query.removeEventListener('change', handlePointerChange));
      } else if (typeof query.addListener === 'function') {
        query.addListener(handlePointerChange);
        cleanups.push(() => query.removeListener(handlePointerChange));
      }
    };

    attachListener(pointerQuery);
    attachListener(hoverQuery);

    return () => {
      cleanups.forEach((cleanup) => cleanup());
    };
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const isDesktopShellRuntime = isDesktopShell();
    const supportsMatchMedia = typeof window.matchMedia === 'function';
    const pointerQuery = supportsMatchMedia ? window.matchMedia('(pointer: coarse)') : null;
    const hoverQuery = supportsMatchMedia ? window.matchMedia('(hover: none)') : null;
    const prefersCoarsePointer = pointerQuery?.matches ?? false;
    const noHover = hoverQuery?.matches ?? false;
    const maxTouchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0;
    const hasTouchInput = prefersCoarsePointer || noHover || maxTouchPoints > 0;
    setRootDeviceAttributes(isDesktopShellRuntime, deviceInfo.deviceType, hasTouchInput);
  }, [deviceInfo.deviceType, deviceInfo.hasTouchInput]);

  return deviceInfo;
}
