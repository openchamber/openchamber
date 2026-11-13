import { afterEach, describe, expect, test } from 'bun:test';
import { signOutThisBrowser } from './passkeys';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from './runtime-url';

const originalFetch = globalThis.fetch;
const resolver = getRuntimeUrlResolver();
afterEach(() => {
  globalThis.fetch = originalFetch;
  setRuntimeUrlResolver(resolver);
});

describe('signOutThisBrowser', () => {
  for (const status of [200, 401]) test(`resolves when sign-out answers ${status}`, async () => {
    // Given an active runtime returning success or an already-expired session.
    configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
    let method: string | undefined;
    globalThis.fetch = async (_input, init) => {
      method = init?.method;
      return new Response(null, { status });
    };
    // When the browser signs out.
    await signOutThisBrowser();
    // Then its caller can reload without entering the error path.
    expect(method).toBe('DELETE');
  });

  test('rejects when persistence fails', async () => {
    // Given a runtime that cannot persist the sign-out.
    configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
    globalThis.fetch = async () => new Response(null, { status: 500 });
    // When sign-out fails, then its caller still receives an error.
    await expect(signOutThisBrowser()).rejects.toBeInstanceOf(Error);
  });
});
