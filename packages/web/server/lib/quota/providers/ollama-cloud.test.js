import { describe, expect, it } from 'bun:test';
import { fetchOllamaCloudUsage } from './ollama-cloud.js';

const settingsResponse = (body, { status = 200, url = 'https://ollama.com/settings' } = {}) => {
  const response = new Response(body, { status });
  Object.defineProperty(response, 'url', { value: url });
  return response;
};

describe('Ollama Cloud quota provider', () => {
  it('parses usage from the authenticated settings page', async () => {
    const windows = await fetchOllamaCloudUsage(
      { cookie: '__Secure-session=test-cookie' },
      async () => settingsResponse('<html><body><div>Session usage 50%</div><div>Weekly usage 25%</div><div>Premium 2 / 10</div></body></html>')
    );
    expect(windows.session.usedPercent).toBe(50);
    expect(windows.weekly.usedPercent).toBe(25);
    expect(windows.premium.valueLabel).toBe('2 / 10');
  });

  it('accepts a recognized authenticated page with no usage data', async () => {
    const windows = await fetchOllamaCloudUsage(
      { cookie: '__Secure-session=test-cookie' },
      async () => settingsResponse('<html><body><p>No usage yet</p></body></html>')
    );
    expect(windows).toEqual({});
  });

  it('rejects an unrecognized successful HTML response', async () => {
    await expect(
      fetchOllamaCloudUsage({ cookie: '__Secure-session=test-cookie' }, async () => settingsResponse('<html><body>Unexpected content</body></html>'))
    ).rejects.toThrow('could not be parsed');
  });

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
});
