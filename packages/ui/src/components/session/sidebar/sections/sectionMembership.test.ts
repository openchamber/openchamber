import { describe, expect, test } from 'bun:test';
import { EMPTY_SIDEBAR_SECTION_FILTER, type CustomSidebarSection, type SidebarWorkFacts } from '@/lib/sidebarSections';
import type { SidebarWorkRef } from '../works/sidebarWorks';
import { resolveSidebarSectionMembership, resolveVisibleSidebarSections, type VisibleSidebarSection } from './sectionMembership';

const ref = (id: string, projectId = 'p1'): SidebarWorkRef => ({ kind: 'session', key: `session:${id}`, projectId, rootSessionId: id });

const facts = (overrides: Partial<SidebarWorkFacts> = {}): SidebarWorkFacts => ({
  kind: 'session', projectId: 'p1', pin: null, inWork: false, done: false, running: false, needsAnswer: false,
  unread: false, failed: false, looksDone: false, hasPr: false, hasIssue: false, hasTrackerItem: false, hasPlan: false, hasGoal: false, lastActivityAt: 0, ...overrides,
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
    sections, pinned, work, all: [ref('a'), ref('b'), ref('c', 'p2')], projectIds: new Set(['p1', 'p2']), factsOf, now: 1_000, search: false,
  });

  test('a section that takes its works out of their projects still leaves them to the other sections', () => {
    const result = resolve([
      custom(section('first', { claims: true, filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, states: ['running'] } })),
      custom(section('second', { filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, states: ['running'] } })),
    ]);
    expect(result.custom.get('first')?.map((work) => work.key)).toEqual(['session:a', 'session:b']);
    expect(result.custom.get('second')?.map((work) => work.key)).toEqual(['session:a', 'session:b']);
    expect([...result.claimedKeys]).toEqual(['session:a', 'session:b']);
    expect(result.listedKeys.size).toBe(0);
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
    expect([...result.listedKeys]).toEqual(['session:a', 'session:b']);
  });

  test('a search lists a work once, in the first section that shows it', () => {
    const result = resolveSidebarSectionMembership({
      sections: [
        { kind: 'work', claims: false },
        custom(section('second', { filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, states: ['running'] } })),
      ],
      pinned: [], work: [ref('a')], all: [ref('a'), ref('b')], projectIds: new Set(['p1']), factsOf, now: 1_000, search: true,
    });
    expect(result.work.map((work) => work.key)).toEqual(['session:a']);
    expect(result.custom.get('second')?.map((work) => work.key)).toEqual(['session:b']);
  });

  test('Pinned above takes its works from In work below, and the order turned around gives them to In work', () => {
    const above = resolve([{ kind: 'pinned' }, { kind: 'work', claims: true }], [ref('a')], [ref('a'), ref('b')]);
    expect(above.pinned.map((work) => work.key)).toEqual(['session:a']);
    expect(above.work.map((work) => work.key)).toEqual(['session:b']);

    const below = resolve([{ kind: 'work', claims: true }, { kind: 'pinned' }], [ref('a')], [ref('a'), ref('b')]);
    expect(below.work.map((work) => work.key)).toEqual(['session:a', 'session:b']);
    expect(below.pinned).toEqual([]);
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
      show,
      keepWorkInPlace: true,
      customSections: true,
    });
    expect(visible).toEqual([
      { kind: 'chats' },
      { kind: 'custom', section: draft, preview: true },
      { kind: 'work', claims: false },
      { kind: 'projects' },
    ]);
  });

  test('VS Code shows no section of the user\'s own', () => {
    const visible = resolveVisibleSidebarSections({
      sections: [section('mine'), { kind: 'builtin', id: 'projects' }],
      hiddenSections: [], draft: null, draftIsNew: false, show, keepWorkInPlace: false, customSections: false,
    });
    expect(visible).toEqual([{ kind: 'projects' }]);
  });
});
