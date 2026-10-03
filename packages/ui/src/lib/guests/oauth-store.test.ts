import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { useGuestOauthStore } from './oauth-store';

afterEach(() => useGuestOauthStore.getState().resetForRuntimeSwitch());

describe('instance-scoped extension accounts', () => {
  test('a late account refresh cannot overwrite the next instance with the same built-in ID', async () => {
    let respond: ((response: Response) => void) | undefined;
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((resolve) => { respond = resolve; }));
    try {
      const pending = useGuestOauthStore.getState().refresh('openchamber-builtin-sdk-demo');
      await new Promise(resolve => setTimeout(resolve, 0));
      useGuestOauthStore.getState().resetForRuntimeSwitch();
      const current = { connection: { connected: true, account: 'current' }, hasClient: false, settings: {}, redirectUri: '' };
      useGuestOauthStore.getState().setStatus('openchamber-builtin-sdk-demo', current);
      if (!respond) throw new Error('Expected a pending status request');
      respond(Response.json({ connected: true, account: 'old', hasClient: false, settings: {}, redirectUri: '' }));
      expect(await pending).toBeNull();
      expect(useGuestOauthStore.getState().byId['openchamber-builtin-sdk-demo']).toEqual(current);
    } finally { fetch.mockRestore(); }
  });

  test('commits current responses and preserves known state on fetch failure', async () => {
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ connected: true, account: 'current', hasClient: false, settings: {} }));
    try {
      await useGuestOauthStore.getState().refresh('demo');
      expect(useGuestOauthStore.getState().byId.demo.connection.account).toBe('current');
      fetch.mockResolvedValue(new Response('', { status: 500 }));
      expect(await useGuestOauthStore.getState().refresh('demo')).toBeNull();
      expect(useGuestOauthStore.getState().byId.demo.connection.account).toBe('current');
    } finally { fetch.mockRestore(); }
  });
});
