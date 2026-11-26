import { describe, expect, test } from 'bun:test';
import { EMPTY_SIDEBAR_SECTION_FILTER, type CustomSidebarSection, type SidebarWorkFacts } from '@/lib/sidebarSections';
import type { SidebarWorkRef } from '../works/sidebarWorks';
import { resolveSidebarSectionMembership, resolveVisibleSidebarSections, type VisibleSidebarSection } from './sectionMembership';

const ref = (id: string, projectId = 'p1'): SidebarWorkRef => ({ kind: 'session', key: `session:${id}`, projectId, rootSessionId: id });

const facts = (overrides: Partial<SidebarWorkFacts> = {}): SidebarWorkFacts => ({
  kind: 'session', projectId: 'p1', folderId: null, pin: null, inWork: false, done: false, running: false, needsAnswer: false,
  unread: false, failed: false, looksDone: false, hasPr: false, hasIssue: false, hasTrackerItem: false, hasPlan: false, hasGoal: false, lastActivityAt: 0, texts: [], lead: false, scheduled: false, ...overrides,
});

const section = (id: string, overrides: Partial<CustomSidebarSection> = {}): CustomSidebarSection => ({
  kind: 'custom', id, name: id, grouping: 'time', filter: EMPTY_SIDEBAR_SECTION_FILTER, claims: false, hideWhenEmpty: true, ...overrides,
});

const custom = (definition: CustomSidebarSection): VisibleSidebarSection => ({ kind: 'custom', section: definition, preview: false });

describe('resolveSidebarSectionMembership', () => {
  const running = new Set(['a', 'b']);
  const factsOf = (work: SidebarWorkRef): SidebarWorkFacts => facts({
    running: work.kind === 'session' && running.has(work.rootSessionId),
    projectId: work.projectId,
  });
  const resolve = (sections: VisibleSidebarSection[], pinned: SidebarWorkRef[] = [], work: SidebarWorkRef[] = []) => resolveSidebarSectionMembership({
    sections, pinned, work, isPinned: (entry) => pinned.some((pin) => pin.key === entry.key), all: [ref('a'), ref('b'), ref('c', 'p2')], projectIds: new Set(['p1', 'p2']), factsOf, now: 1_000,
  });

  test('a section that takes its works out of their projects still leaves them to the other sections', () => {
    const result = resolve([
      custom(section('first', { claims: true, filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, states: ['running'] } })),
      custom(section('second', { filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, states: ['running'] } })),
    ]);
    expect(result.custom.get('first')?.map((work) => work.key)).toEqual(['session:a', 'session:b']);
    expect(result.custom.get('second')?.map((work) => work.key)).toEqual(['session:a', 'session:b']);
    expect([...result.claimedKeys]).toEqual(['session:a', 'session:b']);
  });

  test('a section that asks for nothing lists nothing', () => {
    const result = resolve([custom(section('blank', { claims: true }))]);
    expect(result.custom.get('blank')).toEqual([]);
    expect(result.claimedKeys.size).toBe(0);
  });

  test('a section that does not claim lets its works through and only lists them', () => {
    const result = resolve([
      custom(section('first', { filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, states: ['running'] } })),
      custom(section('second', { filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, states: ['running'] } })),
    ]);
    expect(result.custom.get('second')?.length).toBe(2);
    expect(result.claimedKeys.size).toBe(0);
  });

  test('Pinned that leaves its works in place lists them in their projects too', () => {
    const result = resolve([{ kind: 'pinned', claims: false }, { kind: 'work', claims: true }], [ref('a')], [ref('b')]);
    expect(result.pinned.map((work) => work.key)).toEqual(['session:a']);
    expect(result.work.map((work) => work.key)).toEqual(['session:b']);
    expect([...result.claimedKeys]).toEqual(['session:b']);
  });

  test('a pinned work in work shows in both, and only Pinned decides whether it leaves its project', () => {
    const workFirst = resolve([{ kind: 'work', claims: true }, { kind: 'pinned', claims: false }], [ref('a')], [ref('a'), ref('b')]);
    expect(workFirst.pinned.map((work) => work.key)).toEqual(['session:a']);
    expect(workFirst.work.map((work) => work.key)).toEqual(['session:a', 'session:b']);
    expect([...workFirst.claimedKeys]).toEqual(['session:b']);
    const pinnedClaims = resolve([{ kind: 'pinned', claims: true }, { kind: 'work', claims: false }], [ref('a')], [ref('a'), ref('b')]);
    expect([...pinnedClaims.claimedKeys]).toEqual(['session:a']);
  });

  test('In work lists what no shown section of the user\'s own lists, wherever it stands in the order', () => {
    const inWork = { kind: 'work', claims: true } as const;
    const client = custom(section('client', { filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, projectIds: ['p2'] } }));
    for (const sections of [[inWork, client], [client, inWork]]) {
      const result = resolve(sections, [], [ref('a'), ref('c', 'p2')]);
      expect(result.work.map((work) => work.key)).toEqual(['session:a']);
      expect(result.custom.get('client')?.map((work) => work.key)).toEqual(['session:c']);
      expect([...result.claimedKeys]).toEqual(['session:a']);
    }
    expect(resolve([inWork], [], [ref('a'), ref('c', 'p2')]).work.map((work) => work.key)).toEqual(['session:a', 'session:c']);
  });

  test('a section filtered by state leaves its works in In work, also with other conditions', () => {
    const result = resolve([
      custom(section('running', { filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, states: ['running'], projectIds: ['p1'] } })),
      { kind: 'work', claims: true },
    ], [], [ref('a')]);
    expect(result.custom.get('running')?.map((work) => work.key)).toEqual(['session:a', 'session:b']);
    expect(result.work.map((work) => work.key)).toEqual(['session:a']);
  });

  test('a section that asks for nothing takes nothing from In work, and a group of projects neither', () => {
    const result = resolve([
      custom(section('blank')),
      custom(section('clients', { grouping: 'project', filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, projectIds: ['p1'] } })),
      { kind: 'work', claims: true },
    ], [], [ref('a')]);
    expect(result.work.map((work) => work.key)).toEqual(['session:a']);
  });

  test('a group of projects takes its projects from Projects only', () => {
    const result = resolve([
      custom(section('clients', { grouping: 'project', claims: true, filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, projectIds: ['p2', 'gone'] } })),
      custom(section('all', { filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, activity: 'any', projectIds: ['p1', 'p2'] } })),
    ]);
    expect(result.projectGroups.get('clients')).toEqual(['p2']);
    expect([...result.claimedProjectIds]).toEqual(['p2']);
    expect(result.custom.get('all')?.map((work) => work.key)).toEqual(['session:a', 'session:b', 'session:c']);
  });
});

describe('resolveVisibleSidebarSections', () => {
  const show = { chats: true, pinned: false, work: true };
  test('follows the saved order and the show toggles, and puts a new draft under Pinned', () => {
    const draft = section('draft');
    const visible = resolveVisibleSidebarSections({
      sections: [{ kind: 'builtin', id: 'chats' }, { kind: 'builtin', id: 'pinned' }, section('hidden'), { kind: 'builtin', id: 'work' }, { kind: 'builtin', id: 'projects' }],
      hiddenSections: ['hidden'],
      draft,
      draftIsNew: true,
      show: { ...show, pinned: true },
      keepWorkInPlace: true,
      keepPinnedInPlace: false,
      customSections: true,
      pages: true,
    });
    expect(visible).toEqual([
      { kind: 'chats' },
      { kind: 'pinned', claims: true },
      { kind: 'custom', section: draft, preview: true },
      { kind: 'work', claims: false },
      { kind: 'projects' },
    ]);
  });

  test('VS Code shows no section of the user\'s own', () => {
    const visible = resolveVisibleSidebarSections({
      sections: [section('mine'), { kind: 'builtin', id: 'projects' }],
      hiddenSections: [], draft: null, draftIsNew: false, show, keepWorkInPlace: false, keepPinnedInPlace: true, customSections: false, pages: false,
    });
    expect(visible).toEqual([{ kind: 'projects' }]);
  });

  test('Pages shows where the sidebar lists pages, unless hidden', () => {
    const sections = [{ kind: 'builtin', id: 'pages' }, { kind: 'builtin', id: 'projects' }] as const;
    const base = { draft: null, draftIsNew: false, show, keepWorkInPlace: false, keepPinnedInPlace: true, customSections: true };
    expect(resolveVisibleSidebarSections({ ...base, sections, hiddenSections: [], pages: true })).toEqual([{ kind: 'pages' }, { kind: 'projects' }]);
    expect(resolveVisibleSidebarSections({ ...base, sections, hiddenSections: ['pages'], pages: true })).toEqual([{ kind: 'projects' }]);
    expect(resolveVisibleSidebarSections({ ...base, sections, hiddenSections: [], pages: false })).toEqual([{ kind: 'projects' }]);
  });
});
