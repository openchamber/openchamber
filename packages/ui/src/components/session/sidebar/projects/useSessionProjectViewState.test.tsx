import { beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ProjectEntry } from '@/lib/api/types';
import type { DesktopSettings } from '@/lib/desktop';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { useSessionProjectViewState } from './useSessionProjectViewState';

const settingsWrites: Array<Partial<DesktopSettings>> = [];
const writeSettings = async (changes: Partial<DesktopSettings>) => {
  settingsWrites.push(changes);
  return { ok: true };
};

const savedCollapse = () => settingsWrites.map((write) => (
  (write.projects ?? []).flatMap((project) => (project.sidebarCollapsed ? [project.id] : []))
));

class ElementStub implements Partial<Element> {
  nodeType = 1;
}
type DocumentStub = {
  nodeType: number;
  defaultView: typeof globalThis;
  activeElement: null;
  addEventListener: () => void;
  removeEventListener: () => void;
  documentElement?: Element;
  body?: Element;
};
type GlobalValue = typeof globalThis | typeof ElementStub | DocumentStub | boolean;
type HookCapture = {
  state?: ReturnType<typeof useSessionProjectViewState>['state'];
  actions?: ReturnType<typeof useSessionProjectViewState>['actions'];
  renderCount: number;
};

const installMinimalDom = () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: GlobalValue) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const documentStub: DocumentStub = {
    nodeType: 9,
    defaultView: globalThis,
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  // SAFETY: React's test renderer only inspects this fixture's DOM identity fields and listeners.
  const container = Object.create(ElementStub.prototype) as Element;
  Object.assign(container, {
    nodeType: 1,
    tagName: 'DIV',
    nodeName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: documentStub,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  documentStub.documentElement = container;
  documentStub.body = container;
  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('Element', ElementStub);
  setGlobal('HTMLElement', ElementStub);
  setGlobal('HTMLIFrameElement', ElementStub);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return {
    container,
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

describe('useSessionProjectViewState', () => {
  beforeEach(() => {
    const storage = getDeferredSafeStorage();
    storage.removeItem('oc.sessions.projectCollapse');
    storage.removeItem('oc.sessions.groupCollapse');
    storage.removeItem('oc.sessions.activityCollapse');
    storage.removeItem(`oc.sessions.projectCollapse.pending:${encodeURIComponent(getRuntimeKey())}`);
    useProjectsStore.setState({ hasServerSnapshot: false, projects: [] });
    settingsWrites.length = 0;
  });

  test('keeps stable state/actions and ignores selection-store updates', async () => {
    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);
    const capture: HookCapture = { renderCount: 0 };
    const projects = [{ id: 'project-a' }, { id: 'project-b' }];
    const Harness = () => {
      capture.renderCount += 1;
      const viewState = useSessionProjectViewState({ isVSCode: true, projects });
      capture.state = viewState.state;
      capture.actions = viewState.actions;
      return null;
    };

    try {
      await act(async () => root.render(React.createElement(Harness)));
      const initialState = capture.state;
      const initialActions = capture.actions;
      const initialRenderCount = capture.renderCount;
      if (!initialState || !initialActions) throw new Error('hook did not mount');

      await act(async () => {
        useSessionUIStore.setState({ currentSessionId: 'selection-only' });
      });
      expect(capture.renderCount).toBe(initialRenderCount);
      expect(capture.state).toBe(initialState);
      expect(capture.actions).toBe(initialActions);

      await act(async () => initialActions.toggleProject('project-a'));
      expect(capture.state?.collapsedProjects).toEqual(new Set(['project-a']));
      // Collapse all / Expand all drive every zone and leave a key no zone
      // uses any more alone.
      await act(async () => initialActions.setCollapsedActivities(new Set(['retired-zone'])));
      await act(async () => initialActions.collapseAll());
      expect(capture.state?.collapsedProjects).toEqual(new Set(['project-a', 'project-b']));
      expect(capture.state?.collapsedActivities).toEqual(new Set(['retired-zone', 'pages', 'chats', 'pinned', 'work', 'timeline']));
      await act(async () => initialActions.expandAll());
      expect(capture.state?.collapsedProjects).toEqual(new Set());
      expect(capture.state?.collapsedActivities).toEqual(new Set(['retired-zone']));

      await act(async () => initialActions.toggleGroup('project-a:group-a'));
      expect(capture.state?.collapsedGroups).toEqual(new Set(['project-a:group-a']));

      await new Promise((resolve) => setTimeout(resolve, 0));
      const storage = getDeferredSafeStorage();
      expect(JSON.parse(storage.getItem('oc.sessions.projectCollapse') ?? 'null')).toEqual([]);
      expect(JSON.parse(storage.getItem('oc.sessions.groupCollapse') ?? 'null')).toEqual(['project-a:group-a']);
      expect(JSON.parse(storage.getItem('oc.sessions.activityCollapse') ?? 'null')).toEqual(['retired-zone']);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('preserves malformed group storage until explicit user mutation', async () => {
    const storage = getDeferredSafeStorage();
    const malformedCollapse = '{malformed-collapse';
    storage.setItem('oc.sessions.groupCollapse', malformedCollapse);
    const dom = installMinimalDom();
    const root = createRoot(dom.container);
    const capture: HookCapture = { renderCount: 0 };
    const Harness = () => {
      capture.renderCount += 1;
      const value = useSessionProjectViewState({ isVSCode: true, projects: [{ id: 'project-a' }] });
      capture.state = value.state;
      capture.actions = value.actions;
      return null;
    };

    try {
      await act(async () => root.render(React.createElement(Harness)));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(capture.state?.collapsedGroups).toEqual(new Set());
      expect(storage.getItem('oc.sessions.groupCollapse')).toBe(malformedCollapse);

      await act(async () => capture.actions!.toggleGroup('project-a:group-a'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(JSON.parse(storage.getItem('oc.sessions.groupCollapse') ?? 'null')).toEqual(['project-a:group-a']);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('retains persisted project/group state while hidden and across a full remount', async () => {
    const storage = getDeferredSafeStorage();
    storage.setItem('oc.sessions.projectCollapse', JSON.stringify(['project-a']));
    storage.setItem('oc.sessions.groupCollapse', JSON.stringify(['project-a:group-a']));
    storage.setItem('oc.sessions.activityCollapse', JSON.stringify(['chats', 'work']));
    const dom = installMinimalDom();
    const root = createRoot(dom.container);
    const capture: HookCapture = { renderCount: 0 };
    const Harness = ({ hidden }: { hidden: boolean }) => {
      void hidden;
      capture.renderCount += 1;
      const value = useSessionProjectViewState({ isVSCode: true, projects: [{ id: 'project-a' }] });
      capture.state = value.state;
      capture.actions = value.actions;
      return null;
    };

    try {
      await act(async () => root.render(React.createElement(Harness, { hidden: false })));
      await act(async () => root.render(React.createElement(Harness, { hidden: true })));
      await act(async () => root.render(React.createElement(Harness, { hidden: false })));
      expect(capture.state?.collapsedProjects).toEqual(new Set(['project-a']));
      expect(capture.state?.collapsedGroups).toEqual(new Set(['project-a:group-a']));

      await act(async () => root.render(null));
      await act(async () => root.render(React.createElement(Harness, { hidden: false })));
      expect(capture.state?.collapsedProjects).toEqual(new Set(['project-a']));
      expect(capture.state?.collapsedGroups).toEqual(new Set(['project-a:group-a']));
      expect(capture.state?.collapsedActivities).toEqual(new Set(['chats', 'work']));
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
  test('adopts the instance\'s own collapse state when its project list arrives after a switch', async () => {
    // The device-wide key still lists the previous instance's projects.
    getDeferredSafeStorage().setItem('oc.sessions.projectCollapse', JSON.stringify(['local-a']));
    const dom = installMinimalDom();
    const root = createRoot(dom.container);
    const capture: HookCapture = { renderCount: 0 };
    let projects: Array<{ id: string; sidebarCollapsed?: boolean }> = [{ id: 'remote-a' }, { id: 'remote-b' }];
    const Harness = () => {
      const value = useSessionProjectViewState({ isVSCode: false, projects, writeSettings });
      capture.state = value.state;
      capture.actions = value.actions;
      return null;
    };

    try {
      await act(async () => root.render(React.createElement(Harness)));
      expect(capture.state?.collapsedProjects).toEqual(new Set(['local-a']));

      projects = [{ id: 'remote-a', sidebarCollapsed: true }, { id: 'remote-b', sidebarCollapsed: false }];
      await act(async () => useProjectsStore.setState({ hasServerSnapshot: true }));
      expect(capture.state?.collapsedProjects).toEqual(new Set(['remote-a']));

      // Later syncs leave the user's folding alone.
      await act(async () => capture.actions!.toggleProject('remote-b'));
      projects = [{ id: 'remote-a', sidebarCollapsed: false }, { id: 'remote-b', sidebarCollapsed: false }];
      await act(async () => useProjectsStore.setState({ hasServerSnapshot: false }));
      await act(async () => useProjectsStore.setState({ hasServerSnapshot: true }));
      expect(capture.state?.collapsedProjects).toEqual(new Set(['remote-a', 'remote-b']));
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('keeps a fold made before the project list arrives', async () => {
    const dom = installMinimalDom();
    const root = createRoot(dom.container);
    const capture: HookCapture = { renderCount: 0 };
    let projects: Array<{ id: string; sidebarCollapsed?: boolean }> = [{ id: 'remote-a' }];
    const Harness = () => {
      const value = useSessionProjectViewState({ isVSCode: false, projects, writeSettings });
      capture.state = value.state;
      capture.actions = value.actions;
      return null;
    };

    try {
      await act(async () => root.render(React.createElement(Harness)));
      await act(async () => capture.actions!.toggleProject('remote-a'));
      projects = [{ id: 'remote-a', sidebarCollapsed: false }];
      await act(async () => useProjectsStore.setState({ hasServerSnapshot: true }));
      expect(capture.state?.collapsedProjects).toEqual(new Set(['remote-a']));
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
  test('replays a fold made while the instance loads over its own collapse state', async () => {
    // The local key still lists the previous instance's projects.
    getDeferredSafeStorage().setItem('oc.sessions.projectCollapse', JSON.stringify(['local-a']));
    const dom = installMinimalDom();
    const root = createRoot(dom.container);
    const capture: HookCapture = { renderCount: 0 };
    let projects: Array<{ id: string; sidebarCollapsed?: boolean }> = [];
    const Harness = () => {
      const value = useSessionProjectViewState({ isVSCode: false, projects, writeSettings });
      capture.state = value.state;
      capture.actions = value.actions;
      return null;
    };

    try {
      await act(async () => root.render(React.createElement(Harness)));
      // Opened, then folded again: the last choice for remote-a is "collapsed".
      await act(async () => capture.actions!.toggleProject('remote-a'));
      await act(async () => capture.actions!.toggleProject('remote-a'));
      await act(async () => capture.actions!.toggleProject('remote-a'));
      expect(settingsWrites).toEqual([]);

      const stored: ProjectEntry[] = [
        { id: 'remote-a', path: '/a', sidebarCollapsed: false },
        { id: 'remote-b', path: '/b', sidebarCollapsed: true },
        { id: 'remote-c', path: '/c', sidebarCollapsed: false },
      ];
      projects = stored;
      await act(async () => useProjectsStore.setState({ projects: stored, hasServerSnapshot: true }));
      expect(capture.state?.collapsedProjects).toEqual(new Set(['remote-a', 'remote-b']));
      expect(savedCollapse()).toEqual([['remote-a', 'remote-b']]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('replays Collapse all and the folds after it over the arriving list', async () => {
    const dom = installMinimalDom();
    const root = createRoot(dom.container);
    const capture: HookCapture = { renderCount: 0 };
    let projects: Array<{ id: string; sidebarCollapsed?: boolean }> = [{ id: 'local-a' }];
    const Harness = () => {
      const value = useSessionProjectViewState({ isVSCode: false, projects, writeSettings });
      capture.state = value.state;
      capture.actions = value.actions;
      return null;
    };

    try {
      await act(async () => root.render(React.createElement(Harness)));
      await act(async () => capture.actions!.collapseAll());
      await act(async () => capture.actions!.toggleProject('remote-b'));
      expect(settingsWrites).toEqual([]);

      const stored: ProjectEntry[] = [
        { id: 'remote-a', path: '/a', sidebarCollapsed: false },
        { id: 'remote-b', path: '/b', sidebarCollapsed: false },
      ];
      projects = stored;
      await act(async () => useProjectsStore.setState({ projects: stored, hasServerSnapshot: true }));
      // remote-b was not in the old list, so its toggle folded it.
      expect(capture.state?.collapsedProjects).toEqual(new Set(['remote-a', 'remote-b']));

      await act(async () => capture.actions!.expandAll());
      expect(capture.state?.collapsedProjects).toEqual(new Set());
      expect(savedCollapse()).toEqual([['remote-a', 'remote-b'], []]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('hands a fold to the settings writer at once, so a reload right after keeps it', async () => {
    const stored: ProjectEntry[] = [{ id: 'remote-a', path: '/a', sidebarCollapsed: false }];
    useProjectsStore.setState({ projects: stored, hasServerSnapshot: true });
    const dom = installMinimalDom();
    const root = createRoot(dom.container);
    const capture: HookCapture = { renderCount: 0 };
    const Harness = () => {
      const value = useSessionProjectViewState({ isVSCode: false, projects: stored, writeSettings });
      capture.state = value.state;
      capture.actions = value.actions;
      return null;
    };

    try {
      await act(async () => root.render(React.createElement(Harness)));
      await act(async () => capture.actions!.toggleProject('remote-a'));
      expect(savedCollapse()).toEqual([['remote-a']]);
      expect(getDeferredSafeStorage().getItem('oc.sessions.projectCollapse')).toBe(JSON.stringify(['remote-a']));
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('puts the fold into the project store, so a reorder right after saves it too', async () => {
    const stored: ProjectEntry[] = [
      { id: 'remote-a', path: '/a', sidebarCollapsed: false },
      { id: 'remote-b', path: '/b', sidebarCollapsed: false },
    ];
    useProjectsStore.setState({ projects: stored, hasServerSnapshot: true });
    const dom = installMinimalDom();
    const root = createRoot(dom.container);
    const capture: HookCapture = { renderCount: 0 };
    const Harness = () => {
      const value = useSessionProjectViewState({ isVSCode: false, projects: stored, writeSettings });
      capture.state = value.state;
      capture.actions = value.actions;
      return null;
    };

    try {
      await act(async () => root.render(React.createElement(Harness)));
      await act(async () => capture.actions!.toggleProject('remote-a'));
      // A reorder rebuilds its settings write from the store's entries.
      expect(useProjectsStore.getState().projects.map((project) => [project.id, project.sidebarCollapsed])).toEqual([
        ['remote-a', true],
        ['remote-b', false],
      ]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('replays a fold made while the instance loads after a reload before its list arrives', async () => {
    const dom = installMinimalDom();
    const root = createRoot(dom.container);
    const capture: HookCapture = { renderCount: 0 };
    let projects: Array<{ id: string; sidebarCollapsed?: boolean }> = [{ id: 'remote-a' }];
    const Harness = () => {
      const value = useSessionProjectViewState({ isVSCode: false, projects, writeSettings });
      capture.state = value.state;
      capture.actions = value.actions;
      return null;
    };

    try {
      await act(async () => root.render(React.createElement(Harness)));
      await act(async () => capture.actions!.toggleProject('remote-a'));
      // The reload: the component's own memory is gone.
      await act(async () => root.render(null));
      await act(async () => root.render(React.createElement(Harness)));

      const stored: ProjectEntry[] = [{ id: 'remote-a', path: '/a', sidebarCollapsed: false }];
      projects = stored;
      await act(async () => useProjectsStore.setState({ projects: stored, hasServerSnapshot: true }));
      expect(capture.state?.collapsedProjects).toEqual(new Set(['remote-a']));
      expect(savedCollapse()).toEqual([['remote-a']]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
