import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Session } from '@/lib/opencode/model';
import { I18nProvider } from '@/lib/i18n';
import { toast } from '@/components/ui';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { invokeActiveSelectionAddToChat } from '@/lib/addSelectionToChat';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { readLinkedReferences, useLinkedReferenceDrafts } from '../composer/linkedReferenceDrafts';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { ChatColumnActionsContext, ChatColumnSessionContext, useChatColumnActions } from '../chatColumnSession';
import { createChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { dispatchFrameSelection } from './frameSelection';
import { MobileCommentComposerContext } from '../composer/comment/MobileCommentComposerContext';
import { LiveActivityInteractionContext } from '../components/liveActivityContext';
import { createMobileCommentDraftController, type MobileCommentDraftController } from '../composer/comment/mobileCommentDraft';

// React DOM probes for a DOM when first imported; give it one, then restore
// the caller's globals.
const importWindow = new Window();
const importGlobals = ['window', 'document'] as const;
const previousImportGlobals = importGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: importWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: importWindow.document, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { TextSelectionMenu } = await import('./TextSelectionMenu');
for (const [name, descriptor] of previousImportGlobals) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
void importWindow.happyDOM.close();

const directory = '/repo';
const sessionId = 'session-1';
const column = { sessionId, directory };
const session = (updated: number): Session => ({
  id: sessionId, projectID: 'project', directory, title: 'test', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated },
});
const otherSession = (updated: number): Session => ({ ...session(updated), id: 'session-2' });

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Text', 'CustomEvent', 'DOMRect', 'MutationObserver', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'FileReader', 'File', 'ClipboardEvent', 'DataTransfer', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const installDom = () => {
  const win = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = { window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
    HTMLElement: win.HTMLElement, Text: win.Text, CustomEvent: win.CustomEvent, DOMRect: win.DOMRect, MutationObserver: win.MutationObserver, localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win), FileReader: win.FileReader, File: win.File, ClipboardEvent: win.ClipboardEvent, DataTransfer: win.DataTransfer, IS_REACT_ACT_ENVIRONMENT: true };
  for (const name of DOM_GLOBAL_NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, restore: () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    void win.happyDOM.close();
  } };
};

describe('TextSelectionMenu render subscriptions', () => {
  const Pinned = ({ children }: { children: React.ReactNode }) => {
    const actions = useChatColumnActions();
    return <ChatColumnActionsContext.Provider value={{ ...actions, pinned: true }}>{children}</ChatColumnActionsContext.Provider>;
  };
  let root: Root;
  let dom: ReturnType<typeof installDom>;
  let renders = 0;
  // Bootstrap stays pending, so each test owns the directory store's contents.
  const sdk = OpenCode.make({ baseUrl: 'http://selection.test', fetch: () => new Promise<Response>(() => undefined) });
  const containerRef: React.RefObject<HTMLElement | null> = { current: null };
  const store = () => {
    const result = getSyncChildStores().getChild(directory);
    if (!result) throw new Error('Expected mounted directory store');
    return result;
  };
  const stage = (sessions: Session[]) => act(async () => {
    store().setState({ session: sessions });
  });
  const render = (frameSelections = false, controller: MobileCommentDraftController | null = null, pinned = false) => act(async () => root.render(
    <SyncProvider sdk={sdk} directory={directory}>
      <I18nProvider>
        <MobileCommentComposerContext.Provider value={controller}>
          <ChatColumnSessionContext.Provider value={column}>
            <React.Profiler id="menu" onRender={() => { renders += 1; }}>
              {pinned
                ? <Pinned><TextSelectionMenu containerRef={containerRef} readingKey="message-1" canReadAloud={false} frameSelections={frameSelections} /></Pinned>
                : <TextSelectionMenu containerRef={containerRef} readingKey="message-1" canReadAloud={false} frameSelections={frameSelections} />}
            </React.Profiler>
          </ChatColumnSessionContext.Provider>
        </MobileCommentComposerContext.Provider>
      </I18nProvider>
    </SyncProvider>,
  ));

  beforeEach(() => {
    renders = 0;
    dom = installDom();
    root = createRoot(dom.container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useInlineCommentDraftStore.setState({ drafts: {} });
    useInputStore.getState().setPendingInputText(null);
    useInputStore.setState({ composerAddress: null, attachedFiles: [], attachmentDrafts: new Map(), attachmentDraftKey: null });
    dom.restore();
  });

  test('a streamed step that replaces the session list does not re-render the menu', async () => {
    await render();
    await stage([session(1), otherSession(1)]);
    const settled = renders;

    // Every streamed step bumps `time.updated` and replaces the list with one
    // of the same length.
    await stage([session(2), otherSession(1)]);
    await stage([session(3), otherSession(2)]);
    await stage([session(4), otherSession(3)]);

    expect(renders).toBe(settled);
  });

  test('a selection a page frame reports opens the menu, and clearing it closes the menu', async () => {
    const host = document.createElement('div');
    const frame = document.createElement('iframe');
    host.appendChild(frame);
    document.body.appendChild(host);
    containerRef.current = host;
    await render(true);
    const report = (text: string) => act(async () => {
      dispatchFrameSelection(frame, { text, rect: { top: 10, left: 20, width: 80, height: 16 } });
    });

    await report('picked words');
    expect(document.body.textContent).toContain('Comment');

    await report('');
    expect(document.body.textContent).not.toContain('Comment');
    containerRef.current = null;
  });

  test('holds its Activity open while the menu shows and releases it when cleared', async () => {
    let holds = 0;
    const interaction = { hold: () => { holds += 1; }, release: () => { holds -= 1; }, pagesShown: false };
    const host = document.createElement('div');
    const frame = document.createElement('iframe');
    host.appendChild(frame);
    document.body.appendChild(host);
    containerRef.current = host;
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory={directory}>
        <I18nProvider>
          <ChatColumnSessionContext.Provider value={column}>
            <LiveActivityInteractionContext.Provider value={interaction}>
              <TextSelectionMenu containerRef={containerRef} readingKey="message-1" canReadAloud={false} frameSelections />
            </LiveActivityInteractionContext.Provider>
          </ChatColumnSessionContext.Provider>
        </I18nProvider>
      </SyncProvider>,
    ));
    expect(holds).toBe(0);

    await act(async () => {
      dispatchFrameSelection(frame, { text: 'picked words', rect: { top: 10, left: 20, width: 80, height: 16 } });
    });
    expect(holds).toBe(1);

    await act(async () => {
      dispatchFrameSelection(frame, { text: '', rect: { top: 0, left: 0, width: 0, height: 0 } });
    });
    expect(holds).toBe(0);
    containerRef.current = null;
  });

  test('on a phone, holds its Activity open while the comment is written in the composer', async () => {
    let holds = 0;
    const interaction = { hold: () => { holds += 1; }, release: () => { holds -= 1; }, pagesShown: false };
    const host = document.createElement('div');
    const frame = document.createElement('iframe');
    host.appendChild(frame);
    document.body.appendChild(host);
    containerRef.current = host;
    const settings = useUIStore.getState();
    const controller = createMobileCommentDraftController();
    controller.setScope({ runtimeKey: getRuntimeKey(), directory, sessionKey: sessionId });
    try {
      useUIStore.setState({ isMobile: true });
      await act(async () => root.render(
        <SyncProvider sdk={sdk} directory={directory}>
          <I18nProvider>
            <MobileCommentComposerContext.Provider value={controller}>
              <ChatColumnSessionContext.Provider value={column}>
                <LiveActivityInteractionContext.Provider value={interaction}>
                  <TextSelectionMenu containerRef={containerRef} readingKey="message-1" canReadAloud={false} frameSelections />
                </LiveActivityInteractionContext.Provider>
              </ChatColumnSessionContext.Provider>
            </MobileCommentComposerContext.Provider>
          </I18nProvider>
        </SyncProvider>,
      ));
      await act(async () => {
        dispatchFrameSelection(frame, { text: 'picked words', rect: { top: 10, left: 20, width: 80, height: 16 } });
      });
      const comment = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Comment');
      await act(async () => { comment?.click(); });
      expect(controller.getState().status).toBe('open');
      expect(holds).toBe(1);

      await act(async () => { controller.cancel(); });
      expect(holds).toBe(0);
    } finally {
      await act(async () => useUIStore.setState({ isMobile: settings.isMobile }));
      containerRef.current = null;
    }
  });

  test('opening a new-session draft over the chat closes the menu', async () => {
    const host = document.createElement('div');
    const frame = document.createElement('iframe');
    host.appendChild(frame);
    document.body.appendChild(host);
    containerRef.current = host;
    const draftBefore = useSessionUIStore.getState().newSessionDraft;
    await render(true);
    try {
      await act(async () => {
        dispatchFrameSelection(frame, { text: 'picked words', rect: { top: 10, left: 20, width: 80, height: 16 } });
      });
      expect(document.body.textContent).toContain('Comment');

      // The chat stays mounted behind the draft, and nothing fires a selectionchange.
      await act(async () => useSessionUIStore.setState({ newSessionDraft: { ...draftBefore, open: true } }));
      expect(document.body.textContent).not.toContain('Comment');
    } finally {
      useSessionUIStore.setState({ newSessionDraft: draftBefore });
      containerRef.current = null;
    }
  });

  test('a frame outside the menu\'s message does not open it', async () => {
    const host = document.createElement('div');
    const otherFrame = document.createElement('iframe');
    document.body.append(host, otherFrame);
    containerRef.current = host;
    await render(true);

    await act(async () => {
      dispatchFrameSelection(otherFrame, { text: 'elsewhere', rect: { top: 0, left: 0, width: 10, height: 10 } });
    });

    expect(document.body.textContent).not.toContain('Comment');
    containerRef.current = null;
  });

  describe('a page frame selection held by the menu', () => {
    const rect = { top: 10, left: 20, width: 80, height: 16 };
    let host: HTMLElement;
    let frame: HTMLElement;
    let cleared: number;
    const report = (text: string, extra: { dismiss?: boolean } = {}) => act(async () => {
      dispatchFrameSelection(frame, { text, rect, clear: () => { cleared += 1; }, ...extra });
    });

    beforeEach(async () => {
      cleared = 0;
      host = document.createElement('div');
      frame = document.createElement('iframe');
      host.appendChild(frame);
      document.body.appendChild(host);
      containerRef.current = host;
      await render(true);
    });
    afterEach(() => { containerRef.current = null; });

    test('is cleared in the page when the page reports it gone', async () => {
      await report('picked words');
      expect(cleared).toBe(0);

      await report('');
      expect(cleared).toBe(1);
      expect(document.body.textContent).not.toContain('Comment');
    });

    test('is cleared in the page when a press outside ends it', async () => {
      await report('picked words');

      await act(async () => {
        document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
      });

      expect(cleared).toBe(1);
      expect(document.body.textContent).not.toContain('Comment');
    });

    test('closes when another page takes the selection over, once, without a loop', async () => {
      await report('picked words');

      await report('', { dismiss: true });

      expect(cleared).toBe(1);
      expect(document.body.textContent).not.toContain('Comment');
    });

    test('keeps an open comment against an ordinary empty report but not against a takeover', async () => {
      await report('picked words');
      const comment = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Comment');
      await act(async () => { comment?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
      expect(document.querySelector('textarea, [contenteditable]')).not.toBeNull();

      await report('');
      expect(document.querySelector('textarea, [contenteditable]')).not.toBeNull();
      expect(cleared).toBe(0);

      await report('', { dismiss: true });
      expect(document.querySelector('textarea, [contenteditable]')).toBeNull();
      expect(cleared).toBe(1);
    });
  });

  describe('an open comment on message text', () => {
    // Like AssistantMessageBody: the menu sits inside the body whose ref it
    // reads, so its layout effects run before React attaches that ref.
    const MessageBody = ({ row }: { row: string }) => {
      const ref = React.useRef<HTMLDivElement>(null);
      return (
        <div ref={ref} data-row={row}>
          <TextSelectionMenu containerRef={ref} readingKey="message-1" canReadAloud={false} />
          <p>Checking the source before the answer</p>
        </div>
      );
    };
    const hold = () => undefined;
    const renderBody = async (row: string, controller: MobileCommentDraftController, pagesShown = true) => {
      await act(async () => root.render(
        <SyncProvider sdk={sdk} directory={directory}>
          <I18nProvider>
            <MobileCommentComposerContext.Provider value={controller}>
              <ChatColumnSessionContext.Provider value={column}>
                <LiveActivityInteractionContext.Provider value={{ hold, release: hold, pagesShown }}>
                  <MessageBody key={row} row={row} />
                </LiveActivityInteractionContext.Provider>
              </ChatColumnSessionContext.Provider>
            </MobileCommentComposerContext.Provider>
          </I18nProvider>
        </SyncProvider>,
      ));
      const body = document.querySelector<HTMLElement>(`[data-row="${row}"]`);
      if (!body) throw new Error('Expected message body');
      return body;
    };
    const commentOn = async (body: HTMLElement, typed: string) => {
      const node = body.querySelector('p')?.firstChild;
      if (!node) throw new Error('Expected quote text');
      const range = document.createRange();
      range.setStart(node, 9);
      range.setEnd(node, 19);
      await act(async () => {
        const selection = document.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new window.Event('selectionchange'));
      });
      // Typing over a shown menu opens the comment with that text.
      await act(async () => { window.dispatchEvent(new window.KeyboardEvent('keydown', { key: typed, bubbles: true })); });
    };
    const editor = () => document.querySelector('[contenteditable="true"]');
    let settings: ReturnType<typeof useUIStore.getState>;
    beforeEach(() => {
      settings = useUIStore.getState();
      useUIStore.setState({ isMobile: false });
    });
    afterEach(async () => {
      await act(async () => useUIStore.setState({ isMobile: settings.isMobile }));
    });

    test('moves with its message to the row that replaces it and attaches to the original quote', async () => {
      const controller = createMobileCommentDraftController();
      controller.setScope({ runtimeKey: getRuntimeKey(), directory, sessionKey: sessionId });
      const fold = await renderBody('fold', controller);
      await commentOn(fold, 'W');
      expect(editor()?.textContent).toBe('W');

      // The working step became the final answer: its body is drawn in another
      // row, and the menu in the old one unmounts.
      await renderBody('answer', controller);
      expect(editor()?.textContent).toBe('W');

      await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Attach"]')?.click(); });
      const drafts = useInlineCommentDraftStore.getState().getDrafts({ directory, sessionKey: sessionId });
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({ code: 'the source', text: 'W', anchor: { text: 'the source' } });
      expect(editor()).toBeNull();
    });

    test('follows its quote when the answer drops the page above it without a scroll', async () => {
      let quoteTop = 300;
      const quoteRect = () => new DOMRect(40, quoteTop, 80, 16);
      const lineList = (): DOMRectList => {
        const line = quoteRect();
        return Object.assign([line], { item: (index: number) => (index === 0 ? line : null) });
      };
      const box = spyOn(window.Range.prototype, 'getBoundingClientRect').mockImplementation(quoteRect);
      const lines = spyOn(window.Range.prototype, 'getClientRects').mockImplementation(lineList);
      try {
        const controller = createMobileCommentDraftController();
        controller.setScope({ runtimeKey: getRuntimeKey(), directory, sessionKey: sessionId });
        const fold = await renderBody('fold', controller);
        await commentOn(fold, 'W');
        const menuTop = () => editor()?.closest<HTMLElement>('.fixed')?.style.top;
        const highlightTop = () => document.querySelector<HTMLElement>('.oc-chat-comment-rect')?.style.top;
        const [menuBefore, highlightBefore] = [menuTop(), highlightTop()];
        expect(highlightBefore).toBe('300px');

        quoteTop = 100;
        await renderBody('fold', controller, false);
        expect(menuTop()).not.toBe(menuBefore);
        expect(highlightTop()).toBe('100px');
        expect(editor()?.textContent).toBe('W');
      } finally {
        box.mockRestore();
        lines.mockRestore();
      }
    });

    test('is not reopened by a later menu for a message whose comment was cancelled', async () => {
      const controller = createMobileCommentDraftController();
      controller.setScope({ runtimeKey: getRuntimeKey(), directory, sessionKey: sessionId });
      const fold = await renderBody('fold', controller);
      await commentOn(fold, 'W');
      await act(async () => { editor()?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      expect(editor()).toBeNull();

      await renderBody('answer', controller);
      expect(editor()).toBeNull();
    });
  });

  test('a menu without frameSelections ignores frame reports, so a message holds one menu per selection', async () => {
    const host = document.createElement('div');
    const frame = document.createElement('iframe');
    host.appendChild(frame);
    document.body.appendChild(host);
    containerRef.current = host;
    await render(false);

    await act(async () => {
      dispatchFrameSelection(frame, { text: 'picked words', rect: { top: 1, left: 1, width: 5, height: 5 } });
    });

    expect(document.body.textContent).not.toContain('Comment');
    containerRef.current = null;
  });

  test('a comment is filed into the target the composer published, not the column session', async () => {
    const host = document.createElement('div');
    const frame = document.createElement('iframe');
    host.appendChild(frame);
    document.body.appendChild(host);
    containerRef.current = host;
    const controller = createMobileCommentDraftController();
    await render(true, controller);

    await act(async () => {
      // The composer is talking to a `/btw` fork while the column still shows
      // the parent session; the fork's key is the only one it reads.
      controller.setScope({ runtimeKey: getRuntimeKey(), directory, sessionKey: 'btw-fork' });
      dispatchFrameSelection(frame, { text: 'picked words', rect: { top: 10, left: 20, width: 80, height: 16 } });
    });

    const comment = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Comment');
    await act(async () => { comment?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    const attach = document.querySelector<HTMLButtonElement>('button[aria-label="Attach"]');
    expect(attach).not.toBeNull();
    await act(async () => { attach?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });

    const store = useInlineCommentDraftStore.getState();
    expect(store.getDrafts({ directory, sessionKey: 'btw-fork' })).toHaveLength(1);
    expect(store.getDrafts({ directory, sessionKey: column.sessionId })).toEqual([]);
    containerRef.current = null;
  });

  test('a pinned comment and its pasted image stay together while the main composer is selected', async () => {
    const main = createChatDraftIdentity(getRuntimeKey(), directory, 'main-session');
    const pinned = createChatDraftIdentity(getRuntimeKey(), directory, 'pinned-fork');
    if (!main || !pinned) throw new Error('Expected draft identities');
    useInputStore.getState().selectAttachmentDraft(main);
    useInputStore.getState().addRestoredAttachment({ url: 'data:text/plain;base64,aGk=', mimeType: 'text/plain', filename: 'main.txt' }, main);
    useInputStore.getState().setComposerAddress({ inline: { directory, sessionKey: 'main-session' }, attachments: main });
    const mainFiles = useInputStore.getState().getAttachedFiles(main);
    const host = document.createElement('div');
    const frame = document.createElement('iframe');
    host.appendChild(frame);
    document.body.appendChild(host);
    containerRef.current = host;
    const controller = createMobileCommentDraftController();
    controller.setScope({ runtimeKey: getRuntimeKey(), directory, sessionKey: 'pinned-fork' });
    await render(true, controller, true);
    await act(async () => { dispatchFrameSelection(frame, { text: 'picked words', rect: { top: 10, left: 20, width: 80, height: 16 } }); });
    const comment = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Comment');
    await act(async () => { comment?.click(); });
    const editor = document.querySelector<HTMLElement>('[contenteditable="true"]');
    expect(editor).not.toBeNull();
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'image.png', { type: 'image/png' }));
    await act(async () => { editor?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); });
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Attach"]')?.click(); });
    await act(async () => {
      for (let attempt = 0; attempt < 100 && !useInputStore.getState().getAttachedFiles(pinned).length; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    });
    const drafts = useInlineCommentDraftStore.getState();
    expect(drafts.getDrafts({ directory, sessionKey: 'pinned-fork' })[0]?.text).toContain('[image-1.png]');
    expect(drafts.getDrafts({ directory, sessionKey: 'main-session' })).toEqual([]);
    expect(useInputStore.getState().getAttachedFiles(pinned).map((file) => file.filename)).toEqual(['image-1.png']);
    expect(useInputStore.getState().getAttachedFiles(main)).toBe(mainFiles);
    containerRef.current = null;
  });

  test('a quote is addressed to the chat on screen, so an expanded fork takes it', async () => {
    const host = document.createElement('div');
    const frame = document.createElement('iframe');
    host.appendChild(frame);
    document.body.appendChild(host);
    containerRef.current = host;
    const controller = createMobileCommentDraftController();
    await render(true, controller);

    await act(async () => {
      controller.setScope({ runtimeKey: getRuntimeKey(), directory, sessionKey: 'btw-fork' });
      dispatchFrameSelection(frame, { text: 'picked words', rect: { top: 10, left: 20, width: 80, height: 16 } });
    });

    await act(async () => { expect(invokeActiveSelectionAddToChat()).toBe(true); });

    // The main column's address, which the fork composer reads as the composer on
    // screen; addressing the fork by id would strand the text on collapse.
    expect(useInputStore.getState().pendingInputText).toContain('picked words');
    expect(useInputStore.getState().pendingInputTarget).toBeNull();
    containerRef.current = null;
  });

  test('closes when its session is hidden, and stays closed when the session is shown again', async () => {
    const host = document.createElement('div');
    const frame = document.createElement('iframe');
    host.appendChild(frame);
    document.body.appendChild(host);
    containerRef.current = host;
    // KeepAlive keeps a session the user switched away from in a hidden Activity.
    const renderIn = (mode: 'visible' | 'hidden') => act(async () => root.render(
      <SyncProvider sdk={sdk} directory={directory}>
        <I18nProvider>
          <ChatColumnSessionContext.Provider value={column}>
            <React.Activity mode={mode}>
              <TextSelectionMenu containerRef={containerRef} readingKey="message-1" canReadAloud={false} frameSelections />
            </React.Activity>
          </ChatColumnSessionContext.Provider>
        </I18nProvider>
      </SyncProvider>,
    ));
    await renderIn('visible');
    await act(async () => {
      dispatchFrameSelection(frame, { text: 'picked words', rect: { top: 1, left: 1, width: 5, height: 5 } });
    });
    expect(document.body.textContent).toContain('Comment');

    // The menu's own state, not what is painted: the app showed the portal
    // over the next session while this test DOM keeps it either way.
    await renderIn('hidden');
    expect(document.body.textContent).not.toContain('Comment');

    // Shown again, a menu left open would have lost its Escape and outside-press handling.
    await renderIn('visible');
    expect(document.body.textContent).not.toContain('Comment');
    containerRef.current = null;
  });

  test('a page shown in a dialog gets its menu inside the dialog, where it stays usable', async () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('data-slot', 'dialog-content');
    const host = document.createElement('div');
    const frame = document.createElement('iframe');
    host.appendChild(frame);
    dialog.appendChild(host);
    document.body.appendChild(dialog);
    containerRef.current = host;
    await render(true);

    await act(async () => {
      dispatchFrameSelection(frame, { text: 'picked words', rect: { top: 1, left: 1, width: 5, height: 5 } });
    });

    expect(dialog.textContent).toContain('Comment');
    containerRef.current = null;
  });

  test('desktop approval adds one anchored quote to its pinned composer and preserves pending input', async () => {
    const host = document.createElement('div');
    const frame = document.createElement('iframe');
    host.append(frame);
    document.body.append(host);
    containerRef.current = host;
    const input = document.createElement('div');
    input.dataset.chatInput = 'true';
    const editor = document.createElement('div');
    editor.className = 'cm-content';
    input.append(editor);
    document.body.append(input);
    const focus = spyOn(editor, 'focus');
    const settings = useUIStore.getState();
    const linkedDrafts = useLinkedReferenceDrafts.getState().drafts;
    const send = spyOn(useSessionUIStore.getState(), 'sendMessage').mockImplementation(async () => {});
    const queue = spyOn(useMessageQueueStore.getState(), 'addToQueue').mockImplementation(async () => {});
    const target = { directory, sessionKey: 'pinned-fork' };
    const identity = createChatDraftIdentity(getRuntimeKey(), directory, target.sessionKey);
    if (!identity) throw new Error('Missing draft identity');
    const controller = createMobileCommentDraftController();
    try {
      useUIStore.setState({ isMobile: false, selectionApprovalText: '   ' });
      await render(true, controller, true);
      controller.setScope({ runtimeKey: getRuntimeKey(), ...target });
      useInputStore.getState().setPendingInputText('Keep my draft', 'append', target.sessionKey);
      useInputStore.getState().addRestoredAttachment({ url: 'data:text/plain;base64,aGk=', mimeType: 'text/plain', filename: 'keep.txt' }, identity);
      const files = useInputStore.getState().getAttachedFiles(identity);
      const linked = [{ kind: 'repository-issue' as const, number: 7, title: 'Keep this issue', url: 'https://example.com/7', contextText: 'Existing reference' }];
      useLinkedReferenceDrafts.getState().set(linked, identity);
      useInlineCommentDraftStore.getState().addDraft(target, { source: 'chat-quote', fileLabel: 'earlier-message', code: 'Earlier quote', text: 'Existing comment', startLine: 1, endLine: 1, language: '' });
      const existing = useInlineCommentDraftStore.getState().getDrafts(target)[0];
      const anchor = { text: 'picked', prefix: 'before ', suffix: ' after', start: 7 };
      await act(async () => dispatchFrameSelection(frame, { text: 'picked', anchor, rect: { top: 40, left: 80, width: 100, height: 20 } }));
      const button = document.querySelector<HTMLButtonElement>('[aria-label="Approve selection"]');
      if (!button) throw new Error('Missing approval action');
      await act(async () => { button.click(); button.click(); });
      const quotes = useInlineCommentDraftStore.getState().getDrafts(target);
      expect(quotes).toHaveLength(2);
      expect(quotes[0]).toBe(existing);
      expect(quotes[1]).toMatchObject({ source: 'chat-quote', sessionKey: target.sessionKey, fileLabel: 'message-1', code: 'picked', text: 'Sounds good', anchor });
      expect(useInlineCommentDraftStore.getState().getDrafts({ directory, sessionKey: column.sessionId })).toEqual([]);
      expect(useInputStore.getState().pendingInputText).toBe('Keep my draft');
      expect(useInputStore.getState().getAttachedFiles(identity)).toBe(files);
      expect(readLinkedReferences(identity)).toEqual(linked);
      expect(focus.mock.calls).toHaveLength(1);
      expect(send.mock.calls).toEqual([]);
      expect(queue.mock.calls).toEqual([]);
      expect(document.querySelector('[aria-label="Approve selection"]')).toBeNull();
    } finally {
      focus.mockRestore();
      send.mockRestore();
      queue.mockRestore();
      useLinkedReferenceDrafts.setState({ drafts: linkedDrafts });
      await act(async () => useUIStore.setState({ isMobile: settings.isMobile, selectionApprovalText: settings.selectionApprovalText }));
    }
  });

  test('approval preserves the selection when the composer target or attachment is unavailable', async () => {
    const host = document.createElement('div');
    const frame = document.createElement('iframe');
    host.append(frame);
    document.body.append(host);
    containerRef.current = host;
    const settings = useUIStore.getState();
    const controller = createMobileCommentDraftController();
    const target = { directory, sessionKey: 'approval-target' };
    const addDraft = useInlineCommentDraftStore.getState().addDraft;
    const error = spyOn(toast, 'error').mockImplementation(() => 'toast');
    let cleared = 0;
    try {
      useUIStore.setState({ isMobile: false });
      await render(true, controller);
      await act(async () => dispatchFrameSelection(frame, {
        text: 'picked', rect: { top: 40, left: 80, width: 100, height: 20 }, clear: () => { cleared += 1; },
      }));
      const button = document.querySelector<HTMLButtonElement>('[aria-label="Approve selection"]');
      if (!button) throw new Error('Missing approval action');

      await act(async () => button.click());
      controller.setScope({ runtimeKey: 'another-runtime', ...target });
      await act(async () => button.click());
      controller.setScope({ runtimeKey: getRuntimeKey(), ...target });
      useInlineCommentDraftStore.setState({ addDraft: () => null });
      await act(async () => button.click());

      expect(error.mock.calls).toHaveLength(3);
      expect(cleared).toBe(0);
      expect(document.querySelector('[aria-label="Approve selection"]')).not.toBeNull();
      expect(useInlineCommentDraftStore.getState().getDrafts(target)).toEqual([]);

      useInlineCommentDraftStore.setState({ addDraft });
      await act(async () => button.click());
      expect(useInlineCommentDraftStore.getState().getDrafts(target)).toHaveLength(1);
      expect(cleared).toBe(1);
      expect(document.querySelector('[aria-label="Approve selection"]')).toBeNull();
    } finally {
      useInlineCommentDraftStore.setState({ addDraft });
      error.mockRestore();
      await act(async () => useUIStore.setState({ isMobile: settings.isMobile }));
      containerRef.current = null;
    }
  });

  test('mobile approval attaches custom text to its BTW composer without sending or focusing the editor', async () => {
    const host = document.createElement('div');
    const frame = document.createElement('iframe');
    host.append(frame);
    document.body.append(host);
    containerRef.current = host;
    const input = document.createElement('div');
    input.dataset.chatInput = 'true';
    const editor = document.createElement('div');
    editor.className = 'cm-content';
    input.append(editor);
    document.body.append(input);
    const focus = spyOn(editor, 'focus');
    const settings = useUIStore.getState();
    const send = spyOn(useSessionUIStore.getState(), 'sendMessage').mockImplementation(async () => {});
    const queue = spyOn(useMessageQueueStore.getState(), 'addToQueue').mockImplementation(async () => {});
    const controller = createMobileCommentDraftController();
    const target = { directory, sessionKey: 'mobile-btw' };
    try {
      useUIStore.setState({ isMobile: true, selectionApprovalText: '  Ship this  ' });
      await render(true, controller);
      controller.setScope({ runtimeKey: getRuntimeKey(), ...target });
      await act(async () => store().setState({ session_status: { [sessionId]: { type: 'busy' } } }));
      const anchor = { text: 'picked', prefix: '', suffix: '', start: 0, page: { partId: 'page-1' } };
      await act(async () => dispatchFrameSelection(frame, { text: 'picked', anchor, rect: { top: 40, left: 80, width: 100, height: 20 } }));
      const button = document.querySelector<HTMLButtonElement>('[aria-label="Approve selection"]');
      if (!button) throw new Error('Missing approval action');
      await act(async () => button.click());
      const quotes = useInlineCommentDraftStore.getState().getDrafts(target);
      expect(quotes).toHaveLength(1);
      expect(quotes[0]).toMatchObject({ source: 'chat-quote', fileLabel: 'message-1', code: 'picked', text: 'Ship this', anchor });
      expect(useInlineCommentDraftStore.getState().getDrafts({ directory, sessionKey: column.sessionId })).toEqual([]);
      expect(controller.getState()).toEqual({ status: 'closed' });
      expect(focus.mock.calls).toEqual([]);
      expect(send.mock.calls).toEqual([]);
      expect(queue.mock.calls).toEqual([]);
      expect(document.querySelector('[aria-label="Approve selection"]')).toBeNull();
    } finally {
      focus.mockRestore();
      send.mockRestore();
      queue.mockRestore();
      await act(async () => useUIStore.setState({ isMobile: settings.isMobile, selectionApprovalText: settings.selectionApprovalText }));
    }
  });

});
