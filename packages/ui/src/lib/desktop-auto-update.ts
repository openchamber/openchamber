import { z } from 'zod';

import { getDesktopBridge, hasDesktopInvoke, invokeDesktop } from '@/lib/desktop';

const autoUpdateStatusSchema = z.object({
  enabled: z.boolean(),
  supported: z.boolean().optional().default(true),
});
const downloadedReleaseSchema = z.object({ version: z.string().min(1) });

export const getDesktopAutoUpdateEnabled = async (): Promise<boolean | null> => {
  if (!hasDesktopInvoke()) return null;
  try {
    const parsed = autoUpdateStatusSchema.safeParse(await invokeDesktop('desktop_get_auto_update'));
    return parsed.success && parsed.data.supported ? parsed.data.enabled : null;
  } catch (error) {
    console.warn('Failed to get automatic updates preference', error);
    return null;
  }
};

export const setDesktopAutoUpdateEnabled = async (enabled: boolean): Promise<boolean | null> => {
  if (!hasDesktopInvoke()) return null;
  try {
    const parsed = autoUpdateStatusSchema.safeParse(await invokeDesktop('desktop_set_auto_update', { enabled }));
    return parsed.success && parsed.data.supported ? parsed.data.enabled : null;
  } catch (error) {
    console.warn('Failed to save automatic updates preference', error);
    return null;
  }
};

export const listenDesktopUpdateDownloaded = async (
  handler: (version: string) => void,
): Promise<() => void> => {
  const bridge = getDesktopBridge();
  if (!bridge?.listen) return () => {};
  const unlisten = await bridge.listen('openchamber:update-downloaded', (evt) => {
    const parsed = downloadedReleaseSchema.safeParse(evt?.payload);
    if (parsed.success) handler(parsed.data.version);
  });
  return () => {
    void unlisten?.();
  };
};
