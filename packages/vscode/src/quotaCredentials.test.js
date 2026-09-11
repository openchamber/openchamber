import { describe, expect, it, afterEach } from 'bun:test';
import { normalizeCredential, validateCredential } from './quotaCredentials.ts';

describe('validateCredential for ollama-cloud', () => {
  const originalFetch = globalThis.fetch;
  const settingsUrl = 'https://ollama.com/settings';

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const response = (body, { status = 200, url = settingsUrl, headers } = {}) => {
    const result = new Response(body, { status, headers });
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

  it('keeps the cookie on a same-origin redirect', async () => {
    const requests = [];
    const responses = [
      response('', { status: 302, headers: { location: settingsUrl } }),
      response('<html>Session usage 50%</html>'),
    ];
    globalThis.fetch = (async (url, init) => {
      requests.push({ url, init });
      return responses.shift();
    });

    await expect(validateCredential('ollama-cloud', { cookie: '__Secure-session=test-cookie' })).resolves.toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(requests[0].init.redirect).toBe('manual');
    expect(requests[0].init.headers.Cookie).toBe('__Secure-session=test-cookie');
    expect(requests[1].init.headers.Cookie).toBe('__Secure-session=test-cookie');
  });

  it('does not forward the cookie to a cross-origin redirect target', async () => {
    const requests = [];
    const responses = [
      response('', { status: 302, headers: { location: 'https://evil.example/settings' } }),
      response('<html>Session usage 50%</html>', { url: 'https://evil.example/settings' }),
    ];
    globalThis.fetch = (async (url, init) => {
      requests.push({ url, init });
      return responses.shift();
    });

    await expect(validateCredential('ollama-cloud', { cookie: '__Secure-session=test-cookie' })).rejects.toThrow('unexpected origin');
    expect(requests).toHaveLength(2);
    expect(requests[1].url).toBe('https://evil.example/settings');
    expect(requests[1].init.headers.Cookie).toBeUndefined();
  });

  it('rejects redirect loops beyond the maximum', async () => {
    const responses = Array.from({ length: 11 }, () => response('', { status: 302, headers: { location: settingsUrl } }));
    globalThis.fetch = async () => responses.shift();
    await expect(validateCredential('ollama-cloud', { cookie: '__Secure-session=test-cookie' })).rejects.toThrow('too many redirects');
  });

  it('rejects an invalid redirect URL', async () => {
    globalThis.fetch = async () => response('', { status: 302, headers: { location: 'https://' } });
    await expect(validateCredential('ollama-cloud', { cookie: '__Secure-session=test-cookie' })).rejects.toThrow('invalid redirect URL');
  });

  it('rejects a redirect to a non-http protocol', async () => {
    globalThis.fetch = async () => response('', { status: 302, headers: { location: 'file:///etc/passwd' } });
    await expect(validateCredential('ollama-cloud', { cookie: '__Secure-session=test-cookie' })).rejects.toThrow('invalid redirect URL');
  });

  it('preserves timeout failures', async () => {
    globalThis.fetch = async () => { throw new DOMException('The operation timed out', 'TimeoutError'); };
    await expect(validateCredential('ollama-cloud', { cookie: '__Secure-session=test-cookie' })).rejects.toThrow('The operation timed out');
  });
});

describe('normalizeCredential for ollama-cloud', () => {
  it('prefers wos-session from a full Cookie header', () => {
    expect(normalizeCredential('ollama-cloud', { cookie: 'other=1; wos-session=abc123; __Secure-session=legacy456' })).toEqual({ cookie: 'wos-session=abc123' });
  });

  it('falls back to the legacy session cookie', () => {
    expect(normalizeCredential('ollama-cloud', { cookie: 'other=1; __Secure-session=legacy456' })).toEqual({ cookie: '__Secure-session=legacy456' });
  });

  it('keeps a single name=value pair', () => {
    expect(normalizeCredential('ollama-cloud', { cookie: '__Secure-session=test-cookie' })).toEqual({ cookie: '__Secure-session=test-cookie' });
  });

  it('keeps a raw token without an equals sign', () => {
    expect(normalizeCredential('ollama-cloud', { cookie: 'raw-token-value' })).toEqual({ cookie: 'raw-token-value' });
  });

  it('rejects values with CR/LF', () => {
    expect(normalizeCredential('ollama-cloud', { cookie: 'wos-session=abc\r\nInjected: 1' })).toBeNull();
    expect(normalizeCredential('ollama-cloud', { cookie: 'wos-session=abc\nInjected: 1' })).toBeNull();
  });
});
