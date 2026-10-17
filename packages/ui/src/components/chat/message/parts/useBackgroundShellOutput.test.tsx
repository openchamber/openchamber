import { afterEach, beforeEach, expect, jest, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { opencodeClient } from '@/lib/opencode/client';
import { useBackgroundShellOutput } from './useBackgroundShellOutput';

let root: Root | null = null;
let shown = '';
const originals = new Map<string, PropertyDescriptor | undefined>();

const Host: React.FC = () => {
  shown = useBackgroundShellOutput('shell_1', '/repo', true);
  return null;
};

const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

/** Advances fake time and lets the read that falls due settle. */
const advance = async (milliseconds: number) => {
  await act(async () => {
    jest.advanceTimersByTime(milliseconds);
  });
  await flush();
};

beforeEach(() => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = { window: dom, document: dom.document, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  jest.useFakeTimers();
  shown = '';
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  jest.useRealTimers();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

test('reads a quiet command less and less often, up to every 4 s, and every second again once output arrives', async () => {
  const pages = ['ready\n', '', '', '', '', '', 'request\n', ''];
  const readAt: number[] = [];
  let cursor = 0;
  const read = spyOn(opencodeClient, 'readShellOutput').mockImplementation(async () => {
    readAt.push(Date.now());
    const output = pages.shift() ?? '';
    cursor += output.length;
    return { output, cursor, skipped: false };
  });

  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root?.render(<Host />));
  await flush();

  for (let step = 0; step < 30; step += 1) await advance(1_000);

  const gaps = readAt.slice(1).map((at, index) => at - readAt[index]);
  expect(gaps.slice(0, 7)).toEqual([1_000, 2_000, 4_000, 4_000, 4_000, 4_000, 1_000]);
  expect(shown).toBe('ready\nrequest\n');
  read.mockRestore();
});
