import React, { act } from 'react';
import { beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { LinearAPI } from '@/lib/api/types';

// A DOM only for the render, restored afterwards so other files see none.
const withDom = async (run: () => Promise<void>) => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  try {
    await run();
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

const createLinear = (connected: boolean) => {
  const issueSummaries: string[][] = [];
  const calls = { authStatus: 0, issueSummaries };
  const unreachable = () => Promise.reject(new Error('not used in this test'));
  const linear: LinearAPI = {
    authStatus: async () => { calls.authStatus += 1; return { connected }; },
    authStart: unreachable,
    authDisconnect: unreachable,
    authActivate: unreachable,
    issuesList: unreachable,
    issueGet: unreachable,
    issueStates: unreachable,
    issueSummaries: async (identifiers) => {
      calls.issueSummaries.push(identifiers);
      return { connected: true, issues: [] };
    },
    issueUpdate: unreachable,
    mappingGet: unreachable,
    mappingSet: unreachable,
    sessionStatusPost: unreachable,
    preferencesGet: unreachable,
    preferencesSet: unreachable,
  };
  return { linear, calls };
};

const render = (identifiers: string[], linear: LinearAPI | undefined) => withDom(async () => {
  const { createRoot } = await import('react-dom/client');
  const { useLinearIssueStateSync } = await import('./useLinearIssueStateSync');
  function Harness() {
    useLinearIssueStateSync(identifiers, linear);
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => { root.render(<Harness />); });
  // Let the auth check and the request it unlocks settle.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { root.unmount(); });
});

beforeEach(async () => {
  const { useLinearAuthStore } = await import('@/stores/useLinearAuthStore');
  const { useLinearIssueStateStore } = await import('@/stores/useLinearIssueStateStore');
  useLinearAuthStore.getState().resetForRuntimeSwitch();
  useLinearIssueStateStore.getState().resetForRuntimeSwitch();
});

test('with no linked Linear issue on screen, nothing is asked, not even whether Linear is connected', async () => {
  const { linear, calls } = createLinear(true);
  await render([], linear);
  expect(calls).toEqual({ authStatus: 0, issueSummaries: [] });
});

test('a disconnected Linear is checked once and asked nothing more', async () => {
  const { linear, calls } = createLinear(false);
  await render(['ENG-1'], linear);
  expect(calls).toEqual({ authStatus: 1, issueSummaries: [] });
});

test('a connected Linear is asked about the issues on screen', async () => {
  const { linear, calls } = createLinear(true);
  await render(['ENG-1', 'ENG-2'], linear);
  expect(calls).toEqual({ authStatus: 1, issueSummaries: [['ENG-1', 'ENG-2']] });
});
