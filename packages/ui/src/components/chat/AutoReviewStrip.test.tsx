import { act } from 'react';
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { AutoReviewRun } from '@/stores/useAutoReviewStore';
import type { FixLoop } from '@/lib/prFixLoop';

const dom = new Window({ url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;

beforeAll(async () => {
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
    // Directory bootstrap is unrelated to the review and projection fixtures.
    if (path === '/api/fs/home') return new Promise<Response>(() => {});
    return Response.json({ revision: 2, run: null });
  }, originalFetch);
  const projection = await import('@/stores/usePrFixLoopStore');
  // The control-stream lifecycle is tested with the projection. This suite
  // renders its real store without opening an external event stream.
  mock.module('@/stores/usePrFixLoopStore', () => ({
    ...projection,
    usePrFixLoopProjection: () => {},
  }));
});

afterAll(async () => {
  mock.restore();
  globalThis.fetch = originalFetch;
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  await dom.happyDOM.close();
});

const run: AutoReviewRun = {
  originalSessionID: 'ses_column', reviewSessionID: 'ses_review', directory: '/repo',
  status: 'disputed', step: 'review', round: 2, maxRounds: 3, startedAt: 1, updatedAt: 2,
  dispute: 'Reviewer and implementer disagree. <script>untrusted()</script>',
};

async function mount(value: AutoReviewRun | null) {
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { getRuntimeKey } = await import('@/lib/runtime-switch');
  const { DEFAULT_PR_FIX_LOOP_CONFIG } = await import('@/lib/prFixLoop');
  const { prFixLoopStore } = await import('@/stores/usePrFixLoopStore');
  const { useAutoReviewStore } = await import('@/stores/useAutoReviewStore');
  const { ChatColumnSessionContext } = await import('./chatColumnSession');
  const { AutoReviewStrip } = await import('./AutoReviewStrip');
  const previousProjection = prFixLoopStore.getState();
  const loop: FixLoop = {
    id: 'loop', sessionId: 'ses_column', directory: '/repo', owner: 'org', repo: 'repo', number: 12,
    url: 'https://github.com/org/repo/pull/12', title: 'Column pull request', branch: 'fix', status: 'watching',
    statusReason: null, config: DEFAULT_PR_FIX_LOOP_CONFIG, iterations: 0, tokensUsed: 0,
    ci: { state: 'success', headSha: 'a' }, unresolvedThreads: 0, changesRequested: false, worker: null,
    pendingApproval: null, review: null, lastCheckedAt: 1, lastError: null, createdAt: 1, updatedAt: 1,
  };
  useAutoReviewStore.getState().resetForRuntimeSwitch();
  if (value) useAutoReviewStore.getState().applyUpdate({
    revision: 1, originalSessionID: value.originalSessionID, directory: value.directory, run: value,
  }, getRuntimeKey());
  prFixLoopStore.setState({ runtimeKey: getRuntimeKey(), loops: [loop], loadState: 'ready', loadError: null, failedLoopIds: [] });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(
    <I18nProvider>
      <ChatColumnSessionContext.Provider value={{ sessionId: 'ses_column', directory: '/repo' }}>
        <AutoReviewStrip />
      </ChatColumnSessionContext.Provider>
    </I18nProvider>,
  ));
  return {
    container, prFixLoopStore,
    close: async () => {
      await act(async () => root.unmount());
      useAutoReviewStore.getState().resetForRuntimeSwitch();
      prFixLoopStore.setState(previousProjection);
      container.remove();
    },
  };
}

test('a settled review expands its dispute alongside the column PR loop', async () => {
  // Given
  const view = await mount(run);
  try {
    const toggle = view.container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    if (!toggle) throw new Error('Missing dispute disclosure');
    // When
    await act(async () => toggle.click());
    // Then
    const content = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(content?.textContent).toBe(run.dispute);
    expect(content?.querySelector('script')).toBeNull();
    expect(view.container.textContent).toContain('Column pull request');
  } finally { await view.close(); }
});

test('dismissing the review keeps the PR loop visible', async () => {
  // Given
  const { dict } = await import('@/lib/i18n/messages/en');
  const view = await mount({ ...run, status: 'clean' });
  try {
    const dismiss = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === dict['chat.autoReview.actions.dismiss']);
    if (!dismiss) throw new Error('Missing review dismissal');
    // When
    await act(async () => dismiss.click());
    // Then
    expect(view.container.textContent).not.toContain(dict['chat.autoReview.result.clean']);
    expect(view.container.textContent).toContain('Column pull request');
  } finally { await view.close(); }
});

test('a failed projection keeps the PR row visible with unknown CI and a retry action', async () => {
  // Given
  const { dict } = await import('@/lib/i18n/messages/en');
  const view = await mount(null);
  try {
    // When
    await act(async () => view.prFixLoopStore.setState({ loadState: 'error', loadError: 'Unavailable' }));
    // Then
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(dict['prFixLoop.action.retry']);
    expect(view.container.textContent).toContain('Column pull request');
    expect(view.container.textContent).toContain(dict['prFixLoop.ci.unknown']);
  } finally { await view.close(); }
});
