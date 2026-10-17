import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

// A project without git never lists its root as a known branch, so a pin on it
// never clears by itself. This is how Mini Chat opens a draft from the main window.
const PLAIN = { id: 'plain', path: '/plain' };
const OTHER = { id: 'other', path: '/other' };

describe('useDraftTarget with a pinned draft directory', () => {
  let dom: Window;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, {
      window: dom,
      document: dom.document,
      navigator: dom.navigator,
      localStorage: dom.localStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    // Store modules probe the server on import; nothing here needs an answer.
    globalThis.fetch = Object.assign(async () => new Response(null, { status: 503 }), originalFetch);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    dom.close();
  });

  const renderDraftTarget = async (pendingWorktreeRequestId: string | null = null) => {
    const { createRoot } = await import('react-dom/client');
    const { I18nProvider } = await import('@/lib/i18n');
    const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
    const { createWebAPIs } = await import('../../../../../../../web/src/api/index');
    const { useProjectsStore } = await import('@/stores/useProjectsStore');
    const { useSessionUIStore } = await import('@/sync/session-ui-store');
    const { useDraftTarget } = await import('../useDraftTarget');

    useProjectsStore.setState({ projects: [PLAIN, OTHER], activeProjectId: PLAIN.id });
    useSessionUIStore.setState({
      availableWorktreesByProject: new Map(),
      newSessionDraft: {
        draftId: 1,
        open: true,
        selectedProjectId: PLAIN.id,
        directoryOverride: PLAIN.path,
        preserveDirectoryOverride: true,
        parentID: null,
        target: 'project',
        pendingWorktreeRequestId,
      },
    });

    const target = React.createRef<ReturnType<typeof useDraftTarget>>();
    const Probe = () => {
      target.current = useDraftTarget(false);
      return null;
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider>
          <RuntimeAPIContext.Provider value={createWebAPIs()}>
            <Probe />
          </RuntimeAPIContext.Provider>
        </I18nProvider>,
      );
    });
    return { target, root, useSessionUIStore };
  };

  test('picking another project moves the draft and clears the pin', async () => {
    const { target, root, useSessionUIStore } = await renderDraftTarget();

    await act(async () => target.current?.handleDraftProjectChange(OTHER.id));

    const draft = useSessionUIStore.getState().newSessionDraft;
    expect(draft.selectedProjectId).toBe(OTHER.id);
    expect(draft.directoryOverride).toBe(OTHER.path);
    expect(draft.preserveDirectoryOverride).toBe(false);
    await act(async () => root.unmount());
  });

  test('picking another directory moves the draft and clears the pin', async () => {
    const { target, root, useSessionUIStore } = await renderDraftTarget();

    await act(async () => target.current?.handleDraftDirectoryChange('/plain-feature'));

    const draft = useSessionUIStore.getState().newSessionDraft;
    expect(draft.selectedProjectId).toBe(PLAIN.id);
    expect(draft.directoryOverride).toBe('/plain-feature');
    expect(draft.preserveDirectoryOverride).toBe(false);
    await act(async () => root.unmount());
  });

  test('re-picking the shown project or directory keeps the pin', async () => {
    const { target, root, useSessionUIStore } = await renderDraftTarget();

    await act(async () => target.current?.handleDraftProjectChange(PLAIN.id));
    await act(async () => target.current?.handleDraftDirectoryChange(PLAIN.path));

    const draft = useSessionUIStore.getState().newSessionDraft;
    expect(draft.selectedProjectId).toBe(PLAIN.id);
    expect(draft.directoryOverride).toBe(PLAIN.path);
    expect(draft.preserveDirectoryOverride).toBe(true);
    await act(async () => root.unmount());
  });

  test('a worktree still being created keeps the draft where it is', async () => {
    const { target, root, useSessionUIStore } = await renderDraftTarget('request');

    await act(async () => target.current?.handleDraftProjectChange(OTHER.id));

    const draft = useSessionUIStore.getState().newSessionDraft;
    expect(draft.selectedProjectId).toBe(PLAIN.id);
    expect(draft.directoryOverride).toBe(PLAIN.path);
    expect(draft.preserveDirectoryOverride).toBe(true);
    await act(async () => root.unmount());
  });
});
