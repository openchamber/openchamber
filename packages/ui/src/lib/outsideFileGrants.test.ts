import { expect, test } from 'bun:test';

import { initializeRuntimeEndpoint } from './runtime-switch';
import { resolveOutsideFileReadOptions } from './outsideFileGrants';

test('renews an expired outside-file grant before returning read options', async () => {
  let now = 1_000;
  let grantRequests = 0;
  const originalNow = Date.now;
  const originalWindow = globalThis.window;
  Date.now = () => now;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
      __OPENCHAMBER_DESKTOP__: {
        invoke: async () => null,
        grantFileAccess: async (path: string) => {
          grantRequests += 1;
          return { path, outsideFileGrant: `grant-${grantRequests}` };
        },
      },
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
    now += 10 * 60 * 1000 + 1;
    const [renewed, concurrent] = await Promise.all([
      resolveOutsideFileReadOptions('C:/outside/file.txt', 'C:/workspace', true),
      resolveOutsideFileReadOptions('C:/outside/file.txt', 'C:/workspace', true),
    ]);

    expect(first).toEqual({ allowOutsideWorkspace: true, outsideFileGrant: 'grant-1' });
    expect(renewed).toEqual({ allowOutsideWorkspace: true, outsideFileGrant: 'grant-2' });
    expect(concurrent).toEqual(renewed);
    expect(grantRequests).toBe(2);
  } finally {
    Date.now = originalNow;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  }
});
