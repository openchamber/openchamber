
import { registerPlugin } from '@capacitor/core';
import { z } from 'zod';

import { getClientPlatform } from '@/lib/platform';

const IMAGE_PASTE_EVENT = 'openchamber-native-image-paste';

const IMAGE_FILE_NAME = 'image';

const IMAGE_MIME_TYPE = /^image\/(png|jpeg|gif|webp|heic)$/;

const IMAGE_PASTE_FAILURES = ['unreadable', 'too-large', 'unsupported-type'] as const;

const imagePastePayload = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    mimeType: z.string().regex(IMAGE_MIME_TYPE),
    data: z.string().min(1),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(IMAGE_PASTE_FAILURES),
  }),
]);

export type NativeImagePasteFailure = (typeof IMAGE_PASTE_FAILURES)[number];

export type NativeImagePaste =
  | { ok: true; file: File }
  | { ok: false; reason: NativeImagePasteFailure };

const base64ToBytes = (data: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(data);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const parseImagePaste = (event: Event): NativeImagePaste | null => {
  if (!(event instanceof CustomEvent)) return null;
  const payload = imagePastePayload.safeParse(event.detail);
  if (!payload.success) return null;
  if (!payload.data.ok) return payload.data;

  try {
    return {
      ok: true,
      file: new File([base64ToBytes(payload.data.data)], IMAGE_FILE_NAME, { type: payload.data.mimeType }),
    };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
};

interface ImagePastePlugin {
  setEnabled(options: { enabled: boolean }): Promise<void>;
}

const ImagePaste = registerPlugin<ImagePastePlugin>('ImagePaste');

export const setNativeImagePasteEnabled = (enabled: boolean): void => {
  if (getClientPlatform() !== 'android') return;
  void ImagePaste.setEnabled({ enabled }).catch(() => {});
};

export const subscribeToNativeImagePastes = (handler: (paste: NativeImagePaste) => void): (() => void) => {
  if (getClientPlatform() !== 'android') {
    return () => {};
  }

  const onImagePaste = (event: Event): void => {
    const paste = parseImagePaste(event);
    if (paste) handler(paste);
  };

  window.addEventListener(IMAGE_PASTE_EVENT, onImagePaste);
  return () => window.removeEventListener(IMAGE_PASTE_EVENT, onImagePaste);
};
