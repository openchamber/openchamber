import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { TerminalAPI, TerminalServerSession } from './api/types';
import { observeTerminalSessions } from './terminalSessionObserver';
import { useTerminalStore } from '@/stores/useTerminalStore';

let browser: Window;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
const cleanups: Array<() => void> = [];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  browser = new Window({ url: 'http://localhost' });
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator })) {
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

test('visible consumers share one loop and discover a later peer run without interaction', async () => {
  const source = createTerminal();
  const first: TerminalServerSession[][] = [];
  const second: TerminalServerSession[][] = [];
  cleanups.push(observeTerminalSessions(source.terminal, '/repo', () => new Map(), result => first.push(result.sessions)));
  cleanups.push(observeTerminalSessions(source.terminal, '/repo', () => new Map(), result => second.push(result.sessions)));
  await tick();
  expect(source.reads).toEqual(['']);
  source.setRecords([running]);
  await new Promise(resolve => setTimeout(resolve, 5100));
  expect(source.reads).toEqual(['', '']);
  expect(first.at(-1)).toEqual([running]);
  expect(second.at(-1)).toEqual([running]);
}, 10000);

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
