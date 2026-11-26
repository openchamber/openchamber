import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { Window } from 'happy-dom';
import type { Part, UserMessage } from '@/lib/opencode/model';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { ChatSurfaceProvider } from '@/components/chat/ChatSurfaceContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useUIStore } from '@/stores/useUIStore';

const { default: ChatMessage } = await import('../ChatMessage');

useUIStore.setState({ userMessageRenderingMode: 'plain', collapsibleUserMessages: false });

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
const userText: Part = {
  id: 'prt_text',
  sessionID: 'ses_1',
  messageID: 'msg_user',
  type: 'text',
  text: 'Also run the integration tests',
  time: { start: 1, end: 2 },
};

let happyWindow: Window;
let previous: Array<readonly [string, PropertyDescriptor | undefined]>;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  happyWindow = new Window({ url: 'http://localhost/' });
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const globals = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    localStorage: happyWindow.localStorage,
    customElements: happyWindow.customElements,
    Node: happyWindow.Node,
    NodeList: happyWindow.NodeList,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    SVGElement: happyWindow.SVGElement,
    Event: happyWindow.Event,
    CustomEvent: happyWindow.CustomEvent,
    MouseEvent: happyWindow.MouseEvent,
    KeyboardEvent: happyWindow.KeyboardEvent,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
    ResizeObserver: ResizeObserverStub,
    MutationObserver: happyWindow.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  container = document.createElement('div');
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

const wrap = (node: React.ReactNode) => (
  <RuntimeAPIContext.Provider value={runtimeApis}>
    <SyncProvider sdk={sdk} directory="">
      <I18nProvider>
        <TooltipProvider>
          <ChatSurfaceProvider mode="default">
            {node}
          </ChatSurfaceProvider>
        </TooltipProvider>
      </I18nProvider>
    </SyncProvider>
  </RuntimeAPIContext.Provider>
);

const created = 1_700_000_000_000;
const steerInfo = (createdAt: number): UserMessage => ({ id: 'msg_steer_1', sessionID: 'ses_1', role: 'user', time: { created: createdAt }, pending: true, steer: true });
// A slow ordinary Send: OpenCode holds it in the inbox, but it was never steered.
const slowSendInfo: UserMessage = { id: 'msg_steer_1', sessionID: 'ses_1', role: 'user', time: { created }, pending: true };
const deliveredInfo: UserMessage = { id: 'msg_steer_1', sessionID: 'ses_1', role: 'user', time: { created } };

const renderChatMessage = async (info: UserMessage) => {
  await act(async () => {
    root.render(wrap(
      <ChatMessage
        message={{ info, parts: [userText] }}
        isInActiveTurn
      />,
    ));
  });
};
const waitingBubble = () => container.querySelector('[data-user-message-bubble][data-user-message-waiting]');
const timestampShown = () => container.querySelector('[data-user-message-actions] .tabular-nums') !== null;

describe('pending steered user message', () => {
  test('a steer still held past the grace period gets a dashed bubble, and delivery clears it with history actions back', async () => {
    await renderChatMessage(steerInfo(created));
    const bubble = waitingBubble();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Waiting for the agent');
    // The status stays out of the bubble, so selecting or quoting its text does not pick it up.
    expect(bubble?.textContent).not.toContain('Waiting for the agent');
    expect(container.querySelector('button[aria-label="Revert to this message"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Copy message text"]')).not.toBeNull();
    // More menu stays available for Save as snippet while Fork and Pin are absent.
    expect(container.querySelector('button[aria-label="More actions"]')).not.toBeNull();
    expect(timestampShown()).toBe(false);

    // Delivery with identical created time still re-renders the memoized row, drops the mark, and restores Revert.
    await renderChatMessage(deliveredInfo);
    expect(waitingBubble()).toBeNull();
    expect(container.querySelector('button[aria-label="Revert to this message"]')).not.toBeNull();
    expect(timestampShown()).toBe(true);
  });

  test('a steer just sent is not marked as waiting before the grace period ends', async () => {
    await renderChatMessage(steerInfo(Date.now()));
    expect(waitingBubble()).toBeNull();
    // History actions still wait for delivery.
    expect(container.querySelector('button[aria-label="Revert to this message"]')).toBeNull();
    // The live region is already mounted, so the delayed text is announced.
    expect(container.querySelector('[role="status"]')?.textContent).toBe('');

    // The inbox echo of the same steer can carry a server time that reads as old on this clock; it must not skip the grace period.
    await renderChatMessage(steerInfo(created));
    expect(waitingBubble()).toBeNull();
  });

  test('an ordinary Send that stays pending keeps its usual bubble, however long the inbox holds it', async () => {
    await renderChatMessage(slowSendInfo);
    expect(waitingBubble()).toBeNull();
    expect(container.querySelector('button[aria-label="Revert to this message"]')).not.toBeNull();
    expect(timestampShown()).toBe(true);
  });
});
