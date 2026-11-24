import { describe, expect, test } from 'bun:test';

import { parseSharedFiles, subscribeToNativeSharedFiles } from './nativeSharedFiles';

// Not a real document: this path's contract is that the bytes arrive unchanged, whatever
// media type the native side announced them as.
const FILE_BYTES = new Uint8Array([1, 2, 3, 250, 251, 255]);
const FILE_BASE64 = Buffer.from(FILE_BYTES).toString('base64');

describe('shared files payload', () => {
  test('decodes a staged file with its name and declared type', async () => {
    const payload = parseSharedFiles({
      files: [{ name: 'report.pdf', mimeType: 'application/pdf', data: FILE_BASE64 }],
    });

    expect(payload?.rejected).toEqual([]);
    expect(payload?.text).toBeNull();
    expect(payload?.files).toHaveLength(1);
    const [file] = payload!.files;
    expect(file.name).toBe('report.pdf');
    expect(file.type).toBe('application/pdf');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(FILE_BYTES);
  });

  test('passes the names the native side refused to the caller', () => {
    const payload = parseSharedFiles({
      files: [],
      rejected: [{ name: 'huge.zip', reason: 'too-large' }],
    });

    expect(payload?.files).toEqual([]);
    expect(payload?.rejected).toEqual([{ name: 'huge.zip', reason: 'too-large' }]);
  });

  test('reports a file whose base64 cannot be decoded instead of dropping it', () => {
    const payload = parseSharedFiles({
      files: [{ name: 'broken.bin', mimeType: 'application/octet-stream', data: '!!!!' }],
    });

    expect(payload?.files).toEqual([]);
    expect(payload?.rejected).toEqual([{ name: 'broken.bin', reason: 'unreadable' }]);
  });

  test('rejects a shape the plugin never promised', () => {
    expect(parseSharedFiles({ files: [{ name: 'note.txt' }] })).toBeNull();
    expect(parseSharedFiles({ text: 42 })).toBeNull();
    expect(parseSharedFiles(undefined)).toBeNull();
  });

  test('keeps a shared link or paragraph as text with no files', () => {
    const payload = parseSharedFiles({ text: '  https://openchamber.dev/session/abc\n' });

    expect(payload?.text).toBe('https://openchamber.dev/session/abc');
    expect(payload?.files).toEqual([]);
    expect(payload?.rejected).toEqual([]);
  });

  test('carries both when the share had text and a file', () => {
    const payload = parseSharedFiles({
      text: 'Screenshot from the failing run',
      files: [{ name: 'shot.png', mimeType: 'image/png', data: FILE_BASE64 }],
    });

    expect(payload?.text).toBe('Screenshot from the failing run');
    expect(payload?.files).toHaveLength(1);
  });

  test('treats blank text as no text', () => {
    const payload = parseSharedFiles({ text: '   \n ', files: [] });

    expect(payload?.text).toBeNull();
  });
});

describe('shared files subscription', () => {
  const fakePlugin = () => {
    const calls = { takePending: 0, addListener: 0 };
    const accepted: string[] = [];
    const plugin = {
      takePending: async () => {
        calls.takePending += 1;
        return { id: 'share-1', text: 'shared', files: [], rejected: [] };
      },
      accept: async ({ id }: { id: string }) => {
        accepted.push(id);
      },
      addListener: async () => {
        calls.addListener += 1;
        return { remove: async () => undefined };
      },
    };
    return { calls, plugin, accepted };
  };

  test('drains on Android and iOS when the shell has the plugin', async () => {
    for (const platform of ['android', 'ios'] as const) {
      const { calls, plugin } = fakePlugin();
      let stop = () => {};
      const received = await new Promise<string | null>((resolve) => {
        stop = subscribeToNativeSharedFiles((payload) => resolve(payload.text), {
          platform,
          pluginAvailable: () => true,
          plugin,
        });
      });
      stop();

      expect(calls).toEqual({ takePending: 1, addListener: 1 });
      expect(received).toBe('shared');
    }
  });

  test('the same share handed over again before it is accepted reaches the page once, and accept tells the shell', async () => {
    const { plugin, accepted } = fakePlugin();
    const handedOver = ['share-1', 'share-1', 'share-2'];
    let notify = () => {};
    const received: Array<{ id: string | null; accept: () => void }> = [];
    let secondArrived = () => {};
    const second = new Promise<void>((resolve) => { secondArrived = resolve; });
    const stop = subscribeToNativeSharedFiles((payload, accept) => {
      received.push({ id: payload.id, accept });
      if (received.length === 2) secondArrived();
    }, {
      platform: 'android',
      pluginAvailable: () => true,
      plugin: {
        ...plugin,
        takePending: async () => ({ id: handedOver.shift() ?? null, text: 'shared', files: [], rejected: [] }),
        addListener: async (_event, listener) => {
          notify = listener;
          return { remove: async () => undefined };
        },
      },
    });
    await Promise.resolve();
    notify();
    notify();
    await second;
    stop();

    expect(received.map((entry) => entry.id)).toEqual(['share-1', 'share-2']);
    expect(accepted).toEqual([]);
    received[0].accept();
    expect(accepted).toEqual(['share-1']);
  });

  test('asks nothing of a shell built before the plugin', () => {
    for (const platform of ['android', 'ios'] as const) {
      const { calls, plugin } = fakePlugin();

      subscribeToNativeSharedFiles(() => undefined, { platform, pluginAvailable: () => false, plugin })();

      expect(calls).toEqual({ takePending: 0, addListener: 0 });
    }
  });

  test('asks nothing on the web or the desktop', () => {
    for (const platform of ['web', 'desktop'] as const) {
      const { calls, plugin } = fakePlugin();

      subscribeToNativeSharedFiles(() => undefined, { platform, pluginAvailable: () => true, plugin })();

      expect(calls).toEqual({ takePending: 0, addListener: 0 });
    }
  });
});
