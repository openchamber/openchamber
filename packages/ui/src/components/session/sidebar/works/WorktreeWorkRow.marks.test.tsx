import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { EMPTY_GUEST_MARK_INDEX, type GuestMarkEntry } from '@/lib/guests/marks';
import { useGuestMarksStore } from '@/lib/guests/marks-store';
import type { InstalledGuest } from '@/lib/guests/types';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { SessionGroup } from '../types';

const surfaces: Array<{ mode: string; directory: string | null }> = [];
const links: string[] = [];
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
  openGuestUrl: async (url: string) => {
    links.push(url);
    return true;
  },
}));
const { WorktreeWorkRow } = await import('./WorktreeWorkRow');

const WORKTREE = '/trees/app/feature-login';

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

const group = (sessions: SessionGroup['sessions'] = []): SessionGroup => ({
  id: 'worktree:feature-login',
  label: 'feature-login',
  branch: 'feature-login',
  description: null,
  isMain: false,
  worktree: { path: WORKTREE, projectDirectory: '/project-a', branch: 'feature-login', label: 'feature-login' },
  directory: WORKTREE,
  sessions,
});

const noop = () => undefined;
const row = (detailed: boolean, sessions?: SessionGroup['sessions']) => (
  <I18nProvider>
    <WorktreeWorkRow
      group={group(sessions)}
      groupKey="project-a:worktree:feature-login"
      projectId="project-a"
      depth={0}
      detailed={detailed}
      mixed={false}
      inPinnedZone={false}
      collapsed
      empty={!sessions?.length}
      alwaysShowActions={false}
      mobileVariant={false}
      onToggle={noop}
      setSessionSwitcherOpen={noop}
    />
  </I18nProvider>
);

let win: Window;
let root: Root;
let host: HTMLElement;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
const originalProjects = useProjectsStore.getState();
const originalSessionUI = useSessionUIStore.getState();

const showMarks = (guests: InstalledGuest[], entries: GuestMarkEntry[]): void => {
  useGuestMarksStore.getState().setGuests(guests);
  useGuestMarksStore.getState().replaceEntries(entries, 'server-a');
};
const drawn = (): string[] => Array.from(host.querySelectorAll('[data-guest-mark]')).map((node) => node.getAttribute('aria-label') ?? '');

beforeEach(() => {
  win = new Window({ url: 'http://localhost/' });
  const globals = {
    window: win, document: win.document, navigator: win.navigator,
    Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
    HTMLIFrameElement: win.HTMLIFrameElement, Event: win.Event, CustomEvent: win.CustomEvent, MouseEvent: win.MouseEvent,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    ResizeObserver: win.ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of Object.keys(globals)) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.assign(globalThis, globals);
  useProjectsStore.setState({ projects: [{ id: 'project-a', path: '/project-a' }], activeProjectId: 'project-a' });
  useGuestMarksStore.setState({
    ...EMPTY_GUEST_MARK_INDEX,
    runtimeKey: 'server-a',
    entries: [],
    guests: [],
    places: [{ path: '/project-a', projectId: 'project-a' }, { path: WORKTREE, projectId: 'project-a' }],
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  useProjectsStore.setState(originalProjects, true);
  useSessionUIStore.setState(originalSessionUI, true);
  surfaces.length = 0;
  links.length = 0;
  await win.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

for (const detailed of [false, true]) {
  test(`a worktree's row shows the marks on its branch and on its folder (detailed: ${detailed})`, async () => {
    showMarks(
      [guest('ci', 'CI Watch', 'panel/index.html'), guest('deploy', 'Deploy Log')],
      [
        // Named through the project root: the branch belongs to the repository, not to one folder.
        mark('ci', { directory: '/project-a', branch: 'feature-login' }, '2 checks failed'),
        mark('deploy', { directory: WORKTREE }, 'Preview is up', 'https://deploy.test/preview'),
        mark('deploy', { directory: '/project-a', branch: 'main' }, 'On another branch'),
        mark('ci', { sessionId: 'ses_elsewhere' }, 'On a session'),
      ],
    );
    await act(async () => root.render(row(detailed)));
    expect(drawn()).toEqual(['CI Watch: 2 checks failed', 'Deploy Log: Preview is up']);
  });
}

test('a click on a mark opens the work and the extension panel in its folder, and a link mark opens only its link', async () => {
  showMarks(
    [guest('ci', 'CI Watch', 'panel/index.html'), guest('deploy', 'Deploy Log')],
    [
      mark('ci', { directory: '/project-a', branch: 'feature-login' }, '2 checks failed'),
      mark('deploy', { directory: WORKTREE }, 'Preview is up', 'https://deploy.test/preview'),
    ],
  );
  await act(async () => root.render(row(false)));

  await act(async () => host.querySelector<HTMLButtonElement>('button[data-guest-mark="deploy"]')?.click());
  expect(links).toEqual(['https://deploy.test/preview']);
  expect(surfaces).toEqual([]);
  expect(useSessionUIStore.getState().newSessionDraft.open).toBe(originalSessionUI.newSessionDraft.open);

  await act(async () => host.querySelector<HTMLButtonElement>('button[data-guest-mark="ci"]')?.click());
  expect(surfaces).toEqual([{ mode: 'plugin:ci', directory: WORKTREE }]);
  // A work without sessions opens as a new chat in its folder.
  expect(useSessionUIStore.getState().newSessionDraft.directoryOverride).toBe(WORKTREE);
});
