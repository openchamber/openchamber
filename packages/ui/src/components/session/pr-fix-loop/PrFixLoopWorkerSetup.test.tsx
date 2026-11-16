import { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

test('a prepared-worker read cannot resurrect a selection forgotten while it was in flight', async () => {
  // Given
  const worker = {
    id: 'a95d2bca-d7b5-41c6-b52f-4f8a9623c76d', spaceId: '012345abcdef', parentSessionId: 'ses_host', directory: '/repo',
    model: { providerID: 'openai', modelID: 'gpt-test' }, sessionId: null, spacePath: null,
  };
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
    PointerEvent: dom.PointerEvent, FocusEvent: dom.FocusEvent,
    ResizeObserver: dom.ResizeObserver, MutationObserver: dom.MutationObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    localStorage: dom.localStorage, sessionStorage: dom.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const originalFetch = globalThis.fetch;
  let reads = 0;
  let releaseRead: (response: Response) => void = () => { throw new Error('No pending read'); };
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), 'http://localhost'), init);
    const path = new URL(request.url).pathname;
    // Directory bootstrap is unrelated to the prepared-worker request race.
    if (path === '/api/fs/home') return new Promise<Response>(() => {});
    if (path === '/api/openchamber/spaces/switch') return Response.json({ enabled: true, spaces: [] });
    if (path === '/api/openchamber/spaces/places') return Response.json({ places: [{ id: 'docker', available: true, hostIsolation: true }] });
    if (path === '/api/openchamber/spaces') return Response.json({ spaces: [{
      id: worker.spaceId, purpose: 'pr-fix-loop-approval', name: 'pr-12', placeId: 'docker',
      approvalModel: worker.model,
      projectDirectory: '/repo', directory: '/spaces/012345abcdef/repo', state: 'running', step: null, failure: null,
      network: { mode: 'allowlist', domains: [] }, access: 'granted', needsAccess: [],
      grants: [{ kind: 'login', id: 'openai', provider: 'openai', method: 'chatgpt-token-sharing', url: 'http://gatekeeper/model/openai' }],
    }] });
    if (path.endsWith('/workers') && request.method === 'GET') {
      reads += 1;
      if (reads === 1) return Response.json({ workers: [worker] });
      return new Promise<Response>((resolve) => { releaseRead = resolve; });
    }
    if (path.endsWith(`/workers/${worker.id}`) && request.method === 'DELETE') return Response.json({ ok: true });
    return Response.json({}, { status: 503 });
  }, originalFetch);
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { dict } = await import('@/lib/i18n/messages/en');
  const { useUIStore } = await import('@/stores/useUIStore');
  const { PrFixLoopWorkerSetup } = await import('./PrFixLoopWorkerSetup');
  useUIStore.setState({ isMobile: false, isolatedSpacesEnabled: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let selected: string | null = null;
  await act(async () => root.render(<I18nProvider><PrFixLoopWorkerSetup target={{
    sessionId: 'ses_host', owner: 'owner', repo: 'repo', number: 12,
    context: { provider: 'github', instance: 'https://github.com', directory: '/repo', repositoryId: 'r1', accountId: 'a1', bindingRevision: 1, primaryRemote: 'origin' },
  }} onSelect={(value) => { selected = value.worker?.id ?? null; }} /></I18nProvider>));
  try {
    const trigger = document.querySelector<HTMLButtonElement>(`[aria-label="${dict['prFixLoop.worker.selection']}"]`);
    if (!trigger) throw new Error('Missing prepared-worker selection');
    await act(async () => trigger.click());
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) => entry.textContent?.includes(worker.spaceId));
    if (!option) throw new Error('Missing prepared-worker option');
    await act(async () => {
      option.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', button: 0 }));
      option.click();
    });
    expect(selected).toBe(worker.id);
    const refresh = [...container.querySelectorAll<HTMLButtonElement>('section > button')].find((entry) => entry.textContent === dict['spaces.access.blocked.refresh']);
    if (!refresh) throw new Error('Missing worker refresh');
    await act(async () => refresh.click());
    expect(reads).toBe(2);
    const forget = [...container.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === dict['prFixLoop.worker.forget']);
    if (!forget) throw new Error('Missing forget action');
    await act(async () => forget.click());
    // When the older read answers after the successful forget
    await act(async () => releaseRead(Response.json({ workers: [worker] })));
    // Then
    expect(selected).toBeNull();
    expect(container.querySelector(`[aria-label="${dict['prFixLoop.worker.selection']}"]`)).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});
