import { act } from 'react';
import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { OpenCode } from '@opencode/client';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';

import { OpenUIHostContext, type OpenUIHost } from '../../openui/openuiHost';

// Base UI's portal detects DOM availability at import time.
const importWindow = new Window();
const importGlobals = ['window', 'document'] as const;
const beforeImport = importGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: importWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: importWindow.document, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { HtmlRenderDocument } = await import('./HtmlRenderFrame');
const { OpenUIHtmlView } = await import('./OpenUIHtmlView');
for (const [name, descriptor] of beforeImport) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
void importWindow.happyDOM.close();

const light = getDefaultTheme(false);
const dark = getDefaultTheme(true);
const context = (currentTheme = light): ThemeContextValue => ({
  currentTheme,
  availableThemes: [light, dark],
  setTheme: () => {},
  customThemesLoading: false,
  reloadCustomThemes: async () => {},
  importTheme: async () => currentTheme,
  deleteImportedTheme: async () => {},
  customThemeIds: [],
  isSystemPreference: false,
  setSystemPreference: () => {},
  themeMode: currentTheme.metadata.variant,
  setThemeMode: () => {},
  lightThemeId: light.metadata.id,
  darkThemeId: dark.metadata.id,
  setLightThemePreference: () => {},
  setDarkThemePreference: () => {},
});

const previous = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;

function installDom() {
  const win = new Window({ url: 'http://localhost' });
  const globals = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    localStorage: win.localStorage,
    HTMLElement: win.HTMLElement,
    HTMLIFrameElement: win.HTMLIFrameElement,
    HTMLButtonElement: win.HTMLButtonElement,
    Element: win.Element,
    MessageEvent: win.MessageEvent,
    Node: win.Node,
    NodeFilter: win.NodeFilter,
    MutationObserver: win.MutationObserver,
    ResizeObserver: win.ResizeObserver,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  configureRuntimeUrlResolver({ apiBaseUrl: 'http://localhost' });
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/session-warming')) return Response.json({ revision: 1, enabled: false, minutes: 5, sessions: [] });
    return Response.json({});
  };
  return win;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  previous.clear();
});

test('keeps one document through pending and theme rerenders, then unloads it once', async () => {
  const win = installDom();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const state = { waiting: true, answer: null, pending: true };
  const render = async (theme = light, onContentHeight = () => {}) => {
    await act(async () => {
      root.render(
        <ThemeSystemContext.Provider value={context(theme)}>
          <HtmlRenderDocument partId="part" viewId="view" html="<p>page</p>" title="Page" answerState={state} onContentHeight={onContentHeight} />
        </ThemeSystemContext.Provider>,
      );
    });
  };

  try {
    await render();
    const frame = container.querySelector('iframe')!;
    const source = frame.srcdoc;
    const messages: unknown[] = [];
    const contentWindow = frame.contentWindow!;
    contentWindow.postMessage = (message: unknown) => { messages.push(message); };

    await render(dark, () => {});
    expect(container.querySelector('iframe')).toBe(frame);
    expect(frame.srcdoc).toBe(source);
    expect(messages.filter((message) => (message as { type?: string }).type === 'openchamber:html-render:unload')).toHaveLength(0);

    await act(async () => { root.unmount(); });
    expect(messages.filter((message) => (message as { type?: string }).type === 'openchamber:html-render:unload')).toHaveLength(1);
  } finally {
    await win.happyDOM.abort();
  }
});

test('HtmlView relays the current nonce once and keeps reusable Markdown answers open', async () => {
  const win = installDom();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const answers: unknown[] = [];
  const replies: unknown[] = [];
  const html = '<p>Answer here</p>';
  const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/event')) return new Response(new ReadableStream({ start(controller) {
      init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
    return Response.json([]);
  } });
  let host: OpenUIHost = {
    owner: { runtimeKey: 'runtime', directory: '/repo', sessionId: 's', messageId: 'm', partId: 'p' },
    renderKey: 'source',
    access: { kind: 'interactive' }, answer: null,
    initialMediaSources: [],
    canInteract: () => true,
    submit: async (answer) => { answers.push(answer); },
    submission: { kind: 'ready', answer: null },
  };
  const draw = () => act(async () => root.render(
    <I18nProvider><ThemeSystemContext.Provider value={context()}><SyncProvider sdk={sdk} directory="/repo">
      <OpenUIHostContext.Provider value={{ host, occurrence: 'children.0' }}>
        <OpenUIHtmlView html={html} title="Choice" />
      </OpenUIHostContext.Provider>
    </SyncProvider></ThemeSystemContext.Provider></I18nProvider>,
  ));
  try {
    await draw();
    const frame = container.querySelector('iframe');
    if (!frame?.contentWindow) throw new Error('Missing HtmlView frame');
    const page = new win.DOMParser().parseFromString(frame.srcdoc, 'text/html');
    const nonce = JSON.parse(page.getElementById('oc-html-render-nonce')?.textContent ?? 'null');
    frame.contentWindow.postMessage = (message: unknown) => { replies.push(message); };
    const send = (nonce: string) => window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      data: { jsonrpc: '2.0', id: answers.length + 1, method: 'ui/message', params: {
        role: 'user', content: [{ type: 'text', text: 'Use one' }],
        _meta: { 'openchamber/data': { choice: 1 }, 'openchamber/nonce': nonce },
      } },
    }));
    await act(async () => { send('wrong-document'); });
    expect(answers).toHaveLength(0);
    await act(async () => { send(nonce); });
    expect(answers).toEqual([{ summary: 'Use one', data: { choice: 1 } }]);
    host = { ...host, submission: { kind: 'accepted', answer: { choice: 1 } }, answer: { choice: 1 } };
    await draw();
    expect(container.querySelector('iframe')).toBe(frame);
    await act(async () => { send(nonce); });
    expect(answers).toHaveLength(2);
    expect(replies.at(-1)).toMatchObject({ nonce, result: { waiting: true } });
    host = { ...host, access: { kind: 'readonly', reason: 'Settled' }, canInteract: () => false };
    await draw();
    await act(async () => { send(nonce); });
    expect(answers).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    await win.happyDOM.abort();
  }
});

test('HtmlView restores measured height only for the same page and document', async () => {
  const win = installDom();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/event')) return new Response(new ReadableStream({ start(controller) {
      init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
    return Response.json([]);
  } });
  const host: OpenUIHost = {
    owner: { runtimeKey: 'height-runtime', directory: '/repo', sessionId: 's', messageId: 'm', partId: 'p' },
    renderKey: 'original', access: { kind: 'interactive' }, answer: null,
    initialMediaSources: [], canInteract: () => true, submit: async () => {},
    submission: { kind: 'ready', answer: null },
  };
  const draw = (occurrence = 'children.0', html = '<p>Long page</p>', renderKey = 'original') => act(async () => root.render(
    <I18nProvider><ThemeSystemContext.Provider value={context()}><SyncProvider sdk={sdk} directory="/repo">
      <OpenUIHostContext.Provider value={{ host: { ...host, renderKey }, occurrence }}>
        <OpenUIHtmlView html={html} />
      </OpenUIHostContext.Provider>
    </SyncProvider></ThemeSystemContext.Provider></I18nProvider>,
  ));
  const height = () => container.querySelector('iframe')?.parentElement?.style.height;
  try {
    await draw();
    const frame = container.querySelector('iframe')!;
    await act(async () => { window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow, data: { type: 'openchamber:html-render:size', height: 1200 },
    })); });
    expect(height()).toBe('1200px');
    await act(async () => root.render(null));
    await draw();
    expect(height()).toBe('1200px');
    await draw('children.1');
    expect(height()).toBe('48px');
    await draw('children.0', '<p>Changed page</p>');
    expect(height()).toBe('48px');
    await draw('children.0', '<p>Long page</p>', 'replacement');
    expect(height()).toBe('48px');
    await act(async () => root.render(null));
    await draw();
    expect(height()).toBe('1200px');
    const openFullscreen = container.querySelector<HTMLButtonElement>('button[aria-label="Open full screen"]');
    if (!openFullscreen) throw new Error('Missing fullscreen action');
    await act(async () => openFullscreen.click());
    const fullscreen = document.querySelector<HTMLIFrameElement>('[role="dialog"] iframe');
    if (!fullscreen) throw new Error('Missing fullscreen frame');
    await act(async () => { window.dispatchEvent(new MessageEvent('message', {
      source: fullscreen.contentWindow, data: { type: 'openchamber:html-render:size', height: 1600 },
    })); });
    expect(fullscreen.style.height).toBe('1600px');
    await act(async () => root.render(null));
    await draw();
    expect(height()).toBe('1600px');
  } finally {
    await act(async () => root.unmount());
    await win.happyDOM.abort();
  }
});
