import { afterAll, expect, test } from 'bun:test';

/**
 * A dropped file's on-disk path reaches the attachment, so the model is handed
 * the file's location instead of a bare basename. This lives in its own file:
 * it installs the desktop globals the intake gate reads, which would leak into
 * the store's other cases if they shared a process.
 */

// The store installs its `onload` as a closure over the reader, never as a
// `this`-bound handler, so the stub only needs the no-argument shape.
class ImmediateFileReader {
  result: string | ArrayBuffer | null = 'data:text/plain;base64,aGVsbG8=';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: DOMException | null = null;
  readAsDataURL() {
    queueMicrotask(() => { this.onload?.(); });
  }
}

const origin = 'http://127.0.0.1:3901';
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousFileReader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
    __OPENCHAMBER_LOCAL_ORIGIN__: origin,
    __OPENCHAMBER_API_BASE_URL__: origin,
    __OPENCHAMBER_DESKTOP__: {
      invoke: async () => null,
      // Stands in for Electron's `webUtils.getPathForFile`.
      pathForFile: (file: File) => `/Users/me/Documents/${file.name}`,
    },
  },
});
Object.defineProperty(globalThis, 'FileReader', { configurable: true, writable: true, value: ImmediateFileReader });

afterAll(() => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  if (previousFileReader) Object.defineProperty(globalThis, 'FileReader', previousFileReader);
  else Reflect.deleteProperty(globalThis, 'FileReader');
});

test('a desktop-dropped file carries its on-disk path while the chip label stays the basename', async () => {
  const { useInputStore } = await import('./input-store');

  const attached = await useInputStore.getState().addAttachedFile(
    new File(['hello'], 'report.txt', { type: 'text/plain' }),
  );

  expect(attached).toBe(true);
  const [file] = useInputStore.getState().attachedFiles;
  expect(file?.filename).toBe('report.txt');
  expect(file?.agentPath).toBe('/Users/me/Documents/report.txt');
});

test('a content-transformed attachment does not carry the path to the unsanitized original', async () => {
  const { useInputStore } = await import('./input-store');
  useInputStore.getState().clearAttachedFiles();

  // A HAR is credential-redacted at intake: `prepareStructuredText` builds a
  // new File that keeps the original name. Handing the model the on-disk path
  // would point it at the unredacted original, so no path travels — the model
  // gets the sanitized content under the basename, exactly as before.
  const har = JSON.stringify({ log: { entries: [{ request: { headers: [{ name: 'authorization', value: 'Bearer secret' }] } }] } });
  const attached = await useInputStore.getState().addAttachedFile(
    new File([har], 'capture.har', { type: 'application/json' }),
  );

  expect(attached).toBe(true);
  const [file] = useInputStore.getState().attachedFiles;
  expect(file?.filename).toBe('capture.har');
  expect(file?.agentPath).toBeUndefined();
});
