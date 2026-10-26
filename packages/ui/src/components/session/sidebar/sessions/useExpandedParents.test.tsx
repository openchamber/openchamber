import { describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { SESSION_EXPANDED_STORAGE_KEY, useExpandedParents } from './useExpandedParents';
import { installHookTestDom } from '../test-utils/testDom';

const createStorage = (initial: string | null = null, failWrites = false): Storage => {
  const values = new Map<string, string>();
  if (initial !== null) values.set(SESSION_EXPANDED_STORAGE_KEY, initial);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (failWrites) throw new Error('write failed');
      values.set(key, value);
    },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
};

type ExpandedParentsCapture = { value?: ReturnType<typeof useExpandedParents> };

const mountHook = async (storage: Storage) => {
  const dom = installHookTestDom(storage);
  const root = createRoot(dom.container);
  const capture: ExpandedParentsCapture = {};
  const Harness = () => {
    capture.value = useExpandedParents();
    return null;
  };
  await act(async () => root.render(React.createElement(Harness)));
  return { capture, root, dom };
};

describe('parent expansion persistence', () => {
  test('hydrates the complete v3 set and preserves unknown/context-isolated entries when toggling', async () => {
    const initial = [
      'project:active:parent-a',
      'project:archived:parent-b',
      'recent:active:parent-a',
      'unknown:future:value',
    ];
    const storage = createStorage(JSON.stringify(initial));
    const mounted = await mountHook(storage);
    try {
      expect([...mounted.capture.value!.expandedParents]).toEqual(initial);
      await act(async () => mounted.capture.value!.toggleParent('project:active:parent-a'));
      expect(JSON.parse(storage.getItem(SESSION_EXPANDED_STORAGE_KEY) ?? 'null')).toEqual(initial.slice(1));
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.dom.restore();
    }
  });

  test('does not write missing or malformed storage during initialization', async () => {
    for (const initial of [null, '{malformed', JSON.stringify(['valid', 2])]) {
      const storage = createStorage(initial);
      const mounted = await mountHook(storage);
      try {
        expect(mounted.capture.value!.expandedParents.size).toBe(0);
        expect(storage.getItem(SESSION_EXPANDED_STORAGE_KEY)).toBe(initial);
      } finally {
        await act(async () => mounted.root.unmount());
        mounted.dom.restore();
      }
    }
  });

  test('leaves durable data unchanged on write failure and rereads it on remount', async () => {
    const raw = JSON.stringify(['recent:active:parent-a']);
    const storage = createStorage(raw, true);
    const first = await mountHook(storage);
    await act(async () => first.capture.value!.toggleParent('project:active:parent-b'));
    expect(first.capture.value!.expandedParents).toEqual(new Set([
      'recent:active:parent-a',
      'project:active:parent-b',
    ]));
    expect(storage.getItem(SESSION_EXPANDED_STORAGE_KEY)).toBe(raw);
    await act(async () => first.root.unmount());
    first.dom.restore();

    const second = await mountHook(storage);
    try {
      expect(second.capture.value!.expandedParents).toEqual(new Set(['recent:active:parent-a']));
    } finally {
      await act(async () => second.root.unmount());
      second.dom.restore();
    }
  });
});
