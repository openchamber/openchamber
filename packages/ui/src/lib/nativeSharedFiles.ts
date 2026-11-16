import type { JsonValue } from '@openchamber/sdk';
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

type SharedFilesPayload = {
  files: File[];
  text: string | null;
  rejected: RejectedSharedFile[];
};

type BridgeValue = JsonValue | undefined;

const base64ToBytes = (data: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(data);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

export const parseSharedFiles = (raw: BridgeValue): SharedFilesPayload | null => {
  const parsed = takePendingResultSchema.safeParse(raw);
  if (!parsed.success) return null;

  const files: File[] = [];
  const rejected: RejectedSharedFile[] = [...(parsed.data.rejected ?? [])];
  for (const entry of parsed.data.files ?? []) {
    try {
      files.push(new File([base64ToBytes(entry.data)], entry.name, { type: entry.mimeType }));
    } catch {
      rejected.push({ name: entry.name, reason: 'unreadable' });
    }
  }
  return { files, text: parsed.data.text?.trim() || null, rejected };
};

interface SharedFilesPlugin {
  takePending(): Promise<BridgeValue>;
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

export const subscribeToNativeSharedFiles = (handler: (payload: SharedFilesPayload) => void): (() => void) => {
  const platform = getClientPlatform();
  if (platform !== 'ios' && platform !== 'android') {
    return () => {};
  }

  let disposed = false;
  let listener: PluginListenerHandle | null = null;
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
