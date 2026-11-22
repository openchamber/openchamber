import { afterEach, describe, expect, test } from 'bun:test';

import { guestGenerate } from './generate';

const originalFetch = globalThis.fetch;

type RecordedCall = { headers: Headers };

const stubFetch = (calls: RecordedCall[]): typeof fetch => (
  async (_input, init) => {
    calls.push({ headers: new Headers(init?.headers) });
    return Response.json({ ok: true, result: { text: 'generated' } });
  }
);

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('guestGenerate directory transport', () => {
  test('carries a directory outside Latin-1 the way the server decodes it', async () => {
    const calls: RecordedCall[] = [];
    globalThis.fetch = stubFetch(calls);

    const result = await guestGenerate('guest-1', { prompt: 'Hi' }, '/tmp/oc-project-中文', { providerID: 'anthropic', modelID: 'claude' });

    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get('x-opencode-directory')).toBe(encodeURIComponent('/tmp/oc-project-中文'));
    expect(calls[0].headers.get('x-opencode-directory-encoding')).toBe('uri');
    expect(calls[0].headers.get('x-openchamber-provider')).toBe('anthropic');
    expect(result.ok).toBe(true);
  });

  test('sends an ASCII directory unchanged and unmarked', async () => {
    const calls: RecordedCall[] = [];
    globalThis.fetch = stubFetch(calls);

    await guestGenerate('guest-1', { prompt: 'Hi' }, '/tmp/oc-project-ascii', { providerID: null, modelID: null });

    expect(calls[0].headers.get('x-opencode-directory')).toBe('/tmp/oc-project-ascii');
    expect(calls[0].headers.get('x-opencode-directory-encoding')).toBeNull();
  });
});
