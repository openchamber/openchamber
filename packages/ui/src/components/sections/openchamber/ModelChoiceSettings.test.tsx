import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

import { GoalWriterChoiceSuggestion, ModelChoiceSettings } from './ModelChoiceSettings';

type Call = { method: string; url: string; body: unknown };

const suggestion = { id: 'goal-writer:p/m:low', surface: 'goal-writer', model: 'p/m', variant: 'low', count: 6, total: 7 };
// What `GET /api/openchamber/model-choices` answers, as far as Settings reads it.
type SummaryBody = { enabled: boolean; total: number; suggestions: Array<typeof suggestion> };

describe('model choice settings', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let calls: Call[];
  let summary: SummaryBody;
  let globalDescriptors: Map<string, PropertyDescriptor | undefined>;
  const originalFetch = globalThis.fetch;
  const globalNames = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'localStorage', 'sessionStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'IS_REACT_ACT_ENVIRONMENT'];

  const render = (element: React.ReactElement) => act(async () => {
    root.render(<I18nProvider>{element}</I18nProvider>);
  });
  // Reads and writes are promises the component awaits; let them settle.
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const button = (label: string): HTMLButtonElement => {
    const match = Array.from(host.querySelectorAll('button')).find((element) => element.textContent?.trim() === label);
    if (!match) throw new Error(`No button "${label}" in: ${host.textContent}`);
    return match;
  };

  beforeEach(() => {
    windowInstance = new Window({ url: 'http://localhost' });
    globalDescriptors = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      localStorage: windowInstance.localStorage,
      sessionStorage: windowInstance.sessionStorage,
      // happy-dom 21 no longer leaks a global requestAnimationFrame into
      // the test realm, and Base UI's animation-completion hook calls the
      // bare global. Run frames synchronously, as in TerminalViewport.
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
      cancelAnimationFrame: () => undefined,
      MutationObserver: windowInstance.MutationObserver,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    calls = [];
    summary = { enabled: true, total: 3, suggestions: [] };
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === 'DELETE') return new Response(null, { status: 204 });
      if (url.includes('/decision')) {
        const approved = String(init?.body).includes('"decision":"approved"');
        return Response.json({ settings: approved ? { sessionGoalWriterModel: 'p/m', sessionGoalWriterVariant: 'low' } : null });
      }
      return Response.json(summary);
    }, { preconnect: async () => {} });
    useUIStore.setState({ modelChoiceRecordingEnabled: true });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      globalThis.fetch = originalFetch;
      useUIStore.setState({ modelChoiceRecordingEnabled: true });
      windowInstance.close();
      for (const [name, descriptor] of globalDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  test('the switch turns recording off and back on', async () => {
    await render(<ModelChoiceSettings />);
    await settle();
    const row = host.querySelector<HTMLElement>('[role="button"][data-settings-item="chat.model-choice-recording"]');
    if (!row) throw new Error(`No recording switch in: ${host.innerHTML}`);
    await act(async () => row.click());
    expect(useUIStore.getState().modelChoiceRecordingEnabled).toBe(false);
    await act(async () => row.click());
    expect(useUIStore.getState().modelChoiceRecordingEnabled).toBe(true);
  });

  test('shows how many choices are kept, and Clear history empties them', async () => {
    await render(<ModelChoiceSettings />);
    await settle();
    expect(host.textContent).toContain('Choices kept: 3.');

    await act(async () => button('Clear history').click());
    await settle();

    const deletes = calls.filter((call) => call.method === 'DELETE').map((call) => call.url);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toContain('/api/openchamber/model-choices');
    expect(host.textContent).toContain('Choices kept: 0.');
    expect(button('Clear history').disabled).toBe(true);
  });

  test('a history that cannot be read says so, never an empty count', async () => {
    globalThis.fetch = Object.assign(async () => new Response('{}', { status: 500 }), { preconnect: async () => {} });
    await render(<ModelChoiceSettings />);
    await settle();
    expect(host.textContent).toContain('Could not read the history');
    expect(host.textContent).not.toContain('Choices kept');
  });

  for (const decision of ['approved', 'declined'] as const) {
    test(`${decision === 'approved' ? 'Approve' : 'Decline'} answers the suggestion and hides it`, async () => {
      summary = { ...summary, suggestions: [suggestion] };
      const applied: unknown[] = [];
      await render(<GoalWriterChoiceSuggestion onApproved={(settings) => applied.push(settings)} />);
      await settle();
      expect(host.textContent).toContain('You picked m at Low effort for 6 of your last 7 goal specs.');

      await act(async () => button(decision === 'approved' ? 'Approve' : 'Decline').click());
      await settle();

      expect(calls.filter((call) => call.url.includes('/decision')).map((call) => call.body)).toEqual([{ id: suggestion.id, decision }]);
      expect(applied).toEqual(decision === 'approved' ? [{ sessionGoalWriterModel: 'p/m', sessionGoalWriterVariant: 'low' }] : []);
      expect(host.textContent).toBe('');
    });
  }

  test('no suggestion is asked for or shown while recording is off', async () => {
    summary = { ...summary, suggestions: [suggestion] };
    useUIStore.setState({ modelChoiceRecordingEnabled: false });
    await render(<GoalWriterChoiceSuggestion onApproved={() => undefined} />);
    await settle();
    expect(calls).toEqual([]);
    expect(host.textContent).toBe('');
  });
});
