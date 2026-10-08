// An image the Android IME committed to the composer. A WebView declares no content types, so
// the IME refuses the paste; OpenChamberWebView.java declares them and sends what it commits.
// Every other runtime pastes images through the DOM paste event, so subscribing is a no-op.

import { registerPlugin } from '@capacitor/core';
import { z } from 'zod';

import { getClientPlatform } from '@/lib/platform';

const IMAGE_PASTE_EVENT = 'openchamber-native-image-paste';

// No extension: the citation and attachment code take it from the media type.
const IMAGE_FILE_NAME = 'image';

// What OpenChamberWebView sniffs out of the bytes it reads.
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
    // The shell produced this base64, so surfacing the failure beats dropping it silently.
    return { ok: false, reason: 'unreadable' };
  }
};

interface ImagePastePlugin {
  setEnabled(options: { enabled: boolean }): Promise<void>;
}

const ImagePaste = registerPlugin<ImagePastePlugin>('ImagePaste');

/**
 * Narrows the declaration to the composer: the WebView is one input connection for every
 * editable element, so without this an image pasted into any other field would be offered and
 * then routed into a chat draft the user never targeted. Turning it on also makes the shell
 * re-read it, since the IME reads it at focus time and that can be before this call arrives.
 */
export const setNativeImagePasteEnabled = (enabled: boolean): void => {
  if (getClientPlatform() !== 'android') return;
  void ImagePaste.setEnabled({ enabled }).catch(() => {});
};

/** Unsubscribe, and a no-op outside the Android app. */
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
