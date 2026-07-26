import { describe, expect, it } from 'bun:test';
import { fetchOllamaCloudUsage } from './ollama-cloud.js';

describe('Ollama Cloud quota provider', () => {
  it('rejects redirects without forwarding credentials', async () => {
    await expect(fetchOllamaCloudUsage({ cookie: 'session=secret' }, async () => new Response('', { status: 302 }))).rejects.toThrow('authentication failed');
  });

  it('rejects successful pages without usage data', async () => {
    await expect(fetchOllamaCloudUsage({ cookie: 'session=secret' }, async () => new Response('<html></html>'))).rejects.toThrow('could not be parsed');
  });
});
