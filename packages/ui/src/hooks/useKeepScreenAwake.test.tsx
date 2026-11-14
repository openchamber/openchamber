import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useUIStore } from '@/stores/useUIStore';
import { replaceGlobalSessionStatusById, setSessionParentResolver } from '@/sync/global-session-status';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useKeepScreenAwake } from './useKeepScreenAwake';

type FakeSentinel = { released: boolean; release: () => Promise<void> };

let dom: Window;
let root: Root | null = null;
let visibility: DocumentVisibilityState = 'visible';
let sentinels: FakeSentinel[] = [];

const Probe: React.FC<{ connected: boolean }> = ({ connected }) => {
  useKeepScreenAwake(connected);
  return null;
};

const render = (connected: boolean) => act(async () => root?.render(<Probe connected={connected} />));

const held = () => sentinels.filter((sentinel) => !sentinel.released).length;
const settle = () => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
const setMode = (mode: 'off' | 'working' | 'always') => act(async () => { useUIStore.setState({ mobileKeepScreenAwake: mode }); });
const running = (...sessionIds: string[]) => act(async () => {
  replaceGlobalSessionStatusById(new Map(sessionIds.map((id) => [id, { status: { type: 'busy' }, directory: '/project' }])));
});
const changeVisibility = (next: DocumentVisibilityState) => {
  visibility = next;
  dom.document.dispatchEvent(new dom.Event('visibilitychange'));
};

beforeEach(async () => {
  dom = new Window({ url: 'https://localhost' });
  visibility = 'visible';
  sentinels = [];
  Object.defineProperty(dom.document, 'visibilityState', { configurable: true, get: () => visibility });
  // The native app's WebView: Capacitor present and the Screen Wake Lock API exposed.
  Object.assign(dom, { Capacitor: { isNativePlatform: () => true } });
  Object.defineProperty(dom.navigator, 'wakeLock', {
    configurable: true,
    value: {
      request: async () => {
        const sentinel: FakeSentinel = { released: false, release: async () => { sentinel.released = true; } };
        sentinels.push(sentinel);
        return sentinel;
      },
    },
  });
  for (const [name, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  useUIStore.setState({ mobileKeepScreenAwake: 'off' });
  useSessionUIStore.setState({ currentSessionId: 'ses_open' });
  setSessionParentResolver((id) => (id === 'ses_child' ? 'ses_open' : undefined));
  replaceGlobalSessionStatusById(new Map());
  root = createRoot(document.createElement('div'));
  await render(true);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  setSessionParentResolver(() => undefined);
  for (const name of ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']) Reflect.deleteProperty(globalThis, name);
});

test('Off holds nothing, Always holds the screen until it is turned off', async () => {
  await running('ses_open');
  await settle();
  expect(sentinels).toHaveLength(0);

  await setMode('always');
  await settle();
  expect(held()).toBe(1);

  await setMode('off');
  await settle();
  expect(held()).toBe(0);
});

test('While working follows the open session and the subagents below it', async () => {
  await setMode('working');
  await running('ses_other');
  await settle();
  expect(held()).toBe(0);

  await running('ses_open');
  await settle();
  expect(held()).toBe(1);

  await running('ses_child');
  await settle();
  expect(held()).toBe(1);
  expect(sentinels).toHaveLength(1);

  await running();
  await settle();
  expect(held()).toBe(0);
});

test('a run on a server that stopped answering does not hold the screen', async () => {
  await setMode('working');
  await running('ses_open');
  await settle();
  expect(held()).toBe(1);

  await render(false);
  await settle();
  expect(held()).toBe(0);

  await render(true);
  await settle();
  expect(held()).toBe(1);
});

test('the lock the system dropped in the background is asked for again on return', async () => {
  await setMode('always');
  await settle();
  expect(held()).toBe(1);

  await sentinels[0]?.release();
  changeVisibility('hidden');
  await settle();
  expect(held()).toBe(0);

  changeVisibility('visible');
  await settle();
  expect(held()).toBe(1);
  expect(sentinels).toHaveLength(2);
});
