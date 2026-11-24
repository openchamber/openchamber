import type { JsonValue } from '@openchamber/sdk';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { toast } from 'sonner';
import { z } from 'zod';

import { formatMessage, useI18nStore, type I18nKey } from '@/lib/i18n';
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
  id: z.string().nullish(),
  text: z.string().nullish(),
  files: z.array(sharedFileSchema).nullish(),
  rejected: z.array(rejectedFileSchema).nullish(),
});

export type RejectedSharedFile = z.infer<typeof rejectedFileSchema>;

const reasonKey = (reason: string): I18nKey | null => {
  switch (reason) {
    case 'too-large': return 'chat.chatInput.toast.sharedFileTooLarge';
    case 'batch-limit': return 'chat.chatInput.toast.sharedFileBatchLimit';
    case 'too-many': return 'chat.chatInput.toast.sharedFileTooMany';
    case 'unsupported-type': return 'chat.chatInput.toast.sharedFileUnsupportedType';
    case 'unreadable': return 'chat.chatInput.toast.sharedFileUnreadable';
    case 'timed-out': return 'chat.chatInput.toast.sharedFileTimedOut';
    default: return null;
  }
};

const reasonLabel = (reason: string): string => {
  const key = reasonKey(reason);
  return key ? formatMessage(useI18nStore.getState().dictionary, key) : reason;
};

export const reportSkippedSharedFiles = (rejected: RejectedSharedFile[]): void => {
  if (rejected.length === 0) return;
  const summary = rejected
    .map((file) => `${file.name}: ${reasonLabel(file.reason)}`)
    .join('\n');
  toast.error(formatMessage(useI18nStore.getState().dictionary, 'chat.chatInput.toast.someFilesSkipped', { summary }));
};

type SharedFilesPayload = {
  id: string | null;
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
  return { id: parsed.data.id ?? null, files, text: parsed.data.text?.trim() || null, rejected };
};

interface SharedFilesPlugin {
  takePending(): Promise<BridgeValue>;
  accept(options: { id: string }): Promise<void>;
  addListener(event: 'pending', listener: () => void): Promise<PluginListenerHandle>;
}

const SharedFiles = registerPlugin<SharedFilesPlugin>('SharedFiles');

type SharedFilesEnvironment = {
  platform: ReturnType<typeof getClientPlatform>;
  pluginAvailable: () => boolean;
  plugin: SharedFilesPlugin;
};

const nativeEnvironment = (): SharedFilesEnvironment => ({
  platform: getClientPlatform(),
  pluginAvailable: () => Capacitor.isPluginAvailable('SharedFiles'),
  plugin: SharedFiles,
});

export const subscribeToNativeSharedFiles = (
  handler: (payload: SharedFilesPayload, accept: () => void) => void,
  environment: SharedFilesEnvironment = nativeEnvironment(),
): (() => void) => {
  if ((environment.platform !== 'android' && environment.platform !== 'ios') || !environment.pluginAvailable()) {
    return () => {};
  }
  const { plugin } = environment;
  const takePending = async (): Promise<SharedFilesPayload | null> => {
    try {
      return parseSharedFiles(await plugin.takePending());
    } catch {
      return null;
    }
  };

  let disposed = false;
  let listener: PluginListenerHandle | null = null;
  const handed = new Set<string>();
  const deliverPending = (): void => {
    void takePending().then((payload) => {
      if (!payload || disposed) return;
      const { id } = payload;
      if (id !== null) {
        if (handed.has(id)) return;
        handed.add(id);
      }
      const accept = () => {
        if (id !== null) void plugin.accept({ id }).catch(() => undefined);
      };
      if (payload.files.length > 0 || payload.rejected.length > 0 || payload.text !== null) handler(payload, accept);
      else accept();
    });
  };

  void plugin.addListener('pending', deliverPending)
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
