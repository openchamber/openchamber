import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const PROJECT = { id: 'project', path: '/repo' };
const WORKTREE = '/repo-feature';

describe('useDraftTarget while a new worktree attaches', () => {
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

  test('keeps the selected worktree listed until its bootstrap settles, without rewriting the draft', async () => {
    const { createRoot } = await import('react-dom/client');
    const { I18nProvider } = await import('@/lib/i18n');
    const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
    const { createWebAPIs } = await import('../../../../../../../web/src/api/index');
    const { useProjectsStore } = await import('@/stores/useProjectsStore');
    const { useSessionUIStore } = await import('@/sync/session-ui-store');
    const { markWorktreeBootstrapPending, setWorktreeBootstrapState, clearWorktreeBootstrapState } = await import('@/lib/worktrees/worktreeBootstrap');
    const { useDraftTarget } = await import('../useDraftTarget');

    useProjectsStore.setState({ projects: [PROJECT], activeProjectId: PROJECT.id });
    useSessionUIStore.setState({
      availableWorktreesByProject: new Map(),
      newSessionDraft: {
        draftId: 1,
        open: true,
        selectedProjectId: PROJECT.id,
        directoryOverride: WORKTREE,
        parentID: null,
        target: 'project',
      },
    });
    markWorktreeBootstrapPending(WORKTREE);

    let listed: string[] = [];
    const Probe = () => {
      listed = useDraftTarget(false).draftBranchItems.map((item) => item.value);
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

    // Git lists the worktree only once its attach finishes, so a refresh in
    // this window omits it; the selection must survive that.
    expect(listed).toContain(WORKTREE);
    await act(async () => {
      useSessionUIStore.setState({ availableWorktreesByProject: new Map([[PROJECT.path, []]]) });
    });
    expect(listed).toContain(WORKTREE);
    expect(useSessionUIStore.getState().newSessionDraft.directoryOverride).toBe(WORKTREE);

    await act(async () => {
      setWorktreeBootstrapState(WORKTREE, { status: 'failed', error: 'attach failed', updatedAt: Date.now() });
    });
    expect(listed).not.toContain(WORKTREE);

    await act(async () => root.unmount());
    clearWorktreeBootstrapState(WORKTREE);
  });
});
