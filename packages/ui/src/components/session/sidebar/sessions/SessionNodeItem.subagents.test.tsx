import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { ChildStoreManager } from '@/sync/child-store';
import { SessionMessageLoader } from '@/sync/session-message-loader';
import { SyncRuntimeContext, type OpenCodeClient, type SyncRuntime } from '@/sync/sync-runtime-context';
import { applyGlobalBlockingRequestEvents, resetGlobalBlockingRequests } from '@/sync/global-blocking-requests';
import { sessionExpansionKey } from '../sessionSidebarRowModel';
import type { SessionNode } from '../types';
import type { SessionNodeItemProps } from './SessionNodeItem';
import { SessionNodeItem } from './SessionNodeItem';

const subagentParentNode = (): SessionNode => ({
  session: {
    id: 'ses_parent', projectID: 'project-a', title: 'Ship the release',
    directory: '/project-a', cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  },
  children: [{
    session: {
      id: 'ses_subagent', parentID: 'ses_parent', projectID: 'project-a', title: 'Run the checks',
      directory: '/project-a', cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    },
    children: [],
    worktree: null,
  }],
  worktree: null,
});

const noop = () => undefined;
const rowProps = (): SessionNodeItemProps => ({
  node: subagentParentNode(),
  ownsWork: false, projectId: 'project-a', renderContext: 'project',
  folderOwnerKey: 'project-a', groupDirectory: '/project-a',
  pinnedSessionIds: new Set(), expandedParents: new Set(),
  editingId: null, editingRowKey: null, editTitle: '', openSidebarMenuKey: null,
  setEditingId: noop, setEditingRowKey: noop, setEditTitle: noop,
  handleSaveEdit: noop, handleCancelEdit: noop, toggleParent: noop,
  handleSessionSelect: noop, handleSessionDoubleClick: noop,
  setOpenSidebarMenuKey: noop, createFolderAndStartRename: () => null,
  handleDeleteSession: noop, handleRestoreSession: noop,
  startSessionWorktreeMenuLoad: () => ({ cachedTargets: [], refreshTargets: Promise.resolve([]) }),
  mobileVariant: false, alwaysShowActions: false,
  subtreeContainsEditing: new Set(), menuOpenSessionId: null, nodeStructureKey: '',
});

let win: Window;
let root: Root;
let host: HTMLElement;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
const originalProjects = useProjectsStore.getState();
const originalShowSubagentSessions = useSessionDisplayStore.getState().showSubagentSessions;

const childStores = new ChildStoreManager();
const runtime: SyncRuntime = {
  runtimeKey: 'server-test',
  childStores,
  messageLoader: new SessionMessageLoader(childStores, {
    sdk: { getSessionMessages: async () => ({ items: [], cursor: {} }) },
    runtimeKey: 'server-test',
  }),
  // SAFETY: no row hook calls the SDK in this test.
  sdk: {} as OpenCodeClient,
  currentDirectory: { get: () => '/project', subscribe: () => () => undefined },
};

const render = async (props: SessionNodeItemProps): Promise<void> => {
  await act(async () => root.render(
    <I18nProvider>
      <SyncRuntimeContext.Provider value={runtime}>
        <SessionNodeItem {...props} />
      </SyncRuntimeContext.Provider>
    </I18nProvider>,
  ));
};

beforeEach(() => {
  win = new Window({ url: 'http://localhost/' });
  const globals = {
    window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage,
    Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
    HTMLIFrameElement: win.HTMLIFrameElement, Event: win.Event, MouseEvent: win.MouseEvent,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    ResizeObserver: win.ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of Object.keys(globals)) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.assign(globalThis, globals);
  useProjectsStore.setState({ projects: [{ id: 'project-a', path: '/project-a' }] });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  resetGlobalBlockingRequests();
  useProjectsStore.setState(originalProjects, true);
  useSessionDisplayStore.setState({ showSubagentSessions: originalShowSubagentSessions });
  await win.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('a parent of spawned sessions keeps its expander while those sessions are listed', async () => {
  useSessionDisplayStore.setState({ showSubagentSessions: true });
  await render(rowProps());
  expect(host.querySelector('[aria-expanded]')).not.toBeNull();
});

test('a parent whose only children are spawned sessions has no expander while they are hidden', async () => {
  useSessionDisplayStore.setState({ showSubagentSessions: false });
  await render(rowProps());
  expect(host.querySelector('[aria-expanded]')).toBeNull();
});

test('a parent expanded before its subagents were hidden still reports their pending permission', async () => {
  resetGlobalBlockingRequests();
  useSessionDisplayStore.setState({ showSubagentSessions: false });
  await act(async () => applyGlobalBlockingRequestEvents('/project-a', [{
    type: 'permission.asked',
    properties: { id: 'perm-1', sessionID: 'ses_subagent', action: 'bash', resources: [] },
  }]));
  await render({ ...rowProps(), expandedParents: new Set([sessionExpansionKey('project', false, 'ses_parent')]) });
  expect(host.querySelector('[aria-label="Permission required"]')).not.toBeNull();
});
