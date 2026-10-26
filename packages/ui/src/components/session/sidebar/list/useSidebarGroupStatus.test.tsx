import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, test } from 'bun:test';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { ChildStoreManager } from '@/sync/child-store';
import { FilesystemError } from '@/lib/api/files-errors';
import { installHookTestDom } from '../test-utils/testDom';
import type { SessionGroup } from '../types';
import type { ProjectSection } from '../projects/sessionProjectRender';
import { useSidebarGroupStatus } from './useSidebarGroupStatus';

const sections: ProjectSection[] = [];
const chatGroup: SessionGroup = {
  id: 'managed-chats', label: '', branch: null, description: null, isMain: true,
  worktree: null, directory: '/chats', folderScopeKey: '/chats', sessions: [],
  folderScopes: [{ scopeKey: '/chats', directory: '/chats' }, { scopeKey: '/chats/session', directory: '/chats/session' }],
};

beforeEach(() => useGlobalSessionsStore.getState().resetForRuntimeSwitch());

for (const failure of ['load-failed', 'initialization-failed', 'permission-denied'] as const) {
  test(`a Chats-only sidebar observes ${failure} and a successful retry`, async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const manager = new ChildStoreManager();
    const captured = React.createRef<ReturnType<typeof useSidebarGroupStatus>>();
    let renders = 0;
    let fail = true;
    manager.configure({ onBootstrap: (context) => {
      if (!fail) { context.trackInitialization(Promise.resolve()); return; }
      if (failure === 'load-failed') throw new Error('list failed');
      const error = failure === 'permission-denied'
        ? new FilesystemError('Access denied', { reason: 'os-permission' })
        : new Error('initialization failed');
      context.trackInitialization(Promise.reject(error));
    } });
    const Harness = ({ nativeAccess = true }: { nativeAccess?: boolean }) => {
      renders += 1;
      captured.current = useSidebarGroupStatus({ childStores: manager, sections, chatGroup, canGrantAccess: nativeAccess });
      return null;
    };
    try {
      await act(async () => root.render(<Harness />));
      await act(async () => manager.requestBootstrap({ directory: '/chats/session', priority: 'selected', reason: 'selected-session' }));
      expect(captured.current?.groupStatusByKey.get('activity:chats')).toEqual({
        state: failure, directory: '/chats/session', canGrantAccess: failure === 'permission-denied',
      });
      await act(async () => root.render(<Harness nativeAccess={false} />));
      expect(captured.current?.groupStatusByKey.get('activity:chats')?.canGrantAccess).toBe(false);

      const previousRenders = renders;
      await act(async () => manager.requestBootstrap({ directory: '/unrelated', priority: 'selected', reason: 'selected-session' }));
      expect(renders).toBe(previousRenders);
      fail = false;
      await act(async () => manager.requestBootstrap({ directory: '/chats/session', priority: 'expanded', reason: 'project-expanded', force: true }));
      // One completed directory does not cover the other Chats scope.
      expect(captured.current?.groupStatusByKey.get('activity:chats')?.state).toBe('loading');
      await act(async () => manager.requestBootstrap({ directory: '/chats', priority: 'selected', reason: 'current-directory' }));
      expect(captured.current?.groupStatusByKey.get('activity:chats')?.state).toBe('ready');
    } finally {
      await act(async () => root.unmount());
      manager.disposeAll();
      dom.restore();
    }
  });
}

test('Chats loading ends when its list completes, without waiting for initialization', async () => {
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const manager = new ChildStoreManager();
  let resolveList: () => void = () => undefined;
  let resolveInitialization: () => void = () => undefined;
  const list = new Promise<void>((resolve) => { resolveList = resolve; });
  const initialization = new Promise<void>((resolve) => { resolveInitialization = resolve; });
  manager.configure({ onBootstrap: (context) => { context.trackInitialization(initialization); return list; } });
  const captured = React.createRef<ReturnType<typeof useSidebarGroupStatus>>();
  const Harness = () => {
    captured.current = useSidebarGroupStatus({ childStores: manager, sections, chatGroup, canGrantAccess: false });
    return null;
  };
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => manager.requestBootstrap({ directory: '/chats', priority: 'selected', reason: 'selected-session' }));
    expect(captured.current?.groupStatusByKey.get('activity:chats')?.state).toBe('loading');
    await act(async () => manager.requestBootstrap({ directory: '/chats/session', priority: 'selected', reason: 'selected-session' }));
    await act(async () => resolveList());
    expect(manager.getInitializationState('/chats')).toBe('running');
    expect(captured.current?.groupStatusByKey.get('activity:chats')?.state).toBe('ready');
  } finally {
    await act(async () => { resolveList(); resolveInitialization(); root.unmount(); });
    manager.disposeAll();
    dom.restore();
  }
});

test('A complete global list keeps an opened empty group out of loading', async () => {
  useGlobalSessionsStore.getState().applySnapshot([], []);
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const manager = new ChildStoreManager();
  let resolveList: () => void = () => undefined;
  const list = new Promise<void>((resolve) => { resolveList = resolve; });
  manager.configure({ onBootstrap: () => list });
  const captured = React.createRef<ReturnType<typeof useSidebarGroupStatus>>();
  const Harness = () => {
    captured.current = useSidebarGroupStatus({ childStores: manager, sections, chatGroup, canGrantAccess: false });
    return null;
  };
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => manager.requestBootstrap({ directory: '/chats', priority: 'selected', reason: 'selected-session' }));
    expect(manager.getBootstrapState('/chats')).toBe('running');
    expect(captured.current?.groupStatusByKey.get('activity:chats')?.state).toBe('ready');
  } finally {
    await act(async () => { resolveList(); root.unmount(); });
    manager.disposeAll();
    dom.restore();
  }
});

const projectGroup: SessionGroup = {
  ...chatGroup, id: 'root', directory: '/project', folderScopeKey: '/project', folderScopes: undefined,
};
const projectSections: ProjectSection[] = [{
  project: { id: 'project', normalizedPath: '/project' }, groups: [projectGroup],
}];

test('unopened groups wait for the global list, expose failure, and settle after retry', async () => {
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const manager = new ChildStoreManager();
  const captured = React.createRef<ReturnType<typeof useSidebarGroupStatus>>();
  const Harness = () => {
    captured.current = useSidebarGroupStatus({ childStores: manager, sections: projectSections, chatGroup, canGrantAccess: true });
    return null;
  };
  const states = () => [...(captured.current?.groupStatusByKey.values() ?? [])];
  try {
    await act(async () => root.render(<Harness />));
    expect(states().map((status) => status.state)).toEqual(['loading', 'loading']);
    await act(async () => useGlobalSessionsStore.setState({ status: 'loading' }));
    expect(states().map((status) => status.state)).toEqual(['loading', 'loading']);
    await act(async () => useGlobalSessionsStore.setState({ status: 'error' }));
    expect(states()).toEqual([
      { state: 'load-failed', directory: null, canGrantAccess: false },
      { state: 'load-failed', directory: null, canGrantAccess: false },
    ]);
    await act(async () => useGlobalSessionsStore.setState({ status: 'loading' }));
    expect(states().map((status) => status.state)).toEqual(['loading', 'loading']);
    await act(async () => useGlobalSessionsStore.getState().applySnapshot([], []));
    expect(states().map((status) => status.state)).toEqual(['ready', 'ready']);
    // Routine polling must not flash loading over a known empty group.
    await act(async () => useGlobalSessionsStore.setState({ status: 'loading' }));
    expect(states().map((status) => status.state)).toEqual(['ready', 'ready']);
    expect(manager.getBootstrapState('/project')).toBeUndefined();
    expect(manager.getBootstrapState('/chats')).toBeUndefined();
    await act(async () => useGlobalSessionsStore.getState().resetForRuntimeSwitch());
    expect(states().map((status) => status.state)).toEqual(['loading', 'loading']);
  } finally {
    await act(async () => root.unmount());
    manager.disposeAll();
    dom.restore();
  }
});

test('a complete directory does not hide a global failure in an unrelated group', async () => {
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const manager = new ChildStoreManager();
  manager.configure({ onBootstrap: () => undefined });
  const captured = React.createRef<ReturnType<typeof useSidebarGroupStatus>>();
  const Harness = () => {
    captured.current = useSidebarGroupStatus({ childStores: manager, sections: projectSections, chatGroup, canGrantAccess: false });
    return null;
  };
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => manager.requestBootstrap({ directory: '/project', priority: 'selected', reason: 'current-directory' }));
    await act(async () => useGlobalSessionsStore.setState({ status: 'error' }));
    expect(captured.current?.groupStatusByKey.get('project:root')?.state).toBe('ready');
    expect(captured.current?.groupStatusByKey.get('activity:chats')).toEqual({ state: 'load-failed', directory: null, canGrantAccess: false });
  } finally {
    await act(async () => root.unmount());
    manager.disposeAll();
    dom.restore();
  }
});

test('directory active-list coverage cannot finish an archived group before the global list', async () => {
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const manager = new ChildStoreManager();
  manager.configure({ onBootstrap: () => undefined });
  const archivedSections: ProjectSection[] = [{
    project: projectSections[0].project,
    groups: [projectGroup, { ...projectGroup, id: 'archived', isArchivedBucket: true }],
  }];
  const captured = React.createRef<ReturnType<typeof useSidebarGroupStatus>>();
  const Harness = () => {
    captured.current = useSidebarGroupStatus({ childStores: manager, sections: archivedSections, chatGroup: null, canGrantAccess: false });
    return null;
  };
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => manager.requestBootstrap({ directory: '/project', priority: 'selected', reason: 'current-directory' }));
    expect(captured.current?.groupStatusByKey.get('project:root')?.state).toBe('ready');
    expect(captured.current?.groupStatusByKey.get('project:archived')?.state).toBe('loading');
    await act(async () => useGlobalSessionsStore.getState().applySnapshot([], []));
    expect(captured.current?.groupStatusByKey.get('project:archived')?.state).toBe('ready');
  } finally {
    await act(async () => root.unmount());
    manager.disposeAll();
    dom.restore();
  }
});
