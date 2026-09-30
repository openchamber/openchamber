import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { Toaster, toast } from 'sonner';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useRoutingStore } from '@/stores/useRoutingStore';
import { usePermissionReviewStore } from '@/stores/usePermissionReviewStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useRoutingSync } from './useRoutingSync';

let sessionId: string;
let scenario = 0;

class EventSourceFixture {
  static CLOSED = 2;
  static instances: EventSourceFixture[] = [];
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { EventSourceFixture.instances.push(this); }
  close() { this.readyState = EventSourceFixture.CLOSED; }
  skip(directory: string | null) {
    this.onmessage?.({ data: JSON.stringify({
      type: 'openchamber:routing.safety-skipped',
      properties: { permissionId: 'permission', sessionId, directory, error: 'Jev unavailable' },
    }) });
  }
}

function Harness() {
  useRoutingSync();
  return <Toaster />;
}

let dom: Window;
let root: Root;
const originals = new Map<string, PropertyDescriptor | undefined>();
const initialUI = useUIStore.getState();
const initialSessions = useSessionUIStore.getState();
const initialGlobalSessions = useGlobalSessionsStore.getState();
const initialRouting = useRoutingStore.getState();
const initialLocale = useI18nStore.getState();

beforeEach(async () => {
  sessionId = `permission-session-${++scenario}`;
  dom = new Window({ url: 'http://routing.test' });
  Object.assign(dom, { __OPENCHAMBER_API_BASE_URL__: 'http://routing.test' });
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    Event: dom.Event, CustomEvent: dom.CustomEvent,
    EventSource: EventSourceFixture,
    matchMedia: dom.matchMedia.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    fetch: async (input: RequestInfo | URL) => String(input).includes('/permission-auto-accept')
      ? Response.json({ dispositionVersion: 1, instanceId: 'server', revision: 0, permissions: [] })
      : new Response(null, { status: 404 }),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  EventSourceFixture.instances = [];
  useUIStore.setState({ routingFeatureAvailable: true });
  useSessionUIStore.setState({ currentSessionId: 'other-session', currentSessionDirectory: '/other' });
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>));
});

afterEach(async () => {
  await act(async () => root.unmount());
  toast.dismiss();
  useUIStore.setState(initialUI);
  useSessionUIStore.setState(initialSessions);
  useGlobalSessionsStore.setState(initialGlobalSessions);
  useRoutingStore.setState(initialRouting);
  useI18nStore.setState(initialLocale);
  await dom.happyDOM.close();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

async function showWarning(directory: string | null, label = 'Open session') {
  await act(async () => {
    EventSourceFixture.instances[0].skip(directory);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const button = document.querySelector<HTMLButtonElement>('[data-sonner-toast] button');
  if (!button) throw new Error('Missing warning action');
  expect(document.body.textContent).toContain('Jev unavailable');
  expect(button.textContent).toBe(label);
  return button;
}

test('warning opens the permission session using its event directory', async () => {
  const button = await showWarning('/permission-project');
  await act(async () => button.click());
  expect(useSessionUIStore.getState().currentSessionId).toBe(sessionId);
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/permission-project');
});

test('control snapshots suppress only active reviews and disconnect clears them immediately', async () => {
  const source = EventSourceFixture.instances[0];
  const publish = (revision: number, active: boolean) => source.onmessage?.({ data: JSON.stringify({
    type: 'openchamber:permission-review.updated', properties: {
      dispositionVersion: 1, instanceId: 'server', revision,
      permissions: [{ permissionId: 'permission', remainingMs: active ? 1000 : 0, phase: active ? 'reviewing' : 'manual' }],
    },
  }) });
  await act(async () => publish(1, true));
  expect(usePermissionReviewStore.getState().deadlines.has('permission')).toBe(true);
  await act(async () => publish(2, false));
  expect(usePermissionReviewStore.getState().deadlines.size).toBe(0);
  await act(async () => publish(3, true));
  await act(async () => source.onerror?.());
  expect(usePermissionReviewStore.getState().deadlines.size).toBe(0);
  await act(async () => publish(4, true));
  expect(usePermissionReviewStore.getState().deadlines.size).toBe(0);
  expect(EventSourceFixture.instances).toHaveLength(1);
});

test('stream ready refreshes the review snapshot and runtime changes reject a stale refresh', async () => {
  let reads = 0;
  let resolveOld: (response: Response) => void = () => {};
  const old = new Promise<Response>((resolve) => { resolveOld = resolve; });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const path = String(input instanceof Request ? input.url : input);
    if (!path.includes('/permission-auto-accept')) return new Response(null, { status: 404 });
    reads += 1;
    return reads === 1 ? old : Response.json({ dispositionVersion: 1, instanceId: 'new', revision: 0, permissions: [] });
  }, previousFetch);
  try {
    await act(async () => EventSourceFixture.instances[0].onmessage?.({ data: JSON.stringify({ type: 'openchamber:event-stream-ready' }) }));
    expect(reads).toBe(1);
    await act(async () => {
      Object.assign(dom, { __OPENCHAMBER_API_BASE_URL__: 'http://new-runtime.test' });
      dom.dispatchEvent(new dom.CustomEvent('openchamber:runtime-endpoint-changed'));
    });
    expect(reads).toBe(2);
    await act(async () => {
      resolveOld(Response.json({ dispositionVersion: 1, instanceId: 'server', revision: 99, permissions: [{ permissionId: 'old', phase: 'reviewing', remainingMs: 1000 }] }));
      await old;
    });
    expect(usePermissionReviewStore.getState().revision).toBe(0);
    expect(usePermissionReviewStore.getState().deadlines.size).toBe(0);
    expect(EventSourceFixture.instances).toHaveLength(2);
  } finally { globalThis.fetch = previousFetch; }
});

test('a null event directory uses the session record instead of the active directory', async () => {
  useGlobalSessionsStore.getState().upsertSession({
    id: sessionId, projectID: 'project', directory: '/indexed-project', title: 'Permission', cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  });
  const button = await showWarning(null);
  await act(async () => button.click());
  expect(useSessionUIStore.getState().currentSessionId).toBe(sessionId);
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/indexed-project');
});

test('stream ready replaces pre-subscription hydration and recovers a missed review start', async () => {
  await act(async () => useUIStore.setState({ routingFeatureAvailable: false }));
  const previousFetch = globalThis.fetch;
  let reads = 0;
  let resolveOld: (response: Response) => void = () => {};
  let resolveFresh: (response: Response) => void = () => {};
  const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
  const freshResponse = new Promise<Response>((resolve) => { resolveFresh = resolve; });
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const path = String(input instanceof Request ? input.url : input);
    if (!path.includes('/permission-auto-accept')) return new Response(null, { status: 404 });
    reads += 1;
    return reads === 1 ? oldResponse : freshResponse;
  }, previousFetch);
  try {
    await act(async () => useUIStore.setState({ routingFeatureAvailable: true }));
    expect(reads).toBe(1);
    const oldLoad = usePermissionReviewStore.getState().load();
    // The first snapshot is empty. Review starts before SSE subscribes, so no
    // review-start event reaches this client. Stream-ready must bridge that gap.
    await act(async () => EventSourceFixture.instances.at(-1)?.onmessage?.({ data: JSON.stringify({ type: 'openchamber:event-stream-ready' }) }));
    expect(reads).toBe(2);
    const freshLoad = usePermissionReviewStore.getState().load();
    await act(async () => {
      resolveOld(Response.json({ dispositionVersion: 1, instanceId: 'server', revision: 1, permissions: [] }));
      await oldLoad;
    });
    expect(usePermissionReviewStore.getState().revision).toBe(-1);
    expect(usePermissionReviewStore.getState().load()).toBe(freshLoad);
    await act(async () => {
      resolveFresh(Response.json({ dispositionVersion: 1, instanceId: 'server', revision: 2, permissions: [{ permissionId: 'missed-start', phase: 'reviewing', remainingMs: 1000 }] }));
      await freshLoad;
    });
    expect(usePermissionReviewStore.getState().revision).toBe(2);
    expect([...usePermissionReviewStore.getState().deadlines.keys()]).toEqual(['missed-start']);
  } finally { globalThis.fetch = previousFetch; }
});

test('a warning from another runtime cannot change session selection', async () => {
  const button = await showWarning('/permission-project');
  Object.assign(dom, { __OPENCHAMBER_API_BASE_URL__: 'http://other-runtime.test' });
  await act(async () => button.click());
  expect(useSessionUIStore.getState().currentSessionId).toBe('other-session');
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/other');
});

test('warning action follows the current locale after a language change', async () => {
  await act(async () => {
    const loaded = new Promise<void>((resolve) => {
      const unsubscribe = useI18nStore.subscribe((state) => {
        if (state.locale !== 'fr' || state.loadingLocale !== null) return;
        unsubscribe();
        resolve();
      });
    });
    useI18nStore.getState().setLocale('fr');
    await loaded;
  });
  const button = await showWarning('/permission-project', 'Ouvrir la session');
  await act(async () => button.click());
  expect(useSessionUIStore.getState().currentSessionId).toBe(sessionId);
});
