import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import type { Session } from '@/lib/opencode/model';
import type { SessionSidebarRow } from '@/components/session/sidebar/sessionSidebarRowModel';
import type { SessionNode } from '@/components/session/sidebar/types';
import { ChildStoreManager } from '@/sync/child-store';
import { applyGlobalBlockingRequestEvents, resetGlobalBlockingRequests } from '@/sync/global-blocking-requests';
import { SyncRuntimeContext, type SyncRuntime } from '@/sync/sync-runtime-context';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
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

const actions: MobileSidebarActions = {
  close: () => undefined,
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

beforeEach(() => {
  resetGlobalBlockingRequests();
  runtime = createRuntime();
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
  await win.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('a parent row without listed children still reports a spawned child waiting on the user', async () => {
  await askPermissionOnSubagent();
  await render(row());
  expect(host.querySelector('[aria-label="Permission required"]')).not.toBeNull();
  expect(host.querySelector('[aria-expanded]')).toBeNull();
});

test('a request settled while the stream was down clears once the directory store has re-read it (#6802)', async () => {
  await askPermissionOn('ses_parent');
  await render(row());
  expect(host.querySelector('[aria-label="Permission required"]')).not.toBeNull();

  // The index never saw permission.replied; the store's own read found nothing pending.
  await act(async () => runtime.childStores.ensureChild('/project', { bootstrap: false }).setState({ status: 'complete', session: [row().node.session], requestCoverage: new Set([row().node.session.id]) }));
  expect(host.querySelector('[aria-label="Permission required"]')).toBeNull();
});

test('an expanded parent leaves its child rows to report themselves', async () => {
  useSessionDisplayStore.setState({ showSubagentSessions: true });
  await askPermissionOnSubagent();
  await render(row(true));
  expect(host.querySelector('[aria-label="Permission required"]')).toBeNull();
});

test('an expanded parent still reports a hidden subagent while its listed review reports itself', async () => {
  useSessionDisplayStore.setState({ showSubagentSessions: false });
  const mixed = parentNode([reviewNode(), subagentNode()]);
  await askPermissionOn('ses_review');
  await render(row(true, mixed));
  expect(host.querySelector('[aria-label="Permission required"]')).toBeNull();

  await askPermissionOnSubagent();
  expect(host.querySelector('[aria-label="Permission required"]')).not.toBeNull();
});
