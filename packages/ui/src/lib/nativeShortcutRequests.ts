// A new-session request from the iOS Shortcuts app or Siri: an optional project and an
// optional first message. It reaches the page through the app-local `ShortcutRequests`
// plugin (ShortcutRequests.swift), never through an `openchamber://` link: any app or web
// page can open a link, and a link must not be able to send a prompt to an agent. The
// plugin keeps the request until the page takes it, so a cold launch does not lose it.
// Every other runtime has no such plugin, so subscribing is a no-op there.

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

// What ShortcutRequestsPlugin.takePending resolves with. The bridge does not check it, so
// the answer is still parsed before it is trusted.
interface ShortcutRequestsPlugin {
  takePending(): Promise<{ request?: { projectId?: string; text?: string } | null }>;
  addListener(event: 'pending', listener: () => void): Promise<PluginListenerHandle>;
}

const ShortcutRequests = registerPlugin<ShortcutRequestsPlugin>('ShortcutRequests');

const takePending = async (): Promise<NativeShortcutRequest | null> => {
  const result = takePendingResultSchema.safeParse(await ShortcutRequests.takePending());
  return result.success ? result.data.request ?? null : null;
};

/**
 * Hands each request to `handler` once: the one waiting at subscribe time, then each new
 * one as the plugin announces it. Unsubscribe, and a no-op outside the iOS app.
 */
export const subscribeToNativeShortcutRequests = (handler: (request: NativeShortcutRequest) => void): (() => void) => {
  if (getClientPlatform() !== 'ios') {
    return () => {};
  }

  let disposed = false;
  let listener: PluginListenerHandle | null = null;
  // A request already taken from the shell is always handed over, even when the
  // subscription ended meanwhile: the shell no longer holds it, so dropping it here would
  // lose it (React StrictMode subscribes, unsubscribes and subscribes again on mount).
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
