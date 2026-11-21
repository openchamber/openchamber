import { afterEach, describe, expect, it } from 'vitest';
import { createWebSettingsAPI } from './settings';

const originalFetch = globalThis.fetch;

describe('createWebSettingsAPI', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends the save with keepalive only when asked, so an unload flush survives the page', async () => {
    const inits: RequestInit[] = [];
    // SAFETY: the mock receives only the (input, init) pair the adapter passes and always resolves to a Response.
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init ?? {});
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const api = createWebSettingsAPI();
    await api.save({ gitChangesViewMode: 'flat' }, { keepalive: true });
    await api.save({ gitChangesViewMode: 'tree' });

    expect(inits.map((init) => [init.method, init.keepalive])).toEqual([['PUT', true], ['PUT', false]]);
  });
});
