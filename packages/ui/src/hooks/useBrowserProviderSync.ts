
import React from 'react';

import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { useUIStore } from '@/stores/useUIStore';

export const useBrowserProviderSync = (): void => {
  const { t } = useI18n();
  const setBrowserProvider = useUIStore((state) => state.setBrowserProvider);

  React.useEffect(() => subscribeOpenchamberEvents((event) => {
    if (event.type !== 'browser-provider-reset') return;
    setBrowserProvider('builtin');
    toast.info(t('settings.openchamber.tools.browserProvider.toast.reset', { name: event.guestName }));
  }), [setBrowserProvider, t]);
};
