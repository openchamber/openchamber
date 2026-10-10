import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { fetchSessionKnowledge, reportSessionKnowledgeDelivered } from '@/lib/sessionKnowledgeApi';
import { useConfigStore } from '@/stores/useConfigStore';
import {
  OpenCodeStartupError,
  isOpenCodeStarting,
  openCodeStartupSignal,
  runAfterOpenCodeStartup,
  useOpenCodeStartupStore,
  waitForOpenCodeStartup,
} from './opencode-startup-gate';

const originalBase = getRuntimeApiBaseUrl();
const originalRuntime = getRuntimeKey();

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// A runtime switch reaches subscribers as a window event, so the gate needs a
// window to hear it. The switch also mints a URL auth token for the new
// endpoint; that request is refused here instead of reaching the network.
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
beforeAll(() => {
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true, writable: true });
  const refuse = async () => { throw new Error('network disabled in tests'); };
  Object.defineProperty(globalThis, 'fetch', { value: refuse, configurable: true, writable: true });
});
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
});

beforeEach(() => {
  useConfigStore.setState({ isConnected: false, hasEverConnected: false });
  useOpenCodeStartupStore.setState({ waitingSends: 0 });
});

afterEach(() => {
  if (getRuntimeKey() !== originalRuntime) switchRuntimeEndpoint({ apiBaseUrl: originalBase, runtimeKey: originalRuntime });
});

describe('waitForOpenCodeStartup', () => {
  test('a send after OpenCode connected goes out at once', async () => {
    useConfigStore.setState({ isConnected: true, hasEverConnected: true });
    await waitForOpenCodeStartup();
    expect(useOpenCodeStartupStore.getState().waitingSends).toBe(0);
  });

  test('a send after a later disconnect does not wait for startup', async () => {
    useConfigStore.setState({ isConnected: false, hasEverConnected: true });
    expect(isOpenCodeStarting()).toBe(false);
    await waitForOpenCodeStartup();
  });

  test('a send before the first connection waits and goes out once OpenCode connects', async () => {
    let sent = false;
    const waiting = waitForOpenCodeStartup().then(() => { sent = true; });
    await settle();
    expect(sent).toBe(false);
    expect(useOpenCodeStartupStore.getState().waitingSends).toBe(1);

    useConfigStore.setState({ connectionPhase: 'connecting' });
    await settle();
    expect(sent).toBe(false);

    useConfigStore.setState({ isConnected: true, hasEverConnected: true });
    await waiting;
    expect(sent).toBe(true);
    expect(useOpenCodeStartupStore.getState().waitingSends).toBe(0);
  });

  test('several waiting sends all go out on the same connection', async () => {
    const first = waitForOpenCodeStartup();
    const second = waitForOpenCodeStartup();
    await settle();
    expect(useOpenCodeStartupStore.getState().waitingSends).toBe(2);
    useConfigStore.setState({ isConnected: true, hasEverConnected: true });
    await Promise.all([first, second]);
    expect(useOpenCodeStartupStore.getState().waitingSends).toBe(0);
  });

  test('a send fails when OpenCode does not start in time', async () => {
    await expect(waitForOpenCodeStartup(20)).rejects.toBeInstanceOf(OpenCodeStartupError);
    expect(useOpenCodeStartupStore.getState().waitingSends).toBe(0);
  });

  test('a send fails when the runtime changes while it waits', async () => {
    const waiting = waitForOpenCodeStartup();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://other.example' });
    await expect(waiting).rejects.toBeInstanceOf(OpenCodeStartupError);
    // A connection to the new runtime must not send the old message.
    useConfigStore.setState({ isConnected: true, hasEverConnected: true });
    expect(useOpenCodeStartupStore.getState().waitingSends).toBe(0);
  });
});

describe('openCodeStartupSignal', () => {
  test('a read waiting for OpenCode resolves on the first connection and is not counted as a held send', async () => {
    let resolved = false;
    const waiting = openCodeStartupSignal.waitForConnection().then(() => { resolved = true; });
    await settle();
    expect(resolved).toBe(false);
    expect(useOpenCodeStartupStore.getState().waitingSends).toBe(0);

    useConfigStore.setState({ isConnected: true, hasEverConnected: true });
    await waiting;
    expect(resolved).toBe(true);
    expect(openCodeStartupSignal.isStarting()).toBe(false);
  });

  test('a read waiting for OpenCode fails when it does not start in time', async () => {
    await expect(openCodeStartupSignal.waitForConnection(5)).rejects.toBeInstanceOf(OpenCodeStartupError);
  });
});

describe('runAfterOpenCodeStartup', () => {
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // The session owes its project knowledge until a delivery report lands.
  const installKnowledgeServer = () => {
    let owed = true;
    const refuse = globalThis.fetch;
    const resolver = getRuntimeUrlResolver();
    configureRuntimeUrlResolver({ apiBaseUrl: 'https://knowledge.example' });
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes('/api/session-knowledge/delivered')) {
        await delay(15);
        owed = false;
        return Response.json({ ok: true });
      }
      if (request.url.includes('/api/session-knowledge')) {
        return Response.json(owed ? { text: 'KNOWLEDGE', signature: 'sig' } : { text: '', signature: '' });
      }
      throw new Error(`unexpected request ${request.url}`);
    };
    return () => {
      globalThis.fetch = refuse;
      setRuntimeUrlResolver(resolver);
    };
  };

  test('held sends reach OpenCode in the order they were made, and the knowledge goes once', async () => {
    const restoreFetch = installKnowledgeServer();
    const posts: Array<{ message: string; knowledge: string }> = [];
    // The session-ui-store send: knowledge, then the prompt POST, then the
    // delivery report it does not wait for.
    const send = (message: string, workBeforePost: number) => runAfterOpenCodeStartup(async () => {
      const knowledge = await fetchSessionKnowledge('/repo', 'ses_1');
      await delay(workBeforePost);
      posts.push({ message, knowledge: knowledge.text });
      if (knowledge.text) void reportSessionKnowledgeDelivered('/repo', 'ses_1', knowledge.signature);
    });

    try {
      const first = send('first', 30);
      const second = send('second', 0);
      await settle();
      expect(useOpenCodeStartupStore.getState().waitingSends).toBe(2);
      useConfigStore.setState({ isConnected: true, hasEverConnected: true });
      // A send made while the held ones are still going out queues behind them.
      const third = send('third', 0);
      await Promise.all([first, second, third]);

      // Before: all released on one notification; "second" posted first and
      // both carried the knowledge block.
      expect(posts).toEqual([
        { message: 'first', knowledge: 'KNOWLEDGE' },
        { message: 'second', knowledge: '' },
        { message: 'third', knowledge: '' },
      ]);
    } finally {
      restoreFetch();
    }
  });

  test('a failed held send does not block the next one', async () => {
    const first = runAfterOpenCodeStartup(async () => { throw new Error('rejected'); });
    const second = runAfterOpenCodeStartup(async () => 'sent');
    useConfigStore.setState({ isConnected: true, hasEverConnected: true });
    await expect(first).rejects.toThrow('rejected');
    expect(await second).toBe('sent');
  });

  test('a send after startup with nothing held runs at once', async () => {
    useConfigStore.setState({ isConnected: true, hasEverConnected: true });
    let ran = false;
    const sending = runAfterOpenCodeStartup(async () => { ran = true; });
    expect(ran).toBe(true);
    await sending;
  });
});
