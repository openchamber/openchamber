import { expect, test } from 'bun:test';
import { serverBrowserOrigins, serverBrowserOriginsSchema } from './server-browser-config.js';

test('adds actual listening URLs to mirrored front-door origins', () => {
  // Given an agent listener and a distinct mirrored front door.
  const input = { settingsOrigins: ['https://FRONT.example'], port: 4321, host: '0.0.0.0', addresses: ['192.168.1.4', '::1'] };
  // When deriving the service policy.
  const origins = serverBrowserOrigins(input);
  // Then neither the mirror nor the concrete listening addresses are lost.
  expect(origins).toEqual(['https://front.example', 'http://localhost:4321', 'http://127.0.0.1:4321', 'http://[::1]:4321', 'http://0.0.0.0:4321', 'http://192.168.1.4:4321']);
});

test('refuses invalid mirrored policy and an unknown listening port', () => {
  // Given policy that cannot safely define the protected origins.
  for (const settingsOrigins of [null, ['https://good.example', 'bad'], ['https://user:pass@example.com'], ['https://example.com/path']]) {
    // When parsing it, then no partial list is accepted.
    expect(serverBrowserOriginsSchema.safeParse(settingsOrigins).success).toBe(false);
  }
  expect(() => serverBrowserOrigins({ port: 0 })).toThrow();
});
