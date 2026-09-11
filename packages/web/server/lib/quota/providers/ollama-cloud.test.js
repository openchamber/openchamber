import { describe, expect, it } from 'bun:test';
import { parseOllamaSettingsHtml, fetchOllamaCloudUsage } from './ollama-cloud.js';
import { normalizers } from '../credentials/providers.js';

const settingsResponse = (body, { status = 200, url = 'https://ollama.com/settings', headers } = {}) => {
  const response = new Response(body, { status, headers });
  Object.defineProperty(response, 'url', { value: url });
  return response;
};

describe('Ollama Cloud quota provider', () => {
  it('rejects 401/403 as authentication failure', async () => {
    await expect(fetchOllamaCloudUsage({ cookie: '__Secure-session=test-cookie' }, async () => settingsResponse('', { status: 401 }))).rejects.toThrow('authentication failed');
    await expect(fetchOllamaCloudUsage({ cookie: '__Secure-session=test-cookie' }, async () => settingsResponse('', { status: 403 }))).rejects.toThrow('authentication failed');
  });

  it('rejects a signin redirect as authentication failure', async () => {
    await expect(
      fetchOllamaCloudUsage({ cookie: '__Secure-session=test-cookie' }, async () => settingsResponse('<html>Sign in</html>', { url: 'https://ollama.com/signin' }))
    ).rejects.toThrow('authentication failed');
  });

  it('rejects an unexpected final redirect origin', async () => {
    await expect(
      fetchOllamaCloudUsage({ cookie: '__Secure-session=test-cookie' }, async () => settingsResponse('<html>Session usage 50%</html>', { url: 'https://evil.example/settings' }))
    ).rejects.toThrow('unexpected origin');
  });

  it('rejects an unexpected final redirect path', async () => {
    await expect(
      fetchOllamaCloudUsage({ cookie: '__Secure-session=test-cookie' }, async () => settingsResponse('<html>Session usage 50%</html>', { url: 'https://ollama.com/dashboard' }))
    ).rejects.toThrow('unexpected final path');
  });

  it('keeps cookies on same-origin redirects and strips them before cross-origin requests', async () => {
    const sameOriginRequests = [];
    const sameOriginResponses = [
      settingsResponse('', { status: 302, headers: { location: 'https://ollama.com/settings' } }),
      settingsResponse('<html><body><div>Session usage 50%</div></body></html>'),
    ];
    const sameOriginWindows = await fetchOllamaCloudUsage(
      { cookie: '__Secure-session=test-cookie' },
      async (url, options) => {
        sameOriginRequests.push({ url, options });
        return sameOriginResponses.shift();
      }
    );

    expect(sameOriginWindows.session.usedPercent).toBe(50);
    expect(sameOriginRequests).toHaveLength(2);
    expect(sameOriginRequests[0].options.redirect).toBe('manual');
    expect(sameOriginRequests[0].options.headers.Cookie).toBe('__Secure-session=test-cookie');
    expect(sameOriginRequests[1].options.headers.Cookie).toBe('__Secure-session=test-cookie');

    const crossOriginRequests = [];
    const crossOriginResponses = [
      settingsResponse('', { status: 302, headers: { location: 'https://evil.example/settings' } }),
      settingsResponse('<html><body><div>Session usage 50%</div></body></html>', { url: 'https://evil.example/settings' }),
    ];
    await expect(
      fetchOllamaCloudUsage(
        { cookie: '__Secure-session=test-cookie' },
        async (url, options) => {
          crossOriginRequests.push({ url, options });
          return crossOriginResponses.shift();
        }
      )
    ).rejects.toThrow('unexpected origin');

    expect(crossOriginRequests).toHaveLength(2);
    expect(crossOriginRequests[1].url).toBe('https://evil.example/settings');
    expect(crossOriginRequests[1].options.headers.Cookie).toBeUndefined();
  });

  it('rejects redirect loops beyond the maximum', async () => {
    const responses = Array.from({ length: 11 }, () => settingsResponse('', { status: 302, headers: { location: 'https://ollama.com/settings' } }));
    await expect(
      fetchOllamaCloudUsage({ cookie: '__Secure-session=test-cookie' }, async () => responses.shift())
    ).rejects.toThrow('too many redirects');
  });

  it('rejects an invalid redirect URL', async () => {
    await expect(
      fetchOllamaCloudUsage({ cookie: '__Secure-session=test-cookie' }, async () => settingsResponse('', { status: 302, headers: { location: 'https://' } }))
    ).rejects.toThrow('invalid redirect URL');
  });

  it('rejects a redirect to a non-http protocol', async () => {
    await expect(
      fetchOllamaCloudUsage({ cookie: '__Secure-session=test-cookie' }, async () => settingsResponse('', { status: 302, headers: { location: 'file:///etc/passwd' } }))
    ).rejects.toThrow('invalid redirect URL');
  });

  it('rejects non-ok statuses that are not auth failures', async () => {
    await expect(fetchOllamaCloudUsage({ cookie: '__Secure-session=test-cookie' }, async () => settingsResponse('', { status: 500 }))).rejects.toThrow('HTTP 500');
  });

  it('preserves timeout failures', async () => {
    await expect(
      fetchOllamaCloudUsage({ cookie: '__Secure-session=test-cookie' }, async () => {
        throw new DOMException('The operation timed out', 'TimeoutError');
      })
    ).rejects.toThrow('The operation timed out');
  });

  it('rejects successful pages without usage data', async () => {
    await expect(fetchOllamaCloudUsage({ cookie: 'session=secret' }, async () => settingsResponse('<html></html>'))).rejects.toThrow('could not be parsed');
  });

  it('parses session/weekly/premium windows', () => {
    const windows = parseOllamaSettingsHtml('<p>Session usage: 42%</p><p>Weekly usage: 7%</p><p>Premium 120 / 1000</p>');
    expect(windows.session.usedPercent).toBe(42);
    expect(windows.weekly.usedPercent).toBe(7);
    expect(windows.premium.usedPercent).toBe(12);
    expect(windows.premium.valueLabel).toBe('120 / 1000');
  });

  it('parses the cost-based monthly usage shape', () => {
    const html = '<span class="text-sm">Monthly usage</span>\n      <span class="text-sm "\n        >$4.39 of $60 used</span\n      >';
    const windows = parseOllamaSettingsHtml(html);
    expect(windows.monthly.usedPercent).toBeCloseTo(7.3, 1);
    expect(windows.monthly.valueLabel).toBe('$4.39 / $60');
    expect(windows.monthly.remainingPercent).toBeCloseTo(92.7, 1);
  });

  it('parses the extra-usage credits balance', () => {
    const html = '<div><span>Balance remaining</span><span>$12.50</span></div><button>Add $5</button>';
    const windows = parseOllamaSettingsHtml(html);
    expect(windows.credits_balance.usedPercent).toBeNull();
    expect(windows.credits_balance.valueLabel).toBe('$12.50');
  });

  it('omits the credits balance when it is zero', () => {
    const html = '<div><span>Balance remaining</span><span>$0.00</span></div>';
    expect(parseOllamaSettingsHtml(html).credits_balance).toBeUndefined();
  });

  it('ignores nearby dollar amounts that are not the balance', () => {
    expect(parseOllamaSettingsHtml('<p>Add $5 to your balance when it hits $0</p>').credits_balance).toBeUndefined();
  });
});

describe('Ollama Cloud cookie normalizer', () => {
  const normalize = normalizers['ollama-cloud'];

  it('prefers wos-session from a full Cookie header', () => {
    expect(normalize({ cookie: 'other=1; wos-session=abc123; __Secure-session=legacy456' })).toEqual({ cookie: 'wos-session=abc123' });
  });

  it('falls back to the legacy session cookie', () => {
    expect(normalize({ cookie: 'other=1; __Secure-session=legacy456' })).toEqual({ cookie: '__Secure-session=legacy456' });
  });

  it('keeps a single name=value pair', () => {
    expect(normalize({ cookie: '__Secure-session=test-cookie' })).toEqual({ cookie: '__Secure-session=test-cookie' });
  });

  it('keeps a raw token without an equals sign', () => {
    expect(normalize({ cookie: 'raw-token-value' })).toEqual({ cookie: 'raw-token-value' });
  });

  it('rejects values with CR/LF', () => {
    expect(normalize({ cookie: 'wos-session=abc\r\nInjected: 1' })).toBeNull();
    expect(normalize({ cookie: 'wos-session=abc\nInjected: 1' })).toBeNull();
  });
});
