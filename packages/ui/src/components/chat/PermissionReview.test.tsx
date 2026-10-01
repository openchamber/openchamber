import { afterEach, beforeEach, expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider, useChildStoreManager, useScopedBlockingPermissions } from '@/sync/sync-context';
import { usePermissionReviewStore } from '@/stores/usePermissionReviewStore';
import type { PermissionRequest } from '@/types/permission';
import { createEventPipeline } from '@/sync/event-pipeline';
import { applyDirectoryEvent } from '@/sync/event-reducer';
import type { Session } from '@/lib/opencode/model';
import { useTraySync } from '@/hooks/useTraySync';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
plugin({
  name: 'permission-review-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`, loader: 'js',
    }));
  },
});
let PermissionCard: typeof import('./PermissionCard').PermissionCard;
let PermissionDock: typeof import('./PermissionDock').PermissionDock;

const permission: PermissionRequest = { id: 'review-request', sessionID: 'session', action: 'read', resources: ['/project/file'], metadata: {} };
const sdk = OpenCode.make({ baseUrl: 'http://review.test', fetch: async () => Response.json([]) });
let manager: ReturnType<typeof useChildStoreManager>;
let rawPending: PermissionRequest[] = [];
function Harness() {
  manager = useChildStoreManager();
  rawPending = useScopedBlockingPermissions('session', '/project');
  return <>{rawPending.map((request) => <PermissionCard key={request.id} permission={request} directory="/project" />)}<PermissionDock sessionId="session" directory="/project" hidden={false} /></>;
}
let dom: Window;
let root: Root;
const originals = new Map<string, PropertyDescriptor | undefined>();
type PermissionDelivery = {
  id: string;
  type: 'permission.asked' | 'permission.replied';
  location: { directory: string };
  data: PermissionRequest | { sessionID: string; requestID: string };
};
const deliverySignal = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const approvalControls = () => [...document.querySelectorAll('button')].filter((button) => button.textContent?.includes('Allow once'));

const observeApprovalControls = () => {
  const frames: number[] = [];
  let inserted = false;
  const containsApprovalControl = (node: Node) => node instanceof Element
    && (node.textContent?.includes('Allow once') ?? false);
  const observer = new MutationObserver((records) => {
    frames.push(approvalControls().length);
    inserted ||= records.some((record) => [...record.addedNodes].some(containsApprovalControl));
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return { frames, get inserted() { return inserted; }, stop: () => observer.disconnect() };
};
const originalFetch = globalThis.fetch;
let resolveLookup: (response: Response) => void = () => {};
const lookupBodies: Array<BodyInit | null | undefined> = [];

beforeEach(async () => {
  ({ PermissionCard } = await import('./PermissionCard'));
  ({ PermissionDock } = await import('./PermissionDock'));
  dom = new Window({ url: 'http://review.test' });
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    ResizeObserver: dom.ResizeObserver, MutationObserver: dom.MutationObserver,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  usePermissionReviewStore.getState().reset();
  lookupBodies.length = 0;
  const lookup = new Promise<Response>((resolve) => { resolveLookup = resolve; });
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input instanceof Request ? input.url : String(input);
    if (!path.includes('/permission-auto-accept/dispositions')) return new Response(null, { status: 404 });
    lookupBodies.push(init?.body);
    return (await lookup).clone();
  }, originalFetch);
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root.render(<SyncProvider sdk={sdk} directory="/project"><I18nProvider><Harness /></I18nProvider></SyncProvider>));
});

afterEach(async () => {
  await act(async () => root.unmount());
  usePermissionReviewStore.getState().reset();
  resolveLookup(new Response(null, { status: 503 }));
  globalThis.fetch = originalFetch;
  await dom.happyDOM.close();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

test('dock without a directory prop coordinates pending from its provider directory', async () => {
  function ProviderScopedDock() {
    manager = useChildStoreManager();
    rawPending = useScopedBlockingPermissions('session');
    return <PermissionDock sessionId="session" hidden={false} />;
  }
  await act(async () => root.render(<SyncProvider sdk={sdk} directory="/project"><I18nProvider><ProviderScopedDock /></I18nProvider></SyncProvider>));
  await act(async () => {
    const child = manager.ensureChild('/project', { bootstrap: false });
    const draft = { ...child.getState(), permission: { ...child.getState().permission } };
    applyDirectoryEvent(draft, { type: 'permission.asked', properties: permission });
    child.setState(draft);
  });
  expect(rawPending).toEqual([permission]);
  expect(approvalControls()).toHaveLength(0);
  expect(lookupBodies).toEqual([JSON.stringify({ requests: [{
    id: permission.id, sessionID: permission.sessionID, directory: '/project',
  }] })]);
  // Unknown suppression must own a deadline, otherwise waiting can never expose it.
  expect(usePermissionReviewStore.getState().deadlines.has(permission.id)).toBe(true);
  await act(async () => resolveLookup(Response.json({ dispositionVersion: 1, instanceId: 'server', revision: 3,
    permissions: [{ permissionId: permission.id, phase: 'manual', remainingMs: 0 }] })));
  expect(rawPending).toEqual([permission]);
  expect(approvalControls()).toHaveLength(1);
});

for (const source of ['dock', 'child-dock', 'btw', 'tray', 'global-tray'] as const) {
  test(`${source} resolves a parent-store request to its worktree session before registration`, async () => {
    const parent: Session = {
      id: 'parent', projectID: 'project', directory: '/repo', title: 'Parent', cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    };
    const child: Session = { ...parent, id: permission.sessionID, parentID: parent.id, directory: '/repo/wt' };
    const previousGlobal = useGlobalSessionsStore.getState();
    const previousRequests = useGlobalBlockingRequestsStore.getState();
    const trayFirst = source === 'tray' || source === 'global-tray';
    function Tray() { useTraySync(); return null; }
    function WorktreeHarness({ showControls }: { showControls: boolean }) {
      manager = useChildStoreManager();
      rawPending = useScopedBlockingPermissions(parent.id, '/repo');
      return <>
        {trayFirst ? <Tray /> : null}
        {showControls ? source === 'btw'
          ? <PermissionCard permission={permission} directory="/repo" />
          : <PermissionDock sessionId={source === 'child-dock' ? child.id : parent.id} directory="/repo" hidden={false} /> : null}
      </>;
    }
    const render = (showControls: boolean) => root.render(<SyncProvider sdk={sdk} directory="/repo">
      <I18nProvider><WorktreeHarness showControls={showControls} /></I18nProvider>
    </SyncProvider>);
    if (trayFirst) Object.assign(dom, {
      __OPENCHAMBER_PLATFORM__: 'linux',
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron', trayEnabled: true },
      __OPENCHAMBER_API_BASE_URL__: 'http://review.test',
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://review.test',
      __OPENCHAMBER_DESKTOP__: { invoke: async () => null, listen: async () => () => {} },
    });
    try {
      // Prepare the parent store before the tray mounts. The worktree has no store.
      await act(async () => root.render(<SyncProvider sdk={sdk} directory="/repo"><I18nProvider>{null}</I18nProvider></SyncProvider>));
      manager.ensureChild('/repo', { bootstrap: false }).setState({
        session: source === 'global-tray' ? [parent] : [parent, child],
        permission: source === 'global-tray' ? {} : { [permission.sessionID]: [permission] },
      });
      if (source === 'global-tray') {
        useGlobalSessionsStore.getState().upsertSession(child);
        useGlobalBlockingRequestsStore.setState({ bySession: new Map([[permission.sessionID, {
          directory: '/repo', permissions: [permission], forms: [],
        }]]) });
      }
      await act(async () => render(!trayFirst));
      expect(lookupBodies).toEqual([JSON.stringify({ requests: [{
        id: permission.id, sessionID: permission.sessionID, directory: '/repo/wt',
      }] })]);
      expect(approvalControls()).toHaveLength(0);
      if (trayFirst) await act(async () => {
        manager.ensureChild('/repo', { bootstrap: false }).setState({ session: [parent, child], permission: { [permission.sessionID]: [permission] } });
        render(true);
      });
      expect(rawPending).toEqual([permission]);
      expect(lookupBodies).toHaveLength(1);
      await act(async () => resolveLookup(Response.json({ dispositionVersion: 1, instanceId: 'server', revision: 1,
        permissions: [{ permissionId: permission.id, phase: 'manual', remainingMs: 0 }] })));
      expect(approvalControls()).toHaveLength(1);
      expect(rawPending).toEqual([permission]);
      expect(usePermissionReviewStore.getState().visible(permission.id)).toBe(true);
      expect(lookupBodies).toHaveLength(1);
    } finally {
      await act(async () => root.render(null));
      useGlobalSessionsStore.setState(previousGlobal);
      useGlobalBlockingRequestsStore.setState(previousRequests);
    }
  });
}

for (const directory of ['/cold-btw', '/spaces/abcdef123456/project']) {
  test(`cold BTW card scopes coordination without a dock or tray: ${directory}`, async () => {
    const bodies: Array<BodyInit | null | undefined> = [];
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = input instanceof Request ? input.url : String(input);
      if (!path.includes('/permission-auto-accept/dispositions')) return new Response(null, { status: 404 });
      bodies.push(init?.body);
      return Response.json({ dispositionVersion: 1, instanceId: 'server', revision: 1,
        permissions: [{ permissionId: permission.id, phase: 'manual', remainingMs: 0 }] });
    }, originalFetch);
    await act(async () => root.render(<SyncProvider sdk={sdk} directory={directory}><I18nProvider>
      <PermissionCard permission={permission} directory={directory} />
    </I18nProvider></SyncProvider>));
    const allows = [...document.querySelectorAll('button')].filter((button) => button.textContent?.includes('Allow once'));
    expect(allows).toHaveLength(1);
    expect(bodies).toEqual(directory.startsWith('/spaces/') ? [] : [JSON.stringify({ requests: [{
      id: permission.id, sessionID: permission.sessionID, directory,
    }] })]);
    expect(usePermissionReviewStore.getState().visible(permission.id)).toBe(true);
  });
}

test('initial pending has no approval frame; manual disposition exposes dock and BTW while raw pending blocks', async () => {
  await act(async () => {
    flushSync(() => manager.ensureChild('/project', { bootstrap: false }).setState({ permission: { session: [permission] } }));
    expect(approvalControls()).toHaveLength(0);
  });
  expect(approvalControls()).toHaveLength(0);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  // ChatInput uses this raw hook's length for hasPendingPermission/hasPendingForm.
  expect(rawPending).toEqual([permission]);
  expect(manager.ensureChild('/project', { bootstrap: false }).getState().permission.session).toEqual([permission]);
  const key = new dom.KeyboardEvent('keydown', { key: 'Enter', altKey: true, cancelable: true });
  dom.dispatchEvent(key);
  expect(key.defaultPrevented).toBe(false);
  await act(async () => {
    resolveLookup(Response.json({ dispositionVersion: 1, instanceId: 'server', revision: 2, permissions: [{ permissionId: permission.id, phase: 'manual', remainingMs: 0 }] }));
  });
  expect(approvalControls()).toHaveLength(2);
  expect(rawPending).toEqual([permission]);
  await act(async () => usePermissionReviewStore.getState().applySnapshot({ dispositionVersion: 1, instanceId: 'server', revision: 3, permissions: [{ permissionId: permission.id, phase: 'reviewing', remainingMs: 1000 }] }));
  expect(approvalControls()).toHaveLength(2);
  await act(async () => {
    manager.ensureChild('/project', { bootstrap: false }).setState({ permission: { session: [] } });
  });
  expect(rawPending).toEqual([]);
  expect(approvalControls()).toHaveLength(0);
});

test('delayed hydration after newer review and answered events never inserts approval controls', async () => {
  const child = manager.ensureChild('/project', { bootstrap: false });
  const observation = observeApprovalControls();
  try {
    // Raw pending arrives before the layout effect can register its disposition lookup.
    await act(async () => {
      flushSync(() => child.setState({ permission: { session: [permission] } }));
      await Promise.resolve();
    });
    expect(rawPending).toEqual([permission]);
    expect(approvalControls()).toHaveLength(0);

    // The control stream starts review while the older hydration request is still delayed.
    await act(async () => {
      usePermissionReviewStore.getState().applySnapshot({ dispositionVersion: 1, instanceId: 'server', revision: 2,
        permissions: [{ permissionId: permission.id, phase: 'reviewing', remainingMs: 10_000 }] });
      await Promise.resolve();
    });
    expect(approvalControls()).toHaveLength(0);

    // A stale manual hydration response must not undo the newer reviewing authority.
    await act(async () => {
      resolveLookup(Response.json({ dispositionVersion: 1, instanceId: 'server', revision: 1,
        permissions: [{ permissionId: permission.id, phase: 'manual', remainingMs: 0 }] }));
      await Promise.resolve();
    });
    expect(approvalControls()).toHaveLength(0);

    // Auto-accept settles before sync removes raw pending; neither turn may reveal controls.
    await act(async () => {
      usePermissionReviewStore.getState().applySnapshot({ dispositionVersion: 1, instanceId: 'server', revision: 3,
        permissions: [{ permissionId: permission.id, phase: 'answered', remainingMs: 9_000 }] });
      await Promise.resolve();
    });
    expect(rawPending).toEqual([permission]);
    expect(approvalControls()).toHaveLength(0);
    await act(async () => {
      child.setState({ permission: { session: [] } });
      await Promise.resolve();
    });
    expect(rawPending).toEqual([]);
    expect(approvalControls()).toHaveLength(0);
  } finally {
    observation.stop();
  }
  // Every delivery uses its own act turn; this catches an insertion removed by a later turn.
  expect(observation.frames.every((count) => count === 0)).toBe(true);
  expect(observation.inserted).toBe(false);
});

for (const controlFirst of [false, true]) {
  for (const repliedFirst of [false, true]) {
    test(`presentation gate has no approval frame, controlFirst=${controlFirst}, repliedFirst=${repliedFirst}`, async () => {
      const child = manager.ensureChild('/project', { bootstrap: false });
      const observation = observeApprovalControls();
      await act(async () => child.setState({ permission: {} }));
      const admission = { dispositionVersion: 1 as const, instanceId: 'server', revision: 1, permissions: [{ permissionId: permission.id, phase: 'reviewing' as const, remainingMs: 25_000 }] };
      const answered = { ...admission, revision: 3, permissions: [{ ...admission.permissions[0], phase: 'answered' as const }] };
      const body = new TransformStream<Uint8Array, Uint8Array>();
      const writer = body.writable.getWriter();
      const eventSdk = OpenCode.make({ baseUrl: 'http://review.test', fetch: async () => new Response(body.readable, { headers: { 'Content-Type': 'text/event-stream' } }) });
      const frames: number[] = [];
      let delivered = deliverySignal();
      const pipeline = createEventPipeline({
        sdk: eventSdk, transport: 'sse',
        onEvents: (_directory, events) => {
          const draft = { ...child.getState(), permission: { ...child.getState().permission } };
          for (const event of events) applyDirectoryEvent(draft, event);
          flushSync(() => child.setState(draft));
          frames.push([...document.querySelectorAll('button')].filter((button) => button.textContent?.includes('Allow once')).length);
          delivered.resolve();
        },
      });
      const send = async (payload: PermissionDelivery) => {
        delivered = deliverySignal();
        await act(async () => {
          await writer.write(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
          await delivered.promise;
          await Promise.resolve();
        });
      };
      try {
        if (controlFirst) await act(async () => usePermissionReviewStore.getState().applySnapshot(admission));
        await send({ id: 'asked', type: 'permission.asked', location: { directory: '/project' }, data: permission });
        expect(rawPending).toEqual([permission]);
        expect(frames).toEqual([0]);
        if (!controlFirst) await act(async () => usePermissionReviewStore.getState().applySnapshot(admission));
        const reply = () => send({ id: 'replied', type: 'permission.replied', location: { directory: '/project' }, data: { sessionID: 'session', requestID: permission.id } });
        if (repliedFirst) await reply();
        await act(async () => usePermissionReviewStore.getState().applySnapshot(answered));
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        if (!repliedFirst) {
          expect(rawPending).toEqual([permission]);
          await reply();
        }
        expect(rawPending).toEqual([]);
        expect(frames).toEqual([0, 0]);
      } finally {
        observation.stop();
        pipeline.cleanup();
        await writer.close().catch(() => {});
      }
      expect(observation.frames.every((count) => count === 0)).toBe(true);
      expect(observation.inserted).toBe(false);
    });
  }
}
