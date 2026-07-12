import { beforeEach, describe, expect, mock, test } from 'bun:test';

let fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (input: string, init?: RequestInit) => fetchImpl(input, init),
}));

const { useBackgroundAutoAcceptStore } = await import('./backgroundAutoAcceptStore');
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe('background auto-accept store', () => {
  beforeEach(() => {
    useBackgroundAutoAcceptStore.getState().reset();
    fetchImpl = async () => json({ enabled: false });
  });

  test('hydrates the current server mode', async () => {
    await useBackgroundAutoAcceptStore.getState().hydrate();
    expect(useBackgroundAutoAcceptStore.getState().enabled).toBe(false);
  });

  test('enables with a client policy snapshot', async () => {
    let body: unknown;
    fetchImpl = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return json({ enabled: true });
    };

    await useBackgroundAutoAcceptStore.getState().setEnabled(true, { session: true });

    expect(body).toEqual({ enabled: true, policies: { session: true } });
    expect(useBackgroundAutoAcceptStore.getState().enabled).toBe(true);
  });

  test('reports a session policy conflict when background mode is off', async () => {
    fetchImpl = async () => json({ enabled: false }, 409);
    expect(await useBackgroundAutoAcceptStore.getState().setSessionPolicy('session', true)).toBe(false);
    expect(useBackgroundAutoAcceptStore.getState().enabled).toBe(false);
  });
});
