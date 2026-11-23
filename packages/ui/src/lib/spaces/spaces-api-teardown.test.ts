import { afterEach, describe, expect, mock, test } from 'bun:test';

const desktopCalls: Array<{ command: string; args?: Record<string, unknown> }> = [];
let desktopFailure: Error | null = null;

mock.module('@/lib/desktopNative', () => ({
  invokeDesktopCommand: mock(async (command: string, args?: Record<string, unknown>) => {
    desktopCalls.push({ command, args });
    if (desktopFailure) throw desktopFailure;
    return { released: true };
  }),
}));

const { removeSpace } = await import('./spaces-api');

const ID = 'a1b2c3d4e5f6';
const originalFetch = globalThis.fetch;
const windowSlot = globalThis as { window?: unknown };
const originalWindow = windowSlot.window;

const answerRemoval = () => {
  const seen: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input instanceof Request ? input : new URL(String(input), 'http://127.0.0.1'), init));
      return new Response(JSON.stringify({ id: ID, removed: true, failures: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    originalFetch,
  );
  return seen;
};

const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  desktopCalls.length = 0;
  desktopFailure = null;
  if (originalWindow === undefined) delete windowSlot.window;
  else windowSlot.window = originalWindow;
});

describe('removeSpace desktop preview teardown', () => {
  test('notifies the desktop shell to release the removed space preview state', async () => {
    windowSlot.window = { __OPENCHAMBER_ELECTRON__: {} };
    const seen = answerRemoval();
    const removal = await removeSpace(ID);
    await flush();
    expect(removal.removed).toBe(true);
    expect(seen[0]?.method).toBe('DELETE');
    expect(desktopCalls).toEqual([{ command: 'desktop_space_preview_teardown', args: { spaceId: ID } }]);
  });

  test('does not invoke the desktop shell outside the desktop runtime', async () => {
    delete windowSlot.window;
    answerRemoval();
    await removeSpace(ID);
    await flush();
    expect(desktopCalls).toEqual([]);
  });

  test('a failing desktop notification does not fail the removal', async () => {
    windowSlot.window = { __OPENCHAMBER_ELECTRON__: {} };
    desktopFailure = new Error('desktop bridge unavailable');
    answerRemoval();
    const removal = await removeSpace(ID);
    await flush();
    expect(removal.removed).toBe(true);
    expect(desktopCalls).toHaveLength(1);
  });
});
