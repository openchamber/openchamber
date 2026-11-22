import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { loadGuestCatalog, reloadGuestCatalog } from './load-catalog';
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

  test('one row the UI cannot read leaves the rest of the catalog loaded', async () => {
    useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    const hello = { id: 'hello', name: 'Hello', icon: 'window', capabilities: { requested: [], granted: [] } };
    const newer = { ...hello, id: 'newer', name: 'Newer', capabilities: { requested: ['telepathy'], granted: [] } };
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ guests: [hello, newer] }));
    try {
      await loadGuestCatalog();
      const state = useGuestsStore.getState();
      expect(state.status).toBe('ready');
      expect(state.failure).toBeNull();
      expect(state.guests).toEqual([hello]);
      expect(state.unreadable).toEqual([{ id: 'newer', name: 'Newer', builtIn: false }]);
    } finally { fetch.mockRestore(); }
  });

  test('a change announced while a read is out is read again after it', async () => {
    useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    const hello = { id: 'hello', name: 'Hello', icon: 'window', capabilities: { requested: [], granted: [] } };
    const responses: Array<(response: Response) => void> = [];
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((resolve) => { responses.push(resolve); }));
    const reads = async (count: number) => {
      for (let attempt = 0; responses.length < count && attempt < 50; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0));
      expect(responses).toHaveLength(count);
    };
    try {
      const stale = loadGuestCatalog();
      await reads(1);
      const fresh = reloadGuestCatalog();
      expect(loadGuestCatalog()).toBe(fresh);
      responses[0](Response.json({ guests: [] }));
      await stale;
      await reads(2);
      responses[1](Response.json({ guests: [hello] }));
      await fresh;
      expect(useGuestsStore.getState().guests).toEqual([hello]);
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

  test('a read queued behind one for the previous server never runs after a switch', async () => {
    useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    const responses: Array<(response: Response) => void> = [];
    // Only catalog reads stay pending; the switch's own token refresh fails at once.
    const fetch = spyOn(globalThis, 'fetch').mockImplementation((input) => (
      String(input instanceof Request ? input.url : input).includes('/api/guests')
        ? new Promise<Response>((resolve) => { responses.push(resolve); })
        : Promise.reject(new Error('offline'))
    ));
    try {
      const stale = loadGuestCatalog();
      for (let attempt = 0; responses.length < 1 && attempt < 50; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0));
      const queued = reloadGuestCatalog();
      switchRuntimeEndpoint({ apiBaseUrl: 'https://next.test', runtimeKey: 'next-runtime' });
      useGuestsStore.getState().resetForRuntimeSwitch('next-runtime');
      responses[0](Response.json({ guests: [] }));
      await stale;
      await queued;
      expect(responses).toHaveLength(1);
      expect(useGuestsStore.getState().runtimeKey).toBe('next-runtime');
      expect(useGuestsStore.getState().status).toBe('idle');
    } finally { fetch.mockRestore(); }
  });
});
