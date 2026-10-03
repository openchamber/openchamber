import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenCodeClient } from './opencode-client.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const client = () => createOpenCodeClient({ baseUrl: 'http://opencode.test', headers: { Authorization: 'Bearer test' }, directory: '/repo/app' });

describe('server-owned OpenCode dispatch responses', () => {
  it.each(['prompt', 'command'])('rejects an HTML %s acknowledgement through the real v2 client', async (operation) => {
    globalThis.fetch = vi.fn(async () => new Response('<!doctype html><title>OpenChamber</title>', {
      status: 200, headers: { 'content-type': 'text/html' },
    }));
    const sdk = client();
    const request = operation === 'prompt'
      ? sdk.session.prompt({ sessionID: 'ses_1', text: 'hello' })
      : sdk.session.command({ sessionID: 'ses_1', name: 'review', text: '' });
    const error = await request.catch((failure) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error.cause?.message ?? error.message).toContain('runtime returned HTML instead of an API response');
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it('keeps a healthy v2 acknowledgement and request authentication intact', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ data: { id: 'msg_accepted' } }));
    await expect(client().session.prompt({ sessionID: 'ses_1', text: 'hello' })).resolves.toEqual({ id: 'msg_accepted' });
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(String(url)).toBe('http://opencode.test/api/session/ses_1/prompt');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test');
    expect(new Headers(init.headers).get('x-opencode-directory')).toBe(encodeURIComponent('/repo/app'));
  });
});
