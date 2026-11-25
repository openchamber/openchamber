import React, { act } from 'react';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { Window } from 'happy-dom';
import type { Part } from '@/lib/opencode/model';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { onRowExpand } from '@/components/chat/lib/scroll/timelineScrollIntent';
import { CONTEXT_METADATA_KEY } from '@/lib/messages/contextParts';

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

const quote = (id: string, comment = ''): Part => ({
  id, sessionID: 'session', messageID: 'user', type: 'text', text: 'quoted',
  metadata: { [CONTEXT_METADATA_KEY]: { kind: 'chat-quote', quote: 'q', text: comment } },
  time: { start: 1, end: 2 },
});

let happyWindow: Window;
let previous: Array<readonly [string, PropertyDescriptor | undefined]>;
let observers: Array<() => void>;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  happyWindow = new Window({ url: 'http://localhost' });
  observers = [];
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
    Event: happyWindow.Event, CustomEvent: happyWindow.CustomEvent,
    MouseEvent: happyWindow.MouseEvent, KeyboardEvent: happyWindow.KeyboardEvent,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
    ResizeObserver: ResizeObserverStub, MutationObserver: happyWindow.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  container = document.createElement('div');
  container.dataset.scrollbar = 'chat';
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  await happyWindow.happyDOM.abort();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const renderPrompt = async (parts: Part[], stuck = false) => {
  const body = (
    <MessageBody
      messageId="user" parts={parts} isUser isMessageCompleted messageFinish="stop"
      isMobile={false} copiedCode={null} onCopyCode={() => {}} expandedTools={new Set()}
      onToggleTool={() => {}} onShowPopup={() => {}} streamPhase="completed" allowAnimation={false}
      hasTextContent onCopyMessage={() => {}} userMessagePart="bubble"
    />
  );
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
};

// The clamped text takes two lines and reports that it hides more.
const measureTwoLines = async () => {
  // SAFETY: happy-dom's element is the global HTMLElement class installed above.
  const text = container.querySelector('div.typography-markdown-body') as HTMLElement | null;
  if (!text) throw new Error('Expected the clamped user text');
  text.style.lineHeight = '20px';
  Object.defineProperties(text, {
    clientHeight: { configurable: true, value: 40 },
    scrollHeight: { configurable: true, value: 400 },
  });
  await act(async () => { observers.forEach((notify) => notify()); });
  return text;
};

const link = () => [...container.querySelectorAll('button')].find((button) => /Show (more|less)$/.test(button.textContent ?? ''));
const clickLink = () => act(async () => { link()?.click(); });

// Opening a long user message must let go of the end before it grows, as a
// tool row does (#6045): held on the end, the text grew upward and carried
// the start of the message off the top. A prompt stuck on top in the sticky
// header opens over its turn and keeps the reply below followed; happy-dom
// lays nothing out, so the header and the chat both read top 0, as when stuck.
for (const stuck of [false, true]) test(stuck
  ? 'expanding a prompt stuck in the sticky header keeps the timeline following'
  : 'expanding a long user message tells the timeline; collapsing it does not', async () => {
  let expands = 0;
  const stop = onRowExpand(container, () => { expands += 1; });
  const opened = stuck ? 0 : 1;

  try {
    await renderPrompt([longText], stuck);
    const text = await measureTwoLines();

    expect(link()?.textContent).toBe('Show more');
    await clickLink();
    expect(link()?.textContent).toBe('Show less');
    expect(expands).toBe(opened);

    await clickLink();
    expect(link()?.textContent).toBe('Show more');
    expect(expands).toBe(opened);

    // A click on the collapsed text opens it the same way.
    await act(async () => { text.click(); });
    expect(link()?.textContent).toBe('Show less');
    expect(expands).toBe(opened * 2);
  } finally {
    stop();
  }
});

// A collapsed message that hides quotes says how many it hid; without the
// count it read as if the hidden quotes were never there (#7472).
test('a collapsed message counts the quotes it hides', async () => {
  await renderPrompt([quote('q1'), quote('q2'), quote('q3'), longText]);

  // One row fits beside one line of text, so two of the three quotes wait.
  expect(link()?.textContent).toBe('+2 more · Show more');

  await clickLink();
  expect(link()?.textContent).toBe('Show less');
  expect(container.textContent?.match(/Quoted from an earlier message/g)).toHaveLength(3);
});

test('a commented quote hidden behind two lines of text is counted until the prompt is opened', async () => {
  await renderPrompt([quote('q1', 'Why this one?'), longText]);
  await measureTwoLines();

  expect(link()?.textContent).toBe('+1 more · Show more');
  expect(container.textContent).not.toContain('Why this one?');

  await clickLink();
  expect(link()?.textContent).toBe('Show less');
  expect(container.textContent).toContain('Why this one?');

  await clickLink();
  expect(link()?.textContent).toBe('+1 more · Show more');
  expect(container.textContent).not.toContain('Why this one?');
});
