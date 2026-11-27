import React from 'react';
import { z } from 'zod';

import { canUseElectronDesktopIPC, invokeDesktop, isDesktopShell } from '@/lib/desktop';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { requestTrackerItemOpen } from '@/lib/trackerItemRequests';

const desktopTrackerItemSchema = z.object({
  url: z.string().min(1),
  directory: z.string().min(1).optional(),
  runtimeKey: z.string().min(1).optional(),
});

type DesktopTrackerItem = z.infer<typeof desktopTrackerItemSchema>;

const openInOwningHostWindow = ({ url, directory, runtimeKey }: DesktopTrackerItem): boolean => {
  if (!runtimeKey || runtimeKey === getRuntimeKey() || !canUseElectronDesktopIPC()) return false;
  void invokeDesktop<{ opened: boolean }>('desktop_open_host_tracker_item', { runtimeKey, url, directory: directory ?? '' })
    .catch((error) => {
      console.warn('[desktop] failed to open host tracker item', error);
    });
  return true;
};

const openDesktopTrackerItem = (item: DesktopTrackerItem): void => {
  if (openInOwningHostWindow(item)) return;
  requestTrackerItemOpen({ url: item.url, directory: item.directory ?? null });
};

export const useDesktopTrackerItemClicks = (): void => {
  React.useEffect(() => {
    if (!isDesktopShell()) return;
    const handler = (event: Event) => {
      const item = desktopTrackerItemSchema.safeParse(event instanceof CustomEvent ? event.detail : null);
      if (item.success) openDesktopTrackerItem(item.data);
    };
    const takeWaiting = () => {
      void invokeDesktop('desktop_take_pending_tracker_item').then((pending) => {
        const item = desktopTrackerItemSchema.safeParse(pending);
        if (item.success) openDesktopTrackerItem(item.data);
      }, (error) => {
        console.warn('Failed to read the pending tracker item', error);
      });
    };
    window.addEventListener('openchamber:open-tracker-item', handler);
    window.addEventListener('openchamber:tracker-item-waiting', takeWaiting);
    takeWaiting();
    return () => {
      window.removeEventListener('openchamber:open-tracker-item', handler);
      window.removeEventListener('openchamber:tracker-item-waiting', takeWaiting);
    };
  }, []);
};
