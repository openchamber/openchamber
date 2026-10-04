import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { Window } from 'happy-dom';
import { hostMessageSchema } from '@openchamber/sdk/schemas';
import type { GuestMessage, HostMessage } from '@openchamber/sdk';

import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { I18nProvider } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { useGuestsStore } from '@/lib/guests/store';
import type { InstalledGuest } from '@/lib/guests/types';
import { SyncProvider } from '@/sync/sync-context';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useInputStore } from '@/sync/input-store';
import { WorkStatusExtensionSection } from './WorkStatusExtensionSection';
import { PresenceContext } from './presenceContext';

test('a status frame keeps subscriptions and storage alive while project changes retire only its controls', async () => {
  const dom = new Window({ url: 'http://guest.test', settings: { disableIframePageLoading: true } });
  const iframeWindows = new Map<HTMLIFrameElement, Window>();
  const iframeMessages = new Map<HTMLIFrameElement, HostMessage[]>();
  const iframePosts: Array<ReturnType<typeof spyOn>> = [];
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, getComputedStyle: dom.getComputedStyle.bind(dom), Event: dom.Event, MessageEvent: dom.MessageEvent,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, DocumentFragment: dom.DocumentFragment,
    MutationObserver: dom.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let resolveStorage: ((response: Response) => void) | null = null;
  const storageResponse = new Promise<Response>((resolve) => { resolveStorage = resolve; });
  let resolveChildService: ((response: Response) => void) | null = null;
  const childServiceResponse = new Promise<Response>((resolve) => { resolveChildService = resolve; });
  let childServiceCalls = 0;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.includes('/api/guests/git-graph/storage')) return storageResponse;
    if (target.includes('/api/guests/git-graph/service/request')) {
      childServiceCalls++;
      return childServiceResponse;
    }
    if (target.includes('/auth/url-token')) return Response.json({ token: 'scoped-test', expiresAt: Date.now() + 60_000 });
    if (target.includes('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    if (target.includes('/session/active')) return Response.json({ data: {} });
    if (new URL(target).pathname.endsWith('/shell')) return Response.json({ location: { directory: null }, data: [] });
    if (target.includes('/location')) return Response.json({ directory: '/visible', project: { id: 'project', directory: '/visible', canonical: '/visible' } });
    if (target.includes('/fs/home')) return Response.json({ home: '/home/test' });
    if (target.includes('/config')) return Response.json([]);
    if (target.includes('/project')) return Response.json([]);
    if (target.includes('/vcs')) return Response.json({ data: { branch: { current: 'main', default: 'main' } } });
    return Response.json({ data: [], cursor: {} });
  });
  const sdk = OpenCode.make({ baseUrl: 'http://sync.test', fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (path.endsWith('/shell')) return Response.json({ location: { directory: null }, data: [] });
    if (path.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    const body = path.endsWith('/location')
      ? { directory: '/visible', project: { id: 'project', directory: '/visible', canonical: '/visible' } }
      : path.endsWith('/session/active') ? {} : { data: [] };
    return Response.json(body);
  } });
  const theme = getDefaultTheme(false);
  const themeContext: ThemeContextValue = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
    reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
    isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
    lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
  };
  let activeThemeContext = themeContext;
  const guest: InstalledGuest = {
    id: 'git-graph', name: 'Git graph', icon: 'git-commit', statusEntry: 'status/index.html', statusTitle: 'Recent commits', statusHeight: 140,
    storageId: '11111111-1111-4111-8111-111111111111', origins: ['https://first.example'],
    capabilities: { requested: ['sessions', 'origins'], granted: ['sessions', 'origins'] },
    service: { runtime: 'host', granted: true },
  };
  const previousRuntimeUrlResolver = getRuntimeUrlResolver();
  configureRuntimeUrlResolver({ apiBaseUrl: 'http://sync.test' });
  opencodeClient.reconnectToRuntimeBaseUrl();
  const runtimeKey = getRuntimeKey();
  const previousProjects = useProjectsStore.getState();
  useProjectsStore.setState({
    hasServerSnapshot: true,
    serverSnapshotFailed: false,
    projects: [{ id: 'visible', path: '/visible', label: 'Visible', addedAt: 1 }],
    activeProjectId: 'visible',
  });
  useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
  useGuestsStore.getState().replaceCatalog([guest], runtimeKey);
  useUIStore.setState({ workStatusExpandedSections: {} });
  const contentWindowDescriptor = Object.getOwnPropertyDescriptor(dom.HTMLIFrameElement.prototype, 'contentWindow');
  const indexedDBDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {} });
  Object.defineProperty(dom.HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    get(this: HTMLIFrameElement) {
      let frameWindow = iframeWindows.get(this);
      if (!frameWindow) {
        frameWindow = new Window();
        iframeWindows.set(this, frameWindow);
        const frameMessages: HostMessage[] = [];
        iframeMessages.set(this, frameMessages);
        iframePosts.push(spyOn(frameWindow, 'postMessage').mockImplementation((data) => {
          frameMessages.push(hostMessageSchema.parse(data));
        }));
      }
      return frameWindow;
    },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const renderSection = (directory: string) => (
    <I18nProvider><ThemeSystemContext.Provider value={activeThemeContext}>
      <SyncProvider sdk={sdk} directory={directory}><WorkStatusExtensionSection guest={guest} directory={directory} /></SyncProvider>
    </ThemeSystemContext.Provider></I18nProvider>
  );
  try {
    await act(async () => root.render(renderSection('/visible')));
    for (let attempt = 0; attempt < 100 && !container.querySelector('iframe'); attempt++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    const frame = container.querySelector<HTMLIFrameElement>('iframe');
    if (!frame) throw new Error('Status frame did not mount');
    expect(container.textContent).toContain('Recent commits');
    expect(frame.src.includes('/api/guests/git-graph/status/index.html')).toBe(true);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    const box = frame.parentElement;
    if (!box) throw new Error('Frame box missing');
    expect(box.style.height).toBe('140px');

    const source = frame.contentWindow;
    if (!source) throw new Error('Guest window is missing');
    const messages = iframeMessages.get(frame);
    if (!messages) throw new Error('Guest message collector is missing');
    const send = (message: GuestMessage) => window.dispatchEvent(new MessageEvent('message', { source, data: message }));
    const projectSnapshots = () => messages.flatMap((message) => (
      message.type === 'workspace' && message.payload.subscriptionId === 'projects' && message.payload.snapshot.kind === 'projects'
        ? [message.payload.snapshot]
        : []
    ));
    await act(async () => { send({ channel: 'openchamber.sdk', v: 1, type: 'hello' }); });
    expect(messages.find((message) => message.type === 'ready')).toMatchObject({
      payload: {
        surface: 'status', item: null,
        features: { deviceStorage: true, statusControls: true },
        theme: { tokens: { syntaxKeyword: theme.colors.syntax.base.keyword, syntaxString: theme.colors.syntax.base.string } },
      },
    });

    // Opening a preview must create a separately-addressable sandbox. A shared
    // contentWindow would let an old child impersonate its owner.
    Object.defineProperties(frame, {
      clientWidth: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 140 },
    });
    spyOn(frame, 'getBoundingClientRect').mockReturnValue(new dom.DOMRect(20, 30, 300, 140));
    // Happy DOM has no hit testing. Supply the browser's owner-frame hover state.
    const matches = frame.matches.bind(frame);
    spyOn(frame, 'matches').mockImplementation((selector) => selector === ':hover' || matches(selector));
    await act(async () => {
      send({
        channel: 'openchamber.sdk', v: 1, type: 'popover-open', id: 'unfocused-request',
        payload: { id: 'unfocused', anchor: { x: 12, y: 12, width: 24, height: 20 }, width: 240, height: 120, focus: true, data: null },
      });
    });
    expect(document.querySelector('[data-guest-popover-overlay]')).toBeNull();
    expect(messages.find((message) => message.type === 'result' && message.id === 'unfocused-request')).toMatchObject({ ok: false });
    await act(async () => {
      send({
        channel: 'openchamber.sdk', v: 1, type: 'popover-open', id: 'open-preview',
        payload: { id: 'preview-1', anchor: { x: 12, y: 12, width: 24, height: 20 }, width: 240, height: 120, data: { sha: 'abc123' } },
      });
      await Promise.resolve();
    });
    const popover = document.querySelector<HTMLElement>('[data-guest-popover-overlay]');
    const child = popover?.querySelector<HTMLIFrameElement>('iframe');
    if (!popover || !child || !child.contentWindow) throw new Error('Popover frame did not mount');
    const childSource = child.contentWindow;
    const childMessages = iframeMessages.get(child);
    if (!childMessages) throw new Error('Popover message collector is missing');
    expect(childSource).not.toBe(source);
    expect(child.src.includes('/api/guests/git-graph/status/index.html')).toBe(true);
    expect(child.getAttribute('sandbox')).toBe('allow-scripts');

    // Pointer previews do not steal the owner's focus when their child loads.
    await act(async () => child.dispatchEvent(new Event('load')));
    expect(document.activeElement).not.toBe(child);
    const sendChild = (message: GuestMessage) => window.dispatchEvent(new MessageEvent('message', { source: childSource, data: message }));
    await act(async () => { sendChild({ channel: 'openchamber.sdk', v: 1, type: 'hello' }); });
    expect(childMessages.find((message) => message.type === 'ready')).toMatchObject({
      payload: { surface: 'popover', directory: '/visible', popover: { id: 'preview-1', data: { sha: 'abc123' } } },
    });

    await act(async () => {
      sendChild({ channel: 'openchamber.sdk', v: 1, type: 'service-request', id: 'pending-child-service', payload: { method: 'GET', path: '/commit' } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(childServiceCalls).toBe(1);

    // A popover child has no authority to nest, and a foreign window cannot
    // address either the owner or child listener.
    await act(async () => {
      sendChild({
        channel: 'openchamber.sdk', v: 1, type: 'popover-open', id: 'nested-preview',
        payload: { id: 'nested-1', anchor: { x: 1, y: 1, width: 10, height: 10 }, width: 200, height: 80, data: {} },
      });
      window.dispatchEvent(new MessageEvent('message', {
        source: window,
        data: { channel: 'openchamber.sdk', v: 1, type: 'popover-close', id: 'forged-close', payload: { id: 'preview-1' } },
      }));
      await Promise.resolve();
    });
    expect(document.querySelectorAll('[data-guest-popover-overlay]')).toHaveLength(1);
    expect(childMessages.find((message) => message.type === 'result' && message.id === 'nested-preview')).toMatchObject({ ok: false });

    // The popover's own resize affects only its wrapper, not the status frame.
    await act(async () => { sendChild({ channel: 'openchamber.sdk', v: 1, type: 'resize', id: 'child-height', payload: { height: 180 } }); });
    expect(popover.style.height).toBe('182px');
    expect(box.style.height).toBe('140px');
    activeThemeContext = { ...themeContext, currentTheme: getDefaultTheme(true) };
    await act(async () => root.render(renderSection('/visible')));
    expect(childServiceCalls).toBe(1);
    await act(async () => {
      resolveChildService?.(Response.json({ status: 200, body: 'commit detail' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(childMessages.find((message) => message.type === 'result' && message.id === 'pending-child-service')).toMatchObject({
      ok: true, payload: { status: 200, body: 'commit detail' },
    });

    // `host.close()` from the child is a real guest request, not a wrapper
    // callback. It must retire this child only.
    await act(async () => { sendChild({ channel: 'openchamber.sdk', v: 1, type: 'close', id: 'close-preview' }); });
    expect(document.querySelector('[data-guest-popover-overlay]')).toBeNull();
    expect(container.querySelector('iframe')).toBe(frame);


    await act(async () => {
      send({ channel: 'openchamber.sdk', v: 1, type: 'workspace-subscribe', id: 'subscribe-1', payload: { subscriptionId: 'projects', query: { kind: 'projects' } } });
      await Promise.resolve();
    });
    expect(projectSnapshots().at(-1)?.projects.map((project) => project.id)).toEqual(['visible']);
    await act(async () => {
      useProjectsStore.setState({ projects: [
        { id: 'visible', path: '/visible', label: 'Visible', addedAt: 1 },
        { id: 'before', path: '/before', label: 'Before', addedAt: 2 },
      ] });
      await Promise.resolve();
    });
    expect(projectSnapshots().at(-1)?.projects.map((project) => project.id)).toEqual(['visible', 'before']);

    const controls: GuestMessage = {
      channel: 'openchamber.sdk', v: 1, type: 'status-controls', id: 'controls-1',
      payload: { controls: [{ kind: 'button', id: 'refresh', label: 'Refresh' }] },
    };
    await act(async () => { send(controls); await Promise.resolve(); });
    expect(container.querySelector('[data-work-status-control="refresh"]')).not.toBeNull();

    await act(async () => {
      frame.focus();
      send({
        channel: 'openchamber.sdk', v: 1, type: 'popover-open', id: 'open-focused-preview',
        payload: { id: 'preview-2', anchor: { x: 12, y: 12, width: 24, height: 20 }, width: 240, height: 120, focus: true, data: { sha: 'def456' } },
      });
      await Promise.resolve();
    });
    const focusedChild = document.querySelector<HTMLIFrameElement>('[data-guest-popover-overlay] iframe');
    if (!focusedChild?.contentWindow) throw new Error('Focused popover frame did not mount');
    const focusedChildSource = focusedChild.contentWindow;
    await act(async () => focusedChild.dispatchEvent(new Event('load')));
    expect(document.activeElement).toBe(focusedChild);

    await act(async () => {
      send({ channel: 'openchamber.sdk', v: 1, type: 'storage', id: 'storage-1', payload: { op: 'keys' } });
      await Promise.resolve();
    });
    expect(messages.some((message) => message.type === 'result' && message.id === 'storage-1')).toBe(false);

    await act(async () => root.render(renderSection('/other')));
    expect(container.querySelector('iframe')).toBe(frame);
    expect(container.querySelector('[data-work-status-control="refresh"]')).toBeNull();
    expect(document.querySelector('[data-guest-popover-overlay]')).toBeNull();
    // The retired child source cannot mutate the composer after its owner
    // changes directory. Owner subscriptions and the pending storage request
    // below remain live across this same transition.
    useInputStore.getState().setPendingInputText(null);
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: focusedChildSource,
        data: { channel: 'openchamber.sdk', v: 1, type: 'compose', id: 'stale-compose', payload: { text: 'stale child mutation' } },
      }));
      await Promise.resolve();
    });
    expect(useInputStore.getState().pendingInputText).toBeNull();

    await act(async () => {
      useProjectsStore.setState({ projects: [
        { id: 'visible', path: '/visible', label: 'Visible', addedAt: 1 },
        { id: 'before', path: '/before', label: 'Before', addedAt: 2 },
        { id: 'after', path: '/after', label: 'After', addedAt: 3 },
      ] });
      await Promise.resolve();
    });
    expect(projectSnapshots().at(-1)?.projects.map((project) => project.id)).toEqual(['visible', 'before', 'after']);

    await act(async () => {
      resolveStorage?.(Response.json({ storage: true, op: 'keys', keys: ['saved'] }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(messages.find((message) => message.type === 'result' && message.id === 'storage-1')).toMatchObject({
      ok: true,
      payload: { storage: true, op: 'keys', keys: ['saved'] },
    });

    await act(async () => { send({ ...controls, id: 'controls-2' }); await Promise.resolve(); });
    expect(container.querySelector('[data-work-status-control="refresh"]')).not.toBeNull();

    await act(async () => { send({ channel: 'openchamber.sdk', v: 1, type: 'resize', id: 'h-1', payload: { height: 96 } }); });
    expect(box.style.height).toBe('96px');
    await act(async () => { send({ channel: 'openchamber.sdk', v: 1, type: 'resize', id: 'h-2', payload: { height: 2000 } }); });
    expect(box.style.height).toBe('320px');
    expect(messages.some((message) => message.type === 'result' && message.id === 'h-2' && message.ok)).toBe(true);
    // Status-only: the catalog has no panel entry, and that must not tear the section down.
    expect(container.querySelector('iframe')).not.toBeNull();

    const header = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (!header) throw new Error('Section header missing');
    await act(async () => header.click());
    expect(container.querySelector('iframe')).toBeNull();
    // Reopening starts at the height the page last asked for, not the manifest default.
    await act(async () => header.click());
    expect(container.querySelector('iframe')?.parentElement?.style.height).toBe('320px');

    // Changing either installation identity or approved origins replaces the
    // frame, so stale header bindings cannot address the new installation.
    let previousFrame = container.querySelector('iframe');
    const approvedOriginsGuest = { ...guest, origins: ['https://second.example'] };
    for (const nextGuest of [approvedOriginsGuest, {
      ...approvedOriginsGuest, storageId: '22222222-2222-4222-8222-222222222222',
    }]) {
      await act(async () => {
        useGuestsStore.getState().replaceCatalog([nextGuest], runtimeKey);
        await Promise.resolve();
      });
      for (let attempt = 0; attempt < 100 && container.querySelector('iframe') === previousFrame; attempt++) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      }
      const replacementFrame = container.querySelector('iframe');
      expect(replacementFrame).not.toBeNull();
      expect(replacementFrame).not.toBe(previousFrame);
      expect(container.querySelector('[data-work-status-control="refresh"]')).toBeNull();
      previousFrame = replacementFrame;
    }
    // Catalog authorization changes revoke child effects synchronously, even
    // before React has removed the old iframe from the document.
    for (const revoked of [
      { ...guest, enabled: false },
      { ...guest, capabilities: { requested: guest.capabilities.requested, granted: [] } },
      { ...guest, origins: ['https://changed.example'] },
    ]) {
      await act(async () => { useGuestsStore.getState().replaceCatalog([guest], runtimeKey); });
      for (let attempt = 0; attempt < 100 && !container.querySelector('iframe'); attempt++) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      }
      const owner = container.querySelector<HTMLIFrameElement>('iframe');
      if (!owner?.contentWindow) throw new Error('Owner frame missing');
      Object.defineProperties(owner, {
        clientWidth: { configurable: true, value: 300 }, clientHeight: { configurable: true, value: 140 },
      });
      spyOn(owner, 'getBoundingClientRect').mockReturnValue(new dom.DOMRect(20, 30, 300, 140));
      await act(async () => {
        owner.focus();
        window.dispatchEvent(new MessageEvent('message', { source: owner.contentWindow, data: {
          channel: 'openchamber.sdk', v: 1, type: 'popover-open', id: 'open-revocable',
          payload: { id: 'revocable', anchor: { x: 1, y: 1, width: 20, height: 20 }, width: 240, height: 120, data: null },
        } }));
      });
      const child = document.querySelector<HTMLIFrameElement>('[data-guest-popover-overlay] iframe');
      if (!child?.contentWindow) throw new Error('Revocable child missing');
      const retiredSource = child.contentWindow;
      useInputStore.getState().setPendingInputText(null);
      await act(async () => {
        useGuestsStore.getState().replaceCatalog([revoked], runtimeKey);
        window.dispatchEvent(new MessageEvent('message', { source: retiredSource, data: {
          channel: 'openchamber.sdk', v: 1, type: 'compose', id: 'revoked-compose', payload: { text: 'revoked child mutation' },
        } }));
      });
      expect(useInputStore.getState().pendingInputText).toBeNull();
      expect(document.querySelector('[data-guest-popover-overlay]')).toBeNull();
    }
  } finally {
    await act(async () => {
      resolveChildService?.(Response.json({ status: 200, body: 'commit detail' }));
      root.unmount();
    });
    for (const post of iframePosts) post.mockRestore();
    fetch.mockRestore();
    useProjectsStore.setState(previousProjects, true);
    if (contentWindowDescriptor) Object.defineProperty(dom.HTMLIFrameElement.prototype, 'contentWindow', contentWindowDescriptor);
    else Reflect.deleteProperty(dom.HTMLIFrameElement.prototype, 'contentWindow');
    if (indexedDBDescriptor) Object.defineProperty(globalThis, 'indexedDB', indexedDBDescriptor);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
    setRuntimeUrlResolver(previousRuntimeUrlResolver);
    opencodeClient.reconnectToRuntimeBaseUrl();
    useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
    await dom.happyDOM.close();
    for (const frameWindow of iframeWindows.values()) await frameWindow.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('a project-required status section reports absent without the actual Work Status directory', async () => {
  const dom = new Window({ url: 'http://guest.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, getComputedStyle: dom.getComputedStyle.bind(dom), Event: dom.Event,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const theme = getDefaultTheme(false);
  const themeContext: ThemeContextValue = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
    reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
    isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
    lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
  };
  const guest: InstalledGuest = {
    id: 'project-status', name: 'Project status', icon: 'git-commit', statusEntry: 'status/index.html', statusRequiresProject: true,
    capabilities: { requested: [], granted: [] },
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const presence: Array<[string, boolean]> = [];
  try {
    for (const directory of [null, '']) {
      await act(async () => root.render(<I18nProvider><ThemeSystemContext.Provider value={themeContext}>
        <PresenceContext.Provider value={(id, present) => presence.push([id, present])}>
          <WorkStatusExtensionSection guest={guest} directory={directory} />
        </PresenceContext.Provider>
      </ThemeSystemContext.Provider></I18nProvider>));
      expect(container.querySelector('[data-guest-status-body]')).toBeNull();
    }
    expect(presence.some(([, present]) => !present)).toBe(true);
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
