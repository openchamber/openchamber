import React from 'react';
import type { HostDevice } from '@openchamber/sdk';

import { useTabletLayout } from '@/lib/device';
import { readMobileKeyboardVar } from '@/lib/mobileKeyboardInsets';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';

type DeviceMetrics = Omit<HostDevice, 'formFactor'>;

const NO_INSETS: HostDevice['insets'] = { top: 0, right: 0, bottom: 0, left: 0 };

const readSafeArea = (): HostDevice['insets'] => {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;'
    + 'padding:var(--oc-safe-area-top,env(safe-area-inset-top,0px)) var(--oc-safe-area-right,env(safe-area-inset-right,0px))'
    + ' var(--oc-safe-area-bottom,env(safe-area-inset-bottom,0px)) var(--oc-safe-area-left,env(safe-area-inset-left,0px));';
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const px = (value: string) => Math.max(0, Math.round(Number.parseFloat(value) || 0));
  const insets = { top: px(style.paddingTop), right: px(style.paddingRight), bottom: px(style.paddingBottom), left: px(style.paddingLeft) };
  probe.remove();
  return insets;
};

const readKeyboard = (): number => {
  const viewport = window.visualViewport;
  const overlap = viewport ? window.innerHeight - viewport.height - viewport.offsetTop : 0;
  return Math.max(0, Math.round(Math.max(readMobileKeyboardVar('--oc-keyboard-inset'), overlap)));
};

const readMetrics = (): DeviceMetrics => {
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  const mobile = isMobileSurfaceRuntime();
  return {
    pointer: coarse ? 'coarse' : 'fine',
    insets: mobile ? readSafeArea() : NO_INSETS,
    keyboard: mobile ? readKeyboard() : 0,
  };
};

const sameMetrics = (a: DeviceMetrics, b: DeviceMetrics): boolean => (
  a.pointer === b.pointer && a.keyboard === b.keyboard
  && a.insets.top === b.insets.top && a.insets.right === b.insets.right
  && a.insets.bottom === b.insets.bottom && a.insets.left === b.insets.left
);

export function useHostDevice(): HostDevice {
  const tablet = useTabletLayout().enabled;
  const [metrics, setMetrics] = React.useState(readMetrics);

  React.useEffect(() => {
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      const next = readMetrics();
      setMetrics((current) => (sameMetrics(current, next) ? current : next));
    };
    const schedule = () => {
      if (frame === undefined) frame = window.requestAnimationFrame(update);
    };
    update();
    const pointer = typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: coarse)') : null;
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.addEventListener('oc:keyboard-settled', schedule);
    pointer?.addEventListener('change', schedule);
    return () => {
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.removeEventListener('oc:keyboard-settled', schedule);
      pointer?.removeEventListener('change', schedule);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, []);

  const formFactor: HostDevice['formFactor'] = isMobileSurfaceRuntime() ? (tablet ? 'tablet' : 'phone') : 'desktop';
  return React.useMemo(() => ({ formFactor, ...metrics }), [formFactor, metrics]);
}
