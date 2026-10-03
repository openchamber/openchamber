/**
 * Keeps the browser-provider setting honest after the server drops it.
 *
 * The server owns the choice of who answers the agent's browser actions. When
 * the chosen extension is paused, removed, or loses approval, the server writes
 * `builtin` back on its own; this hook mirrors that into the store, so
 * Settings shows the in-app browser again, and tells the user, so the next
 * agent run does not surprise them.
 */

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
