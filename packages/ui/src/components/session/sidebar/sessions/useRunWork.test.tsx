import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import type { MultiRunSummary } from '@/lib/multirun/runs';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useRunWork } from './useRunWork';

const run: MultiRunSummary = {
  key: 'run-a', title: 'Try three models', groupSlug: 'try-three-models',
  lanes: [], fusions: [], memberIds: ['ses_lane_1', 'ses_lane_2'],
  providerIDs: [], variants: [], createdAt: 1, lastActivity: 1,
};

test('a run row keeps the selection for its own overview and gives it up to any other page', async () => {
  const win = new Window({ url: 'http://localhost' });
  for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const initialUI = useUIStore.getState();
  const initialSessionUI = useSessionUIStore.getState();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const Row = () => <span data-active={String(useRunWork(run, [], () => {}).isActive)} />;
  const active = () => container.querySelector('span')?.getAttribute('data-active');
  try {
    useSessionUIStore.setState({ currentSessionId: 'ses_lane_1' });
    await act(async () => root.render(<I18nProvider><Row /></I18nProvider>));
    expect(active()).toBe('true');

    await act(async () => useUIStore.getState().setRunOverviewKey('run-a'));
    expect(active()).toBe('true');

    await act(async () => useUIStore.getState().setRunOverviewKey('run-b'));
    expect(active()).toBe('false');

    await act(async () => useUIStore.getState().setArchivePageOpen(true));
    expect(active()).toBe('false');

    await act(async () => useUIStore.getState().closeMainSurfaces());
    expect(active()).toBe('true');
  } finally {
    await act(async () => root.unmount());
    useUIStore.setState(initialUI, true);
    useSessionUIStore.setState(initialSessionUI, true);
    await win.happyDOM.close();
  }
});
