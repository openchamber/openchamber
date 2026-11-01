import { describe, expect, test } from 'bun:test';
import {
  EMPTY_SIDEBAR_SECTION_FILTER,
  matchesSidebarSectionFilter,
  sidebarPinListsSchema,
  sidebarSectionsSchema,
  type SidebarWorkFacts,
} from './sidebarSections';

const facts = (overrides: Partial<SidebarWorkFacts> = {}): SidebarWorkFacts => ({
  kind: 'session', projectId: 'p1', pin: null, inWork: false, done: false, running: false, needsAnswer: false,
  unread: false, failed: false, looksDone: false, hasPr: false, hasIssue: false, hasTrackerItem: false, hasPlan: false, hasGoal: false, lastActivityAt: 0, texts: [], scheduled: false, ...overrides,
});

describe('sidebarSectionsSchema', () => {
  test('an empty list is the default order, and what is not a list is rejected', () => {
    expect(sidebarSectionsSchema.parse([]).map((entry) => entry.id)).toEqual(['chats', 'pinned', 'work', 'projects']);
    expect(sidebarSectionsSchema.safeParse('junk').success).toBe(false);
  });

  test('drops broken and repeated entries and puts missing built-in sections back in their default place', () => {
    const sections = sidebarSectionsSchema.parse([
      { kind: 'builtin', id: 'projects' },
      { kind: 'custom', id: 'mine', name: '  Mine  ', filter: { states: ['running', 'bogus'] } },
      { kind: 'custom', id: 'mine', name: 'Again' },
      { kind: 'custom', id: 'work', name: 'Takes a built-in id' },
      { kind: 'custom', id: 'nameless', name: '' },
      'junk',
      { kind: 'builtin', id: 'chats' },
    ]);
    // Pinned follows Chats, as by default, and In work follows Pinned.
    expect(sections.map((entry) => entry.id)).toEqual(['projects', 'mine', 'chats', 'pinned', 'work']);
    const mine = sections.find((entry) => entry.id === 'mine');
    expect(mine).toMatchObject({ kind: 'custom', name: 'Mine', grouping: 'time', claims: false, hideWhenEmpty: true });
    expect(mine?.kind === 'custom' ? mine.filter.states : null).toEqual(['running']);
  });

  test('a group of projects keeps only its projects', () => {
    const entry = sidebarSectionsSchema.parse([{ kind: 'custom', id: 'g', name: 'Clients', grouping: 'project', filter: { projectIds: ['p1'], states: ['running'] } }])
      .find((section) => section.id === 'g');
    expect(entry?.kind === 'custom' ? entry.filter : null).toEqual({ ...EMPTY_SIDEBAR_SECTION_FILTER, projectIds: ['p1'] });
  });

  test('keeps a project named by a long folder path', () => {
    // A project's id is `path_` and its folder path encoded, longer than the ids sections make.
    const id = `path_${'L1VzZXJzL2J0cmlhcGl0c3lu'.repeat(4)}`;
    const entry = sidebarSectionsSchema.parse([{ kind: 'custom', id: 'g', name: 'Clients', grouping: 'project', filter: { projectIds: [id] } }])
      .find((section) => section.id === 'g');
    expect(entry?.kind === 'custom' ? entry.filter.projectIds : null).toEqual([id]);
  });

  test('keeps phrases trimmed, short and once, and reads one saved as a string or none at all', () => {
    const parsed = sidebarSectionsSchema.parse([
      { kind: 'custom', id: 't', name: 'Relay', filter: { text: `  relay ${'x'.repeat(200)}` } },
      { kind: 'custom', id: 'l', name: 'Topics', filter: { text: [' relay ', 'relay', '', 42, 'mobile'] } },
      { kind: 'custom', id: 'o', name: 'Old', filter: { states: ['running'] } },
    ]);
    const textOf = (id: string) => {
      const entry = parsed.find((section) => section.id === id);
      return entry?.kind === 'custom' ? entry.filter.text : null;
    };
    expect(textOf('t')).toEqual([`relay ${'x'.repeat(94)}`]);
    expect(textOf('l')).toEqual(['relay', 'mobile']);
    expect(textOf('o')).toEqual([]);
  });
});

describe('sidebarPinListsSchema', () => {
  test('keeps named lists once and never one named like Pinned', () => {
    expect(sidebarPinListsSchema.parse([{ id: 'a', name: 'Release' }, { id: 'a', name: 'Dup' }, { id: 'pinned', name: 'Clash' }, { id: 'b', name: ' ' }]))
      .toEqual([{ id: 'a', name: 'Release' }]);
  });
});

describe('matchesSidebarSectionFilter', () => {
  const now = new Date(2026, 9, 31, 15, 0).getTime();
  test('any chip in a row matches, and every row with a chip must match', () => {
    const filter = { ...EMPTY_SIDEBAR_SECTION_FILTER, states: ['running', 'needs-answer'] as const, kinds: ['worktree'] as const };
    expect(matchesSidebarSectionFilter({ ...filter, states: [...filter.states], kinds: [...filter.kinds] }, facts({ kind: 'worktree', needsAnswer: true }), now)).toBe(true);
    expect(matchesSidebarSectionFilter({ ...filter, states: [...filter.states], kinds: [...filter.kinds] }, facts({ kind: 'session', needsAnswer: true }), now)).toBe(false);
    expect(matchesSidebarSectionFilter({ ...filter, states: [...filter.states], kinds: [...filter.kinds] }, facts({ kind: 'worktree' }), now)).toBe(false);
  });

  test('pins match by list, and an unpinned work matches no pin', () => {
    const filter = { ...EMPTY_SIDEBAR_SECTION_FILTER, pins: ['release'] };
    expect(matchesSidebarSectionFilter(filter, facts({ pin: 'release' }), now)).toBe(true);
    expect(matchesSidebarSectionFilter(filter, facts({ pin: 'pinned' }), now)).toBe(false);
    expect(matchesSidebarSectionFilter(filter, facts(), now)).toBe(false);
  });

  test('a scheduled run is a type of its own beside what the work is', () => {
    const scheduled = { ...EMPTY_SIDEBAR_SECTION_FILTER, kinds: ['scheduled' as const] };
    expect(matchesSidebarSectionFilter(scheduled, facts({ scheduled: true }), now)).toBe(true);
    expect(matchesSidebarSectionFilter(scheduled, facts({ kind: 'worktree', scheduled: true }), now)).toBe(true);
    expect(matchesSidebarSectionFilter(scheduled, facts(), now)).toBe(false);
    // With a title: the runs of one task.
    expect(matchesSidebarSectionFilter({ ...scheduled, text: ['nightly triage'] }, facts({ scheduled: true, texts: ['Nightly triage 2026-10-31'] }), now)).toBe(true);
    expect(matchesSidebarSectionFilter({ ...scheduled, text: ['nightly triage'] }, facts({ texts: ['Nightly triage notes'] }), now)).toBe(false);
  });

  test('text: every word of a phrase in a title or the branch, as the sidebar search matches', () => {
    const filter = { ...EMPTY_SIDEBAR_SECTION_FILTER, text: ['relay fix'] };
    expect(matchesSidebarSectionFilter(filter, facts({ texts: ['Fix the Relay reconnect'] }), now)).toBe(true);
    expect(matchesSidebarSectionFilter(filter, facts({ texts: ['Relay pairing', 'fix/relay-pairing'] }), now)).toBe(true);
    expect(matchesSidebarSectionFilter(filter, facts({ texts: ['Relay pairing'] }), now)).toBe(false);
    expect(matchesSidebarSectionFilter({ ...filter, text: [] }, facts(), now)).toBe(true);
  });

  test('text: any one of the phrases', () => {
    const filter = { ...EMPTY_SIDEBAR_SECTION_FILTER, text: ['relay', 'mobile drawer'] };
    expect(matchesSidebarSectionFilter(filter, facts({ texts: ['Relay pairing'] }), now)).toBe(true);
    expect(matchesSidebarSectionFilter(filter, facts({ texts: ['Mobile drawer scroll'] }), now)).toBe(true);
    expect(matchesSidebarSectionFilter(filter, facts({ texts: ['Mobile sheet'] }), now)).toBe(false);
  });

  test('activity: today and the last two days from local midnight, stalled after three quiet days', () => {
    const today = { ...EMPTY_SIDEBAR_SECTION_FILTER, activity: 'today' as const };
    const stalled = { ...EMPTY_SIDEBAR_SECTION_FILTER, activity: 'stalled' as const };
    expect(matchesSidebarSectionFilter(today, facts({ lastActivityAt: new Date(2026, 9, 31, 0, 5).getTime() }), now)).toBe(true);
    expect(matchesSidebarSectionFilter(today, facts({ lastActivityAt: new Date(2026, 9, 30, 23, 55).getTime() }), now)).toBe(false);
    const twoDays = { ...EMPTY_SIDEBAR_SECTION_FILTER, activity: 'two-days' as const };
    expect(matchesSidebarSectionFilter(twoDays, facts({ lastActivityAt: new Date(2026, 9, 30, 0, 5).getTime() }), now)).toBe(true);
    expect(matchesSidebarSectionFilter(twoDays, facts({ lastActivityAt: new Date(2026, 9, 29, 23, 55).getTime() }), now)).toBe(false);
    expect(matchesSidebarSectionFilter(stalled, facts({ lastActivityAt: now - 4 * 24 * 60 * 60 * 1000 }), now)).toBe(true);
    expect(matchesSidebarSectionFilter(stalled, facts({ lastActivityAt: now - 60_000 }), now)).toBe(false);
    expect(matchesSidebarSectionFilter(stalled, facts({ lastActivityAt: 0 }), now)).toBe(false);
  });
});
