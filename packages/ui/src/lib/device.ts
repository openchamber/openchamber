import React from 'react';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { isCapacitorApp, isIPadApp } from '@/lib/platform';
import { isMobileSurfaceRuntime, TABLET_LAYOUT_MIN_SHORT_SIDE_PX } from '@/lib/runtimeSurface';

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

const hasDesktopSurfaceOverride = (): boolean => {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('surface') === 'desktop';
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
  const setClass = (name: string, on: boolean) => {
    if (root.classList.contains(name) !== on) root.classList.toggle(name, on);
  };

  setClass('device-mobile', deviceType === 'mobile');
  setClass('device-tablet', deviceType === 'tablet');
  setClass('device-desktop', deviceType === 'desktop');
  setClass('desktop-runtime', isDesktopShellRuntime);
  setClass('mobile-pointer', !isDesktopShellRuntime && hasTouchInput);
};

export function getDeviceInfo(): DeviceInfo {
  const width = window.innerWidth;
  const supportsMatchMedia = typeof window.matchMedia === 'function';
  const pointerQuery = supportsMatchMedia ? window.matchMedia('(pointer: coarse)') : null;
  const hoverQuery = supportsMatchMedia ? window.matchMedia('(hover: none)') : null;
  const prefersCoarsePointer = pointerQuery?.matches ?? false;
  const noHover = hoverQuery?.matches ?? false;
  const maxTouchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0;
  const isDesktopShellRuntime = isDesktopShell() || isVSCodeRuntime() || hasDesktopSurfaceOverride();
  const { isExplicitTablet } = getNavigatorDeviceHints(maxTouchPoints);

  const hasTouchOnlyPointer = prefersCoarsePointer || noHover;
  const hasTouchInput = hasTouchOnlyPointer || (!isDesktopShellRuntime && maxTouchPoints > 0);

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
  } else if (isMobileSurfaceRuntime()) {
    isMobile = true;
    isTablet = false;
    isDesktop = false;
    deviceType = 'mobile';
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
  return readDeviceInfoSnapshot().isMobile;
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

export type Orientation = 'portrait' | 'landscape';

const getOrientation = (): Orientation => {
  if (typeof window === 'undefined') return 'portrait';
  return window.matchMedia?.('(orientation: landscape)')?.matches ? 'landscape' : 'portrait';
};

export function useOrientation(): Orientation {
  const [orientation, setOrientation] = React.useState<Orientation>(getOrientation);

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(orientation: landscape)');
    const update = () => setOrientation(query.matches ? 'landscape' : 'portrait');
    update();
    return attachMediaQueryListener(query, update);
  }, []);

  return orientation;
}

const WORKSPACE_PANEL_MIN_WIDTH_PX = 1000;

const ONE_PANEL_MIN_WIDTH_PX = 900;

export interface TabletLayout {
  enabled: boolean;
  roomyForPanels: boolean;
  roomyForOnePanel: boolean;
}

let keyboardFreeHeight: number | null = null;
let keyboardFreeLayout: TabletLayout | null = null;

const keyboardIsUp = (): boolean => {
  const doc = globalThis.document;
  if (!doc) return false;
  // SAFETY: activeElement is an Element, and every element that can hold the
  // soft keyboard here is an HTMLElement, which is where these flags live.
  const active = doc.activeElement as HTMLElement | null;
  const editing = active !== null
    && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
  if (!editing) return false;
  if (doc.documentElement.classList.contains('oc-keyboard-open')) return true;
  if (!isCapacitorApp()) return false;
  return keyboardFreeHeight !== null && window.innerHeight < keyboardFreeHeight;
};

export const readTabletLayout = (): TabletLayout => {
  if (typeof window === 'undefined') return { enabled: false, roomyForPanels: false, roomyForOnePanel: false };
  if (keyboardFreeLayout && keyboardIsUp()) return keyboardFreeLayout;
  const width = window.innerWidth;
  const height = window.innerHeight;
  keyboardFreeHeight = height;
  const enabled = isIPadApp() || Math.min(width, height) >= TABLET_LAYOUT_MIN_SHORT_SIDE_PX;
  const roomyForPanels = enabled && width > height && width >= WORKSPACE_PANEL_MIN_WIDTH_PX;
  keyboardFreeLayout = {
    enabled,
    roomyForPanels,
    roomyForOnePanel: enabled && !roomyForPanels && width >= ONE_PANEL_MIN_WIDTH_PX,
  };
  return keyboardFreeLayout;
};

export function useTabletLayout(): TabletLayout {
  const [layout, setLayout] = React.useState<TabletLayout>(readTabletLayout);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      const next = readTabletLayout();
      setLayout((current) => (
        current.enabled === next.enabled
          && current.roomyForPanels === next.roomyForPanels
          && current.roomyForOnePanel === next.roomyForOnePanel
          ? current
          : next
      ));
    };
    const schedule = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener('resize', schedule);
    const orientationQuery = window.matchMedia?.('(orientation: landscape)') ?? null;
    const detachOrientation = attachMediaQueryListener(orientationQuery, schedule);
    return () => {
      window.removeEventListener('resize', schedule);
      detachOrientation();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, []);

  return layout;
}

export function useDeviceInfo(): DeviceInfo {
  return React.useSyncExternalStore(
    subscribeDeviceInfo,
    readDeviceInfoSnapshot,
    () => DEFAULT_DEVICE_INFO,
  );
}
