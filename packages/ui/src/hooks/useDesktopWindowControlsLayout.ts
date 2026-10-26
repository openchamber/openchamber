import { useMemo } from 'react';

import {
  resolveDesktopWindowControlsSide,
  usesFramelessElectronChrome,
  type DesktopWindowControlsSide,
} from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';

export function useDesktopWindowControlsLayout(): {
  usesFramelessChrome: boolean;
  side: DesktopWindowControlsSide;
} {
  const preference = useUIStore((state) => state.desktopWindowControlsPosition);

  return useMemo(() => {
    const usesFramelessChrome = usesFramelessElectronChrome();
    const side = resolveDesktopWindowControlsSide(preference);
    return { usesFramelessChrome, side };
  }, [preference]);
}
