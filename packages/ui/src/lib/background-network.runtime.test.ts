import { afterAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { subscribeRuntimeEndpointChanged, switchRuntimeEndpoint } from './runtime-switch';

const previousWindow = globalThis.window;
const previousCustomEvent = globalThis.CustomEvent;
const dom = new Window({ url: 'http://instance-a.test' });
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: dom });
Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, writable: true, value: dom.CustomEvent });
let onSwitch = () => {};
const unsubscribe = subscribeRuntimeEndpointChanged(() => onSwitch());
const { runBackgroundNetworkTask, runSessionListNetworkTask } = await import('./background-network');
afterAll(() => {
  unsubscribe();
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow });
  Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, writable: true, value: previousCustomEvent });
  dom.happyDOM.abort();
});
const switchTo = (runtimeKey: string, transport = runtimeKey) => switchRuntimeEndpoint({ runtimeKey, apiBaseUrl: `http://${transport}.test` });
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('background network instance ownership', () => {
  test('reads started by an earlier switch listener belong to the new instance', async () => {
    switchTo('a');
    const gate = deferred();
    const active = [runBackgroundNetworkTask(() => gate.promise), runBackgroundNetworkTask(() => gate.promise)];
    await flush();
    let read: Promise<string | undefined> | undefined;
    onSwitch = () => { read = runBackgroundNetworkTask(async () => 'new'); };
    switchTo('b');
    onSwitch = () => {};
    gate.resolve();
    await Promise.all(active);
    expect(await read).toBe('new');
  });
  test('retires queued reads in both lanes without calling them on the new instance', async () => {
    switchTo('a');
    const gate = deferred();
    const active = [runBackgroundNetworkTask(() => gate.promise), runBackgroundNetworkTask(() => gate.promise), runSessionListNetworkTask(() => gate.promise)];
    await flush();
    const started: string[] = [];
    const queued = [runBackgroundNetworkTask(async () => { started.push('background'); return []; }), runSessionListNetworkTask(async () => { started.push('sessions'); return []; })];
    switchTo('b');
    gate.resolve();
    await Promise.all(active);
    const results = await Promise.all(queued);
    expect(started).toEqual([]);
    expect(results).toEqual([undefined, undefined]);
  });

  test('new instance reads start while previous-instance requests remain unresolved', async () => {
    switchTo('a');
    const oldGate = deferred();
    const oldReads = [runBackgroundNetworkTask(() => oldGate.promise), runBackgroundNetworkTask(() => oldGate.promise), runSessionListNetworkTask(() => oldGate.promise)];
    await flush();
    switchTo('b');
    const started: string[] = [];
    const newGate = deferred();
    const newReads = [runBackgroundNetworkTask(async () => { started.push('background'); await newGate.promise; }), runSessionListNetworkTask(async () => { started.push('sessions'); await newGate.promise; })];
    try {
      await flush();
      expect(started).toEqual(['background', 'sessions']);
    } finally {
      oldGate.resolve(); newGate.resolve();
      await Promise.all([...oldReads, ...newReads]);
    }
  });

  test('an A-B-A round trip retires even an admitted read before its continuation starts', async () => {
    switchTo('a');
    let calls = 0;
    const read = runBackgroundNetworkTask(async () => { calls++; return 'old'; });
    switchTo('b'); switchTo('a');
    expect(await read).toBeUndefined();
    expect(calls).toBe(0);
  });

  test('same-instance transport changes keep queued reads and their concurrency budget', async () => {
    switchTo('a', 'lan');
    const gate = deferred();
    const active = [runBackgroundNetworkTask(() => gate.promise), runBackgroundNetworkTask(() => gate.promise)];
    await flush();
    let calls = 0;
    const queued = runBackgroundNetworkTask(async () => { calls++; return ['valid']; });
    switchTo('a', 'relay');
    await flush();
    expect(calls).toBe(0);
    gate.resolve();
    await Promise.all(active);
    expect(await queued).toEqual(['valid']);
    expect(calls).toBe(1);
  });
});
