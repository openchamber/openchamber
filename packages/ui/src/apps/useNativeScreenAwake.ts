import { useEffect, useRef } from 'react';
import { App } from '@capacitor/app';
import { toast } from 'sonner';

import { useI18n } from '@/lib/i18n';
import { setNativeScreenAwake } from '@/lib/nativeScreenAwake';
import { subscribeMobileScreenAwake } from './mobileScreenAwake';

/** Mounted by the native mobile root only; no work in hosted mobile/PWA. */
export function useNativeScreenAwake(enabled: boolean): void {
  const { t } = useI18n();
  const translate = useRef(t);
  translate.current = t;
  useEffect(() => {
    if (!enabled) return;
    const controller = subscribeMobileScreenAwake(setNativeScreenAwake, () => toast.error(translate.current('settings.mobile.screenAwake.error')));
    const visibility = () => {
      controller.setForeground(document.visibilityState !== 'hidden');
    };
    document.addEventListener('visibilitychange', visibility);
    const listener = App.addListener('appStateChange', ({ isActive }) => {
      controller.setForeground(isActive);
    }).catch(() => null);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      void listener.then((handle) => handle?.remove()).catch(() => undefined);
      controller.dispose();
    };
  }, [enabled]);
}
