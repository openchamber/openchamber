import { z } from 'zod';

import { getDesktopBridge, hasDesktopInvoke, invokeDesktop, isDesktopLocalOriginActive } from '@/lib/desktop';

const idleDesktopUpdateSchema = z.object({
  phase: z.enum(['idle', 'waiting', 'counting', 'installing']),
  reason: z.string().nullable(),
  remainingMs: z.number(),
  version: z.string().nullable(),
  channel: z.string().nullable(),
});

export type IdleDesktopUpdate = z.infer<typeof idleDesktopUpdateSchema>;

const readIdleDesktopUpdate = (value: unknown): IdleDesktopUpdate | null => {
  const parsed = idleDesktopUpdateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const idleCommand = async (command: string): Promise<IdleDesktopUpdate | null> => {
  if (!hasDesktopInvoke() || !isDesktopLocalOriginActive()) return null;
  return readIdleDesktopUpdate(await invokeDesktop(command));
};

export const getIdleDesktopUpdate = (): Promise<IdleDesktopUpdate | null> => idleCommand('desktop_get_idle_update');

export const queueIdleDesktopUpdate = (): Promise<IdleDesktopUpdate | null> => idleCommand('desktop_queue_idle_update');

export const cancelIdleDesktopUpdate = (): Promise<IdleDesktopUpdate | null> => idleCommand('desktop_cancel_idle_update');

export const listenIdleDesktopUpdate = async (
  handler: (status: IdleDesktopUpdate) => void,
): Promise<() => void> => {
  const bridge = getDesktopBridge();
  if (!bridge?.listen || !isDesktopLocalOriginActive()) return () => {};
  const unlisten = await bridge.listen('openchamber:idle-update', (evt) => {
    const status = readIdleDesktopUpdate(evt?.payload);
    if (status) handler(status);
  });
  return () => {
    void unlisten?.();
  };
};
