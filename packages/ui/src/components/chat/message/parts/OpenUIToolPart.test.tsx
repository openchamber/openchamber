import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import type { TextPart, ToolPart } from '@/lib/opencode/model';
import { ChatColumnSessionContext } from '@/components/chat/chatColumnSession';
import { I18nProvider } from '@/lib/i18n';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { opencodeClient } from '@/lib/opencode/client';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { useUIStore } from '@/stores/useUIStore';
import { SyncProvider, useDirectoryStore } from '@/sync/sync-context';
import type { DirectoryStore } from '@/sync/child-store';
import type { StoreApi } from 'zustand';
import { OpenUISessionProvider } from '../../openuiSession';
import { ShownInterface } from './OpenUIToolPart';
import { MarkdownContent } from '../../MarkdownRendererImpl';
import { useConfigStore } from '@/stores/useConfigStore';
import { useInputStore } from '@/sync/input-store';
import { setOptimisticRefs } from '@/sync/session-actions';
import AssistantTextPart from './AssistantTextPart';
import { loadMarkdownRendererModule } from '../../markdownRendererLoader';
import { useDirectoryStore as useDirectorySelection } from '@/stores/useDirectoryStore';
import { KeepAlive } from '@/components/ui/KeepAlive';

const browser = new Window({ url: 'http://openui-tool.test/' });
browser.document.write('<!doctype html><html><head></head><body></body></html>');
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  customElements: browser.customElements,
  HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement,
  Event: browser.Event,
  MessageEvent: browser.MessageEvent,
  Element: browser.Element,
  Node: browser.Node,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  IntersectionObserver: browser.IntersectionObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis.navigator, 'userActivation', { configurable: true, value: undefined });
const { createRoot } = await import('react-dom/client');

const source = `root = Stack([form])
$name = "Alice"
form = Form("prefs", Buttons([Button("Send", @ToAssistant("Use name"))]), [FormControl("Name", Input("name", null, "text", null, $name))])`;
const realFetch = globalThis.fetch;
const sdk = OpenCode.make({ baseUrl: 'http://openui-tool.test', fetch: async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.includes('/event')) {
    return new Response(new ReadableStream({ start(controller) {
      init?.signal?.addEventListener('abort', () => {
        try { controller.close(); } catch { /* The stream may already be closed. */ }
      }, { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  }
  return Response.json([]);
} });
let root: Root;
let host: HTMLDivElement;
let answerRequests: unknown[];
let directoryStore: StoreApi<DirectoryStore>;
let originalDirectory: string;

function StoreProbe() {
  directoryStore = useDirectoryStore('/repo', { bootstrap: false });
  return null;
}

const digest = async (value: string) => {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((entry) => entry.toString(16).padStart(2, '0')).join('');
};

const part = (ui = source): ToolPart => ({
  id: 'part',
  callID: 'call',
  type: 'tool',
  tool: 'openchamber_openui',
  messageID: 'message',
  sessionID: 'session',
  state: { status: 'running', input: { action: 'openui.prompt', parameters: { ui } }, time: { start: 1 } },
});

const answeredPart = (): ToolPart => ({
  ...part(),
  state: {
    status: 'completed',
    input: { action: 'openui.prompt', parameters: { ui: source } },
    output: '',
    metadata: { openchamber: { ok: true, answer: { answered: true, summary: 'Use compact cards', data: { layout: 'compact' } } } },
    time: { start: 1, end: 2 },
  },
});

const terminalPart = (answer: { answered: false } | { answered: true; summary: string; data: Record<string, string> }): ToolPart => ({
  ...part(),
  state: {
    status: 'completed',
    input: { action: 'openui.prompt', parameters: { ui: source } },
    output: '',
    metadata: { openchamber: { ok: true, answer } },
    time: { start: 1, end: 2 },
  },
});

function TestEnvironment({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <ThemeSystemProvider>
        <SyncProvider sdk={sdk} directory="/repo">
          <StoreProbe />
          {children}
        </SyncProvider>
      </ThemeSystemProvider>
    </I18nProvider>
  );
}

const renderContent = async (children: React.ReactNode) => {
  await act(async () => root.render(
    <TestEnvironment>
      <ChatColumnSessionContext.Provider value={{ sessionId: 'session', directory: '/repo' }}>
        <OpenUISessionProvider sessionId="session" directory="/repo">
          {children}
        </OpenUISessionProvider>
      </ChatColumnSessionContext.Provider>
    </TestEnvironment>,
  ));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
};

const render = (tool = part(), visible = true, markdown?: string) => renderContent(
  markdown ? <MarkdownContent content={markdown} directory="/repo" enableFileReferences={false}
    openuiOwner={{ sessionId: 'session', messageId: 'message', partId: 'part' }} />
    : visible && <ShownInterface part={tool} />,
);

const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (predicate()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
  throw new Error('Timed out waiting for the OpenUI renderer');
};

const sendButton = () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Send');

const assertRendererMounted = async () => {
  await waitFor(() => host.querySelector('input') !== null);
  expect(host.querySelector('pre')).toBeNull();
  expect(sendButton()).not.toBeUndefined();
  expect(document.querySelector('[data-openui-devtools-auto-mount]') === null).toBe(true);
};

beforeEach(() => {
  originalDirectory = useDirectorySelection.getState().currentDirectory;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  answerRequests = [];
  useUIStore.setState({ agentRenderToolEnabled: true });
  useGlobalBlockingRequestsStore.setState({ bySession: new Map() });
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/session-warming')) return Response.json({ revision: 1, enabled: false, minutes: 5, sessions: [] });
    if (url.includes('/api/location')) return Response.json({ directory: '/repo', project: { directory: '/repo' } });
    if (url.includes('/api/project') || url.includes('/api/config')) return Response.json([]);
    if (url.includes('/api/form') || url.includes('/api/permission')) return Response.json({ data: [] });
    if (url.includes('/api/vcs')) return Response.json({ data: { branch: { current: 'main', default: 'main' } } });
    if (url.includes('/api/session/active')) return Response.json({ data: {} });
    if (url.includes('/api/shell')) return Response.json({ location: { directory: '/repo' }, data: [] });
    if (url.includes('/api/session')) return Response.json({ data: [], cursor: {} });
    if (url.includes('/api/fs/home')) return Response.json({ home: '/home/test' });
    if (url.includes('/api/openchamber/openui/answer')) {
      const body = input instanceof Request ? await input.json() : JSON.parse(String(init?.body));
      answerRequests.push(body);
      return Response.json({});
    }
    return Response.json({});
  };
  switchRuntimeEndpoint({ apiBaseUrl: 'http://openui-tool.test', runtimeKey: 'runtime-a' });
  configureRuntimeUrlResolver({ apiBaseUrl: 'http://openui-tool.test' });
  opencodeClient.reconnectToRuntimeBaseUrl();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  globalThis.fetch = realFetch;
  useDirectorySelection.setState({ currentDirectory: originalDirectory });
});

afterAll(() => browser.happyDOM.abort());

test('Markdown renders the reported icon gallery and nested Cards through the production mount', async () => {
  const names = ['arrow-right-line', 'arrow-left-line', 'arrow-up-line', 'arrow-down-line',
    'arrow-right-s-line', 'arrow-right-circle-line', 'exchange-line', 'route-line'];
  const cards = names.map((name) => `Card([Icon("${name}", {size: "xl"}), TextContent("${name}")])`);
  const source = `root = Stack([Grid([${cards.join(', ')}], {columns: 4}), Card([Card([TextContent("Payload")])])])`;
  const text = `\`\`\`openui-lang\n${source}\n\`\`\`\n`;
  await render(part(), false);
  await act(async () => directoryStore.setState({ part: {
    message: [{ type: 'text', id: 'part', sessionID: 'session', messageID: 'message', text }],
  } }));
  await render(part(), false, text);
  await waitFor(() => host.querySelectorAll('.openui-card svg').length === names.length);
  expect(host.querySelector('pre')).toBeNull();
  expect(host.querySelector('svg use')).toBeNull();
  expect(host.querySelectorAll('.openui-card')).toHaveLength(10);
  expect(host.textContent).toContain('Payload');
  expect(answerRequests).toEqual([]);
});

for (const answered of [true, false]) test(`completed prompts retain images after ${answered ? 'UI' : 'chat'} answers without a live wait`, async () => {
  const fetchBefore = globalThis.fetch;
  const Observer = browser.IntersectionObserver;
  const inspected: string[] = [];
  Object.defineProperty(browser, 'IntersectionObserver', { configurable: true, value: undefined });
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('/api/fs/stat')) {
      const path = new URL(String(input)).searchParams.get('path') ?? '';
      inspected.push(path);
      return Response.json({ isFile: true, path, size: 12 });
    }
    if (String(input).includes('url-token')) return Response.json({ token: 'test-token', expiresAt: Date.now() + 60_000 });
    return fetchBefore(input, init);
  };
  const ui = `root = Stack([Image("Saved", "completed-${answered}.png"), Input("answer")])`;
  const tool: ToolPart = {
    ...part(ui),
    state: { status: 'completed', input: { action: 'openui.prompt', parameters: { ui } }, output: '', time: { start: 1, end: 2 },
      metadata: { openchamber: { ok: true, answer: answered ? { answered: true, summary: 'Saved', data: {} } : { answered: false } } } },
  };
  try {
    useDirectorySelection.setState({ currentDirectory: '/repo' });
    await render(tool, false);
    await act(async () => directoryStore.setState({ part: { message: [tool] } }));
    await render(tool);
    await waitFor(() => host.querySelector('img') !== null);
    expect(inspected).toEqual([`/repo/completed-${answered}.png`]);
    expect(host.querySelector('input')?.disabled).toBe(true);
    expect(answerRequests).toEqual([]);
  } finally {
    globalThis.fetch = fetchBefore;
    Object.defineProperty(browser, 'IntersectionObserver', { configurable: true, value: Observer });
  }
});

test('Markdown regrouping restores edited fields through the session owner without a warm source fallback', async () => {
  await render(part(), false);
  const fence = '```openui-lang\nroot = Stack([Input("name", null, "text", null, "Alice")])\n```\n\n';
  const first = `Before.\n\n${fence}After.\n\n`;
  const draw = async (text: string) => {
    await act(async () => directoryStore.setState({ part: {
      message: [{ type: 'text', id: 'part', sessionID: 'session', messageID: 'message', text }],
    } }));
    await renderContent(<MarkdownContent content={text} directory="/repo" enableFileReferences={false}
      mode="streaming" isStreaming openuiOwner={{ sessionId: 'session', messageId: 'message', partId: 'part' }} />);
  };
  await draw(first);
  await waitFor(() => host.querySelector('input') !== null);
  const input = host.querySelector('input');
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  if (!input || !setter) throw new Error('Missing generated field');
  await act(async () => {
    setter.call(input, 'Grace');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  let sourceFallbacks = 0;
  const observer = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node instanceof Element && (node.matches('pre') || node.querySelector('pre'))) sourceFallbacks++;
    }
  });
  observer.observe(host, { childList: true, subtree: true });
  try {
    await draw(first + '[late]: https://example.test\n');
    expect(host.querySelector('input') === input).toBe(false);
    expect(host.querySelector('input')?.value).toBe('Grace');
    expect(sourceFallbacks).toBe(0);
  } finally {
    observer.disconnect();
  }
}, 15000);

test('AssistantTextPart retains its completed program through actual throttle lag and part settlement', async () => {
  await loadMarkdownRendererModule();
  useDirectorySelection.setState({ currentDirectory: '/repo' });
  await render(part(), false);
  const fence = '```openui-lang\nroot = Stack([Input("name", null, "text", null, "Alice"), title])\n';
  const draw = async (text: string, finalized = false) => {
    const textPart: TextPart = {
      type: 'text', id: 'part', sessionID: 'session', messageID: 'message', text,
      time: finalized ? { start: 1, end: 2 } : { start: 1 },
    };
    await act(async () => directoryStore.setState({ part: { message: [textPart] } }));
    await renderContent(<AssistantTextPart part={textPart} messageId="message" streamPhase="streaming" allowOpenUI />);
  };
  await draw(fence + 'title = TextContent("Partial');
  await waitFor(() => host.querySelector('input') !== null);
  expect(host.querySelector('input')?.disabled).toBe(true);
  expect(host.textContent).toContain('Partial');
  const completed = fence + 'title = TextContent("Complete")\n```\n\n';
  await draw(completed);
  await waitFor(() => host.querySelector('input')?.disabled === false);
  const input = host.querySelector('input');
  await draw(completed + 'One');
  await draw(completed + 'One more paragraph');
  expect(host.querySelector('input') === input).toBe(true);
  expect(host.querySelector('pre')).toBeNull();
  await draw(completed + 'One more paragraph', true);
  expect(host.querySelector('input') === input).toBe(true);
  expect(host.textContent).toContain('One more paragraph');
}, 15000);

test('Activity restore never commits a source fallback for an already loaded OpenUI', async () => {
  await loadMarkdownRendererModule();
  useDirectorySelection.setState({ currentDirectory: '/repo' });
  await render(part(), false);
  const text = '```openui-lang\nroot = Stack([Input("name", null, "text", null, "Alice")])\n```\n\n';
  let textPart: TextPart = {
    type: 'text', id: 'part', sessionID: 'session', messageID: 'message', text,
    time: { start: 1 },
  };
  await act(async () => directoryStore.setState({ part: { message: [textPart] } }));
  // act() flushes the later recovery render too. Inspect each commit so a
  // temporary source fallback cannot pass just because the final DOM is valid.
  const commits: Array<{ sources: number; inputs: number }> = [];
  const draw = (sessionId: string) => act(async () => root.render(
    <TestEnvironment>
      <React.Profiler id="retained-openui" onRender={() => {
        if (sessionId === 'session') commits.push({ sources: host.querySelectorAll('pre').length, inputs: host.querySelectorAll('input').length });
      }}>
        <KeepAlive cacheKey={sessionId} capacity={2}>
          <ChatColumnSessionContext.Provider value={{ sessionId, directory: '/repo' }}>
            <OpenUISessionProvider sessionId={sessionId} directory="/repo">
              {sessionId === 'session'
                ? <AssistantTextPart part={textPart} messageId="message" streamPhase="streaming" allowOpenUI />
                : <p>Other session</p>}
            </OpenUISessionProvider>
          </ChatColumnSessionContext.Provider>
        </KeepAlive>
      </React.Profiler>
    </TestEnvironment>,
  ));
  await draw('session');
  await waitFor(() => host.querySelector('input') !== null);
  expect(host.querySelector('input')?.disabled).toBe(false);

  await draw('other');
  await act(async () => {
    textPart = { ...textPart, text: text + 'Finished while hidden.', time: { start: 1, end: 2 } };
    directoryStore.setState({ part: { message: [textPart] } });
  });
  commits.length = 0;
  await draw('session');
  await waitFor(() => host.querySelector('input') !== null);
  expect(host.querySelector('input')?.disabled).toBe(false);
  expect(host.querySelector('pre')).toBeNull();
  expect(host.textContent).toContain('Finished while hidden.');
  expect(commits.length).toBeGreaterThan(0);
  expect(commits.every((commit) => commit.sources === 0 && commit.inputs === 1)).toBe(true);
  await draw('other');
  commits.length = 0;
  await draw('session');
  expect(commits.length).toBeGreaterThan(0);
  expect(commits.every((commit) => commit.sources === 0 && commit.inputs === 1)).toBe(true);
});

test('unchanged Activity children reconnect with interactive OpenUI controls', async () => {
  await loadMarkdownRendererModule();
  useDirectorySelection.setState({ currentDirectory: '/repo' });
  await render(part(), false);
  const textPart: TextPart = {
    type: 'text', id: 'part', sessionID: 'session', messageID: 'message',
    text: '```openui-lang\nroot = Stack([Input("name", null, "text", null, "Alice")])\n```\n',
    time: { start: 1, end: 2 },
  };
  await act(async () => directoryStore.setState({ part: { message: [textPart] } }));
  // Keep the same element: React can reconnect Activity effects without
  // rendering the provider, which must recover before the browser paints.
  const retained = <OpenUISessionProvider sessionId="session" directory="/repo">
    <AssistantTextPart part={textPart} messageId="message" streamPhase="completed" allowOpenUI />
  </OpenUISessionProvider>;
  const sourceCommits: number[] = [];
  const draw = (mode: 'visible' | 'hidden') => act(async () => root.render(
    <TestEnvironment>
      <ChatColumnSessionContext.Provider value={{ sessionId: 'session', directory: '/repo' }}>
        <React.Profiler id="unchanged-openui" onRender={() => {
          if (mode === 'visible') sourceCommits.push(host.querySelectorAll('pre').length);
        }}>
          <React.Activity mode={mode}>{retained}</React.Activity>
        </React.Profiler>
      </ChatColumnSessionContext.Provider>
    </TestEnvironment>,
  ));
  await draw('visible');
  await waitFor(() => host.querySelector('input') !== null);
  await draw('hidden');
  sourceCommits.length = 0;
  await draw('visible');
  expect(sourceCommits.length).toBeGreaterThan(0);
  expect(sourceCommits.every((count) => count === 0)).toBe(true);
  expect(host.querySelector('input')?.disabled).toBe(false);
  const input = host.querySelector('input');
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  if (!input || !setter) throw new Error('Missing restored input');
  await act(async () => {
    setter.call(input, 'Restored');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(host.querySelector('input')?.value).toBe('Restored');
});

test('submits one active direct prompt with the live source revision', async () => {
  const sourceRevision = await digest(source);
  await act(async () => {
    useGlobalBlockingRequestsStore.setState({ bySession: new Map([['session', {
      directory: '/repo', permissions: [], forms: [], pages: [{ id: 'call', sessionID: 'session', title: 'Pick', kind: 'openui', sourceRevision }],
    }]]) });
  });
  await render();
  await assertRendererMounted();
  await act(async () => {
    sendButton()?.click();
  });
  await waitFor(() => answerRequests.length === 1);
  expect(answerRequests).toEqual([{
    sessionId: 'session',
    callId: 'call',
    sourceRevision,
    summary: 'Use name',
    data: { params: {}, formName: 'prefs', formValues: { $name: 'Alice' } },
  }]);
  await act(async () => sendButton()?.click());
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(answerRequests).toHaveLength(1);
  expect(host.querySelector<HTMLElement>('[data-oc-openui-source]')?.dataset.ocOpenuiSource).toBe(source);
});

test('a real HtmlView bridge completes only its active tool call once', async () => {
  const ui = 'root = Stack([HtmlView("<button>Choose one</button>")])';
  const sourceRevision = await digest(ui);
  useGlobalBlockingRequestsStore.setState({ bySession: new Map([['session', {
    directory: '/repo', permissions: [], forms: [], pages: [{ id: 'call', sessionID: 'session', title: 'Pick', kind: 'openui', sourceRevision }],
  }]]) });
  await render(part(ui));
  await waitFor(() => host.querySelector('iframe') !== null);
  const frame = host.querySelector('iframe');
  if (!frame?.contentWindow) throw new Error('Missing generated HtmlView');
  const page = new browser.DOMParser().parseFromString(frame.srcdoc, 'text/html');
  const nonce = JSON.parse(page.getElementById('oc-html-render-nonce')?.textContent ?? 'null');
  const submit = () => window.dispatchEvent(new MessageEvent('message', {
    source: frame.contentWindow,
    data: { jsonrpc: '2.0', id: 1, method: 'ui/message', params: {
      role: 'user', content: [{ type: 'text', text: 'Use one' }],
      _meta: { 'openchamber/data': { choice: 1 }, 'openchamber/nonce': nonce },
    } },
  }));
  await act(async () => { submit(); submit(); });
  await waitFor(() => answerRequests.length === 1);
  expect(answerRequests).toEqual([{
    sessionId: 'session', callId: 'call', sourceRevision, summary: 'Use one', data: { choice: 1 },
  }]);
  await act(async () => { submit(); });
  expect(answerRequests).toHaveLength(1);
  expect(host.querySelector('iframe')).toBe(frame);
});

test('a Markdown HtmlView sends repeatable user turns without answering a tool', async () => {
  await render(part(), false);
  const ui = 'root = Stack([HtmlView("<button>Choose one</button>")])';
  const markdown = `\`\`\`openui-lang\n${ui}\n\`\`\``;
  await act(async () => directoryStore.setState({ part: {
    message: [{ type: 'text', id: 'part', sessionID: 'session', messageID: 'message', text: markdown }],
  } }));
  useConfigStore.setState({ currentProviderId: 'provider', isConnected: true, hasEverConnected: true });
  useInputStore.getState().setPendingInputText('Keep the composer');
  const send = spyOn(opencodeClient, 'sendMessage').mockResolvedValue('message');
  try {
    await render(part(), false, markdown);
    setOptimisticRefs(() => {}, () => {});
    await waitFor(() => host.querySelector('iframe') !== null);
    const frame = host.querySelector('iframe');
    if (!frame?.contentWindow) throw new Error('Missing Markdown HtmlView');
    const page = new browser.DOMParser().parseFromString(frame.srcdoc, 'text/html');
    const nonce = JSON.parse(page.getElementById('oc-html-render-nonce')?.textContent ?? 'null');
    const submit = () => window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      data: { jsonrpc: '2.0', id: 1, method: 'ui/message', params: {
        role: 'user', content: [{ type: 'text', text: 'Use one' }],
        _meta: { 'openchamber/data': { choice: 1 }, 'openchamber/nonce': nonce },
      } },
    }));
    for (let index = 0; index < 2; index++) {
      await act(async () => { submit(); submit(); });
      await waitFor(() => send.mock.calls.length === index + 1);
      expect(send).toHaveBeenCalledTimes(index + 1);
      expect(host.querySelector('iframe')).toBe(frame);
    }
    expect(answerRequests).toEqual([]);
    expect(useInputStore.getState().pendingInputText).toBe('Keep the composer');
  } finally {
    send.mockRestore();
  }
});

test('a streamed HtmlView diagram with a forward reference and automatic height reaches its frame', async () => {
  await render(part(), false);
  const html = "<!doctype html><html lang='zh-CN'><head><meta name='viewport' content='width=device-width,initial-scale=1'><style>body{margin:0;font-family:var(--font-sans);color:var(--foreground)}.rows{display:grid;gap:.8rem}.row{display:grid;grid-template-columns:4.2rem minmax(0,1fr);gap:.6rem;align-items:center}.label{font-size:.875rem}.packet{display:grid;grid-template-columns:repeat(3,minmax(0,1fr)) minmax(0,2fr) minmax(0,1fr);gap:3px}.part{display:flex;align-items:center;justify-content:center;min-height:3rem;padding:.25rem;text-align:center;border-radius:.35rem;font-size:.875rem;background:color-mix(in srgb,var(--tone) 22%,transparent)}.data{grid-column:4;--tone:var(--chart-1)}.tcp{grid-column:3;--tone:var(--chart-2)}.ip{grid-column:2;--tone:var(--chart-3)}.eth{grid-column:1;--tone:var(--chart-4)}.tail{grid-column:5;--tone:var(--chart-4)}.note{margin:.9rem 0 0;font-size:.875rem;color:var(--muted-foreground)}</style></head><body><div class='rows' role='img' aria-label='封装过程：应用数据保持在内层，传输层添加TCP头，网络层添加IP头，链路层添加帧头和帧尾。'><div class='row'><span class='label'>应用层</span><div class='packet'><span class='part data'>应用数据</span></div></div><div class='row'><span class='label'>传输层</span><div class='packet'><span class='part tcp'>TCP头</span><span class='part data'>应用数据</span></div></div><div class='row'><span class='label'>网络层</span><div class='packet'><span class='part ip'>IP头</span><span class='part tcp'>TCP头</span><span class='part data'>应用数据</span></div></div><div class='row'><span class='label'>链路层</span><div class='packet'><span class='part eth'>帧头</span><span class='part ip'>IP头</span><span class='part tcp'>TCP头</span><span class='part data'>应用数据</span><span class='part tail'>帧尾</span></div></div></div><p class='note'>从上往下看：每层添加自己的控制信息，把上一层的整体作为载荷。图中省略具体字段，宽度不按比例。</p></body></html>";
  const ui = `root = Stack([diagram])\ndiagram = HtmlView(${JSON.stringify(html)}, null, "TCP/IP 逐层封装示意")`;
  const draw = async (text: string, isStreaming = true) => {
    await act(async () => directoryStore.setState({ part: {
      message: [{ type: 'text', id: 'part', sessionID: 'session', messageID: 'message', text }],
    } }));
    await renderContent(<MarkdownContent content={text} directory="/repo" enableFileReferences={false}
      mode="streaming" isStreaming={isStreaming}
      openuiOwner={{ sessionId: 'session', messageId: 'message', partId: 'part' }} />);
  };
  await draw('Diagram.\n\n```openui-lang\n' + ui.slice(0, -20));
  expect(host.querySelector('iframe')).toBeNull();
  const markdown = 'Diagram.\n\n```openui-lang\n' + ui + '\n```\n\n';
  await draw(markdown);
  await waitFor(() => host.querySelector('iframe') !== null || host.querySelector('pre') !== null);
  expect(host.querySelector('pre')).toBeNull();
  const frame = host.querySelector('iframe');
  expect(frame).not.toBeNull();
  const page = new browser.DOMParser().parseFromString(frame?.srcdoc ?? '', 'text/html');
  expect(page.querySelectorAll('.row')).toHaveLength(4);
  await draw(markdown + 'After.', false);
  expect(host.querySelector('iframe') === frame).toBe(true);
}, 15000);

test('an unrelated directory part update preserves the mounted form lease', async () => {
  const sourceRevision = await digest(source);
  useGlobalBlockingRequestsStore.setState({ bySession: new Map([['session', {
    directory: '/repo', permissions: [], forms: [], pages: [{ id: 'call', sessionID: 'session', title: 'Pick', kind: 'openui', sourceRevision }],
  }]]) });
  await render();
  await assertRendererMounted();
  await act(async () => directoryStore.setState({ part: { message: [part()] } }));
  const input = host.querySelector('input');
  if (!input) throw new Error('Missing generated input');
  await act(async () => directoryStore.setState((state) => ({ part: {
    ...state.part, unrelated: [{ id: 'other', type: 'text', sessionID: 'other', messageID: 'unrelated', text: 'Changed' }],
  } })));
  expect(host.querySelector('input')).toBe(input);
  await act(async () => sendButton()?.click());
  await waitFor(() => answerRequests.length === 1);
  expect(host.textContent).toContain('Answer sent');
});

test('a virtual row remount restores entered fields through the real Renderer', async () => {
  const sourceRevision = await digest(source);
  useGlobalBlockingRequestsStore.setState({ bySession: new Map([['session', {
    directory: '/repo', permissions: [], forms: [], pages: [{ id: 'call', sessionID: 'session', title: 'Pick', kind: 'openui', sourceRevision }],
  }]]) });
  await render();
  await assertRendererMounted();
  await act(async () => directoryStore.setState({ part: { message: [part()] } }));
  const input = host.querySelector('input');
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  if (!input || !setter) throw new Error('Missing generated input');
  await act(async () => {
    setter.call(input, 'Kept through virtualization');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await render(part(), false);
  expect(host.querySelector('input')).toBeNull();
  await render();
  await assertRendererMounted();
  expect(host.querySelector('input')?.value).toBe('Kept through virtualization');
  await act(async () => sendButton()?.click());
  await waitFor(() => answerRequests.length === 1);
  expect(answerRequests[0]).toMatchObject({ data: { formValues: { $name: 'Kept through virtualization' } } });
});

test('a live wait arriving after the tool mount enables the existing controls', async () => {
  await render();
  await assertRendererMounted();
  expect(host.querySelector('input')?.disabled).toBe(true);
  const sourceRevision = await digest(source);
  await act(async () => useGlobalBlockingRequestsStore.setState({ bySession: new Map([['session', {
    directory: '/repo', permissions: [], forms: [], pages: [{ id: 'call', sessionID: 'session', title: 'Pick', kind: 'openui', sourceRevision }],
  }]]) }));
  expect(host.querySelector('input')?.disabled).toBe(false);
  await act(async () => sendButton()?.click());
  await waitFor(() => answerRequests.length === 1);
});

test('does not submit when the live wait is cancelled before the event runs', async () => {
  const sourceRevision = await digest(source);
  useGlobalBlockingRequestsStore.setState({ bySession: new Map([['session', {
    directory: '/repo', permissions: [], forms: [], pages: [{ id: 'call', sessionID: 'session', title: 'Pick', kind: 'openui', sourceRevision }],
  }]]) });
  await render();
  await assertRendererMounted();
  await act(async () => {
    useGlobalBlockingRequestsStore.setState({ bySession: new Map() });
    sendButton()?.click();
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(answerRequests).toEqual([]);
});

test('does not submit when the current live wait has another source revision', async () => {
  const sourceRevision = await digest(source);
  useGlobalBlockingRequestsStore.setState({ bySession: new Map([['session', {
    directory: '/repo', permissions: [], forms: [], pages: [{ id: 'call', sessionID: 'session', title: 'Pick', kind: 'openui', sourceRevision }],
  }]]) });
  await render();
  await assertRendererMounted();
  await act(async () => {
    useGlobalBlockingRequestsStore.setState({ bySession: new Map([['session', {
      directory: '/repo', permissions: [], forms: [], pages: [{ id: 'call', sessionID: 'session', title: 'Pick', kind: 'openui', sourceRevision: `${sourceRevision}stale` }],
    }]]) });
    sendButton()?.click();
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(answerRequests).toEqual([]);
});

test('shows the stored answer summary while exporting only the original source', async () => {
  await render(answeredPart());
  await assertRendererMounted();
  const wrapper = host.querySelector<HTMLElement>('[data-oc-openui-source]');
  expect(host.textContent).toContain('Answered: Use compact cards');
  expect(wrapper?.dataset.ocOpenuiSource).toBe(source);
  expect(wrapper?.dataset.ocCodeSource).toBe(source);
  expect(wrapper?.textContent).not.toContain('compact');
  await act(async () => sendButton()?.click());
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(answerRequests).toEqual([]);
});

test('labels answers delivered in chat and requests that ended unanswered', async () => {
  await render(terminalPart({ answered: false }));
  await assertRendererMounted();
  expect(host.textContent).toContain('Answered in the chat');

  await render({
    ...part(),
    state: { status: 'error', input: { action: 'openui.prompt', parameters: { ui: source } }, error: 'stopped', time: { start: 1, end: 2 } },
  });
  expect(host.textContent).toContain('Not answered');
});
