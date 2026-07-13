import { describe, expect, it, afterEach } from 'bun:test';
import { validateCredential } from './quotaCredentials.js';

describe('validateCredential for ollama-cloud', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const mockFetch = (response: Response) => {
    globalThis.fetch = (async () => response) as typeof fetch;
  };

  it('accepts a valid cookie (200 settings page)', async () => {
    mockFetch(new Response('<html>Session usage 50%</html>', { status: 200 }));
    await expect(validateCredential('ollama-cloud', { cookie: 'session=secret' })).resolves.toBeUndefined();
  });

  it('rejects signin redirect (invalid cookie)', async () => {
    const response = new Response('<html>Sign in</html>', { status: 200 });
    Object.defineProperty(response, 'url', { value: 'https://ollama.com/signin' });
    mockFetch(response);
    await expect(validateCredential('ollama-cloud', { cookie: 'session=bad' })).rejects.toThrow('authentication failed');
  });

  it('rejects 401', async () => {
    mockFetch(new Response('', { status: 401 }));
    await expect(validateCredential('ollama-cloud', { cookie: 'session=secret' })).rejects.toThrow('authentication failed');
  });

  it('rejects 403', async () => {
    mockFetch(new Response('', { status: 403 }));
    await expect(validateCredential('ollama-cloud', { cookie: 'session=secret' })).rejects.toThrow('authentication failed');
  });

  it('rejects 500', async () => {
    mockFetch(new Response('', { status: 500 }));
    await expect(validateCredential('ollama-cloud', { cookie: 'session=secret' })).rejects.toThrow('HTTP 500');
  });

  it('accepts valid cookie with no usage data (new account)', async () => {
    mockFetch(new Response('<html>No usage yet</html>', { status: 200 }));
    await expect(validateCredential('ollama-cloud', { cookie: 'session=secret' })).resolves.toBeUndefined();
  });
});
