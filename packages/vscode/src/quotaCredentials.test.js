import { describe, expect, it, afterEach } from 'bun:test';
import { validateCredential } from './quotaCredentials.js';

describe('validateCredential for ollama-cloud', () => {
  const originalFetch = globalThis.fetch;
  const settingsUrl = 'https://ollama.com/settings';

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const response = (body, { status = 200, url = settingsUrl } = {}) => {
    const result = new Response(body, { status });
    Object.defineProperty(result, 'url', { value: url });
    return result;
  };

  const mockFetch = (result) => {
    globalThis.fetch = async () => result;
  };

  it('accepts a valid cookie (200 settings page)', async () => {
    mockFetch(response('<html>Session usage 50%</html>'));
    await expect(validateCredential('ollama-cloud', { cookie: '__Secure-session=test-cookie' })).resolves.toBeUndefined();
  });

  it('rejects signin redirect (invalid cookie)', async () => {
    mockFetch(response('<html>Sign in</html>', { url: 'https://ollama.com/signin' }));
    await expect(validateCredential('ollama-cloud', { cookie: '__Secure-session=test-cookie' })).rejects.toThrow('authentication failed');
  });

  it('rejects 401', async () => {
    mockFetch(response('', { status: 401 }));
    await expect(validateCredential('ollama-cloud', { cookie: '__Secure-session=test-cookie' })).rejects.toThrow('authentication failed');
  });

  it('rejects 403', async () => {
    mockFetch(response('', { status: 403 }));
    await expect(validateCredential('ollama-cloud', { cookie: '__Secure-session=test-cookie' })).rejects.toThrow('authentication failed');
  });

  it('rejects 500', async () => {
    mockFetch(response('', { status: 500 }));
    await expect(validateCredential('ollama-cloud', { cookie: '__Secure-session=test-cookie' })).rejects.toThrow('HTTP 500');
  });

  it('accepts valid cookie with no usage data (new account)', async () => {
    mockFetch(response('<html><body><p>No usage yet</p></body></html>'));
    await expect(validateCredential('ollama-cloud', { cookie: '__Secure-session=test-cookie' })).resolves.toBeUndefined();
  });

  it('rejects an unrecognized successful HTML response', async () => {
    mockFetch(response('<html>Unexpected content</html>'));
    await expect(validateCredential('ollama-cloud', { cookie: '__Secure-session=test-cookie' })).rejects.toThrow('could not be parsed');
  });

  it('rejects an unexpected final redirect origin', async () => {
    mockFetch(response('<html>Session usage 50%</html>', { url: 'https://evil.example/settings' }));
    await expect(validateCredential('ollama-cloud', { cookie: '__Secure-session=test-cookie' })).rejects.toThrow('unexpected origin');
  });

  it('rejects an unexpected final redirect path', async () => {
    mockFetch(response('<html>Session usage 50%</html>', { url: 'https://ollama.com/dashboard' }));
    await expect(validateCredential('ollama-cloud', { cookie: '__Secure-session=test-cookie' })).rejects.toThrow('unexpected final path');
  });

  it('preserves timeout failures', async () => {
    globalThis.fetch = async () => { throw new DOMException('The operation timed out', 'TimeoutError'); };
    await expect(validateCredential('ollama-cloud', { cookie: '__Secure-session=test-cookie' })).rejects.toThrow('The operation timed out');
  });
});
