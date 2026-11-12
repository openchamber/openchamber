import React from 'react';

import { toast } from '@/components/ui/toast';
import { loadGuestCatalog } from '@/lib/guests/load-catalog';
import { useGuestsStore } from '@/lib/guests/store';
import { GUEST_UPDATE_NOTICE_DELAY_MS, GUEST_UPDATE_NOTICE_INTERVAL_MS, guestUpdateFingerprint } from '@/lib/guests/update-notice';
import { checkGuestUpdates } from '@/lib/guests/updates';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';
import { getSafeStorage } from '@/stores/utils/safeStorage';

const ANNOUNCED_KEY = 'openchamber.guests.announcedUpdates';

/**
 * A check shortly after the app opens, then every few hours. New versions get
 * a toast once, so a reload does not repeat it; Settings → Extensions keeps
 * offering them.
 */
export const useGuestUpdateNotice = (): void => {
  const { t } = useI18n();
  const tRef = React.useRef(t);
  tRef.current = t;

  React.useEffect(() => {
    let disposed = false;
    const check = async () => {
      const runtimeKey = getRuntimeKey();
      await loadGuestCatalog();
      const result = await checkGuestUpdates(false);
      if (disposed || !result.ok || getRuntimeKey() !== runtimeKey) return;
      const store = useGuestsStore.getState();
      store.applyUpdates(result.updates, store.runtimeKey);
      const offered = useGuestsStore.getState().guests.filter((guest) => result.updates[guest.id]);
      const fingerprint = guestUpdateFingerprint(result.updates);
      const storage = getSafeStorage();
      // Per server: the same extension can wait for an update on each.
      const announcedKey = `${ANNOUNCED_KEY}:${runtimeKey}`;
      if (offered.length === 0 || storage.getItem(announcedKey) === fingerprint) return;
      storage.setItem(announcedKey, fingerprint);
      const translate = tRef.current;
      const [only] = offered;
      toast.info(offered.length === 1 && only
        ? translate('settings.extensions.updates.notice.one', { name: only.name })
        : translate('settings.extensions.updates.notice.many', { count: offered.length }), {
        action: {
          label: translate('settings.extensions.updates.notice.open'),
          onClick: () => {
            const ui = useUIStore.getState();
            ui.setSettingsPage('extensions');
            ui.setSettingsDialogOpen(true);
          },
        },
      });
    };
    let interval: number | undefined;
    const timer = window.setTimeout(() => {
      void check();
      interval = window.setInterval(() => { void check(); }, GUEST_UPDATE_NOTICE_INTERVAL_MS);
    }, GUEST_UPDATE_NOTICE_DELAY_MS);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, []);
};
