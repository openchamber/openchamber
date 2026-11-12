import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { TerminalAPI, TerminalServerSession } from './api/types';
import { observeTerminalSessions } from './terminalSessionObserver';
import { useTerminalStore } from '@/stores/useTerminalStore';

let browser: Window;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
const cleanups: Array<() => void> = [];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
class MockEventSource {
  static CLOSED = 2;
  static instances: MockEventSource[] = [];
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  close() { this.readyState = MockEventSource.CLOSED; }
  constructor(_url: string) { MockEventSource.instances.push(this); }
  emit(type: string) { this.onmessage?.({ data: JSON.stringify({ type, properties: {} }) }); }
}

beforeEach(() => {
  browser = new Window({ url: 'http://localhost' });
  MockEventSource.instances = [];
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, EventSource: MockEventSource })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  useTerminalStore.getState().clearAll();
});
afterEach(async () => {
  for (const close of cleanups.splice(0)) close();
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const createTerminal = () => {
  let records: TerminalServerSession[] = [];
  let failed = false;
  const reads: string[] = [];
  const terminal: TerminalAPI = {
    listSessions: async directory => {
      reads.push(directory);
      if (failed) throw new Error('offline');
      return records;
    },
    createSession: async () => { throw new Error('unused'); },
    connect: () => ({ close() {} }), sendInput: async () => {}, resize: async () => {}, close: async () => {},
  };
  return { terminal, reads, setRecords: (next: TerminalServerSession[]) => { records = next; }, fail: (value: boolean) => { failed = value; } };
};
const running: TerminalServerSession = { sessionId: 'peer-run', cwd: '/repo', status: 'running', createdAt: 1, mode: 'command', purpose: { type: 'project-action', actionId: 'build', executionId: 'peer-run' } };

test('a failed invalidation retries with bounded backoff on a connected stream and resets after success', async () => {
  const source = createTerminal();
  const seen: TerminalServerSession[][] = [];
  cleanups.push(observeTerminalSessions(source.terminal, '/repo', () => new Map(), result => seen.push(result.sessions)));
  await tick();
  const original = globalThis.setTimeout;
  const retries: Array<{ delay: number; run: () => void }> = [];
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(Object.assign((...parameters: Parameters<typeof setTimeout>) => {
    const [callback, delay, ...args] = parameters;
    if (delay && delay >= 2000 && delay <= 60_000 && delay !== 45_000) {
      retries.push({ delay, run: () => callback(...args) });
      return original(() => {}, 0);
    }
    return original(callback, delay, ...args);
  }, original));
  const flush = async () => { for (let index = 0; index < 40; index += 1) await Promise.resolve(); };
  try {
    source.fail(true);
    MockEventSource.instances[0].emit('openchamber:terminal-sessions-changed');
    await flush();
    for (const delay of [2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]) {
      const retry = retries.shift();
      expect(retry?.delay).toBe(delay);
      retry?.run();
      await flush();
    }
    expect(seen).toEqual([[]]);
    source.fail(false);
    source.setRecords([running]);
    retries.shift()?.run();
    await flush();
    expect(seen.at(-1)).toEqual([running]);
    expect(retries).toEqual([]);
    source.fail(true);
    MockEventSource.instances[0].emit('openchamber:terminal-sessions-changed');
    await flush();
    expect(retries[0]?.delay).toBe(2000);
    Object.defineProperty(browser.document, 'visibilityState', { value: 'hidden', configurable: true });
    const before = source.reads.length;
    retries.shift()?.run();
    await flush();
    expect(source.reads).toHaveLength(before);
    expect(retries).toEqual([]);
  } finally { timer.mockRestore(); }
});

test('visible consumers share one event subscription and coalesce peer run invalidations without a polling timer', async () => {
  const source = createTerminal();
  const first: TerminalServerSession[][] = [];
  const second: TerminalServerSession[][] = [];
  cleanups.push(observeTerminalSessions(source.terminal, '/repo', () => new Map(), result => first.push(result.sessions)));
  cleanups.push(observeTerminalSessions(source.terminal, '/repo', () => new Map(), result => second.push(result.sessions)));
  await tick();
  expect(source.reads).toEqual(['']);
  expect(MockEventSource.instances).toHaveLength(1);
  source.setRecords([running]);
  const stream = MockEventSource.instances[0];
  stream.emit('openchamber:terminal-sessions-changed');
  stream.emit('openchamber:terminal-sessions-changed');
  // The stream owns a heartbeat watchdog. Once the event has arrived, the
  // observer's request and completion must schedule no timer of their own.
  const timers = spyOn(globalThis, 'setTimeout');
  try {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    expect(timers).not.toHaveBeenCalled();
  } finally { timers.mockRestore(); }
  expect(source.reads).toEqual(['', '']);
  expect(first.at(-1)).toEqual([running]);
  expect(second.at(-1)).toEqual([running]);
});

test('every control stream connection refreshes authority and unsubscribe removes the stream', async () => {
  const source = createTerminal();
  const close = observeTerminalSessions(source.terminal, '/repo', () => new Map(), () => {});
  cleanups.push(close);
  await tick();
  const stream = MockEventSource.instances[0];
  for (let index = 0; index < 2; index += 1) {
    stream.emit('openchamber:event-stream-ready');
    await tick();
  }
  expect(source.reads).toHaveLength(3);
  cleanups.pop()?.();
  expect(stream.readyState).toBe(MockEventSource.CLOSED);
  stream.emit('openchamber:terminal-sessions-changed');
  await tick();
  expect(source.reads).toHaveLength(3);
});

test('visibility recovery discovers changes whose events arrived while hidden', async () => {
  const source = createTerminal();
  const seen: TerminalServerSession[][] = [];
  cleanups.push(observeTerminalSessions(source.terminal, '/repo', () => new Map(), result => seen.push(result.sessions)));
  await tick();
  Object.defineProperty(browser.document, 'visibilityState', { value: 'hidden', configurable: true });
  source.setRecords([running]);
  MockEventSource.instances[0].emit('openchamber:terminal-sessions-changed');
  await tick();
  expect(source.reads).toHaveLength(1);
  Object.defineProperty(browser.document, 'visibilityState', { value: 'visible', configurable: true });
  browser.document.dispatchEvent(new browser.Event('visibilitychange'));
  await tick();
  expect(source.reads).toHaveLength(2);
  expect(seen.at(-1)).toEqual([running]);
});

test('an invalidation during a pending list requests one follow-up snapshot', async () => {
  const source = createTerminal();
  let resolvePending: (sessions: TerminalServerSession[]) => void = () => {};
  const pending = new Promise<TerminalServerSession[]>(resolve => { resolvePending = resolve; });
  let calls = 0;
  source.terminal.listSessions = () => ++calls === 1 ? pending : Promise.resolve([running]);
  const seen: TerminalServerSession[][] = [];
  cleanups.push(observeTerminalSessions(source.terminal, '/repo', () => new Map(), result => seen.push(result.sessions)));
  await tick();
  const stream = MockEventSource.instances[0];
  stream.emit('openchamber:terminal-sessions-changed');
  stream.emit('openchamber:terminal-sessions-changed');
  resolvePending([]);
  await tick();
  expect(calls).toBe(2);
  expect(seen.at(-1)).toEqual([running]);
});

test('hidden and offline scopes stop reads, wake on recovery, and preserve state on failure', async () => {
  const source = createTerminal();
  source.setRecords([running]);
  const store = useTerminalStore.getState();
  cleanups.push(observeTerminalSessions(source.terminal, '/repo', store.captureStartedActionMutationRevisions, result => {
    store.reconcileServerSessions('/repo', result.sessions, { startedActionMutationRevisions: result.startedActionMutationRevisions });
  }));
  await tick();
  Object.defineProperty(browser.document, 'visibilityState', { value: 'hidden', configurable: true });
  browser.document.dispatchEvent(new browser.Event('visibilitychange'));
  browser.dispatchEvent(new browser.Event('focus'));
  await tick();
  expect(source.reads).toHaveLength(1);
  Object.defineProperty(browser.document, 'visibilityState', { value: 'visible', configurable: true });
  Object.defineProperty(browser.navigator, 'onLine', { value: false, configurable: true });
  browser.document.dispatchEvent(new browser.Event('visibilitychange'));
  await tick();
  expect(source.reads).toHaveLength(1);
  source.fail(true);
  Object.defineProperty(browser.navigator, 'onLine', { value: true, configurable: true });
  browser.dispatchEvent(new browser.Event('online'));
  await tick();
  expect(source.reads).toHaveLength(2);
  expect(store.getActiveTab('/repo')?.lifecycle).toBe('running');
  source.fail(false);
  source.setRecords([]);
  browser.dispatchEvent(new browser.Event('focus'));
  await tick();
  expect(store.getActiveTab('/repo')?.lifecycle).toBe('exited');
  for (const close of cleanups.splice(0)) close();
  browser.dispatchEvent(new browser.Event('focus'));
  await tick();
  expect(source.reads).toHaveLength(3);
});


test('one global request serves 100 directories and an all-directory consumer', async () => {
  const source = createTerminal();
  source.setRecords([running]);
  const seen = new Map<string, TerminalServerSession[]>();
  for (let index = 0; index < 100; index += 1) {
    const directory = index === 0 ? '/repo/' : `/project-${index}`;
    cleanups.push(observeTerminalSessions(source.terminal, directory, () => new Map(), result => seen.set(directory, result.sessions)));
  }
  cleanups.push(observeTerminalSessions(source.terminal, '', () => new Map(), result => seen.set('all', result.sessions)));
  await tick();
  expect(source.reads).toEqual(['']);
  expect(seen.get('/repo/')).toEqual([running]);
  expect(seen.get('/project-1')).toEqual([]);
  expect(seen.get('all')).toEqual([running]);
});

test('rejects a replaced runtime response and refreshes the new runtime', async () => {
  const source = createTerminal();
  let resolvePending: (sessions: TerminalServerSession[]) => void = () => {};
  const pending = new Promise<TerminalServerSession[]>(resolve => { resolvePending = resolve; });
  let calls = 0;
  source.terminal.listSessions = () => ++calls === 1 ? pending : Promise.resolve([]);
  const seen: TerminalServerSession[][] = [];
  cleanups.push(observeTerminalSessions(source.terminal, '/repo', () => new Map([['/repo\0build', 3]]), result => seen.push(result.sessions)));
  await tick();
  browser.dispatchEvent(new browser.CustomEvent('openchamber:runtime-endpoint-changed', { detail: {} }));
  resolvePending([running]);
  await tick();
  expect(seen).toEqual([[]]);
  expect(calls).toBe(2);
});
