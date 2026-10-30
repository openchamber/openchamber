import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Session } from '@/lib/opencode/model';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { invokeActiveSelectionAddToChat } from '@/lib/addSelectionToChat';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { ChatColumnActionsContext, ChatColumnSessionContext, useChatColumnActions } from '../chatColumnSession';
import { createChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { dispatchFrameSelection } from './frameSelection';
import { MobileCommentComposerContext } from '../composer/comment/MobileCommentComposerContext';
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
const session = (updated: number, sessionDirectory = directory): Session => ({
  id: sessionId, projectID: 'project', directory: sessionDirectory, title: 'test', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated },
});
const otherSession = (updated: number): Session => ({ ...session(updated), id: 'session-2' });

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'CustomEvent', 'DOMRect', 'MutationObserver', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'FileReader', 'File', 'ClipboardEvent', 'DataTransfer', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const installDom = () => {
  const win = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = { window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
    HTMLElement: win.HTMLElement, CustomEvent: win.CustomEvent, DOMRect: win.DOMRect, MutationObserver: win.MutationObserver, localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
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
    useInlineCommentDraftStore.setState({ drafts: {}, touchedAt: {} });
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

  test('a change of the session directory still re-renders the menu', async () => {
    await render();
    await stage([session(1)]);
    const settled = renders;

    await stage([session(2, '/repo/worktree')]);

    expect(renders).toBeGreaterThan(settled);
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
});
