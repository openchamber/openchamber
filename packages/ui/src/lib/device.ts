import React from 'react';
import { isDesktopShell, isMobileRuntime } from '@/lib/desktop';

export type DeviceType = 'desktop' | 'mobile' | 'tablet';

export interface DeviceInfo {
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  deviceType: DeviceType;
  screenWidth: number;
  breakpoint: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  hasTouchInput: boolean;
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

const setRootDeviceAttributes = (
  isDesktopShellRuntime: boolean,
  isMobileShellRuntime: boolean,
  deviceType: DeviceType,
  hasTouchInput: boolean,
) => {
  if (typeof window === 'undefined') {
    return;
  }

  const root = document.documentElement;
  const isMobile = deviceType === 'mobile';
  const isTablet = deviceType === 'tablet';

  root.classList.remove('device-mobile', 'device-tablet', 'device-desktop', 'runtime-ios', 'runtime-android');
  root.classList.add(
    deviceType === 'mobile'
      ? 'device-mobile'
      : deviceType === 'tablet'
        ? 'device-tablet'
        : 'device-desktop'
  );

  if (isMobileShellRuntime) {
    root.classList.add('tauri-mobile-runtime');
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
    if (/iphone|ipad|ipod/.test(ua)) {
      root.classList.add('runtime-ios');
    }
    if (/android/.test(ua)) {
      root.classList.add('runtime-android');
    }
  } else {
    root.classList.remove('tauri-mobile-runtime');
  }

  if (isDesktopShellRuntime) {
    root.classList.add('desktop-runtime');
    root.style.setProperty('--is-mobile', '0');
    root.style.setProperty('--device-type', 'desktop');
    root.style.setProperty('--font-scale', '1');
    root.style.setProperty('--has-coarse-pointer', '0');
    root.style.setProperty('--has-touch-input', '0');
    root.classList.remove('mobile-pointer');
  } else {
    root.classList.remove('desktop-runtime');
    root.style.setProperty('--is-mobile', (isMobile || isTablet) ? '1' : '0');
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
  const height = window.innerHeight;
  const supportsMatchMedia = typeof window.matchMedia === 'function';
  const pointerQuery = supportsMatchMedia ? window.matchMedia('(pointer: coarse)') : null;
  const hoverQuery = supportsMatchMedia ? window.matchMedia('(hover: none)') : null;
  const prefersCoarsePointer = pointerQuery?.matches ?? false;
  const noHover = hoverQuery?.matches ?? false;
  const maxTouchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0;

  const isDesktopShellRuntime = isDesktopShell();
  const isMobileShellRuntime = isMobileRuntime();

  const hasTouchInput = prefersCoarsePointer || noHover || maxTouchPoints > 0 || isMobileShellRuntime;

  const shortestSide = Math.min(width, height);
  const isPhoneWidth = shortestSide < BREAKPOINTS.md;

  let isMobile = false;
  let isTablet = false;
  let isDesktop = true;
  let deviceType: DeviceType = 'desktop';

  if (isDesktopShellRuntime) {
    isMobile = false;
    isTablet = false;
    isDesktop = true;
    deviceType = 'desktop';
  } else if (hasTouchInput || isMobileShellRuntime) {
    if (isPhoneWidth) {
      isMobile = true;
      isTablet = false;
      deviceType = 'mobile';
    } else {
      isMobile = false;
      isTablet = true;
      deviceType = 'tablet';
    }
    isDesktop = false;
  } else {
    isMobile = false;
    isTablet = false;
    isDesktop = true;
    deviceType = 'desktop';
  }

  setRootDeviceAttributes(isDesktopShellRuntime, isMobileShellRuntime, deviceType, hasTouchInput);

  let breakpoint: keyof typeof BREAKPOINTS = 'xs';
  for (const [key, value] of Object.entries(BREAKPOINTS)) {
    if (width >= value) {
      breakpoint = key as keyof typeof BREAKPOINTS;
    }
  }

  return {
    isMobile: isMobile || isTablet,
    isTablet,
    isDesktop,
    deviceType,
    screenWidth: width,
    breakpoint,
    hasTouchInput,
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
      };
    }
    return getDeviceInfo();
  });

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleResize = () => {
      setDeviceInfo(getDeviceInfo());
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
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
    setRootDeviceAttributes(isDesktopShellRuntime, isMobileRuntime(), deviceInfo.deviceType, hasTouchInput);
  }, [deviceInfo.deviceType, deviceInfo.hasTouchInput]);

  return deviceInfo;
}
