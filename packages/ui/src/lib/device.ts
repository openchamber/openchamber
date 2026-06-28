import React from 'react';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';

type DeviceType = 'desktop' | 'mobile' | 'tablet';

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

const BREAKPOINTS = {
  xs: 0,
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1536,
} as const;

const DEFAULT_DEVICE_INFO: DeviceInfo = {
  isMobile: false,
  isTablet: false,
  isDesktop: true,
  deviceType: 'desktop',
  screenWidth: 1024,
  breakpoint: 'lg',
  hasTouchInput: false,
  hasTouchOnlyPointer: false,
};

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
  isDesktopShellRuntime: boolean,
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
  // VS Code is a desktop surface — don't misdetect a narrow panel as mobile (#1261)
  const isDesktopShellRuntime = isDesktopShell() || isVSCodeRuntime();
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

const isSameDeviceInfo = (left: DeviceInfo, right: DeviceInfo): boolean => (
  left.isMobile === right.isMobile
  && left.isTablet === right.isTablet
  && left.isDesktop === right.isDesktop
  && left.deviceType === right.deviceType
  && left.screenWidth === right.screenWidth
  && left.breakpoint === right.breakpoint
  && left.hasTouchInput === right.hasTouchInput
  && left.hasTouchOnlyPointer === right.hasTouchOnlyPointer
);

const deviceInfoSubscribers = new Set<() => void>();
let deviceInfoSnapshot: DeviceInfo | null = null;
let deviceInfoFrameId: number | undefined;
let cleanupDeviceInfoSource: (() => void) | null = null;

const readDeviceInfoSnapshot = (): DeviceInfo => {
  if (typeof window === 'undefined') {
    return DEFAULT_DEVICE_INFO;
  }

  if (!deviceInfoSnapshot) {
    deviceInfoSnapshot = getDeviceInfo();
  }

  return deviceInfoSnapshot;
};

const notifyDeviceInfoSubscribers = () => {
  for (const listener of deviceInfoSubscribers) {
    listener();
  }
};

const updateDeviceInfoSnapshot = () => {
  deviceInfoFrameId = undefined;
  const next = getDeviceInfo();
  if (deviceInfoSnapshot && isSameDeviceInfo(deviceInfoSnapshot, next)) {
    return;
  }

  deviceInfoSnapshot = next;
  notifyDeviceInfoSubscribers();
};

const scheduleDeviceInfoUpdate = () => {
  if (typeof window === 'undefined' || deviceInfoFrameId !== undefined) {
    return;
  }

  deviceInfoFrameId = window.requestAnimationFrame(updateDeviceInfoSnapshot);
};

const attachMediaQueryListener = (query: MediaQueryList | null, listener: () => void): (() => void) => {
  if (!query) {
    return () => {};
  }

  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }

  if (typeof query.addListener === 'function') {
    query.addListener(listener);
    return () => query.removeListener(listener);
  }

  return () => {};
};

const startDeviceInfoSource = (): (() => void) => {
  if (typeof window === 'undefined') {
    return () => {};
  }

  deviceInfoSnapshot = getDeviceInfo();
  window.addEventListener('resize', scheduleDeviceInfoUpdate);

  const pointerQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)')
    : null;
  const hoverQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(hover: none)')
    : null;
  const cleanupPointer = attachMediaQueryListener(pointerQuery, scheduleDeviceInfoUpdate);
  const cleanupHover = attachMediaQueryListener(hoverQuery, scheduleDeviceInfoUpdate);

  return () => {
    window.removeEventListener('resize', scheduleDeviceInfoUpdate);
    cleanupPointer();
    cleanupHover();
    if (deviceInfoFrameId !== undefined) {
      window.cancelAnimationFrame(deviceInfoFrameId);
      deviceInfoFrameId = undefined;
    }
  };
};

const subscribeDeviceInfo = (listener: () => void): (() => void) => {
  if (typeof window === 'undefined') {
    return () => {};
  }

  deviceInfoSubscribers.add(listener);
  if (!cleanupDeviceInfoSource) {
    cleanupDeviceInfoSource = startDeviceInfoSource();
  }

  return () => {
    deviceInfoSubscribers.delete(listener);
    if (deviceInfoSubscribers.size === 0 && cleanupDeviceInfoSource) {
      cleanupDeviceInfoSource();
      cleanupDeviceInfoSource = null;
      deviceInfoSnapshot = null;
    }
  };
};

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

const isStandalonePwaRuntime = (): boolean => {
  if (typeof window === 'undefined') return false;

  const standaloneNavigator = navigator as Navigator & { standalone?: boolean };
  return Boolean(
    standaloneNavigator.standalone === true
    || window.matchMedia?.('(display-mode: standalone)')?.matches
    || window.matchMedia?.('(display-mode: fullscreen)')?.matches
  );
};

const isTabletStandalonePwaRuntime = (): boolean => {
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
  return React.useSyncExternalStore(
    subscribeDeviceInfo,
    readDeviceInfoSnapshot,
    () => DEFAULT_DEVICE_INFO,
  );
}
