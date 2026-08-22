import { describe, expect, it } from 'bun:test';
import { fetchOllamaCloudUsage } from './ollama-cloud.js';

describe('Ollama Cloud quota provider', () => {
  it('rejects 401/403 as authentication failure', async () => {
    await expect(fetchOllamaCloudUsage({ cookie: 'session=secret' }, async () => new Response('', { status: 401 }))).rejects.toThrow('authentication failed');
    await expect(fetchOllamaCloudUsage({ cookie: 'session=secret' }, async () => new Response('', { status: 403 }))).rejects.toThrow('authentication failed');
  });

  it('returns empty windows for pages without usage data', async () => {
    const windows = await fetchOllamaCloudUsage({ cookie: 'session=secret' }, async () => new Response('<html></html>'));
    expect(windows).toEqual({});
  });

  it('rejects non-ok statuses that are not auth failures', async () => {
    await expect(fetchOllamaCloudUsage({ cookie: 'session=secret' }, async () => new Response('', { status: 500 }))).rejects.toThrow('HTTP 500');
  });

  it('rejects signin page as authentication failure (regression for redirect: follow)', async () => {
    const response = new Response('<html>Sign in</html>', { status: 200 });
    Object.defineProperty(response, 'url', { value: 'https://ollama.com/signin' });
    await expect(fetchOllamaCloudUsage({ cookie: 'session=secret' }, async () => response)).rejects.toThrow('authentication failed');
  });
});
