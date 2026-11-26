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
import type { ChatSurfaceMode } from '@/components/chat/chatSurfaceContextValue';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useUIStore } from '@/stores/useUIStore';

const { default: MessageBody } = await import('./MessageBody');
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
const userFile: Part = {
  id: 'prt_file',
  sessionID: 'ses_1',
  messageID: 'msg_user',
  type: 'file',
  mime: 'image/png',
  url: 'data:image/png;base64,AA==',
  filename: 'shot.png',
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

const wrap = (node: React.ReactNode, surface: ChatSurfaceMode = 'default') => (
  <RuntimeAPIContext.Provider value={runtimeApis}>
    <SyncProvider sdk={sdk} directory="">
      <I18nProvider>
        <TooltipProvider>
          <ChatSurfaceProvider mode={surface}>
            {node}
          </ChatSurfaceProvider>
        </TooltipProvider>
      </I18nProvider>
    </SyncProvider>
  </RuntimeAPIContext.Provider>
);

const renderActionsRow = async (options: {
  isPending?: boolean;
  isMobile?: boolean;
  alwaysShowActions?: boolean;
  surface?: ChatSurfaceMode;
  parts?: Part[];
  hasTextContent?: boolean;
  onCopyMessage?: () => void;
  onRevert?: () => void;
  onFork?: () => void;
  onToggleContextPin?: () => void;
  messageCreatedAt?: number;
}) => {
  await act(async () => {
    root.render(wrap(
      <MessageBody
        messageId="msg_user"
        parts={options.parts ?? [userText]}
        isUser
        isPending={options.isPending}
        isMessageCompleted
        messageFinish="stop"
        messageCreatedAt={options.messageCreatedAt ?? 1_700_000_000_000}
        isMobile={options.isMobile ?? false}
        alwaysShowActions={options.alwaysShowActions}
        copiedCode={null}
        onCopyCode={() => {}}
        expandedTools={new Set()}
        onToggleTool={() => {}}
        onShowPopup={() => {}}
        streamPhase="completed"
        allowAnimation={false}
        hasTextContent={options.hasTextContent ?? true}
        onCopyMessage={options.onCopyMessage}
        onRevert={options.onRevert}
        onFork={options.onFork}
        onToggleContextPin={options.onToggleContextPin}
        userMessagePart="actions"
      />,
      options.surface ?? 'default',
    ));
  });
};

describe('pending steered user message indicator', () => {
  test('shows waiting status at rest outside the desktop hover wrapper and clears immediately on delivery', async () => {
    await renderActionsRow({ isPending: true, onCopyMessage: () => {} });

    const actionsRow = container.querySelector('[data-user-message-actions]');
    const pending = container.querySelector('[data-user-message-pending]');
    const hoverWrapper = actionsRow?.querySelector(':scope > div');
    expect(actionsRow).not.toBeNull();
    expect(pending).not.toBeNull();
    expect(pending?.getAttribute('role')).toBe('status');
    expect(pending?.textContent).toContain('Waiting for the agent');
    expect(pending?.querySelector('[data-busy-dots]')).not.toBeNull();
    // Waiting status is a direct sibling outside the hover-hidden actions wrapper and sits at inline-end.
    expect(hoverWrapper).not.toBeNull();
    expect(hoverWrapper?.contains(pending)).toBe(false);
    expect(actionsRow?.lastElementChild).toBe(pending);
    // Single-line truncation constraints keep the waiting label inside the fixed 26px/32px row on narrow panes.
    expect(actionsRow?.className).toContain('max-w-full');
    expect(actionsRow?.className).toContain('min-w-0');
    expect(hoverWrapper?.className).toContain('shrink-0');
    expect(pending?.className).toContain('min-w-0');
    expect(pending?.className).toContain('whitespace-nowrap');
    expect(pending?.querySelector('.truncate')?.textContent).toBe('Waiting for the agent');
    expect(pending?.querySelector('[data-busy-dots]')?.className).toContain('shrink-0');
    // Premature enqueue timestamp is hidden until delivery.
    expect(hoverWrapper?.querySelector('[aria-label^="Sent at"], [aria-label*="time"]')).toBeNull();

    // Clearing pending removes the waiting status in place inside the same reserved row height.
    await renderActionsRow({ isPending: false, onCopyMessage: () => {} });
    expect(container.querySelector('[data-user-message-pending]')).toBeNull();
    expect(container.querySelector('[data-user-message-actions]')?.className).toContain('h-8');
  });

  test('renders on mobile before the always-visible more button, in peek mode, and for attachment-only steers', async () => {
    // Mobile: waiting status sits inline-start of the always-visible more button so the button keeps its position on delivery.
    await renderActionsRow({ isPending: true, isMobile: true, alwaysShowActions: true, onCopyMessage: () => {} });
    const mobileRow = container.querySelector('[data-user-message-actions]');
    const mobilePending = container.querySelector('[data-user-message-pending]');
    const mobileActions = mobileRow?.querySelector(':scope > div');
    expect(mobileRow?.firstElementChild).toBe(mobilePending);
    expect(mobileRow?.lastElementChild).toBe(mobileActions);

    // Peek surface (/btw panel): waiting indicator still renders even though message actions are omitted.
    await renderActionsRow({ isPending: true, surface: 'peek', onCopyMessage: () => {} });
    const peekRow = container.querySelector('[data-user-message-actions]');
    expect(peekRow?.querySelector('[data-user-message-pending]')?.textContent).toContain('Waiting for the agent');
    expect(peekRow?.querySelector('button')).toBeNull();

    // Attachment-only steered prompt with no copyable text and no actions still renders waiting indicator.
    await renderActionsRow({ isPending: true, parts: [userFile], hasTextContent: false });
    expect(container.querySelector('[data-user-message-pending]')?.textContent).toContain('Waiting for the agent');
  });

  test('ChatMessage gives only a steer the waiting treatment, and restores history actions on delivery', async () => {
    const created = 1_700_000_000_000;
    const steerInfo: UserMessage = { id: 'msg_steer_1', sessionID: 'ses_1', role: 'user', time: { created }, pending: true, steer: true };
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
    const timestampShown = () => container.querySelector('[data-user-message-actions] .tabular-nums') !== null;

    await renderChatMessage(steerInfo);
    expect(container.querySelector('[data-user-message-pending]')?.textContent).toContain('Waiting for the agent');
    expect(container.querySelector('button[aria-label="Revert to this message"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Copy message text"]')).not.toBeNull();
    // More menu stays available for Save as snippet while Fork and Pin are absent.
    expect(container.querySelector('button[aria-label="More actions"]')).not.toBeNull();
    expect(timestampShown()).toBe(false);

    // Delivery with identical created time still re-renders the memoized row, drops waiting, and restores Revert.
    await renderChatMessage(deliveredInfo);
    expect(container.querySelector('[data-user-message-pending]')).toBeNull();
    expect(container.querySelector('button[aria-label="Revert to this message"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Copy message text"]')).not.toBeNull();
    expect(timestampShown()).toBe(true);

    // An ordinary Send that stays pending keeps the row it has today, however long the inbox holds it.
    await renderChatMessage(slowSendInfo);
    expect(container.querySelector('[data-user-message-pending]')).toBeNull();
    expect(container.querySelector('button[aria-label="Revert to this message"]')).not.toBeNull();
    expect(timestampShown()).toBe(true);
  });
});
