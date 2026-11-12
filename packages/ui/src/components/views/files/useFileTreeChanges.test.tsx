import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { notifyFileTreeChanged } from '@/lib/fileTreeChanges';
import { useFileTreeChanges, type FileTreeChangeBatch } from './useFileTreeChanges';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  Event: browser.Event, IS_REACT_ACT_ENVIRONMENT: true,
});

let documentHidden = false;
Object.defineProperty(browser.document, 'hidden', { configurable: true, get: () => documentHidden });

// The batch window is two seconds; fake timers keep the suite fast.
const wait = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
};
const BATCH_WAIT_MS = 2000;

type Props = { root: string; active: boolean; whileInactive: 'drop' | 'hold' };
let reactRoot: Root | null = null;
let batches: FileTreeChangeBatch[] = [];

const Probe: React.FC<Props> = (props) => {
  useFileTreeChanges({ ...props, onChanges: (batch) => batches.push(batch) });
  return null;
};

const render = async (props: Props) => {
  if (!reactRoot) reactRoot = createRoot(document.createElement('div'));
  await act(async () => reactRoot?.render(<Probe {...props} />));
};

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(async () => {
  await act(async () => reactRoot?.unmount());
  jest.useRealTimers();
  reactRoot = null;
  batches = [];
  documentHidden = false;
});

describe('useFileTreeChanges', () => {
  test('a burst of changes becomes one batch of the folders under the root', async () => {
    await render({ root: '/repo', active: true, whileInactive: 'drop' });
    notifyFileTreeChanged({ directory: '/repo', paths: ['/repo/src/a.ts'] });
    notifyFileTreeChanged({ directory: '/repo', paths: ['/repo/src/b.ts', '/repo/top.ts'] });
    notifyFileTreeChanged({ directory: '/elsewhere', paths: ['/elsewhere/x.ts'] });
    await wait(BATCH_WAIT_MS - 1);
    expect(batches).toEqual([]);
    await wait(1);
    expect(batches).toEqual([{ directories: ['/repo/src', '/repo'] }]);
  });

  test('a steady stream of changes is delivered at most once per window', async () => {
    await render({ root: '/repo', active: true, whileInactive: 'drop' });
    notifyFileTreeChanged({ directory: '/repo', paths: ['/repo/a.ts'] });
    await wait(1500);
    notifyFileTreeChanged({ directory: '/repo', paths: ['/repo/src/b.ts'] });
    await wait(500);
    expect(batches).toEqual([{ directories: ['/repo', '/repo/src'] }]);
    notifyFileTreeChanged({ directory: '/repo', paths: ['/repo/c.ts'] });
    await wait(1999);
    expect(batches).toHaveLength(1);
    await wait(1);
    expect(batches).toHaveLength(2);
  });

  test('an unknown change widens the batch to the whole tree', async () => {
    await render({ root: '/repo', active: true, whileInactive: 'drop' });
    notifyFileTreeChanged({ directory: '/repo', paths: ['/repo/src/a.ts'] });
    notifyFileTreeChanged({ directory: '/repo' });
    notifyFileTreeChanged({ directory: '/repo', paths: ['/repo/lib/b.ts'] });
    await wait(BATCH_WAIT_MS);
    expect(batches).toEqual([{ directories: null }]);
  });

  test('changes elsewhere never produce a batch', async () => {
    await render({ root: '/repo', active: true, whileInactive: 'drop' });
    notifyFileTreeChanged({ directory: '/other' });
    notifyFileTreeChanged({ directory: '/repo', paths: ['/other/a.ts'] });
    await wait(BATCH_WAIT_MS);
    expect(batches).toEqual([]);
  });

  test('a hidden window holds the batch until it is visible again', async () => {
    await render({ root: '/repo', active: true, whileInactive: 'drop' });
    documentHidden = true;
    notifyFileTreeChanged({ directory: '/repo', paths: ['/repo/a.ts'] });
    await wait(BATCH_WAIT_MS);
    expect(batches).toEqual([]);
    documentHidden = false;
    browser.document.dispatchEvent(new browser.Event('visibilitychange'));
    await wait(BATCH_WAIT_MS);
    expect(batches).toEqual([{ directories: ['/repo'] }]);
  });

  test('an inactive surface drops changes or holds them until it is shown', async () => {
    await render({ root: '/repo', active: false, whileInactive: 'drop' });
    notifyFileTreeChanged({ directory: '/repo', paths: ['/repo/a.ts'] });
    await render({ root: '/repo', active: true, whileInactive: 'drop' });
    await wait(BATCH_WAIT_MS);
    expect(batches).toEqual([]);

    await render({ root: '/repo', active: false, whileInactive: 'hold' });
    notifyFileTreeChanged({ directory: '/repo', paths: ['/repo/a.ts'] });
    await wait(BATCH_WAIT_MS);
    expect(batches).toEqual([]);
    await render({ root: '/repo', active: true, whileInactive: 'hold' });
    await wait(BATCH_WAIT_MS);
    expect(batches).toEqual([{ directories: ['/repo'] }]);
  });
});
