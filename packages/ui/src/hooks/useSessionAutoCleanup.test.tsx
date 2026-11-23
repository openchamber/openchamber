import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { useSessionUIStore } from '@/sync/session-ui-store';
import * as retention from '@/sync/session-retention';
import { useSessionAutoCleanup } from './useSessionAutoCleanup';

const day = 86_400_000;
let now = 1_800_000_000_000;
let dom: ReturnType<typeof installHookTestDom>;
let root: Root;
let run: ReturnType<typeof spyOn<typeof retention, 'runSessionRetentionCleanup'>>;
const Cleanup = () => { useSessionAutoCleanup(); return null; };
const setVisibility = (value: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
};
const fire = async (type: string) => { await act(async () => { window.dispatchEvent(new Event(type)); }); };
const mount = async () => { await act(async () => root.render(<Cleanup />)); };

beforeEach(() => {
  dom = installHookTestDom();
  root = createRoot(dom.container);
  spyOn(Date, 'now').mockImplementation(() => now);
  getSafeStorage().removeItem('openchamber.sessionRetention.clock');
  run = spyOn(retention, 'runSessionRetentionCleanup').mockImplementation(async () => {
    useUIStore.setState({ autoDeleteLastRunAt: Date.now() });
    return { completedIds: [], failedIds: [], action: 'delete' };
  });
  useGlobalSessionsStore.setState({ status: 'ready', hasLoaded: true });
  useSessionUIStore.setState({ isLoading: false });
  useUIStore.setState({ autoDeleteEnabled: true, autoDeleteAfterDays: 3, autoDeleteLastRunAt: now - 2 * day });
  setVisibility('visible');
});

afterEach(async () => {
  await act(async () => root.unmount());
  mock.restore();
  Reflect.deleteProperty(document, 'visibilityState');
  dom.restore();
});

test('runs at launch, then waits for someone to use an app left open', async () => {
  await mount();
  expect(run).toHaveBeenCalledTimes(1);

  now += 2 * day;
  await act(async () => useUIStore.setState({ autoDeleteAfterDays: 4 }));
  expect(run).toHaveBeenCalledTimes(1);

  await fire('keydown');
  expect(run).toHaveBeenCalledTimes(2);
});

test('a window opened in the background runs only once it is shown', async () => {
  setVisibility('hidden');
  await mount();
  await fire('focus');
  expect(run).toHaveBeenCalledTimes(0);

  setVisibility('visible');
  await fire('visibilitychange');
  expect(run).toHaveBeenCalledTimes(1);
});

test('turning cleanup on long after launch runs it right away', async () => {
  useUIStore.setState({ autoDeleteEnabled: false });
  await mount();
  now += day;
  await fire('pointerdown');
  await act(async () => useUIStore.setState({ autoDeleteEnabled: true }));
  expect(run).toHaveBeenCalledTimes(1);
});
