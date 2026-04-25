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
  isTauriShellRuntime: boolean,
  deviceType: DeviceType,
  hasTouchInput: boolean,
  isAndroid: boolean,
) => {
  if (typeof window === 'undefined') {
    return;
  }

  const root = document.documentElement;
  const isMobile = deviceType === 'mobile';
  const isTablet = deviceType === 'tablet';

  root.classList.remove('device-mobile', 'device-tablet', 'device-desktop', 'device-android');
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
    if (isAndroid) {
      root.classList.add('device-android');
    }
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
  const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

  const isDesktopShellRuntime = isDesktopShell();

  const hasTouchInput = prefersCoarsePointer || noHover || maxTouchPoints > 0;

  const isTabletWidth = width > BREAKPOINTS.md && width <= BREAKPOINTS.lg;
  const isMobileWidth = width <= BREAKPOINTS.md;

  let isMobile = hasTouchInput && isMobileWidth;
  let isTablet = hasTouchInput && !isMobile && isTabletWidth;
  let isDesktop = !hasTouchInput || width > BREAKPOINTS.lg;
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

  setRootDeviceAttributes(isDesktopShellRuntime, deviceType, hasTouchInput, !isDesktopShellRuntime && isAndroid);

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
    const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
    const hasTouchInput = prefersCoarsePointer || noHover || maxTouchPoints > 0;
    setRootDeviceAttributes(
      isDesktopShellRuntime,
      deviceInfo.deviceType,
      hasTouchInput,
      !isDesktopShellRuntime && isAndroid,
    );
  }, [deviceInfo.deviceType, deviceInfo.hasTouchInput]);

  return deviceInfo;
}
