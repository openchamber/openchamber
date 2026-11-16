import { act } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { DEFAULT_PR_FIX_LOOP_CONFIG, type FixLoop } from '@/lib/prFixLoop';

const loop: FixLoop = {
  id: 'loop-config', sessionId: 'ses_host', directory: '/repo', owner: 'owner', repo: 'repo', number: 12,
  url: 'https://github.com/owner/repo/pull/12', title: 'Fix review', branch: 'fix', status: 'watching',
  statusReason: null, config: { ...DEFAULT_PR_FIX_LOOP_CONFIG, pushMode: 'approval' }, iterations: 1, tokensUsed: 0,
  ci: null, unresolvedThreads: null, changesRequested: null, worker: null, pendingApproval: null, review: null,
  lastCheckedAt: null, lastError: null, createdAt: 1, updatedAt: 1,
};
const review: NonNullable<FixLoop['review']> = {
  state: 'pending', actions: [{ kind: 'thread', id: 'PRRT_thread', body: 'Frozen reply', resolve: true }],
  completed: 1, total: 2, lastError: null,
};
const dom = new Window({ url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
const patches: string[] = [];

// Dismissal belongs to the panel; repository readouts are unrelated to this flow.
mock.module('@/components/chat/work-status/WorkStatusSectionList', () => ({ WorkStatusSectionList: () => <section>Session</section> }));

beforeAll(() => {
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent, FormData: dom.FormData,
    ResizeObserver: dom.ResizeObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    localStorage: dom.localStorage, sessionStorage: dom.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), 'http://localhost'), init);
    // Directory bootstrap must not write settings during configuration tests.
    if (new URL(request.url).pathname === '/api/fs/home') return new Promise<Response>(() => {});
    if (request.method === 'PATCH') {
      patches.push(await request.text());
      return Response.json({ loop: { ...loop, updatedAt: 2 } });
    }
    if (new URL(request.url).pathname === '/api/openchamber/spaces/switch') return Response.json({ enabled: false });
    return Response.json({}, { status: 503 });
  }, originalFetch);
});
beforeEach(() => { patches.length = 0; });
afterAll(async () => {
  globalThis.fetch = originalFetch;
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  await dom.happyDOM.close();
});

async function mount(value: FixLoop = loop) {
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { dict } = await import('@/lib/i18n/messages/en');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { prFixLoopStore } = await import('@/stores/usePrFixLoopStore');
  const { useUIStore } = await import('@/stores/useUIStore');
  const { PrFixLoopDialog } = await import('./PrFixLoopDialog');
  useUIStore.setState({ isMobile: false, isSettingsDialogOpen: false });
  prFixLoopStore.setState({ loops: [value], loadState: 'ready', failedLoopIds: [] });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const apis = createWebAPIs();
  await act(async () => root.render(<RuntimeAPIContext.Provider value={apis}><I18nProvider>
    <PrFixLoopDialog target={{ kind: 'edit', loop: value }} onClose={() => undefined} />
  </I18nProvider></RuntimeAPIContext.Provider>));
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === dict['prFixLoop.action.save']);
  const form = document.querySelector('form');
  if (!button || !form) throw new Error('Missing configuration form');
  return { button, form, store: prFixLoopStore, close: async () => { await act(async () => root.unmount()); container.remove(); } };
}

describe('review configuration lock', () => {
  for (const state of ['pending', 'blocked'] as const) {
    test(`refuses form submission while host review writes are ${state}`, async () => {
      // Given
      const view = await mount({ ...loop, review: { ...review, state } });
      try {
        // When
        await act(async () => view.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
        // Then
        expect(view.button.disabled).toBe(true);
        expect(document.querySelector('fieldset')?.disabled).toBe(true);
        expect(patches).toEqual([]);
      } finally { await view.close(); }
    });
  }

  test('rechecks authoritative work before an already-open form can submit', async () => {
    // Given
    const view = await mount();
    try {
      // When
      await act(async () => {
        view.store.setState({ loops: [{ ...loop, review }] });
        view.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      // Then
      expect(view.button.disabled).toBe(true);
      expect(patches).toEqual([]);
    } finally { await view.close(); }
  });

  test('allows settings once host review operations complete', async () => {
    // Given
    const view = await mount({ ...loop, review: { ...review, state: 'complete', completed: 2 } });
    try {
      // When
      await act(async () => view.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
      // Then
      expect(patches).toHaveLength(1);
      expect(JSON.parse(patches[0] ?? '{}').config.pushMode).toBe('approval');
    } finally { await view.close(); }
  });

  test('keeps configuration locked while a publication receipt is pending', async () => {
    // Given
    const receipt = {
      id: 'a95d2bca-d7b5-41c6-b52f-4f8a9623c76d', commit: 'a'.repeat(40), repositoryId: 'local-repo',
      localRef: 'refs/heads/openchamber-approval/a95d2bca-d7b5-41c6-b52f-4f8a9623c76d',
      destination: { headRepo: { id: 'github-repo', owner: 'owner', repo: 'repo' }, ref: 'refs/heads/fix', expectedHead: 'b'.repeat(40) },
      createdAt: 1, changedPaths: 1, changedBytes: 8,
    };
    const view = await mount({ ...loop, pendingApproval: receipt });
    try {
      // When
      await act(async () => view.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
      // Then
      expect(view.button.disabled).toBe(true);
      expect(patches).toEqual([]);
    } finally { await view.close(); }
  });
});

test('the Work status overlay survives configuration and nested portal interactions', async () => {
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { useUIStore } = await import('@/stores/useUIStore');
  const { WorkStatusPanel } = await import('@/components/chat/work-status/WorkStatusPanel');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const apis = createWebAPIs();
  const portal = document.createElement('button');
  document.body.append(portal);
  try {
    useUIStore.setState({ workStatusOverlayOpen: true });
    await act(async () => root.render(<RuntimeAPIContext.Provider value={apis}><I18nProvider>
      <WorkStatusPanel sessionId={null} directory={null} visible overlay />
    </I18nProvider></RuntimeAPIContext.Provider>));
    // An ordinary outside press dismisses the overlay before a dialog opens.
    await act(async () => portal.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(useUIStore.getState().workStatusOverlayOpen).toBe(false);
    useUIStore.setState({ workStatusOverlayOpen: true });
    const dialog = await mount();
    try {
      expect(document.documentElement.classList.contains('oc-dialog-open')).toBe(true);
      await act(async () => dialog.form.dispatchEvent(new Event('pointerdown', { bubbles: true })));
      expect(useUIStore.getState().workStatusOverlayOpen).toBe(true);
      // A nested picker portal is outside both the panel and configuration DOM.
      await act(async () => portal.dispatchEvent(new Event('pointerdown', { bubbles: true })));
      expect(useUIStore.getState().workStatusOverlayOpen).toBe(true);
      await act(async () => portal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
      expect(useUIStore.getState().workStatusOverlayOpen).toBe(true);
    } finally { await dialog.close(); }
    expect(document.documentElement.classList.contains('oc-dialog-open')).toBe(false);
    const consumedEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    consumedEscape.preventDefault();
    await act(async () => portal.dispatchEvent(consumedEscape));
    expect(useUIStore.getState().workStatusOverlayOpen).toBe(true);
    await act(async () => portal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(useUIStore.getState().workStatusOverlayOpen).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    portal.remove();
  }
});
