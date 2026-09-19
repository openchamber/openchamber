import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { loadGuestCatalog } from './load-catalog';
import { useGuestsStore } from './store';

afterEach(() => useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey()));

describe('catalog request diagnostics', () => {
  test('retains HTTP failures and clears them on a successful retry', async () => {
    useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private proxy error', { status: 404 }));
    try {
      await loadGuestCatalog();
      expect(useGuestsStore.getState().status).toBe('error');
      expect(useGuestsStore.getState().failure).toEqual({ method: 'GET', path: '/api/guests', kind: 'http', status: 404 });
      fetch.mockResolvedValue(Response.json({ guests: [] }));
      await loadGuestCatalog();
      expect(useGuestsStore.getState().status).toBe('ready');
      expect(useGuestsStore.getState().failure).toBeNull();
    } finally { fetch.mockRestore(); }
  });

  test('distinguishes unexpected responses and network failures', async () => {
    useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>Fallback</html>'));
    try {
      await loadGuestCatalog();
      expect(useGuestsStore.getState().failure).toEqual({ method: 'GET', path: '/api/guests', kind: 'invalid-response', status: 200 });
      fetch.mockRejectedValue(new Error('Private transport details'));
      await loadGuestCatalog();
      expect(useGuestsStore.getState().failure).toEqual({ method: 'GET', path: '/api/guests', kind: 'network' });
    } finally { fetch.mockRestore(); }
  });

  test('late failures cannot contaminate the next runtime', async () => {
    useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    let respond: ((response: Response) => void) | undefined;
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((resolve) => { respond = resolve; }));
    try {
      const pending = loadGuestCatalog();
      await new Promise(resolve => setTimeout(resolve, 0));
      useGuestsStore.getState().resetForRuntimeSwitch('next-runtime');
      if (!respond) throw new Error('Expected a pending catalog request');
      respond(new Response('', { status: 500 }));
      await pending;
      expect(useGuestsStore.getState().status).toBe('idle');
      expect(useGuestsStore.getState().failure).toBeNull();
    } finally { fetch.mockRestore(); }
  });
});
