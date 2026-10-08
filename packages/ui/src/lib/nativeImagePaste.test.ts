import { afterEach, describe, expect, test } from 'bun:test';

import { subscribeToNativeImagePastes, type NativeImagePaste } from './nativeImagePaste';

const IMAGE_PASTE_EVENT = 'openchamber-native-image-paste';

// Not an encoded image: this path's contract is that the bytes arrive unchanged, whatever
// media type they were announced as.
const IMAGE_BYTES = new Uint8Array([1, 2, 3, 250, 251, 255]);
const IMAGE_BASE64 = Buffer.from(IMAGE_BYTES).toString('base64');

const originalWindow = globalThis.window;

type FakeWindow = {
  /** Delivers a payload the way the shell does, as the JSON it evaluates on the page. */
  emitRaw: (json: string) => void;
  dispatchRaw: (event: Event) => void;
};

const stubWindow = (platform: string | undefined): FakeWindow => {
  const listeners = new Map<string, (event: Event) => void>();

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      Capacitor: platform ? { getPlatform: () => platform } : undefined,
      addEventListener: (type: string, listener: (event: Event) => void) => {
        listeners.set(type, listener);
      },
      removeEventListener: (type: string) => {
        listeners.delete(type);
      },
    },
  });

  const deliver = (event: Event) => {
    listeners.get(IMAGE_PASTE_EVENT)?.(event);
  };

  return {
    emitRaw: (json) => {
      deliver(new CustomEvent(IMAGE_PASTE_EVENT, { detail: JSON.parse(json) }));
    },
    dispatchRaw: deliver,
  };
};

const collectPastes = (): NativeImagePaste[] => {
  const received: NativeImagePaste[] = [];
  subscribeToNativeImagePastes((paste) => received.push(paste));
  return received;
};

afterEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});

describe('subscribeToNativeImagePastes', () => {
  test('subscribes in the Android app only, and stops on unsubscribe', () => {
    const committed = `{"ok":true,"mimeType":"image/png","data":"${IMAGE_BASE64}"}`;

    for (const platform of ['ios', 'web', undefined]) {
      const fake = stubWindow(platform);
      const received: NativeImagePaste[] = [];
      subscribeToNativeImagePastes((paste) => received.push(paste));
      fake.emitRaw(committed);
      expect(received).toEqual([]);
    }

    const android = stubWindow('android');
    const received: NativeImagePaste[] = [];
    const unsubscribe = subscribeToNativeImagePastes((paste) => received.push(paste));
    android.emitRaw(committed);
    unsubscribe();
    android.emitRaw(committed);
    expect(received.length).toBe(1);
  });

  test('attaches a committed image as a file', async () => {
    const fake = stubWindow('android');
    const received = collectPastes();

    fake.emitRaw(`{"ok":true,"mimeType":"image/png","data":"${IMAGE_BASE64}"}`);

    expect(received.length).toBe(1);
    const paste = received[0];
    if (!paste.ok) throw new Error('expected a successful paste');
    expect(paste.file.name).toBe('image');
    expect(paste.file.type).toBe('image/png');
    expect(new Uint8Array(await paste.file.arrayBuffer())).toEqual(IMAGE_BYTES);
  });

  test('carries any image media type through without normalizing it', () => {
    const fake = stubWindow('android');
    const received = collectPastes();

    fake.emitRaw(`{"ok":true,"mimeType":"image/jpeg","data":"${IMAGE_BASE64}"}`);
    fake.emitRaw(`{"ok":true,"mimeType":"image/webp","data":"${IMAGE_BASE64}"}`);
    fake.emitRaw(`{"ok":true,"mimeType":"image/heic","data":"${IMAGE_BASE64}"}`);

    expect(received.map((paste) => (paste.ok ? paste.file.type : paste.reason))).toEqual([
      'image/jpeg',
      'image/webp',
      'image/heic',
    ]);
  });

  test('refuses a media type outside the sniffed set', () => {
    const fake = stubWindow('android');
    const received: NativeImagePaste[] = [];
    subscribeToNativeImagePastes((paste) => received.push(paste));

    for (const mimeType of ['image/svg+xml', 'image/tiff', 'text/plain', 'image/png; charset=utf-8']) {
      fake.emitRaw(`{"ok":true,"mimeType":"${mimeType}","data":"${IMAGE_BASE64}"}`);
    }

    expect(received).toEqual([]);
  });

  test('keeps each failure distinct', () => {
    const fake = stubWindow('android');
    const received = collectPastes();

    for (const reason of ['unreadable', 'too-large', 'unsupported-type']) {
      fake.emitRaw(`{"ok":false,"reason":"${reason}"}`);
    }

    expect(received).toEqual([
      { ok: false, reason: 'unreadable' },
      { ok: false, reason: 'too-large' },
      { ok: false, reason: 'unsupported-type' },
    ]);
  });

  test('reports undecodable image data as a read failure', () => {
    const fake = stubWindow('android');
    const received = collectPastes();

    fake.emitRaw('{"ok":true,"mimeType":"image/png","data":"not base64 ***"}');

    expect(received).toEqual([{ ok: false, reason: 'unreadable' }]);
  });

  test('ignores anything that is not a committed image', () => {
    const fake = stubWindow('android');
    const received = collectPastes();

    fake.emitRaw('null');
    fake.emitRaw('"image"');
    fake.emitRaw('{}');
    fake.emitRaw('{"ok":true}');
    fake.emitRaw(`{"ok":true,"mimeType":"text/plain","data":"${IMAGE_BASE64}"}`);
    fake.emitRaw('{"ok":true,"mimeType":"image/png"}');
    fake.emitRaw('{"ok":false,"reason":"whatever-the-app-said"}');
    fake.dispatchRaw(new Event(IMAGE_PASTE_EVENT));

    expect(received).toEqual([]);
  });
});
