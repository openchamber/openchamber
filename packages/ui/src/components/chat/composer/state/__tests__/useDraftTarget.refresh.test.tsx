import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const PROJECT = { id: 'project', path: '/repo' };

describe('useDraftTarget refresh', () => {
  let dom: Window;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, {
      Event: dom.Event, CustomEvent: dom.CustomEvent, MutationObserver: dom.MutationObserver,
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

  test('refreshes a fresh cached branch list when the window regains focus', async () => {
    const { createRoot } = await import('react-dom/client');
    const { I18nProvider } = await import('@/lib/i18n');
    const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
    const { createWebAPIs } = await import('../../../../../../../web/src/api/index');
    const { useProjectsStore } = await import('@/stores/useProjectsStore');
    const { useSessionUIStore } = await import('@/sync/session-ui-store');
    const { useGitStore } = await import('@/stores/useGitStore');
    const { useDraftTarget } = await import('../useDraftTarget');

    useProjectsStore.setState({ projects: [PROJECT], activeProjectId: PROJECT.id });
    useSessionUIStore.setState({
      availableWorktreesByProject: new Map(),
      newSessionDraft: {
        draftId: 1,
        open: true,
        selectedProjectId: PROJECT.id,
        directoryOverride: PROJECT.path,
        parentID: null,
        target: 'project',
      },
    });

    const calls: string[] = [];
    const now = Date.now();
    useGitStore.setState({
      directories: new Map([[PROJECT.path, {
        isGitRepo: true,
        status: null,
        branches: { all: ['main'], current: 'main', branches: {} },
        log: null,
        identity: null,
        diffCache: new Map(),
        indexRevision: 0,
        lastRepoCheckAt: now,
        lastStatusFetch: now,
        lastStatusChange: 0,
        lastLogFetch: 0,
        lastBranchesFetch: now,
        lastIdentityFetch: 0,
        logMaxCount: 25,
        isLoadingStatus: false,
        isLoadingLog: false,
        isLoadingBranches: false,
        isLoadingIdentity: false,
      }]]),
      fetchBranches: async (directory: string) => {
        calls.push(directory);
      },
    });

    const target = React.createRef<ReturnType<typeof useDraftTarget>>();
    const Probe = () => {
      target.current = useDraftTarget(true);
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

    // A fresh list is exactly the case the old code left alone.
    expect(calls).toEqual([]);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(calls).toEqual([PROJECT.path]);

    // A picker opened moments later reuses that read.
    await act(async () => {
      target.current?.refreshDraftTarget();
    });
    expect(calls).toEqual([PROJECT.path]);

    await act(async () => root.unmount());
  });

  test('leaves the target alone while a worktree is being created', async () => {
    const { createRoot } = await import('react-dom/client');
    const { I18nProvider } = await import('@/lib/i18n');
    const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
    const { createWebAPIs } = await import('../../../../../../../web/src/api/index');
    const { useProjectsStore } = await import('@/stores/useProjectsStore');
    const { useSessionUIStore } = await import('@/sync/session-ui-store');
    const { useGitStore } = await import('@/stores/useGitStore');
    const { useDraftTarget } = await import('../useDraftTarget');

    useProjectsStore.setState({ projects: [PROJECT], activeProjectId: PROJECT.id });
    useSessionUIStore.setState({
      availableWorktreesByProject: new Map(),
      newSessionDraft: {
        draftId: 1,
        open: true,
        selectedProjectId: PROJECT.id,
        directoryOverride: PROJECT.path,
        parentID: null,
        target: 'project',
        pendingWorktreeRequestId: 'creating',
      },
    });

    const calls: string[] = [];
    const now = Date.now();
    useGitStore.setState({
      directories: new Map([[PROJECT.path, {
        isGitRepo: true,
        status: null,
        branches: { all: ['main'], current: 'main', branches: {} },
        log: null,
        identity: null,
        diffCache: new Map(),
        indexRevision: 0,
        lastRepoCheckAt: now,
        lastStatusFetch: now,
        lastStatusChange: 0,
        lastLogFetch: 0,
        lastBranchesFetch: now,
        lastIdentityFetch: 0,
        logMaxCount: 25,
        isLoadingStatus: false,
        isLoadingLog: false,
        isLoadingBranches: false,
        isLoadingIdentity: false,
      }]]),
      fetchBranches: async (directory: string) => {
        calls.push(directory);
      },
    });

    const target = React.createRef<ReturnType<typeof useDraftTarget>>();
    const Probe = () => {
      target.current = useDraftTarget(true);
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

    // The creation owns the branch and worktree lists until it settles.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => {
      target.current?.refreshDraftTarget();
    });
    expect(calls).toEqual([]);

    await act(async () => root.unmount());
  });
});
