import { afterEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

import type { RuntimeAPIs } from '@/lib/api/types';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useSessionTodosStore } from '@/stores/useSessionTodosStore';
import { useLoadSessionTodos } from './useLoadSessionTodos';

const unavailable = (): never => { throw new Error('not used'); };
const runtimeApis = (isVSCode: boolean): RuntimeAPIs => ({
  runtime: { platform: isVSCode ? 'vscode' : 'web', isDesktop: false, isVSCode },
  get terminal() { return unavailable(); }, get git() { return unavailable(); },
  get files() { return unavailable(); }, get settings() { return unavailable(); },
  get permissions() { return unavailable(); }, get notifications() { return unavailable(); },
  get sourceControl() { return unavailable(); },
});

const Probe: React.FC = () => {
  useLoadSessionTodos('ses_1', '/repo');
  return null;
};

const mount = async () => {
  const dom = new Window({ url: 'http://todos.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Probe />));
  return async () => {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
};

afterEach(() => {
  registerRuntimeAPIs(null);
  useSessionTodosStore.getState().reset();
});

test('VS Code, which has no session-todos route, never reads the list', async () => {
  registerRuntimeAPIs(runtimeApis(true));
  const load = spyOn(useSessionTodosStore.getState(), 'load').mockImplementation(async () => {});
  const unmount = await mount();
  try {
    expect(load).not.toHaveBeenCalled();
  } finally {
    await unmount();
    load.mockRestore();
  }
});

test('other runtimes read the shown session once', async () => {
  registerRuntimeAPIs(runtimeApis(false));
  const load = spyOn(useSessionTodosStore.getState(), 'load').mockImplementation(async () => {});
  const unmount = await mount();
  try {
    expect(load.mock.calls.map(([sessionId, directory]) => [sessionId, directory])).toEqual([['ses_1', '/repo']]);
  } finally {
    await unmount();
    load.mockRestore();
  }
});
