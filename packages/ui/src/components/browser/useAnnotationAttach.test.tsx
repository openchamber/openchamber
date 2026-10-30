import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

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

test('a saved annotation callback captures both current destinations and keeps them through screenshot preparation', async () => {
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const originalAdd = useInputStore.getState().addAttachedFile;
  const frameDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 0 });
  const parent = address('ses_parent');
  const fork = address('ses_fork');
  let completeScreenshot: () => void = () => undefined;
  const screenshotReady = new Promise<void>((resolve) => { completeScreenshot = resolve; });
  let savedAttach: ReturnType<typeof useAnnotationAttach> | undefined;
  function Probe() {
    const attach = useAnnotationAttach(directory);
    savedAttach ??= attach;
    return null;
  }
  useInlineCommentDraftStore.setState({ drafts: {}, touchedAt: {} });
  useInputStore.setState({
    composerAddress: fork,
    attachedFiles: [], attachmentDraftKey: null, attachmentDrafts: new Map(),
    addAttachedFile: async (file, target) => {
      expect(target).toEqual(parent.attachments);
      await screenshotReady;
      useInputStore.getState().addRestoredAttachment({ url: 'data:image/png;base64,AA==', mimeType: file.type, filename: file.name }, target);
      return true;
    },
  });
  try {
    await act(async () => root.render(<I18nProvider><Probe /></I18nProvider>));
    // The page still holds the callback it received while BTW was expanded.
    act(() => { useInputStore.getState().setComposerAddress(parent); });
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
    expect(drafts.getDrafts({ directory, sessionKey: 'ses_fork' })).toEqual([]);
    expect(useInputStore.getState().getAttachedFiles(parent.attachments)).toHaveLength(1);
    expect(useInputStore.getState().getAttachedFiles(fork.attachments)).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    useInputStore.setState({ addAttachedFile: originalAdd, composerAddress: null, attachedFiles: [], attachmentDraftKey: null, attachmentDrafts: new Map() });
    useInlineCommentDraftStore.setState({ drafts: {}, touchedAt: {} });
    if (frameDescriptor) Object.defineProperty(globalThis, 'requestAnimationFrame', frameDescriptor);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    dom.restore();
  }
});
