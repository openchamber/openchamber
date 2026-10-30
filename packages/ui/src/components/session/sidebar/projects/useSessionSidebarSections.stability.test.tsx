import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { Session } from '@/lib/opencode/model';
import type { WorktreeMetadata } from '@/types/worktree';
import { I18nProvider } from '@/lib/i18n';
import { useSessionGrouping } from './useSessionGrouping';
import { useSessionSidebarSections } from './useSessionSidebarSections';
import { buildSidebarSessionProjection } from '../list/sessionCollection';

// The sidebar's group headers are memoized on the section's group objects and
// the shared search-data map. These tests pin which inputs may replace them:
// a real change to one project rebuilds that project only, and an update that
// changes nothing a project renders keeps every reference.

const session = (id: string, directory: string, title = id): Session => ({
  id,
  projectID: 'project',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  title,
  directory,
  time: { created: 1, updated: 1 },
});

const worktree = (projectDirectory: string, name: string): WorktreeMetadata => ({
  source: 'sdk', name, path: `${projectDirectory}/.wt/${name}`, projectDirectory, branch: name, label: name,
});

const projectA = { id: 'a', path: '/a', normalizedPath: '/a' };
const projectB = { id: 'b', path: '/b', normalizedPath: '/b' };
const projectC = { id: 'c', path: '/c', normalizedPath: '/c' };
const projects = [projectA, projectB, projectC];
const worktreesByProject = new Map([
  ['/a', [worktree('/a', 'one'), worktree('/a', 'two')]],
  ['/b', [worktree('/b', 'one'), worktree('/b', 'two')]],
]);
const a1 = session('a1', '/a/.wt/one');
const a2 = session('a2', '/a/.wt/two');
const b1 = session('b1', '/b/.wt/one');
const b2 = session('b2', '/b/.wt/two');
const c1 = session('c1', '/c');
const sessionsByProject = new Map([['a', [a1, a2]], ['b', [b1, b2]], ['c', [c1]]]);
const EMPTY: Session[] = [];
const stableMaps = { worktreeMetadata: new Map(), pinnedSessionIds: new Set<string>(), gitBranches: new Map<string, string | null>(), projectRepoStatus: new Map(), projectRootBranches: new Map(), foldersMap: {} };

type Owners = ReadonlyMap<string, { scopeDirectory: string }>;
type Inputs = { ranks: ReadonlyMap<string, number>; owners: Owners; sessions?: ReadonlyMap<string, Session[]> };
type Sections = ReturnType<typeof useSessionSidebarSections>;

// Each project's sessions are listed under the project; the ownership map
// names each session's worktree scope, as the ownership index does.
const ownersFor = (scopes: Record<string, string>): Owners => new Map(
  Object.entries(scopes).map(([id, scopeDirectory]) => [id, { scopeDirectory }]),
);
const defaultScopes = { a1: '/a/.wt/one', a2: '/a/.wt/two', b1: '/b/.wt/one', b2: '/b/.wt/two', c1: '/c' };

const Harness = ({ inputs, capture }: { inputs: Inputs; capture: (sections: Sections) => void }) => {
  const currentSessions = inputs.sessions ?? sessionsByProject;
  const allSessions = [...currentSessions.values()].flat();
  const projectIdBySessionId = new Map(
    [...currentSessions].flatMap(([projectId, sessions]) => sessions.map((entry) => [entry.id, projectId] as const)),
  );
  const projection = buildSidebarSessionProjection({
    globalActiveSessions: allSessions,
    liveSessions: [],
    knownDirectories: new Set(),
    isVSCode: false,
    pinnedSessionIds: stableMaps.pinnedSessionIds,
    sessionOrderRanks: inputs.ranks,
  });
  const projectedSessions = new Map(projects.map((project) => [
    project.id,
    projection.projectSessions.filter((entry) => projectIdBySessionId.get(entry.id) === project.id),
  ]));
  const nestedSessionIds = new Set(
    [...projection.childrenMap]
      .filter(([parentId]) => projection.sessionById.has(parentId))
      .flatMap(([, children]) => children.map((child) => child.id)),
  );
  const grouping = useSessionGrouping({
    homeDirectory: null,
    worktreeMetadata: stableMaps.worktreeMetadata,
    pinnedSessionIds: stableMaps.pinnedSessionIds,
    sessionOrderRanks: inputs.ranks,
    gitBranches: stableMaps.gitBranches,
    isVSCode: false,
    sessionOwners: inputs.owners,
    sessionById: projection.sessionById,
    childrenMap: projection.childrenMap,
    nestedSessionIds,
  });
  // Rebuilt on every render, the way the sidebar rebuilds the ownership index.
  const getSessionsForProject = (projectId: string) => projectedSessions.get(projectId) ?? EMPTY;
  const getArchivedSessionsForProject = React.useCallback(() => EMPTY, []);
  capture(useSessionSidebarSections({
    normalizedProjects: projects,
    getSessionsForProject,
    getArchivedSessionsForProject,
    availableWorktreesByProject: worktreesByProject,
    projectRepoStatus: stableMaps.projectRepoStatus,
    projectRootBranches: stableMaps.projectRootBranches,
    gitBranches: stableMaps.gitBranches,
    sessionOrderRanks: inputs.ranks,
    lastRepoStatus: true,
    buildGroupedSessions: grouping.buildGroupedSessions,
    getGroupingSessions: grouping.getGroupingSessions,
    hasSessionSearchQuery: false,
    normalizedSessionSearchQuery: '',
    filterSessionNodesForSearch: grouping.filterSessionNodesForSearch,
    buildGroupSearchText: grouping.buildGroupSearchText,
    foldersMap: stableMaps.foldersMap,
    standaloneGroups: EMPTY_GROUPS,
  }));
  return null;
};
const EMPTY_GROUPS: never[] = [];

const worktreeLabels = (sections: Sections, projectId: string): string[] => (
  sections.projectSections.find((section) => section.project.id === projectId)?.groups
    .filter((group) => group.worktree)
    .map((group) => group.label) ?? []
);

describe('sidebar project sections keep references across unrelated updates', () => {
  let dom: Window;
  let root: Root;
  let latest: Sections | null = null;
  const originals = new Map<string, PropertyDescriptor | undefined>();

  const render = (inputs: Inputs) => act(async () => root.render(
    <I18nProvider><Harness inputs={inputs} capture={(sections) => { latest = sections; }} /></I18nProvider>,
  ));
  const current = (): Sections => {
    if (!latest) throw new Error('sections hook was not mounted');
    return latest;
  };
  const section = (projectId: string) => current().projectSections.find((entry) => entry.project.id === projectId);

  beforeEach(async () => {
    dom = new Window({ url: 'http://localhost' });
    const globals = { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
    for (const [name, value] of Object.entries(globals)) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const container = document.createElement('div');
    document.body.append(container);
    const { createRoot } = await import('react-dom/client');
    root = createRoot(container);
    latest = null;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    originals.clear();
    void dom.happyDOM.close();
  });

  test('a rebuilt ownership map with the same scopes keeps every section and the search map', async () => {
    await render({ ranks: new Map(), owners: ownersFor(defaultScopes) });
    const before = current();

    await render({ ranks: new Map(), owners: ownersFor(defaultScopes) });

    expect(section('a')).toBe(before.projectSections[0]);
    expect(section('b')).toBe(before.projectSections[1]);
    expect(current().groupSearchDataByGroup).toBe(before.groupSearchDataByGroup);
  });

  test('a session that changes scope regroups it', async () => {
    await render({ ranks: new Map(), owners: ownersFor(defaultScopes) });
    const before = section('a');

    await render({ ranks: new Map(), owners: ownersFor({ ...defaultScopes, a2: '/a/.wt/one' }) });

    expect(section('a')).not.toBe(before);
    const groupOne = section('a')?.groups.find((group) => group.label === 'one');
    expect(groupOne?.sessions.map((node) => node.session.id).sort()).toEqual(['a1', 'a2']);
  });

  test('a rank change rebuilds only the project whose session moved', async () => {
    const owners = ownersFor(defaultScopes);
    await render({ ranks: new Map([['a1', 2], ['a2', 1], ['b1', 2], ['b2', 1]]), owners });
    expect(worktreeLabels(current(), 'a')).toEqual(['one', 'two']);
    const before = current();
    const sectionB = section('b');

    // `a2` becomes the most recent session: its worktree moves up.
    await render({ ranks: new Map([['a1', 2], ['a2', 3], ['b1', 2], ['b2', 1]]), owners });

    expect(worktreeLabels(current(), 'a')).toEqual(['two', 'one']);
    expect(section('b')).toBe(sectionB);
    expect(current().groupSearchDataByGroup).toBe(before.groupSearchDataByGroup);
  });

  test('a same-ID descendant update rebuilds its parent project tree', async () => {
    const child = { ...b1, parentID: 'a1' };
    const beforeSessions = new Map([['a', [a1, a2]], ['b', [child, b2]]]);
    const owners = ownersFor(defaultScopes);
    await render({ ranks: new Map(), owners, sessions: beforeSessions });
    const sectionA = section('a');
    expect(sectionA?.groups.flatMap((group) => group.sessions).find((node) => node.session.id === 'a1')
      ?.children.map((node) => node.session.title)).toContain('b1');

    const updatedChild = { ...child, title: 'renamed child' };
    await render({
      ranks: new Map(),
      owners,
      sessions: new Map([['a', [a1, a2]], ['b', [updatedChild, b2]]]),
    });

    expect(section('a')).not.toBe(sectionA);
    expect(section('a')?.groups.flatMap((group) => group.sessions).find((node) => node.session.id === 'a1')
      ?.children.map((node) => node.session.title)).toContain('renamed child');
  });

  test('a cross-project sibling rank change rebuilds the parent tree in lifecycle order', async () => {
    const childOne = { ...b1, parentID: 'a1' };
    const childTwo = { ...b2, parentID: 'a1' };
    const sessions = new Map([['a', [a1, a2]], ['b', [childOne, childTwo]]]);
    const owners = ownersFor(defaultScopes);
    const childIds = () => section('a')?.groups.flatMap((group) => group.sessions)
      .find((node) => node.session.id === 'a1')?.children.map((node) => node.session.id);

    await render({ ranks: new Map([['b1', 3], ['b2', 2]]), owners, sessions });
    const parentSection = section('a');
    expect(childIds()).toEqual(['b1', 'b2']);

    await render({ ranks: new Map([['b1', 2], ['b2', 4]]), owners, sessions });

    expect(section('a')).not.toBe(parentSection);
    expect(childIds()).toEqual(['b2', 'b1']);
  });

  test('a foreign child arriving after a newer review invalidates only affected project trees', async () => {
    const review = {
      ...session('review', a1.directory),
      metadata: { openchamber: { kind: 'review', originalSessionID: 'a1' } },
    };
    const owners = ownersFor({ ...defaultScopes, review: a1.directory });
    const ranks = new Map([['review', 10], ['a1', 5]]);
    const beforeSessions = new Map([['a', [a1, review, a2]], ['b', [b2]], ['c', [c1]]]);
    await render({ ranks, owners, sessions: beforeSessions });
    const beforeA = section('a');
    const beforeC = section('c');

    const foreignChild = { ...b1, parentID: 'a1' };
    await render({
      ranks,
      owners,
      sessions: new Map([['a', [a1, review, a2]], ['b', [foreignChild, b2]], ['c', [c1]]]),
    });

    const original = section('a')?.groups.flatMap((group) => group.sessions)
      .find((node) => node.session.id === 'a1');
    expect(section('a')).not.toBe(beforeA);
    expect(original?.children.map((node) => node.session.id)).toEqual(['review', 'b1']);
    expect(section('c')).toBe(beforeC);
  });
});
