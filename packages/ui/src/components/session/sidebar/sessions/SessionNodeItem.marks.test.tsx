import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { EMPTY_GUEST_MARK_INDEX, type GuestMarkEntry } from '@/lib/guests/marks';
import { useGuestMarksStore } from '@/lib/guests/marks-store';
import type { InstalledGuest } from '@/lib/guests/types';
import { useGitStore } from '@/stores/useGitStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { SessionNodeItemProps } from './SessionNodeItem';

const surfaces: Array<{ mode: string; directory: string | null }> = [];
const links: Array<{ url: string; directory: string | null }> = [];
const selected: Array<{ sessionId: string; directory: string | null }> = [];
let rowRenders = 0;
const syncContext = await import('@/sync/sync-context');
mock.module('@/sync/sync-context', () => ({
  ...syncContext,
  useSessionBlockingRequests: () => ({ hasPendingPermissions: false, hasPendingQuestions: false }),
}));
const aiRename = await import('@/sync/use-session-ai-rename');
mock.module('@/sync/use-session-ai-rename', () => ({
  ...aiRename,
  useIsSessionAiRenamePending: () => false,
}));
mock.module('@/components/sourceBoard/boardRepository', () => ({
  useLinkRepository: () => ({ status: 'ready', directory: '', owned: true, retry: () => undefined }),
}));
mock.module('./useSessionRefLines', () => ({
  useSessionRefLines: () => {
    rowRenders += 1;
    return { refLines: [], branchPrIconColor: null };
  },
}));
const sync = await import('@/sync/use-sync');
mock.module('@/sync/use-sync', () => ({
  ...sync,
  useSessionMessageRecordsForExport: () => async () => [],
  usePrefetchSessionMessages: () => () => undefined,
}));
const openSurface = await import('@/lib/guests/open-surface');
mock.module('@/lib/guests/open-surface', () => ({
  ...openSurface,
  openGuestSurface: ({ mode, directory }: { mode: string; directory: string | null }) => {
    surfaces.push({ mode, directory });
    return { ok: true };
  },
}));
const openUrl = await import('@/lib/guests/open-url');
mock.module('@/lib/guests/open-url', () => ({
  ...openUrl,
  openGuestUrl: async (url: string, directory: string | null) => {
    links.push({ url, directory });
    return true;
  },
}));
const { SessionNodeItem } = await import('./SessionNodeItem');

const guest = (id: string, name: string, entry?: string): InstalledGuest => ({
  id,
  name,
  icon: 'window',
  source: 'path',
  marks: true,
  ...(entry ? { entry } : {}),
  capabilities: { requested: ['service', 'marks'], granted: ['service', 'marks'] },
});

const mark = (guestId: string, target: GuestMarkEntry['target'], text: string, url?: string): GuestMarkEntry => ({
  guestId,
  target,
  mark: { icon: 'check', tone: 'success', text, ...(url ? { url } : {}) },
});

type DirectoryGitState = NonNullable<ReturnType<ReturnType<typeof useGitStore.getState>['getDirectoryState']>>;
const onBranch = (current: string): DirectoryGitState => ({
  isGitRepo: true,
  repoUnreadable: null,
  status: { current, tracking: null, ahead: 0, behind: 0, files: [], isClean: true },
  branches: null,
  log: null,
  identity: null,
  diffCache: new Map(),
  indexRevision: 0,
  lastRepoCheckAt: 0,
  lastStatusFetch: 0,
  lastStatusChange: 0,
  lastLogFetch: 0,
  lastBranchesFetch: 0,
  lastIdentityFetch: 0,
  logMaxCount: 25,
  askedRemoteOnlyBranches: [],
  isLoadingStatus: false,
  isLoadingLog: false,
  isLoadingBranches: false,
  isLoadingIdentity: false,
});

const noop = () => undefined;
const rowProps = (overrides: Partial<SessionNodeItemProps> = {}, directory = '/project-a'): SessionNodeItemProps => ({
  node: {
    session: {
      id: 'ses_row', projectID: 'project-a', title: 'Add the login form',
      directory, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    },
    children: [], worktree: null,
  },
  ownsWork: false, projectId: 'project-a', renderContext: 'project',
  folderOwnerKey: 'project-a', groupDirectory: '/project-a',
  pinnedSessionIds: new Set(), expandedParents: new Set(),
  hasSessionSearchQuery: false, normalizedSessionSearchQuery: '',
  editingId: null, editingRowKey: null, editTitle: '', openSidebarMenuKey: null,
  setEditingId: noop, setEditingRowKey: noop, setEditTitle: noop,
  handleSaveEdit: noop, handleCancelEdit: noop, toggleParent: noop,
  handleSessionSelect: (sessionId, sessionDirectory) => { selected.push({ sessionId, directory: sessionDirectory }); },
  handleSessionDoubleClick: noop,
  setOpenSidebarMenuKey: noop, createFolderAndStartRename: () => null,
  handleDeleteSession: noop, handleRestoreSession: noop,
  startSessionWorktreeMenuLoad: () => ({ cachedTargets: [], refreshTargets: Promise.resolve([]) }),
  mobileVariant: false, alwaysShowActions: false,
  subtreeContainsEditing: new Set(), menuOpenSessionId: null, nodeStructureKey: '',
  ...overrides,
});

let win: Window;
let root: Root;
let host: HTMLElement;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
const originalProjects = useProjectsStore.getState();
const originalGit = useGitStore.getState();

const showMarks = (guests: InstalledGuest[], entries: GuestMarkEntry[]): void => {
  useGuestMarksStore.getState().setGuests(guests);
  useGuestMarksStore.getState().replaceEntries(entries, 'server-a');
};
const render = async (props: SessionNodeItemProps): Promise<void> => {
  await act(async () => root.render(<I18nProvider><SessionNodeItem {...props} /></I18nProvider>));
};
const drawn = (): string[] => Array.from(host.querySelectorAll('[data-guest-mark]')).map((node) => node.getAttribute('aria-label') ?? '');

beforeEach(() => {
  win = new Window({ url: 'http://localhost/' });
  const globals = {
    window: win, document: win.document, navigator: win.navigator,
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
  useGuestMarksStore.setState({ ...EMPTY_GUEST_MARK_INDEX, runtimeKey: 'server-a', entries: [], guests: [], places: [{ path: '/project-a', projectId: 'project-a' }] });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  useProjectsStore.setState(originalProjects, true);
  useGitStore.setState(originalGit, true);
  surfaces.length = 0;
  links.length = 0;
  selected.length = 0;
  await win.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('a row draws two marks in catalog order, each named by its extension', async () => {
  showMarks(
    [guest('ci', 'CI Watch', 'panel/index.html'), guest('deploy', 'Deploy Log'), guest('review', 'Review Bot')],
    [mark('review', { sessionId: 'ses_row' }, 'Approved'), mark('deploy', { sessionId: 'ses_row' }, 'Deployed'), mark('ci', { sessionId: 'ses_row' }, 'Checks passed')],
  );
  await render(rowProps());
  expect(drawn()).toEqual(['CI Watch: Checks passed', 'Deploy Log: Deployed']);
  expect(host.textContent).not.toContain('+1');
});

test('a mark set while the row is shown appears, and one set on another row leaves this row alone', async () => {
  const guests = [guest('ci', 'CI Watch', 'panel/index.html')];
  showMarks(guests, []);
  await render(rowProps());
  expect(drawn()).toEqual([]);

  let renders = rowRenders;
  await act(async () => showMarks(guests, [mark('ci', { sessionId: 'ses_other' }, 'Checks failed')]));
  expect(rowRenders).toBe(renders);
  expect(drawn()).toEqual([]);

  await act(async () => showMarks(guests, [mark('ci', { sessionId: 'ses_other' }, 'Checks failed'), mark('ci', { sessionId: 'ses_row' }, 'Checks passed')]));
  expect(rowRenders).toBeGreaterThan(renders);
  expect(drawn()).toEqual(['CI Watch: Checks passed']);

  renders = rowRenders;
  await act(async () => showMarks(guests, [mark('ci', { sessionId: 'ses_other' }, 'Checks passed'), mark('ci', { sessionId: 'ses_row' }, 'Checks passed')]));
  expect(rowRenders).toBe(renders);

  await act(async () => showMarks(guests, [mark('ci', { sessionId: 'ses_other' }, 'Checks passed')]));
  expect(drawn()).toEqual([]);
});

test('the session mark wins over the branch mark, and the branch mark over the folder mark', async () => {
  useGitStore.setState({ directories: new Map([['/project-a', onBranch('main')]]) });
  const guests = [guest('ci', 'CI Watch', 'panel/index.html')];
  showMarks(guests, [mark('ci', { directory: '/project-a' }, 'Folder')]);
  await render(rowProps());
  expect(drawn()).toEqual(['CI Watch: Folder']);
  await act(async () => showMarks(guests, [mark('ci', { directory: '/project-a' }, 'Folder'), mark('ci', { directory: '/project-a', branch: 'main' }, 'Branch')]));
  expect(drawn()).toEqual(['CI Watch: Branch']);
  await act(async () => showMarks(guests, [mark('ci', { sessionId: 'ses_row' }, 'Session'), mark('ci', { directory: '/project-a' }, 'Folder'), mark('ci', { directory: '/project-a', branch: 'main' }, 'Branch')]));
  expect(drawn()).toEqual(['CI Watch: Session']);
  await act(async () => showMarks(guests, [mark('ci', { directory: '/project-a', branch: 'other' }, 'Another branch')]));
  expect(drawn()).toEqual([]);
});

test('a click on a mark of an extension with a panel selects the session and opens the panel there, once', async () => {
  showMarks([guest('ci', 'CI Watch', 'panel/index.html')], [mark('ci', { sessionId: 'ses_row' }, 'Checks passed', 'https://ci.test/ignored')]);
  await render(rowProps());
  const button = host.querySelector<HTMLButtonElement>('button[data-guest-mark="ci"]');
  expect(button).not.toBeNull();
  await act(async () => button?.click());
  expect(selected).toEqual([{ sessionId: 'ses_row', directory: '/project-a' }]);
  expect(surfaces).toEqual([{ mode: 'plugin:ci', directory: '/project-a' }]);
  expect(links).toEqual([]);
});

test('a click on a mark of an extension without a panel opens its link and selects nothing', async () => {
  showMarks([guest('deploy', 'Deploy Log')], [mark('deploy', { sessionId: 'ses_row' }, 'Deployed', 'https://deploy.test/runs/7')]);
  await render(rowProps());
  await act(async () => host.querySelector<HTMLButtonElement>('button[data-guest-mark="deploy"]')?.click());
  expect(links.map((link) => link.url)).toEqual(['https://deploy.test/runs/7']);
  expect(selected).toEqual([]);
  expect(surfaces).toEqual([]);
});

test('a mark with nothing to open is an image, not a button', async () => {
  showMarks([guest('deploy', 'Deploy Log')], [mark('deploy', { sessionId: 'ses_row' }, 'Deployed')]);
  await render(rowProps());
  const node = host.querySelector('[data-guest-mark="deploy"]');
  expect(node?.tagName).toBe('SPAN');
  expect(node?.getAttribute('role')).toBe('img');
  expect(node?.getAttribute('aria-label')).toBe('Deploy Log: Deployed');
});

test('a row of an isolated space shows no marks', async () => {
  const directory = '/spaces/0123456789ab/app';
  showMarks([guest('ci', 'CI Watch', 'panel/index.html')], [mark('ci', { sessionId: 'ses_row' }, 'Checks passed'), mark('ci', { directory }, 'Folder')]);
  await render(rowProps({}, directory));
  expect(drawn()).toEqual([]);
});
