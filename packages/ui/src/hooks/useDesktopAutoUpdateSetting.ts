import React from 'react';
import { getDesktopAutoUpdateEnabled, setDesktopAutoUpdateEnabled } from '@/lib/desktop-auto-update';

export const useDesktopAutoUpdateSetting = (active: boolean) => {
  const [autoUpdate, setAutoUpdate] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void getDesktopAutoUpdateEnabled().then((value) => {
      if (!cancelled) setAutoUpdate(value);
    });
    return () => {
      cancelled = true;
    };
  }, [active]);

  const update = React.useCallback(async (next: boolean): Promise<boolean> => {
    const previous = autoUpdate;
    setAutoUpdate(next);
    const saved = await setDesktopAutoUpdateEnabled(next);
    if (saved !== next) {
      setAutoUpdate(previous);
      return false;
    }
    return true;
  }, [autoUpdate]);

  return { autoUpdate, update };
};
