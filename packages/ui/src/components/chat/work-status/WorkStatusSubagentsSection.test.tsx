import React, { act } from 'react';
import { test, expect } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { SyncProvider } from '@/sync/sync-context';
import { I18nProvider } from '@/lib/i18n';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { WorkStatusSubagentsSection } from './WorkStatusSubagentsSection';

test('renders cross-directory permission and question blockers without a child directory store', async () => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, localStorage: window.localStorage, requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window), IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const container = document.createElement('div');
  const root = createRoot(container);
  const previousSessions = useGlobalSessionsStore.getState();
  const previousRequests = useGlobalBlockingRequestsStore.getState();
  const child = (id: string) => ({
    id, parentID: 'parent', projectID: 'project', directory: '/other', title: id,
    cost: 0, time: { created: 1, updated: 1 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  try {
    useGlobalSessionsStore.setState({ activeSessions: [child('permission-child'), child('question-child')] });
    useGlobalBlockingRequestsStore.setState({ bySession: new Map([
      ['permission-child', { directory: '/other', permissions: [{ id: 'permission', sessionID: 'permission-child', action: 'read', resources: ['file'] }], forms: [] }],
      ['question-child', { directory: '/other', permissions: [], forms: [{ id: 'question', sessionID: 'question-child', title: 'Choose' }] }],
    ]) });
    const sdk = OpenCode.make({ baseUrl: 'http://unused.test', fetch: () => new Promise<Response>(() => undefined) });
    await act(async () => root.render(<SyncProvider sdk={sdk} directory="/parent"><I18nProvider><WorkStatusSubagentsSection sessionId="parent" directory="/parent" /></I18nProvider></SyncProvider>));
    const html = container.textContent;
    expect(html).toContain('permission-child');
    expect(html).toContain('question-child');
    expect(html).toContain('needs permission');
    expect(html).toContain('asked a question');
  } finally {
    await act(async () => root.unmount());
    useGlobalSessionsStore.setState(previousSessions);
    useGlobalBlockingRequestsStore.setState(previousRequests);
    await window.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
