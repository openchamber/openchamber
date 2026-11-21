import React from 'react';

import { nativePushHasTarget } from '@/apps/mobilePushTokens';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { I18nKey } from '@/lib/i18n';

/**
 * Who stays silent because the active server was paired for the home network
 * only: `device` when no other saved server delivers either, so this device
 * gets no push at all; `server` when other saved servers still deliver.
 * Asked once per mount; null until the server answers.
 */
type PushDeliveryLocalOnly = 'device' | 'server' | null;

export const pushDeliveryLocalOnlyHintKey = (scope: PushDeliveryLocalOnly): I18nKey | null => {
  if (scope === 'device') return 'settings.notifications.page.delivery.localOnlyDevice';
  if (scope === 'server') return 'settings.notifications.page.delivery.localOnlyServer';
  return null;
};

export const usePushDeliveryLocalOnly = (enabled: boolean): PushDeliveryLocalOnly => {
  const [localOnly, setLocalOnly] = React.useState(false);

  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void getRegisteredRuntimeAPIs()?.push?.getDeliveryStatus?.().then((status) => {
      if (!cancelled) setLocalOnly(status?.localOnly === true);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  if (!enabled || !localOnly) return null;
  return nativePushHasTarget({ localOnly }) ? 'server' : 'device';
};
