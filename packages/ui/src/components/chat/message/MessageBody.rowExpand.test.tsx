import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { Window } from 'happy-dom';
import type { Part } from '@/lib/opencode/model';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { onRowExpand } from '@/components/chat/lib/scroll/timelineScrollIntent';

// Bun needs the asset URL that Vite normally supplies to the real renderer.
plugin({
  name: 'message-row-expand-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

const { default: MessageBody } = await import('./MessageBody');

useUIStore.setState({ userMessageRenderingMode: 'plain', collapsibleUserMessages: true });

const unavailable = (): never => { throw new Error('Message rendering must not call runtime APIs'); };
const runtimeApis: RuntimeAPIs = {
  runtime: { platform: 'web', isDesktop: false, isVSCode: false },
  get terminal() { return unavailable(); },
  get git() { return unavailable(); },
  get files() { return unavailable(); },
  get settings() { return unavailable(); },
  get permissions() { return unavailable(); },
  get notifications() { return unavailable(); },
  get sourceControl() { return unavailable(); },
};
const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: async () => Response.json([]) });
const longText: Part = { id: 'text', sessionID: 'session', messageID: 'user', type: 'text', text: 'Long user report. '.repeat(40), time: { start: 1, end: 2 } };

// Opening a long user message must let go of the end before it grows, as a
// tool row does (#6045): held on the end, the text grew upward and carried
// the start of the message off the top. A prompt stuck on top in the sticky
// header opens over its turn and keeps the reply below followed; happy-dom
// lays nothing out, so the header and the chat both read top 0, as when stuck.
for (const stuck of [false, true]) test(stuck
  ? 'expanding a prompt stuck in the sticky header keeps the timeline following'
  : 'expanding a long user message tells the timeline; collapsing it does not', async () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const observers: Array<() => void> = [];
  class ResizeObserverStub {
    constructor(private readonly callback: () => void) { observers.push(() => this.callback()); }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const globals = {
    window: happyWindow, document: happyWindow.document, navigator: happyWindow.navigator,
    localStorage: happyWindow.localStorage, customElements: happyWindow.customElements,
    Node: happyWindow.Node, NodeList: happyWindow.NodeList, Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement, SVGElement: happyWindow.SVGElement,
    Event: happyWindow.Event, CustomEvent: happyWindow.CustomEvent, MouseEvent: happyWindow.MouseEvent,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
    ResizeObserver: ResizeObserverStub, MutationObserver: happyWindow.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = document.createElement('div');
  container.dataset.scrollbar = 'chat';
  document.body.appendChild(container);
  const root = createRoot(container);
  let expands = 0;
  const stop = onRowExpand(container, () => { expands += 1; });
  const body = (
    <MessageBody
      messageId="user" parts={[longText]} isUser isMessageCompleted messageFinish="stop"
      isMobile={false} copiedCode={null} onCopyCode={() => {}} expandedTools={new Set()}
      onToggleTool={() => {}} onShowPopup={() => {}} streamPhase="completed" allowAnimation={false}
      hasTextContent onCopyMessage={() => {}} userMessagePart="bubble"
    />
  );
  const opened = stuck ? 0 : 1;

  try {
    await act(async () => {
      root.render(
        <RuntimeAPIContext.Provider value={runtimeApis}>
          <SyncProvider sdk={sdk} directory="">
            <I18nProvider>
              {stuck ? <div data-turn-sticky-header="">{body}</div> : body}
            </I18nProvider>
          </SyncProvider>
        </RuntimeAPIContext.Provider>,
      );
    });
    // The clamped text reports that it hides lines, which shows "Show more".
    // SAFETY: happy-dom's element is the global HTMLElement class installed above.
    const text = container.querySelector('div.typography-markdown-body') as HTMLElement | null;
    if (!text) throw new Error('Expected the clamped user text');
    Object.defineProperties(text, {
      clientHeight: { configurable: true, value: 40 },
      scrollHeight: { configurable: true, value: 400 },
    });
    await act(async () => { observers.forEach((notify) => notify()); });
    const link = () => [...container.querySelectorAll('button')].find((button) => /^Show (more|less)$/.test(button.textContent ?? ''));

    expect(link()?.textContent).toBe('Show more');
    await act(async () => { link()?.click(); });
    expect(link()?.textContent).toBe('Show less');
    expect(expands).toBe(opened);

    await act(async () => { link()?.click(); });
    expect(link()?.textContent).toBe('Show more');
    expect(expands).toBe(opened);

    // A click on the collapsed text opens it the same way.
    await act(async () => { text.click(); });
    expect(link()?.textContent).toBe('Show less');
    expect(expands).toBe(opened * 2);
  } finally {
    stop();
    await act(async () => { root.unmount(); });
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
