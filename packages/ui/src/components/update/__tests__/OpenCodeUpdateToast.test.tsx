import { afterEach, beforeEach, expect, jest, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let I18nProvider: typeof import('@/lib/i18n').I18nProvider;
let OpenCodeUpdateToast: typeof import('../OpenCodeUpdateToast').OpenCodeUpdateToast;
let toast: typeof import('@/components/ui/toast').toast;
let useUIStore: typeof import('@/stores/useUIStore').useUIStore;

type StatusBody = { available: boolean | null; currentVersion?: string | null; latestVersion?: string | null; error?: string };

const unknownLatest: StatusBody = { available: null, currentVersion: '2.2.6', latestVersion: null };
const upToDate: StatusBody = { available: false, currentVersion: '2.2.6', latestVersion: '2.2.6' };
const newer: StatusBody = { available: true, currentVersion: '2.2.6', latestVersion: '2.3.0' };
// Settled answers of the VS Code bridge (packages/vscode/src/opencode-upgrade-runtime.ts).
const vscodeNoManager: StatusBody = { available: false, currentVersion: null, latestVersion: null };
const vscodeRegistryError: StatusBody = { available: null, error: 'registry unreachable' };

let dom: Window;
let root: Root;
let restoreGlobals: () => void;
let statuses: StatusBody[];
let reads: number;
let announced: unknown[];
let notifications: boolean;
const spies: Array<{ mockRestore: () => void }> = [];

beforeEach(async () => {
  dom = new Window({ url: 'http://localhost' });
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator,
    Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
    Event: dom.Event, CustomEvent: dom.CustomEvent,
    localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  restoreGlobals = () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
  statuses = [];
  reads = 0;
  spies.push(spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (!String(input instanceof Request ? input.url : input).endsWith('/api/opencode/upgrade-status')) {
      return new Promise<Response>(() => {});
    }
    reads += 1;
    const next = statuses.shift();
    if (!next) throw new Error('unexpected upgrade-status read');
    return Response.json({ ...next, upgrade: { supported: true } });
  }));
  ({ I18nProvider } = await import('@/lib/i18n'));
  ({ OpenCodeUpdateToast } = await import('../OpenCodeUpdateToast'));
  ({ toast } = await import('@/components/ui/toast'));
  ({ useUIStore } = await import('@/stores/useUIStore'));

  announced = [];
  notifications = useUIStore.getState().showOpenCodeUpdateNotifications;
  useUIStore.setState({ showOpenCodeUpdateNotifications: true });
  spies.push(spyOn(toast, 'info').mockImplementation((title) => {
    announced.push(title);
    return 'opencode-update-available';
  }));
  jest.useFakeTimers();
  root = createRoot(document.createElement('div'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  jest.useRealTimers();
  for (const spy of spies.splice(0)) spy.mockRestore();
  useUIStore.setState({ showOpenCodeUpdateNotifications: notifications });
  await dom.happyDOM.close();
  restoreGlobals();
});

const render = async () => {
  await act(async () => root.render(<I18nProvider><OpenCodeUpdateToast /></I18nProvider>));
};

const advance = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  });
};

test('retries the update check when the registry lookup failed and announces the newer version it finds', async () => {
  statuses.push(unknownLatest, newer);
  await render();

  await advance(5_000);
  expect(reads).toBe(1);
  expect(announced).toEqual([]);

  await advance(10_000);
  expect(reads).toBe(2);
  expect(announced).toHaveLength(1);

  await advance(120_000);
  expect(reads).toBe(2);
});

const settledChecks: Array<[string, StatusBody]> = [
  ['finds no update', upToDate],
  ['reaches a VS Code bridge without a managed OpenCode', vscodeNoManager],
  ['gets the VS Code bridge registry error', vscodeRegistryError],
];

for (const [name, status] of settledChecks) test(`schedules no retry after a successful check that ${name}`, async () => {
  statuses.push(status);
  await render();

  await advance(5_000);
  expect(reads).toBe(1);
  expect(announced).toEqual([]);

  await advance(120_000);
  expect(reads).toBe(1);
});
