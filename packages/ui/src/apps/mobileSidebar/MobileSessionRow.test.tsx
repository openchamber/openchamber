import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import type { Session } from '@/lib/opencode/model';
import type { SessionSidebarRow } from '@/components/session/sidebar/sessionSidebarRowModel';
import type { SessionGroup, SessionNode } from '@/components/session/sidebar/types';
import { ChildStoreManager } from '@/sync/child-store';
import { applyGlobalBlockingRequestEvents, resetGlobalBlockingRequests } from '@/sync/global-blocking-requests';
import { SyncRuntimeContext, type SyncRuntime } from '@/sync/sync-runtime-context';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isWaitingPageRevealPending, takeWaitingPageReveal } from '@/sync/request-reveal';
import { setSyncRefs } from '@/sync/sync-refs';
import { applyWaitingPageEvent } from '@/sync/global-blocking-requests';
import { findCurrentRowIndex } from './mobileCurrentRow';
import { MobileSessionRow } from './MobileSessionRow';
import { MOBILE_TREE_GEOMETRY } from './mobileSidebarGeometry';
import { MobileSidebarActionsProvider, type MobileSidebarActions } from './mobileSidebarState';

const session = (id: string, parentID?: string): Session => {
  const base: Session = {
    id,
    projectID: 'project-a',
    directory: '/project',
    title: id,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  };
  return parentID ? { ...base, parentID } : base;
};

const node = (value: Session, children: SessionNode[] = []): SessionNode => ({ session: value, children, worktree: null });
const subagentNode = (): SessionNode => ({ session: session('ses_subagent', 'ses_parent'), children: [], worktree: null });
const reviewNode = (): SessionNode => ({
  session: { ...session('ses_review'), metadata: { openchamber: { kind: 'review', originalSessionID: 'ses_parent' } } },
  children: [],
  worktree: null,
});

const parentNode = (children: SessionNode[] = [subagentNode()]): SessionNode => ({
  session: session('ses_parent'),
  children,
  worktree: null,
});

const row = (expanded?: boolean, node: SessionNode = parentNode()): Extract<SessionSidebarRow, { kind: 'session' }> => {
  const base: Extract<SessionSidebarRow, { kind: 'session' }> = {
    kind: 'session', key: 'project:session:ses_parent', estimateSize: 32,
    node, depth: 0, ownsWork: false,
    projectId: null, ownerProjectId: null, groupDirectory: '/project',
    ownerKey: null, selectionScopeKey: null, archived: false,
    renderContext: 'project', secondaryMeta: null,
  };
  return expanded === undefined ? base : { ...base, expanded };
};

let drawerCloses = 0;
const actions: MobileSidebarActions = {
  close: () => { drawerCloses += 1; },
  openProjectEdit: () => undefined,
  openNewWorktree: () => undefined,
  requestWorktreeDelete: () => undefined,
  openId: 1,
};

let win: Window;
let root: Root;
let host: HTMLElement;
const descriptors = new Map<string, PropertyDescriptor | undefined>();

// SAFETY: the row hooks this test renders read only `runtimeKey` and `childStores`; no SDK or loaders are reached.
// The badge lookup creates directory stores without bootstrapping them, so the index answers.
const createRuntime = () => ({ runtimeKey: 'server-test', childStores: new ChildStoreManager() } as SyncRuntime);
let runtime = createRuntime();

const render = async (value: Extract<SessionSidebarRow, { kind: 'session' }>): Promise<void> => {
  await act(async () => root.render(
    <I18nProvider>
      <SyncRuntimeContext.Provider value={runtime}>
        <MobileSidebarActionsProvider value={actions}>
          <MobileSessionRow row={value} geometry={MOBILE_TREE_GEOMETRY} toggleParent={() => undefined} />
        </MobileSidebarActionsProvider>
      </SyncRuntimeContext.Provider>
    </I18nProvider>,
  ));
};

const askPermissionOn = async (sessionID: string): Promise<void> => {
  await act(async () => applyGlobalBlockingRequestEvents('/project', [{
    type: 'permission.asked',
    properties: { id: `perm-${sessionID}`, sessionID, action: 'bash', resources: [] },
  }]));
};
const askPermissionOnSubagent = (): Promise<void> => askPermissionOn('ses_subagent');
const originalShowSubagentSessions = useSessionDisplayStore.getState().showSubagentSessions;
const originalSessionUI = useSessionUIStore.getState();
let opened: Array<[string, string | null | undefined]> = [];

beforeEach(() => {
  resetGlobalBlockingRequests();
  runtime = createRuntime();
  // SAFETY: the badge's tap lookup reads directory stores only; no SDK call is reached.
  setSyncRefs({} as never, runtime.childStores, '');
  drawerCloses = 0;
  opened = [];
  useSessionUIStore.setState({
    currentSessionId: null,
    setCurrentSession: async (id, directory) => { opened.push([id ?? '', directory]); },
  });
  win = new Window({ url: 'http://localhost/' });
  const globals = {
    window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage,
    Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
    Event: win.Event, MouseEvent: win.MouseEvent, MutationObserver: win.MutationObserver,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    ResizeObserver: win.ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of Object.keys(globals)) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.assign(globalThis, globals);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  resetGlobalBlockingRequests();
  useSessionDisplayStore.setState({ showSubagentSessions: originalShowSubagentSessions });
  useSessionUIStore.setState(originalSessionUI, true);
  takeWaitingPageReveal(null);
  await win.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('a parent row without listed children still reports a spawned child waiting on the user', async () => {
  await askPermissionOnSubagent();
  await render(row());
  expect(host.querySelector<HTMLElement>('[data-pending-request-badge="permission"]')).not.toBeNull();
  expect(host.querySelector('[aria-expanded]')).toBeNull();
});

test('a request settled while the stream was down clears once the directory store has re-read it (#6802)', async () => {
  await askPermissionOn('ses_parent');
  await render(row());
  expect(host.querySelector<HTMLElement>('[data-pending-request-badge="permission"]')).not.toBeNull();

  // The index never saw permission.replied; the store's own read found nothing pending.
  await act(async () => runtime.childStores.ensureChild('/project', { bootstrap: false }).setState({ status: 'complete', session: [row().node.session], requestCoverage: new Set([row().node.session.id]) }));
  expect(host.querySelector<HTMLElement>('[data-pending-request-badge="permission"]')).toBeNull();
});

test('an expanded parent leaves its child rows to report themselves', async () => {
  useSessionDisplayStore.setState({ showSubagentSessions: true });
  await askPermissionOnSubagent();
  await render(row(true));
  expect(host.querySelector<HTMLElement>('[data-pending-request-badge="permission"]')).toBeNull();
});

test('an expanded parent still reports a hidden subagent while its listed review reports itself', async () => {
  useSessionDisplayStore.setState({ showSubagentSessions: false });
  const mixed = parentNode([reviewNode(), subagentNode()]);
  await askPermissionOn('ses_review');
  await render(row(true, mixed));
  expect(host.querySelector<HTMLElement>('[data-pending-request-badge="permission"]')).toBeNull();

  await askPermissionOnSubagent();
  expect(host.querySelector<HTMLElement>('[data-pending-request-badge="permission"]')).not.toBeNull();
});

const tap = async (element: HTMLElement | null): Promise<void> => {
  await act(async () => element?.click());
};

test('a tap on the badge opens the hidden subagent and closes the drawer, from a badge beside the row button', async () => {
  useSessionDisplayStore.setState({ showSubagentSessions: false });
  await askPermissionOnSubagent();
  await render(row());

  const badge = host.querySelector<HTMLElement>('[data-pending-request-badge="permission"]');
  expect(badge?.tagName).toBe('BUTTON');
  expect(badge?.getAttribute('aria-label')).toBe('Permission required. Opens the session that asks');
  expect(host.querySelector('button button')).toBeNull();
  await tap(badge);
  expect(opened).toEqual([['ses_subagent', '/project']]);
  expect(drawerCloses).toBe(1);
});

test('a detailed row draws the badge over its second line, outside the row button, and holds its room there', async () => {
  useSessionDisplayStore.setState({ showSubagentSessions: false });
  await act(async () => applyWaitingPageEvent(
    { type: 'openchamber.page-waiting', properties: { sessionID: 'ses_subagent', directory: '/project', page: { id: 'call-1', title: 'Pick a layout' } } },
    () => '/project',
  ));
  await render({ ...row(), detailed: true });

  const badge = host.querySelector<HTMLElement>('[data-pending-request-badge="form"]');
  expect(badge?.tagName).toBe('BUTTON');
  expect(host.querySelector('button button')).toBeNull();
  expect(host.querySelector('button [aria-hidden="true"].invisible [aria-label="Pending question"]')).not.toBeNull();
  await tap(badge);
  expect(opened).toEqual([['ses_subagent', '/project']]);
  expect(isWaitingPageRevealPending('ses_subagent')).toBe(true);
});

test('a tap on the row away from the badge still opens the parent', async () => {
  useSessionDisplayStore.setState({ showSubagentSessions: false });
  await askPermissionOnSubagent();
  await render(row());
  await tap(host.querySelector<HTMLElement>('button.h-9'));
  expect(opened).toEqual([['ses_parent', '/project']]);
});

test('the row stands in for the open hidden subagent', async () => {
  useSessionDisplayStore.setState({ showSubagentSessions: false });
  await render(row());
  const rowElement = () => host.querySelector('[data-mobile-session-row="ses_parent"]');
  expect(rowElement()?.hasAttribute('data-active-session')).toBe(false);
  await act(async () => useSessionUIStore.setState({ currentSessionId: 'ses_subagent' }));
  expect(rowElement()?.getAttribute('data-active-session')).toBe('true');
});

test('the drawer scrolls to the deepest row above an open session that has no row of its own', () => {
  const grandchild = node(session('ses_grandchild', 'ses_subagent'));
  const subagent = node(session('ses_subagent', 'ses_parent'), [grandchild]);
  const parent = node(session('ses_parent'), [subagent]);
  const other = node(session('ses_other'));
  const rows = [
    { ...row(true, parent), key: 'parent' },
    { ...row(false, subagent), key: 'subagent', depth: 1 },
    { ...row(undefined, other), key: 'other' },
  ];
  const find = (sessionId: string) => findCurrentRowIndex(rows, { sessionId, runKey: null, projectId: null });
  expect(find('ses_grandchild')).toBe(1);
  expect(find('ses_subagent')).toBe(1);
  expect(find('ses_other')).toBe(2);
  expect(find('ses_missing')).toBe(-1);
  expect(findCurrentRowIndex([{ ...row(false, parent), key: 'parent' }, rows[2]], { sessionId: 'ses_grandchild', runKey: null, projectId: null })).toBe(0);
});

test('the drawer scrolls to the nearest listed ancestor, even when an earlier copy of a farther one holds the session', () => {
  const grandchild = node(session('ses_grandchild', 'ses_subagent'));
  const subagent = node(session('ses_subagent', 'ses_parent'), [grandchild]);
  const parent = node(session('ses_parent'), [subagent]);
  const rows = [
    { ...row(false, parent), key: 'pinned:session:ses_parent' },
    { ...row(true, parent), key: 'project:parent' },
    { ...row(false, subagent), key: 'project:subagent', depth: 1 },
  ];
  expect(findCurrentRowIndex(rows, { sessionId: 'ses_grandchild', runKey: null, projectId: null })).toBe(2);
  expect(findCurrentRowIndex(rows.slice(0, 2), { sessionId: 'ses_grandchild', runKey: null, projectId: null })).toBe(0);
});

test('the drawer scrolls to the parent row, not the worktree header above it, for an open hidden subagent', () => {
  const subagent = subagentNode();
  const parent = parentNode([subagent]);
  const group: SessionGroup = {
    id: 'worktree-a', label: 'worktree-a', branch: 'feature', description: null, isMain: false,
    worktree: null, directory: '/project-wt', sessions: [parent],
  };
  const header = (collapsed: boolean): Extract<SessionSidebarRow, { kind: 'group-header' }> => ({
    kind: 'group-header', key: 'worktree-a:header', estimateSize: 32, group, groupKey: 'worktree-a', projectId: null,
    collapsed, empty: false, allSessions: [parent.session, subagent.session], depth: 0, mixed: false, detailed: false,
  });
  const find = (rows: readonly SessionSidebarRow[]) => findCurrentRowIndex(rows, { sessionId: 'ses_subagent', runKey: null, projectId: null });
  expect(find([header(false), { ...row(false, parent), depth: 1 }])).toBe(1);
  expect(find([header(true)])).toBe(0);
});
