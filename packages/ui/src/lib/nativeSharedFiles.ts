// What a native share staged for the app: files the iOS share extension wrote into its App
// Group inbox, or what the Android share intent read, plus the text or link the user shared
// instead of (or along with) files. It reaches the page through the app-local `SharedFiles`
// plugin (README: packages/mobile), never through the `openchamber://` link the iOS extension
// also opens: any app can open a link, but only the extension can write the inbox, so the link
// alone attaches nothing. Every other runtime has no share intake, so subscribing is a no-op
// there.

import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { z } from 'zod';

import { getClientPlatform } from '@/lib/platform';

const sharedFileSchema = z.object({
  name: z.string().min(1),
  mimeType: z.string().min(1),
  data: z.string().min(1),
});

const rejectedFileSchema = z.object({
  name: z.string().min(1),
  reason: z.string().min(1),
});

const takePendingResultSchema = z.object({
  text: z.string().nullish(),
  files: z.array(sharedFileSchema).nullish(),
  rejected: z.array(rejectedFileSchema).nullish(),
});

export type RejectedSharedFile = z.infer<typeof rejectedFileSchema>;

export type SharedFilesPayload = {
  files: File[];
  /** A shared link or paragraph; null when the share carried files only. */
  text: string | null;
  rejected: RejectedSharedFile[];
};

const base64ToBytes = (data: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(data);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

/**
 * Turns the plugin's answer into files and rejected names. The bridge does not check the
 * shape, so nothing is trusted before the schema and the base64 decode succeed.
 */
export const parseSharedFiles = (raw: unknown): SharedFilesPayload | null => {
  const parsed = takePendingResultSchema.safeParse(raw);
  if (!parsed.success) return null;

  const files: File[] = [];
  const rejected: RejectedSharedFile[] = [...(parsed.data.rejected ?? [])];
  for (const entry of parsed.data.files ?? []) {
    try {
      files.push(new File([base64ToBytes(entry.data)], entry.name, { type: entry.mimeType }));
    } catch {
      // A payload that cannot be decoded is reported by name instead of dropped silently.
      rejected.push({ name: entry.name, reason: 'unreadable' });
    }
  }
  return { files, text: parsed.data.text?.trim() || null, rejected };
};

// What SharedFilesPlugin.takePending resolves with.
interface SharedFilesPlugin {
  takePending(): Promise<unknown>;
  addListener(event: 'pending', listener: () => void): Promise<PluginListenerHandle>;
}

const SharedFiles = registerPlugin<SharedFilesPlugin>('SharedFiles');

const takePending = async (): Promise<SharedFilesPayload | null> => {
  try {
    return parseSharedFiles(await SharedFiles.takePending());
  } catch {
    return null;
  }
};

/**
 * Hands each pending share to `handler` once: the one waiting at subscribe time, then each
 * new one as the plugin announces it. Unsubscribe, and a no-op outside the iOS app.
 */
export const subscribeToNativeSharedFiles = (handler: (payload: SharedFilesPayload) => void): (() => void) => {
  const platform = getClientPlatform();
  if (platform !== 'ios' && platform !== 'android') {
    return () => {};
  }

  let disposed = false;
  let listener: PluginListenerHandle | null = null;
  // A take empties the inbox, so a payload already taken from the shell is always handed
  // over, even when the subscription ended meanwhile — dropping it would lose the share
  // (React StrictMode subscribes, unsubscribes and subscribes again on mount).
  const deliverPending = (): void => {
    void takePending().then((payload) => {
      if (payload && (payload.files.length > 0 || payload.rejected.length > 0 || payload.text !== null)) handler(payload);
    });
  };

  void SharedFiles.addListener('pending', deliverPending)
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
