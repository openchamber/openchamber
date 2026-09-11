import { expect, test } from 'bun:test';

import { initializeRuntimeEndpoint, switchRuntimeEndpoint } from './runtime-switch';
import { getOutsideFileGrant, resolveOutsideFileReadOptions } from './outsideFileGrants';

test('renews an expired outside-file grant before returning read options', async () => {
  let now = 1_000;
  let grantRequests = 0;
  let grantFileAccess = async (path: string) => {
    grantRequests += 1;
    return { path, outsideFileGrant: `grant-${grantRequests}`, expiresAt: now + 60_000 };
  };
  const originalNow = Date.now;
  const originalWindow = globalThis.window;
  Date.now = () => now;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
      __OPENCHAMBER_DESKTOP__: {
        invoke: async () => null,
        grantFileAccess: (path: string) => grantFileAccess(path),
      },
      dispatchEvent: () => true,
      location: { origin: 'http://127.0.0.1:57123' },
    },
  });
  initializeRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:57123/api', runtimeKey: 'local' });

  try {
    expect(await resolveOutsideFileReadOptions('C:/workspace/file.txt', 'C:/workspace', true))
      .toEqual({ allowOutsideWorkspace: false });
    expect(await resolveOutsideFileReadOptions('C:/outside/file.txt', 'C:/workspace', false))
      .toEqual({ allowOutsideWorkspace: false });
    expect(grantRequests).toBe(0);

    const first = await resolveOutsideFileReadOptions('C:/outside/file.txt', 'C:/workspace', true);
    now += 55_001;
    const [renewed, concurrent] = await Promise.all([
      resolveOutsideFileReadOptions('C:/outside/file.txt', 'C:/workspace', true),
      resolveOutsideFileReadOptions('C:/outside/file.txt', 'C:/workspace', true),
    ]);

    expect(first).toEqual({ allowOutsideWorkspace: true, outsideFileGrant: 'grant-1' });
    expect(renewed).toEqual({ allowOutsideWorkspace: true, outsideFileGrant: 'grant-2' });
    expect(concurrent).toEqual(renewed);
    expect(grantRequests).toBe(2);

    switchRuntimeEndpoint({ apiBaseUrl: 'https://remote.example/api', runtimeKey: 'remote' });
    expect(await resolveOutsideFileReadOptions('C:/outside/file.txt', 'C:/workspace', true))
      .toEqual({ allowOutsideWorkspace: true, outsideFileGrant: undefined });
    expect(grantRequests).toBe(2);

    switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:57123/api', runtimeKey: 'local' });
    let finishGrantRequest: (grant: { path: string; outsideFileGrant: string; expiresAt: number }) => void = () => undefined;
    grantFileAccess = (path) => new Promise((resolve) => {
      finishGrantRequest = resolve;
      grantRequests += 1;
      void path;
    });
    const pending = resolveOutsideFileReadOptions('C:/outside/pending.txt', 'C:/workspace', true);
    switchRuntimeEndpoint({ apiBaseUrl: 'https://remote.example/api', runtimeKey: 'remote' });
    finishGrantRequest({
      path: 'C:/outside/pending.txt',
      outsideFileGrant: 'stale-grant',
      expiresAt: now + 10 * 60 * 1000,
    });
    expect(await pending).toEqual({ allowOutsideWorkspace: true, outsideFileGrant: undefined });
    switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:57123/api', runtimeKey: 'local' });
    expect(getOutsideFileGrant('C:/outside/pending.txt')).toBe(undefined);
  } finally {
    switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:57123/api', runtimeKey: 'local' });
    Date.now = originalNow;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  }
});
