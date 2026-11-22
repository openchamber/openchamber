import React, { act } from 'react';
import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Metadata, Session } from '@/lib/opencode/model';

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

const session = (id: string, title: string, time: Partial<Session['time']> = {}, metadata?: Metadata): Session => ({
  id, directory: '/repo', projectID: 'project', title, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: NOW - HOUR, updated: NOW - HOUR, ...time },
  metadata,
});

const inWork = (extra: Record<string, Metadata[string]> = {}): Metadata => ({ openchamber: { work: { state: 'open', openedAt: 1 }, ...extra } });

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

test('the page sums up, lists what waits first, and asks before marking everything done', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent,
    MutationObserver: dom.MutationObserver, KeyboardEvent: dom.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  };
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json({}), originalFetch);

  const { createRoot } = await import('react-dom/client');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { I18nProvider } = await import('@/lib/i18n');
  const { TooltipProvider } = await import('@/components/ui/tooltip');
  const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
  const { useGlobalBlockingRequestsStore } = await import('@/sync/global-blocking-requests');
  const { OverviewPage } = await import('./OverviewView');

  const hint = inWork({ work: { state: 'open', openedAt: 1, suggestDoneAt: NOW } });
  useGlobalSessionsStore.getState().applySnapshot([
    session('asking', 'Fix relay reconnect'),
    session('finished', 'Usage stats', { idle: NOW - HOUR, viewed: 0 }, inWork()),
    session('done-a', 'Release notes', { idle: NOW - 2 * HOUR, viewed: NOW - 2 * HOUR }, hint),
    session('done-b', 'Tray icon states', { idle: NOW - 2 * HOUR, viewed: NOW - 2 * HOUR }, hint),
    session('quiet', 'Not in work', { idle: NOW - HOUR, viewed: 0 }),
  ], [], 'ready');
  useGlobalBlockingRequestsStore.setState({
    bySession: new Map([['asking', { directory: '/repo', permissions: [], forms: [{ id: 'f', sessionID: 'asking', title: 'Which branch?' }], pages: [] }]]),
  });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanup = () => {
    act(() => root.unmount());
    globalThis.fetch = originalFetch;
    useGlobalBlockingRequestsStore.setState({ bySession: new Map() });
  };

  await act(async () => root.render(
    <RuntimeAPIContext.Provider value={createWebAPIs()}>
      <I18nProvider>
        <TooltipProvider>
          <OverviewPage layout="page" onLeave={() => undefined} />
        </TooltipProvider>
      </I18nProvider>
    </RuntimeAPIContext.Provider>,
  ));

  const text = container.textContent ?? '';
  expect(text).toContain('2 need you');
  expect(text).toContain('2 look done');
  // The question a session waits on is named under its title.
  expect(text).toContain('Which branch?');
  expect([...container.querySelectorAll('button')].filter((button) => button.textContent === 'Answer').length).toBe(1);
  expect(text.indexOf('Fix relay reconnect')).toBeLessThan(text.indexOf('Usage stats'));
  expect(text).toContain('asks a question');
  // An unread end wears the sidebar's unread mark instead of a word.
  expect(container.querySelectorAll('[data-session-activity-indicator="unread"]').length).toBe(1);
  expect(text).not.toContain('Not in work');

  const markAll = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Mark all done');
  expect(markAll).toBeDefined();
  await act(async () => markAll!.click());
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain('Mark 2 sessions done?');
  expect(dialog?.textContent).toContain('Release notes');
  expect(dialog?.textContent).toContain('Tray icon states');
});
