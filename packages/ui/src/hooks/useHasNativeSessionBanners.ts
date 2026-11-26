import { useEffect, useState } from 'react';

import { hasNativeSessionNotifications, nativeSessionBannersAvailable } from '@/lib/nativeNotifications';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';

export const useHasNativeSessionBanners = (): boolean => {
  const entityById = useGlobalSessionsStore((state) => state.entityById);
  const [hasBanners, setHasBanners] = useState(false);
  useEffect(() => {
    if (!nativeSessionBannersAvailable()) return;
    let current = true;
    void hasNativeSessionNotifications([...entityById.keys()]).then((value) => {
      if (current) setHasBanners(value);
    });
    return () => {
      current = false;
    };
  }, [entityById]);
  return hasBanners;
};
