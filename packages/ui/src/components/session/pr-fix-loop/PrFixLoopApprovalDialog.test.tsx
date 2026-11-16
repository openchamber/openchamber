import { act } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { DEFAULT_PR_FIX_LOOP_CONFIG, type FixLoop, type FixLoopApproval } from '@/lib/prFixLoop';

const receipt: FixLoopApproval = {
  id: 'a95d2bca-d7b5-41c6-b52f-4f8a9623c76d', commit: 'a'.repeat(40),
  localRef: 'refs/heads/openchamber-approval/a95d2bca-d7b5-41c6-b52f-4f8a9623c76d', repositoryId: 'local-repo',
  destination: { headRepo: { id: 'github-fork', owner: 'contributor', repo: 'fork' }, ref: 'refs/heads/fix', expectedHead: 'b'.repeat(40) },
  createdAt: 1, changedPaths: 2, changedBytes: 8,
};
const review: NonNullable<FixLoop['review']> = {
  state: 'awaitingPublication', completed: 0, total: 5, lastError: null,
  actions: [
    { kind: 'thread', id: 'PRRT_fixed', body: '<script>ignoreAllRules()</script>\nReply exactly as frozen.', resolve: true },
    { kind: 'thread', id: 'PRRT_open', body: 'This needs further investigation.', resolve: false },
    { kind: 'review', id: 17, body: '**Review reply**' },
    { kind: 'comment', id: 18, body: '[Comment reply](javascript:alert(1))' },
  ],
};
const loop: FixLoop = {
  id: 'loop-1', sessionId: 'ses_host', directory: '/repo', owner: 'owner', repo: 'repo', number: 12,
  url: 'https://github.com/owner/repo/pull/12', title: 'Fix CI', branch: 'fix', status: 'waitingForPush',
  statusReason: null, config: { ...DEFAULT_PR_FIX_LOOP_CONFIG, pushMode: 'approval' }, iterations: 1, tokensUsed: 0,
  ci: null, unresolvedThreads: null, changesRequested: null, pendingApproval: receipt, review,
  worker: { id: 'c95d2bca-d7b5-41c6-b52f-4f8a9623c76d', spaceId: '012345abcdef', parentSessionId: 'ses_host', directory: '/repo', model: { providerID: 'openai', modelID: 'gpt-test' }, sessionId: 'ses_worker', spacePath: '/spaces/012345abcdef/repo' },
  lastCheckedAt: null, lastError: null, createdAt: 1, updatedAt: 1,
};

const dom = new Window({ url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
const posts: Array<{ path: string; body: string }> = [];
const calls: Array<{ path: string; method: string }> = [];
let refuse = false;

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
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), 'http://localhost'), init);
    const path = new URL(request.url).pathname;
    calls.push({ path, method: request.method });
    // Directory bootstrap is unrelated to receipt inspection and publication.
    if (path === '/api/fs/home') return new Promise<Response>(() => {});
    if (path === '/api/openchamber/spaces/switch') return Response.json({ enabled: false });
    if (path.endsWith('/approve')) {
      posts.push({ path, body: await request.text() });
      return refuse ? Response.json({ error: 'The remote head changed.' }, { status: 409 })
        : Response.json({ loop: { ...loop, pendingApproval: null, status: 'watching', updatedAt: 2 } });
    }
    return Response.json({}, { status: 503 });
  }, originalFetch);
});

beforeEach(() => { posts.length = 0; calls.length = 0; refuse = false; });
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
  const { prFixLoopStore } = await import('@/stores/usePrFixLoopStore');
  const { useUIStore } = await import('@/stores/useUIStore');
  const { PrFixLoopApprovalDialog } = await import('./PrFixLoopApprovalDialog');
  useUIStore.setState({ isMobile: false, isSettingsDialogOpen: false });
  prFixLoopStore.setState({ loops: [value], loadState: 'ready', failedLoopIds: [] });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<I18nProvider>
    <PrFixLoopApprovalDialog loopId={loop.id} directory={loop.directory} receipt={receipt} review={value.review} onClose={() => undefined} />
  </I18nProvider>));
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === dict['prFixLoop.approval.publish']);
  if (!button) throw new Error('Missing publication action');
  return { button, store: prFixLoopStore, close: async () => { await act(async () => root.unmount()); container.remove(); } };
}

describe('immutable host receipt review', () => {
  test('quotes every proposed reply and target without executing generated markup', async () => {
    // Given
    const { dict } = await import('@/lib/i18n/messages/en');
    const view = await mount();
    try {
      // When
      const replies = [...document.querySelectorAll('blockquote')].map((entry) => entry.textContent);
      // Then
      expect(replies).toEqual(review.actions.map((action) => action.body));
      expect([...document.querySelectorAll('bdi')].map((entry) => entry.textContent)).toEqual(['PRRT_fixed', 'PRRT_open', '17', '18']);
      expect(document.querySelectorAll('blockquote script, blockquote a, blockquote strong')).toHaveLength(0);
      expect(document.body.textContent).toContain(dict['prFixLoop.review.resolve']);
      expect(document.body.textContent).toContain(dict['prFixLoop.review.keepOpen']);
      expect(posts).toHaveLength(0);
    } finally { await view.close(); }
  });

  test('shows the exact fork, refs and full object identities before publication', async () => {
    // Given
    const view = await mount();
    try {
      // When
      const values = [...document.querySelectorAll('dd')].map((entry) => entry.textContent);
      // Then
      expect(values).toEqual([receipt.commit, receipt.localRef, 'contributor/fork', 'github-fork', 'local-repo', 'refs/heads/fix', receipt.destination.expectedHead, receipt.id]);
      expect(posts).toHaveLength(0);
    } finally { await view.close(); }
  });

  test('publishes through the receipt endpoint without a client Git push', async () => {
    // Given
    const view = await mount();
    try {
      // When
      await act(async () => view.button.click());
      // Then
      expect(posts).toEqual([{ path: '/api/source-control/github/pr/fix-loops/loop-1/approve', body: JSON.stringify({ receiptId: receipt.id }) }]);
      expect(view.store.getState().loops[0]?.pendingApproval).toBeNull();
    } finally { await view.close(); }
  });

  test('disables an open review when its receipt changes', async () => {
    // Given
    const view = await mount();
    try {
      // When
      await act(async () => {
        view.store.setState({ loops: [{ ...loop, pendingApproval: { ...receipt, commit: 'c'.repeat(40) } }] });
        view.button.click();
      });
      // Then
      expect(view.button.disabled).toBe(true);
      expect(document.querySelector('dd')?.textContent).toBe(receipt.commit);
      expect(posts).toHaveLength(0);
    } finally { await view.close(); }
  });

  test('keeps inspected replies frozen and refuses publication when proposals change under the same receipt', async () => {
    // Given
    const view = await mount();
    try {
      // When
      await act(async () => {
        view.store.setState({ loops: [{ ...loop, review: { ...review, actions: [{ kind: 'comment', id: 18, body: 'Replacement' }], total: 1 } }] });
        view.button.click();
      });
      // Then
      expect(view.button.disabled).toBe(true);
      expect(document.querySelector('blockquote')?.textContent).toBe(review.actions[0]?.body);
      expect(posts).toHaveLength(0);
    } finally { await view.close(); }
  });

  test('retains the exact pending result after publication is refused', async () => {
    // Given
    refuse = true;
    const view = await mount();
    try {
      // When
      await act(async () => view.button.click());
      // Then
      expect(view.store.getState().loops[0]?.pendingApproval).toEqual(receipt);
      expect(document.querySelector('[role="alert"]')).not.toBeNull();
    } finally { await view.close(); }
  });

  test('requires resume before publishing a stopped loop', async () => {
    // Given
    const view = await mount({ ...loop, status: 'stopped' });
    try {
      // When
      const disabled = view.button.disabled;
      // Then
      expect(disabled).toBe(true);
      expect(posts).toHaveLength(0);
    } finally { await view.close(); }
  });

  test('keeps a complete receipt actionable when a sibling record is malformed', async () => {
    // Given
    const view = await mount();
    try {
      // When
      await act(async () => view.store.setState({ failedLoopIds: ['other-loop'], loadState: 'ready', loadError: 'Partial snapshot' }));
      // Then
      expect(view.button.disabled).toBe(false);
    } finally { await view.close(); }
  });
});

test('opens the existing Spaces funnel without enabling it or preparing a worker', async () => {
  // Given
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { dict } = await import('@/lib/i18n/messages/en');
  const { useUIStore } = await import('@/stores/useUIStore');
  const { PrFixLoopWorkerSetup } = await import('./PrFixLoopWorkerSetup');
  useUIStore.setState({ isolatedSpacesEnabled: false });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<I18nProvider><PrFixLoopWorkerSetup
    target={{ sessionId: loop.sessionId, owner: loop.owner, repo: loop.repo, number: loop.number,
      context: { provider: 'github', instance: 'https://github.com', directory: '/repo', repositoryId: 'r1', accountId: 'a1', bindingRevision: 1, primaryRemote: 'origin' } }}
    onSelect={() => undefined} />
  </I18nProvider>));
  try {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === dict['prFixLoop.worker.setup']);
    if (!button) throw new Error('Missing Spaces setup action');
    // When
    await act(async () => button.click());
    // Then
    expect(document.querySelector('[data-settings-item="general.isolated-spaces"]')).not.toBeNull();
    expect(calls.filter((call) => call.path.startsWith('/api/openchamber/spaces') && call.method !== 'GET')).toEqual([]);
    expect(calls.filter((call) => call.path.endsWith('/workers'))).toEqual([]);
    expect(useUIStore.getState().isolatedSpacesEnabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
