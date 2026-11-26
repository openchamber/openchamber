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
import { applyGlobalBlockingRequestEvents, applyWaitingPageEvent, resetGlobalBlockingRequests } from '@/sync/global-blocking-requests';
import { isWaitingPageRevealPending, takeWaitingPageReveal } from '@/sync/request-reveal';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { setSyncRefs } from '@/sync/sync-refs';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { sessionExpansionKey } from '../sessionSidebarRowModel';
import type { SessionNode } from '../types';
import type { SessionNodeItemProps } from './SessionNodeItem';
import { SessionNodeItem } from './SessionNodeItem';

const subagentParentNode = (subagentDirectory = '/project-a'): SessionNode => ({
  session: {
    id: 'ses_parent', projectID: 'project-a', title: 'Ship the release',
    directory: '/project-a', cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  },
  children: [{
    session: {
      id: 'ses_subagent', parentID: 'ses_parent', projectID: 'project-a', title: 'Run the checks',
      directory: subagentDirectory, cost: 0,
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
const originalSessionUI = useSessionUIStore.getState();
const originalMultiSelect = useSessionMultiSelectStore.getState();

const childStores = new ChildStoreManager();
// SAFETY: the badge's click lookup reads directory stores only; no SDK call is reached.
setSyncRefs({} as never, childStores, '');
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
  useSessionUIStore.setState(originalSessionUI, true);
  useSessionMultiSelectStore.setState(originalMultiSelect, true);
  takeWaitingPageReveal(null);
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
  expect(host.querySelector('[aria-label="Permission required. Opens the session that asks"]')).not.toBeNull();
});

const askPermissionOn = async (directory: string, sessionID: string): Promise<void> => {
  await act(async () => applyGlobalBlockingRequestEvents(directory, [{
    type: 'permission.asked',
    properties: { id: `perm-${sessionID}`, sessionID, action: 'bash', resources: [] },
  }]));
};

const recordSelections = () => {
  const selected: Array<[string, string | null]> = [];
  return { selected, handleSessionSelect: (sessionId: string, directory: string | null) => { selected.push([sessionId, directory]); } };
};

const click = async (element: HTMLElement | null): Promise<void> => {
  await act(async () => element?.click());
};

const PERMISSION_BADGE = '[data-pending-request-badge="permission"]';

test('the badge of a one-line row opens the hidden subagent that asks, in its own worktree, and not the parent', async () => {
  useSessionDisplayStore.setState({ showSubagentSessions: false });
  await askPermissionOn('/worktrees/checks', 'ses_subagent');
  const { selected, handleSessionSelect } = recordSelections();
  await render({ ...rowProps(), node: subagentParentNode('/worktrees/checks'), handleSessionSelect });

  const badge = host.querySelector<HTMLElement>(PERMISSION_BADGE);
  expect(badge?.tagName).toBe('BUTTON');
  expect(badge?.getAttribute('aria-label')).toBe('Permission required. Opens the session that asks');
  await click(badge);
  expect(selected).toEqual([['ses_subagent', '/worktrees/checks']]);
});

test('a one-line row keeps its badge out of what hides under the hover actions, and moves the actions beside it', async () => {
  useSessionDisplayStore.setState({ showSubagentSessions: false });
  await render(rowProps());
  const restingActions = host.querySelector('[data-session-row] > .absolute.z-10');
  expect(restingActions?.className).toContain('inset-e-1');

  await askPermissionOn('/project-a', 'ses_subagent');
  const badge = host.querySelector<HTMLElement>(PERMISSION_BADGE);
  const row = host.querySelector('[data-session-row]');
  expect(badge).not.toBeNull();
  for (let element = badge?.parentElement; element && element !== row; element = element.parentElement) {
    expect(element.className).not.toContain('group-hover:opacity-0');
  }
  const actions = host.querySelector('[data-session-row] > .absolute.z-10');
  expect(actions?.className).toContain('inset-e-[calc(1.625rem*var(--padding-scale,1))]');
});

test('the badge of a detailed row opens the waiting page of the hidden subagent and asks the chat to show it', async () => {
  useSessionDisplayStore.setState({ showSubagentSessions: false });
  await act(async () => applyWaitingPageEvent(
    { type: 'openchamber.page-waiting', properties: { sessionID: 'ses_subagent', directory: '/project-a', page: { id: 'call-1', title: 'Pick a layout' } } },
    () => '/project-a',
  ));
  const { selected, handleSessionSelect } = recordSelections();
  await render({ ...rowProps(), detailed: true, handleSessionSelect });

  const badge = host.querySelector<HTMLElement>('[data-pending-request-badge="form"]');
  expect(badge?.tagName).toBe('BUTTON');
  await click(badge);
  expect(selected).toEqual([['ses_subagent', '/project-a']]);
  expect(isWaitingPageRevealPending('ses_subagent')).toBe(true);
});

test('in multi-select the badge is a plain mark, and a click on it selects the row', async () => {
  useSessionDisplayStore.setState({ showSubagentSessions: false });
  useSessionMultiSelectStore.setState({ enabled: true, selectedIds: new Set() });
  await askPermissionOn('/project-a', 'ses_subagent');
  const { selected, handleSessionSelect } = recordSelections();
  await render({ ...rowProps(), handleSessionSelect });

  expect(host.querySelector<HTMLElement>(PERMISSION_BADGE)).toBeNull();
  const mark = host.querySelector<HTMLElement>('[aria-label="Permission required"]');
  expect(mark?.tagName).toBe('SPAN');
  await click(mark);
  expect(selected).toEqual([]);
  expect(useSessionMultiSelectStore.getState().selectedIds.has('ses_parent')).toBe(true);
});

test('the row stands in for an open session it hides, and only for that one', async () => {
  useSessionDisplayStore.setState({ showSubagentSessions: false });
  await render(rowProps());
  const row = () => host.querySelector('[data-session-row]');

  await act(async () => useSessionUIStore.setState({ currentSessionId: 'ses_subagent' }));
  expect(row()?.getAttribute('aria-current')).toBe('true');

  await act(async () => useSessionUIStore.setState({ currentSessionId: 'ses_parent' }));
  expect(row()?.getAttribute('aria-current')).toBe('page');

  await act(async () => useSessionUIStore.setState({ currentSessionId: 'ses_elsewhere' }));
  expect(row()?.getAttribute('aria-current')).toBeNull();

  await act(async () => useSessionDisplayStore.setState({ showSubagentSessions: true }));
  await render({ ...rowProps(), expandedParents: new Set([sessionExpansionKey('project', false, 'ses_parent')]) });
  await act(async () => useSessionUIStore.setState({ currentSessionId: 'ses_subagent' }));
  expect(row()?.getAttribute('aria-current')).toBeNull();
});

test('a double click on the badge opens the waiting session and leaves the row out of rename', async () => {
  useSessionDisplayStore.setState({ showSubagentSessions: false });
  await askPermissionOn('/project-a', 'ses_subagent');
  const renamed: string[] = [];
  await render({ ...rowProps(), handleSessionDoubleClick: (sessionId: string) => { renamed.push(sessionId); } });
  const badge = host.querySelector<HTMLElement>(PERMISSION_BADGE);
  await act(async () => badge?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })));
  expect(badge).not.toBeNull();
  expect(renamed).toEqual([]);
});

const VSCODE_ACTIONS_ROOM = 'group-hover:pe-[calc(3.375rem*var(--padding-scale,1))]';

for (const renderContext of ['project', 'tree-chat'] as const) {
  test(`in VS Code a ${renderContext} row keeps its badge in place and makes room for the hover actions beside it`, async () => {
    Object.defineProperty(window, '__VSCODE_CONFIG__', { configurable: true, value: { workspaceFolder: '/project-a' } });
    useSessionDisplayStore.setState({ showSubagentSessions: false });
    await askPermissionOn('/project-a', 'ses_subagent');
    await render({ ...rowProps(), renderContext, mobileVariant: true, alwaysShowActions: true });

    const badge = host.querySelector<HTMLElement>(PERMISSION_BADGE);
    const row = host.querySelector('[data-session-row]');
    expect(badge).not.toBeNull();
    for (let element = badge?.parentElement; element && element !== row; element = element.parentElement) {
      expect(/(^|\s)(group-hover:)?pe-/.test(element.className)).toBe(false);
      expect(element.className).not.toContain('group-hover:opacity-0');
    }
    expect(host.querySelector('[data-session-row] > .absolute.z-10')?.className).toContain('inset-e-[calc(1.625rem*var(--padding-scale,1))]');
    expect(badge?.closest('[data-session-row-main]')?.parentElement?.querySelector(`[class*="${VSCODE_ACTIONS_ROOM}"]`)).not.toBeNull();
  });
}
