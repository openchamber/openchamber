import { act } from 'react';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { DEFAULT_PR_FIX_LOOP_CONFIG, type FixLoop } from '@/lib/prFixLoop';

const loop: FixLoop = {
  id: 'loop-progress', sessionId: 'ses_host', directory: '/repo', owner: 'owner', repo: 'repo', number: 12,
  url: 'https://github.com/owner/repo/pull/12', title: 'Fix review', branch: 'fix', status: 'watching',
  statusReason: null, config: { ...DEFAULT_PR_FIX_LOOP_CONFIG, pushMode: 'approval' }, iterations: 1, tokensUsed: 0,
  ci: null, unresolvedThreads: null, changesRequested: null, worker: null, pendingApproval: null, review: null,
  lastCheckedAt: null, lastError: null, createdAt: 1, updatedAt: 1,
};
const review: NonNullable<FixLoop['review']> = {
  state: 'pending', actions: [{ kind: 'thread', id: 'PRRT_thread', body: 'Reply', resolve: true }],
  completed: 1, total: 2, lastError: null,
};
const dom = new Window({ url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;

beforeAll(() => {
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
    ResizeObserver: dom.ResizeObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    localStorage: dom.localStorage, sessionStorage: dom.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
    // Directory bootstrap is unrelated to the loop row's seeded state.
    if (path === '/api/fs/home') return new Promise<Response>(() => {});
    return Response.json({}, { status: 503 });
  }, originalFetch);
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  await dom.happyDOM.close();
});

async function mount(value: FixLoop) {
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { prFixLoopStore } = await import('@/stores/usePrFixLoopStore');
  const { PrFixLoopRow } = await import('./PrFixLoopRow');
  prFixLoopStore.setState({ loops: [value], loadState: 'ready', failedLoopIds: [] });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<I18nProvider><PrFixLoopRow loop={value} projectionFailed={false} /></I18nProvider>));
  return { container, close: async () => { await act(async () => root.unmount()); container.remove(); } };
}

describe('host review progress on the loop row', () => {
  for (const [state, completed, locked] of [
    ['awaitingPublication', 0, false], ['pending', 1, true], ['blocked', 1, true], ['complete', 2, false],
  ] as const) {
    test(`shows authoritative ${state} operation counts and configuration availability`, async () => {
      // Given
      const { dict } = await import('@/lib/i18n/messages/en');
      const { formatMessage } = await import('@/lib/i18n');
      const view = await mount({ ...loop, review: { ...review, state, completed } });
      try {
        // When
        const statuses = [...view.container.querySelectorAll('[role="status"]')].map((entry) => entry.textContent).join('\n');
        const settings = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === dict['prFixLoop.action.settings']);
        // Then
        expect(statuses).toContain(dict[`prFixLoop.review.state.${state}`]);
        expect(statuses).toContain(formatMessage(dict, 'prFixLoop.review.progress', { completed, total: 2 }));
        expect(settings?.disabled).toBe(locked);
      } finally { await view.close(); }
    });
  }

  test('keeps the exact host blocker visible as plain text', async () => {
    // Given
    const blocker = 'GitHub write refused. <script>untrusted()</script>';
    const view = await mount({ ...loop, review: { ...review, state: 'blocked', lastError: blocker } });
    try {
      // When
      const alert = view.container.querySelector('[role="alert"]');
      // Then
      expect(alert?.textContent).toBe(blocker);
      expect(alert?.querySelector('script')).toBeNull();
    } finally { await view.close(); }
  });
});

describe('a loop watching a ready PR', () => {
  test('says the PR is ready and still watched, with no stale iteration count', async () => {
    const { dict } = await import('@/lib/i18n/messages/en');
    const view = await mount({ ...loop, status: 'watching', statusReason: 'pr-ready', iterations: 0, ci: { state: 'success', headSha: 'a' }, unresolvedThreads: 0 });
    try {
      const status = view.container.querySelector('[role="status"]')?.textContent ?? '';
      expect(status).toContain(dict['prFixLoop.status.prReady']);
      expect(status).not.toContain('Iteration');
      const buttons = [...view.container.querySelectorAll('button')].map((entry) => entry.textContent);
      expect(buttons).toContain(dict['prFixLoop.action.stop']);
      expect(buttons).not.toContain(dict['prFixLoop.action.dismiss']);
    } finally { await view.close(); }
  });
});
