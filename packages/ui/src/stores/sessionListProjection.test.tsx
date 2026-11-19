import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useShallow } from 'zustand/react/shallow';
import type { Session } from '@/lib/opencode/model';
import { withMultiRunMembership } from '@/lib/multirun/identity';
import { selectArchivedSessions, selectActiveArchiveSessions, selectArchiveParentTitles } from '@/components/views/archive/sessionSelectors';
import { selectHasChats } from '@/apps/mobileSessionFields';
import { ensureChatsRootDirectory } from '@/lib/chatDirectories';
import { useMultiRunMemberIds } from '@/lib/multirun/useMultiRuns';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionsStore } from './useGlobalSessionsStore';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, Event: browser.Event, CustomEvent: browser.CustomEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true });
}
const request = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  return Response.json(url.includes('/fs/home')
    ? { home: '/home/test', chatsRoot: '/chats', canonicalChatsRoot: '/real/chats' }
    : {});
});
const { createRoot } = await import('react-dom/client');
const initial = useGlobalSessionsStore.getState();
const initialWorktrees = useSessionUIStore.getState().worktreeMetadata;
let root: Root;
let renders = 0;
let entriesRead = 0;
const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id, projectID: 'project', directory: '/repo', title: id,
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 }, ...extra,
});
const archive = (id: string, extra: Partial<Session> = {}) =>
  session(id, { time: { created: 1, updated: 1, archived: 2 }, ...extra });
const lane = (id: string) => session(id, { metadata: withMultiRunMembership({}, {
  version: 1, sessionID: id, group: { kind: 'id', id: '9f512893-6e63-4e49-a534-5de733ca103e' },
  groupSlug: 'fix-auth', role: 'run', providerID: 'test', modelID: 'test',
}) });
const unrelated = () => Array.from({ length: 1000 }, (_, i) => session(`other-${i}`));

// Count entity visits independently of whether a projection uses a loop or an array method.
const countReads = (sessions: Session[]) => {
  const observed = [...sessions];
  sessions.forEach((entry, index) => Object.defineProperty(observed, index, {
    configurable: true,
    enumerable: true,
    get() {
      entriesRead += 1;
      return entry;
    },
  }));
  return observed;
};
const observeLists = () => {
  const state = useGlobalSessionsStore.getState();
  useGlobalSessionsStore.setState({
    activeSessions: countReads(state.activeSessions),
    archivedSessions: countReads(state.archivedSessions),
  });
};
const deferred = async () => {
  entriesRead = 0;
  const before = renders;
  await act(async () => {
    for (let i = 0; i < 100; i++) useGlobalSessionsStore.getState().noteDeferredSessionUpdate('other-0');
  });
  expect(entriesRead).toBe(0);
  expect(renders).toBe(before);
};
beforeEach(() => {
  useGlobalSessionsStore.getState().applySnapshot([], []);
  useGlobalSessionsStore.setState({ hasLoaded: true, managedChatsHydrated: true });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  renders = 0;
});
afterEach(async () => {
  await act(async () => root.unmount());
  useGlobalSessionsStore.setState(initial);
  useSessionUIStore.setState({ worktreeMetadata: initialWorktrees });
  document.body.replaceChildren();
});
afterAll(async () => {
  request.mockRestore();
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('archive projections preserve restorable lists and parent titles without visiting unchanged lists', async () => {
  const parent = session('parent', { title: 'Parent title' });
  const child = archive('child', { parentID: parent.id });
  const archivedParent = archive('archived-parent');
  const hidden = archive('hidden', { parentID: archivedParent.id });
  const missing = archive('missing', { parentID: 'absent' });
  useGlobalSessionsStore.getState().applySnapshot(
    [parent, session('active-child', { parentID: parent.id }), ...unrelated()],
    [child, archivedParent, hidden, missing],
  );
  observeLists();
  let selected: [Session[], Session[], string[]] | undefined;
  function Probe() {
    const listed = useGlobalSessionsStore(useShallow(selectArchivedSessions));
    const active = useGlobalSessionsStore(useShallow(selectActiveArchiveSessions));
    const titles = useGlobalSessionsStore(useShallow(selectArchiveParentTitles));
    selected = [listed, active, titles];
    renders += 1;
    return null;
  }
  await act(async () => root.render(<Probe />));
  const state = useGlobalSessionsStore.getState();
  expect(selected?.[0].map((entry) => entry.id)).toEqual(
    state.archivedSessions.filter((entry) => !entry.parentID || (state.entityById.has(entry.parentID) && !state.entityById.get(entry.parentID)?.time.archived)).map((entry) => entry.id),
  );
  expect(selected?.[1]).toEqual([...state.activeSessions]);
  expect(selected?.[2]).toEqual(state.archivedSessions.flatMap((entry) => {
    const owner = entry.parentID ? state.entityById.get(entry.parentID) : undefined;
    return owner ? [owner.id, owner.title] : [];
  }));
  const before = selected;
  await deferred();
  expect(selectArchivedSessions(useGlobalSessionsStore.getState())).toBe(before?.[0]);
  expect(selectActiveArchiveSessions(useGlobalSessionsStore.getState())).toBe(before?.[1]);
  expect(selectArchiveParentTitles(useGlobalSessionsStore.getState())).toBe(before?.[2]);
  // Hidden descendants do not change any of the three narrow outputs.
  const count = renders;
  await act(async () => useGlobalSessionsStore.getState().upsertSession({ ...hidden, cost: 9 }));
  expect(renders).toBe(count);
  await act(async () => useGlobalSessionsStore.getState().upsertSession(session('other-0', { cost: 9 })));
  expect(renders).toBe(count + 1);
  await act(async () => useGlobalSessionsStore.getState().upsertSession({ ...parent, title: 'Renamed parent' }));
  expect(selected?.[2]).toContain('Renamed parent');
  await act(async () => useGlobalSessionsStore.getState().upsertSession(archive(parent.id)));
  expect(selected?.[0].map((entry) => entry.id)).not.toContain(child.id);
  expect(selected?.[1].map((entry) => entry.id)).not.toContain('active-child');
});

test('multi-run membership keeps list order and its reference through deferred and unrelated publications', async () => {
  useGlobalSessionsStore.getState().applySnapshot([lane('lane-2'), lane('lane-1'), ...unrelated()], []);
  observeLists();
  let ids: readonly string[] = [];
  function Probe({ id = 'lane-1' }: { id?: string | null }) {
    ids = useMultiRunMemberIds(id);
    renders += 1;
    return null;
  }
  await act(async () => root.render(<Probe />));
  expect(ids).toEqual(useGlobalSessionsStore.getState().activeSessions.filter((entry) => entry.id.startsWith('lane-')).map((entry) => entry.id));
  const before = ids;
  await deferred();
  expect(ids).toBe(before);
  const count = renders;
  await act(async () => useGlobalSessionsStore.getState().upsertSession(session('other-0', { cost: 9 })));
  expect(ids).toBe(before);
  expect(renders).toBe(count);
  await act(async () => useGlobalSessionsStore.getState().upsertSession(archive('lane-2', { metadata: lane('lane-2').metadata })));
  expect(ids).toEqual([]);
  await act(async () => useGlobalSessionsStore.getState().upsertSession(lane('lane-3')));
  expect(ids).toEqual(useGlobalSessionsStore.getState().activeSessions.filter((entry) => entry.id.startsWith('lane-')).map((entry) => entry.id));
  await act(async () => root.render(<Probe id="lane-2" />));
  expect(ids).toEqual([]);
  await act(async () => root.render(<Probe id={null} />));
  expect(ids).toEqual([]);
  await act(async () => {
    useGlobalSessionsStore.getState().applySnapshot([
      session('legacy-a', { title: 'bench/test/model-a', directory: '/repo' }),
      session('legacy-b', { title: 'bench/test/model-b', directory: '/other' }),
    ], []);
    root.render(<Probe id="legacy-a" />);
  });
  expect(ids).toEqual([]);
  // Legacy scope is another input even when the session arrays are unchanged.
  await act(async () => {
    useSessionUIStore.setState({ worktreeMetadata: new Map([['legacy-b', {
      path: '/other', projectDirectory: '/repo', branch: 'test', label: 'test',
    }]]) });
    useGlobalSessionsStore.getState().noteDeferredSessionUpdate('legacy-b');
  });
  expect(ids).toEqual(['legacy-a', 'legacy-b']);
});

test('mobile chat presence caches unchanged lists and invalidates when roots become known or chats change', async () => {
  useGlobalSessionsStore.getState().applySnapshot([...unrelated(), session('chat', { directory: '/real/chats/day/chat' })], []);
  observeLists();
  // Root discovery changes classification even while the session array stays identical.
  expect(selectHasChats(useGlobalSessionsStore.getState())).toBe(false);
  await ensureChatsRootDirectory();
  expect(selectHasChats(useGlobalSessionsStore.getState())).toBe(true);
  let hasChats = false;
  function Probe() {
    hasChats = useGlobalSessionsStore(selectHasChats);
    renders += 1;
    return null;
  }
  await act(async () => root.render(<Probe />));
  expect(hasChats).toBe(true);
  await deferred();
  const count = renders;
  await act(async () => useGlobalSessionsStore.getState().upsertSession(session('other-0', { title: 'Renamed' })));
  expect(hasChats).toBe(true);
  expect(renders).toBe(count);
  await act(async () => useGlobalSessionsStore.getState().upsertSession(archive('chat', { directory: '/real/chats/day/chat' })));
  expect(hasChats).toBe(false);
  await act(async () => useGlobalSessionsStore.getState().upsertSession(session('legacy-chat', { directory: '/home/test/.config/openchamber/chats/day/chat' })));
  expect(hasChats).toBe(true);
});
