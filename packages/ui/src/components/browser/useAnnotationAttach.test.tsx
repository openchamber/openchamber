import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatColumnActionsContext, useChatColumnActions } from '@/components/chat/chatColumnSession';
import { MobileCommentComposerContext } from '@/components/chat/composer/comment/MobileCommentComposerContext';
import { createMobileCommentDraftController } from '@/components/chat/composer/comment/mobileCommentDraft';

import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { I18nProvider } from '@/lib/i18n';
import { createChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useInputStore, type ComposerAddress } from '@/sync/input-store';
import { useAnnotationAttach } from './useAnnotationAttach';

const directory = '/repo';
const address = (sessionKey: string): ComposerAddress => ({
  inline: { directory, sessionKey },
  attachments: createChatDraftIdentity(getRuntimeKey(), directory, sessionKey),
});

async function checkScreenshotDestination(pinned: boolean) {
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const originalAdd = useInputStore.getState().addAttachedFile;
  const frameDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 0 });
  const parent = address('ses_parent');
  const fork = address('ses_fork');
  const composer = createMobileCommentDraftController();
  composer.setScope({ directory, sessionKey: 'ses_parent', runtimeKey: getRuntimeKey() });
  let completeScreenshot: () => void = () => undefined;
  const screenshotReady = new Promise<void>((resolve) => { completeScreenshot = resolve; });
  let savedAttach: ReturnType<typeof useAnnotationAttach> | undefined;
  function Probe() {
    const attach = useAnnotationAttach(directory);
    savedAttach ??= attach;
    return null;
  }
  function Column() {
    const actions = useChatColumnActions();
    return <ChatColumnActionsContext.Provider value={{ ...actions, pinned }}>
      <MobileCommentComposerContext.Provider value={composer}><Probe /></MobileCommentComposerContext.Provider>
    </ChatColumnActionsContext.Provider>;
  }
  useInlineCommentDraftStore.setState({ drafts: {} });
  useInputStore.setState({
    composerAddress: fork,
    attachedFiles: [], attachmentDraftKey: null, attachmentDrafts: new Map(),
    addAttachedFile: async (file, target, onAttached) => {
      expect(target).toEqual(parent.attachments);
      await screenshotReady;
      useInputStore.getState().addRestoredAttachment({ url: 'data:image/png;base64,AA==', mimeType: file.type, filename: file.name }, target);
      onAttached?.(useInputStore.getState().getAttachedFiles(target).slice(-1));
      return true;
    },
  });
  try {
    await act(async () => root.render(<I18nProvider><Column /></I18nProvider>));
    // The main page still holds the callback it received while BTW was expanded.
    // In a pinned column the published address belongs to a different composer.
    if (!pinned) act(() => { useInputStore.getState().setComposerAddress(parent); });
    const attach = savedAttach;
    if (!attach) throw new Error('Annotation callback was not mounted');
    const pending = attach({
      screenshot: new File(['image'], 'annotation.png', { type: 'image/png' }),
      payload: {
        id: 'annotation-1', pageUrl: 'https://example.test', pageTitle: 'Example',
        viewport: { width: 800, height: 600 }, devicePixelRatio: 1,
        comment: 'Change this', elements: [], regions: [], strokes: [],
      },
    });
    // Switching again during preparation must not move either half.
    act(() => { useInputStore.getState().setComposerAddress(fork); });
    completeScreenshot();
    await act(async () => { await pending; });
    const drafts = useInlineCommentDraftStore.getState();
    expect(drafts.getDrafts({ directory, sessionKey: 'ses_parent' })[0]?.code).toContain('Screenshot: attached');
    expect(drafts.getDrafts({ directory, sessionKey: 'ses_parent' })[0]?.screenshot).toBe('annotation.png');
    expect(drafts.getDrafts({ directory, sessionKey: 'ses_fork' })).toEqual([]);
    expect(useInputStore.getState().getAttachedFiles(parent.attachments)).toHaveLength(1);
    expect(useInputStore.getState().getAttachedFiles(fork.attachments)).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    useInputStore.setState({ addAttachedFile: originalAdd, composerAddress: null, attachedFiles: [], attachmentDraftKey: null, attachmentDrafts: new Map() });
    useInlineCommentDraftStore.setState({ drafts: {} });
    if (frameDescriptor) Object.defineProperty(globalThis, 'requestAnimationFrame', frameDescriptor);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    dom.restore();
  }
}

test('a saved main annotation callback captures the current destinations through screenshot preparation', () => checkScreenshotDestination(false));
test('a pinned annotation and screenshot go to its own composer while another chat is active', () => checkScreenshotDestination(true));

test('a pinned screenshot still lands when another composer takes focus during the read', async () => {
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const frameDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 0 });
  const readerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
  const readers: DelayedReader[] = [];
  class DelayedReader {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    error: DOMException | null = null;
    readAsDataURL() { readers.push(this); }
  }
  Object.defineProperty(globalThis, 'FileReader', { configurable: true, writable: true, value: DelayedReader });
  const pinnedDraft = address('ses_pinned');
  const main = address('ses_main');
  const composer = createMobileCommentDraftController();
  composer.setScope({ directory, sessionKey: 'ses_pinned', runtimeKey: getRuntimeKey() });
  let attach: ReturnType<typeof useAnnotationAttach> | undefined;
  function Probe() {
    attach = useAnnotationAttach(directory);
    return null;
  }
  function Column() {
    const actions = useChatColumnActions();
    return <ChatColumnActionsContext.Provider value={{ ...actions, pinned: true }}>
      <MobileCommentComposerContext.Provider value={composer}><Probe /></MobileCommentComposerContext.Provider>
    </ChatColumnActionsContext.Provider>;
  }
  useInlineCommentDraftStore.setState({ drafts: {} });
  useInputStore.setState({ composerAddress: main, attachedFiles: [], attachmentDraftKey: null, attachmentDrafts: new Map() });
  try {
    await act(async () => root.render(<I18nProvider><Column /></I18nProvider>));
    const pending = attach?.({
      screenshot: new File([new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])], 'annotation.png', { type: 'image/png' }),
      payload: {
        id: 'annotation-3', pageUrl: 'https://example.test', pageTitle: 'Example',
        viewport: { width: 800, height: 600 }, devicePixelRatio: 1,
        comment: 'Change this', elements: [], regions: [], strokes: [],
      },
    });
    for (let attempt = 0; attempt < 100 && readers.length < 1; attempt += 1) {
      await Promise.resolve();
    }
    expect(readers).toHaveLength(1);
    // The user clicks the main composer while the screenshot is being read.
    act(() => { useInputStore.getState().selectAttachmentDraft(main.attachments); });
    const [reader] = readers;
    if (reader) {
      reader.result = 'data:image/png;base64,iVBORw0KGgo=';
      reader.onload?.();
    }
    await act(async () => { expect(await pending).toBe(true); });
    const [saved] = useInlineCommentDraftStore.getState().getDrafts({ directory, sessionKey: 'ses_pinned' });
    expect(saved?.text).toBe('Change this');
    expect(saved?.screenshot).toBe('annotation.png');
    expect(saved?.code).toContain('Screenshot: attached');
    expect(useInputStore.getState().getAttachedFiles(pinnedDraft.attachments).map((file) => file.filename)).toEqual(['annotation.png']);
    expect(useInputStore.getState().getAttachedFiles(main.attachments)).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    if (readerDescriptor) Object.defineProperty(globalThis, 'FileReader', readerDescriptor);
    useInputStore.setState({ composerAddress: null, attachedFiles: [], attachmentDraftKey: null, attachmentDrafts: new Map() });
    useInlineCommentDraftStore.setState({ drafts: {} });
    if (frameDescriptor) Object.defineProperty(globalThis, 'requestAnimationFrame', frameDescriptor);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    dom.restore();
  }
});

test('an annotation keeps its comment when the shared session limit is full', async () => {
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const frameDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 0 });
  let attach: ReturnType<typeof useAnnotationAttach> | undefined;
  function Probe() {
    attach = useAnnotationAttach(directory);
    return null;
  }
  useInlineCommentDraftStore.setState({ drafts: {} });
  for (let index = 0; index < 50; index += 1) {
    useInlineCommentDraftStore.getState().addDraft({ directory, sessionKey: `ses_${index}` }, {
      source: 'file', fileLabel: 'a.ts', startLine: 1, endLine: 1, code: 'code', language: 'ts', text: 'kept',
    });
  }
  useInputStore.setState({ composerAddress: address('ses_new') });
  try {
    await act(async () => root.render(<I18nProvider><Probe /></I18nProvider>));
    await act(async () => {
      await attach?.({
        screenshot: null,
        payload: {
          id: 'annotation-2', pageUrl: 'https://example.test', pageTitle: 'Example',
          viewport: { width: 800, height: 600 }, devicePixelRatio: 1,
          comment: 'Change this', elements: [], regions: [], strokes: [],
        },
      });
    });
    const drafts = useInlineCommentDraftStore.getState();
    // The comment is the draft's own text; the prompt for the model leaves it out.
    const [saved] = drafts.getDrafts({ directory, sessionKey: 'ses_new' });
    expect(saved?.text).toBe('Change this');
    expect(saved?.code).not.toContain('Comment:');
    expect(drafts.getDrafts({ directory, sessionKey: 'ses_0' })).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    useInputStore.setState({ composerAddress: null });
    useInlineCommentDraftStore.setState({ drafts: {} });
    if (frameDescriptor) Object.defineProperty(globalThis, 'requestAnimationFrame', frameDescriptor);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    dom.restore();
  }
});
