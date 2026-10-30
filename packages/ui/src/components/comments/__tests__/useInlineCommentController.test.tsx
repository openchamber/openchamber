import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { OpenCode } from '@opencode/client';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useInlineCommentController } from '../useInlineCommentController';
import { useProjectsStore } from '@/stores/useProjectsStore';

const directory = '/repo';

type Range = { start: number; end: number };

describe('inline comment target', () => {
  let root: Root;
  let dom: ReturnType<typeof installHookTestDom>;
  let surfaceDescriptor: PropertyDescriptor | undefined;
  let frameDescriptor: PropertyDescriptor | undefined;
  let saveComment: (text: string, range?: Range) => void = () => undefined;
  const sdk = OpenCode.make({ baseUrl: 'http://comments.test', fetch: () => new Promise<Response>(() => undefined) });

  const Harness = () => {
    const controller = useInlineCommentController<Range>({
      source: 'file',
      fileLabel: 'src/a.ts',
      language: 'ts',
      getCodeForRange: () => 'const answer = 42;',
      toStoreRange: (range) => ({ startLine: range.start, endLine: range.end }),
      fromDraftRange: (draft) => ({ start: draft.startLine, end: draft.endLine }),
    });
    saveComment = controller.saveComment;
    return null;
  };

  const draftsAt = (sessionKey: string) => useInlineCommentDraftStore.getState().getDrafts({ directory, sessionKey });

  beforeEach(async () => {
    dom = installHookTestDom();
    surfaceDescriptor = Object.getOwnPropertyDescriptor(window, '__OPENCHAMBER_SURFACE__');
    Object.defineProperty(window, '__OPENCHAMBER_SURFACE__', { configurable: true, value: 'desktop' });
    frameDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
    Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 0 });
    const { createRoot } = await import('react-dom/client');
    root = createRoot(dom.container);
    useProjectsStore.setState({ projects: [{ id: 'repo', path: directory }] });
    useSessionUIStore.setState({ currentSessionId: 'ses_parent', currentSessionDirectory: directory });
    useInputStore.setState({ composerAddress: null });
    useInlineCommentDraftStore.setState({ drafts: {}, touchedAt: {} });
    await act(async () => root.render(
      <I18nProvider>
        <SyncProvider sdk={sdk} directory={directory}>
          <Harness />
        </SyncProvider>
      </I18nProvider>,
    ));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useInlineCommentDraftStore.setState({ drafts: {}, touchedAt: {} });
    useInputStore.setState({ composerAddress: null });
    if (surfaceDescriptor) Object.defineProperty(window, '__OPENCHAMBER_SURFACE__', surfaceDescriptor);
    else Reflect.deleteProperty(window, '__OPENCHAMBER_SURFACE__');
    if (frameDescriptor) Object.defineProperty(globalThis, 'requestAnimationFrame', frameDescriptor);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    dom.restore();
  });

  test('a file comment is filed into the target the composer published', async () => {
    const fork = { directory, sessionKey: 'ses_fork' };
    await act(async () => { useInputStore.setState({ composerAddress: { inline: fork, attachments: null } }); });

    await act(async () => { saveComment('why this value?', { start: 3, end: 3 }); });

    expect(draftsAt('ses_fork')).toHaveLength(1);
    expect(draftsAt('ses_parent')).toEqual([]);
  });

  test('without a published target it keeps the open session', async () => {
    await act(async () => { saveComment('why this value?', { start: 3, end: 3 }); });

    expect(draftsAt('ses_parent')).toHaveLength(1);
    expect(draftsAt('ses_fork')).toEqual([]);
  });
});
