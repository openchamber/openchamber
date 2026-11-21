import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { ProjectSessionSelectionEffect } from './useProjectSessionSelection';

type Props = React.ComponentProps<typeof ProjectSessionSelectionEffect>;
const section = (id: string, ids: string[]): Props['projectSections'][number] => ({
  project: { id, normalizedPath: `/${id}` },
  groups: [{
    id, label: id, branch: null, description: null, isMain: true, worktree: null, directory: `/${id}`,
    sessions: ids.map((sessionId) => ({
      session: {
        id: sessionId, projectID: id, directory: `/${id}`, title: sessionId, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
      },
      children: [], worktree: null,
    })),
  }],
});
let browser: Window;
let root: Root;
let props: Props;
let selections: Array<[string, string | null]>;
let drafts: Array<Parameters<Props['openNewSessionDraft']>[0]>;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
const originalSession = useSessionUIStore.getState();
const originalUI = useUIStore.getState();
const render = async (patch: Partial<Props> = {}) => {
  props = { ...props, ...patch };
  await act(async () => root.render(<ProjectSessionSelectionEffect {...props} />));
};
beforeEach(() => {
  browser = new Window({ url: 'http://localhost' });
  for (const [key, value] of Object.entries({
    window: browser, document: browser.document, navigator: browser.navigator,
    HTMLElement: browser.HTMLElement, Element: browser.Element, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useSessionUIStore.setState({ currentSessionId: 'missing-worktree', newSessionDraft: { ...originalSession.newSessionDraft, open: false } });
  useUIStore.setState({ isNewWorktreeDialogOpen: false });
  selections = [];
  drafts = [];
  props = {
    projectSections: [section('a', ['a-first']), section('b', ['b-first', 'b-remembered'])],
    activeProjectId: 'a',
    initialActiveSessionByProject: new Map([['b', 'b-remembered']]),
    persistActiveSessionByProject: () => undefined,
    handleSessionSelect: (id, directory) => { selections.push([id, directory]); },
    openNewSessionDraft: (options) => { drafts.push(options); },
    mobileVariant: false, setSessionSwitcherOpen: () => undefined,
    sessionOwnerBySessionId: new Map([['missing-worktree', { projectId: 'a' }]]),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  useSessionUIStore.setState(originalSession, true);
  useUIStore.setState(originalUI, true);
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

for (const late of [false, true]) {
  test(`switching project restores its remembered session with ${late ? 'late' : 'known'} ownership`, async () => {
    await render();
    await render(late ? { activeProjectId: 'b', sessionOwnerBySessionId: new Map() } : { activeProjectId: 'b' });
    if (late) {
      expect(selections).toEqual([]);
      expect(drafts).toEqual([]);
      await render({ sessionOwnerBySessionId: new Map([['missing-worktree', { projectId: 'a' }]]) });
    }
    expect(selections).toEqual([['b-remembered', '/b']]);
    expect(drafts).toEqual([]);
  });
}

test('a missing remembered session falls back to the first destination session', async () => {
  await render({ initialActiveSessionByProject: new Map([['b', 'deleted']]) });
  await render({ activeProjectId: 'b' });
  expect(selections).toEqual([['b-first', '/b']]);
});

test('an empty destination opens a draft in that project', async () => {
  await render({ projectSections: [section('a', ['a-first']), section('b', [])] });
  await render({ activeProjectId: 'b' });
  expect(selections).toEqual([]);
  expect(drafts).toEqual([{ selectedProjectId: 'b', directoryOverride: '/b' }]);
});

test('same-project ownership keeps a worktree session absent from stale rows selected', async () => {
  await render({ sessionOwnerBySessionId: new Map() });
  await render({ activeProjectId: 'b' });
  expect(selections).toEqual([]);
  await render({ sessionOwnerBySessionId: new Map([['missing-worktree', { projectId: 'b' }]]) });
  expect(selections).toEqual([]);
  expect(drafts).toEqual([]);
});

test('rows identifying a foreign session are sufficient even before ownership arrives', async () => {
  useSessionUIStore.setState({ currentSessionId: 'a-first' });
  await render({ sessionOwnerBySessionId: new Map() });
  await render({ activeProjectId: 'b' });
  expect(selections).toEqual([['b-remembered', '/b']]);
});
