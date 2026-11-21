import { useEffect } from 'react';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { invalidateSettingsCache, syncDesktopSettings } from '@/lib/persistence';

export const useSettingsFileSync = (): void => {
  useEffect(() => {
    let active = true;
    let running = false;
    let pending = false;
    const refresh = async () => {
      pending = true;
      if (running) return;
      running = true;
      try {
        while (active && pending) {
          pending = false;
          invalidateSettingsCache();
          await syncDesktopSettings({ bootstrap: false, adoptTheme: true });
        }
      } finally {
        running = false;
      }
    };
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type === 'settings-changed' || event.type === 'event-stream-ready') void refresh();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
};
