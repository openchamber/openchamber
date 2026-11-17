
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { z } from 'zod';

import { getClientPlatform } from '@/lib/platform';

const shortcutRequestSchema = z.object({
  projectId: z.string().trim().min(1).optional(),
  text: z.string().optional(),
});

const takePendingResultSchema = z.object({
  request: shortcutRequestSchema.nullish(),
});

type NativeShortcutRequest = z.infer<typeof shortcutRequestSchema>;

interface ShortcutRequestsPlugin {
  takePending(): Promise<{ request?: { projectId?: string; text?: string } | null }>;
  addListener(event: 'pending', listener: () => void): Promise<PluginListenerHandle>;
}

const ShortcutRequests = registerPlugin<ShortcutRequestsPlugin>('ShortcutRequests');

const takePending = async (): Promise<NativeShortcutRequest | null> => {
  const result = takePendingResultSchema.safeParse(await ShortcutRequests.takePending());
  return result.success ? result.data.request ?? null : null;
};

export const subscribeToNativeShortcutRequests = (handler: (request: NativeShortcutRequest) => void): (() => void) => {
  if (getClientPlatform() !== 'ios') {
    return () => {};
  }

  let disposed = false;
  let listener: PluginListenerHandle | null = null;
  const deliverPending = (): void => {
    void takePending()
      .then((request) => {
        if (request) handler(request);
      })
      .catch(() => undefined);
  };

  void ShortcutRequests.addListener('pending', deliverPending)
    .then((handle) => {
      if (disposed) {
        void handle.remove();
        return;
      }
      listener = handle;
    })
    .catch(() => undefined);
  deliverPending();

  return () => {
    disposed = true;
    void listener?.remove();
  };
};
