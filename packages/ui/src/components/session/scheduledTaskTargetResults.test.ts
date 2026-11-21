import { describe, expect, test } from 'bun:test';

import type { Session } from '@/lib/opencode/model';
import { SCHEDULED_TASK_TARGET_LIMIT, scheduledTaskTargetCandidates, scheduledTaskTargetLoad, scheduledTaskTargetResults } from './scheduledTaskTargetResults';

// SAFETY: sessions as the stores hold them; the results read id, title, parentID, metadata and time.
const session = (id: string, title: string, updated: number, extra: Partial<Session> = {}): Session => ({
  id, title, directory: '/work/app', projectID: 'p', cost: 0, time: { created: 0, updated }, ...extra,
} as Session);

const worker = (id: string, title: string, parentID: string): Session => session(id, title, 50, {
  parentID,
  metadata: { openchamber: { kind: 'operator-child', parentID } },
});

const newestFirst = (left: Session, right: Session) => right.time.updated - left.time.updated;

const sessions = [
  session('ses_r1', 'Fix retry logic', 1),
  session('ses_r2', 'Release notes', 9),
  session('ses_r3', 'Retry the flaky test', 5),
  session('ses_c1', 'Explore retry logic', 7, { parentID: 'ses_r1' }),
  session('ses_c2', 'Audit lockfile', 3, { parentID: 'ses_gone' }),
  worker('ses_w1', 'Worker: retry logic', 'ses_r2'),
  session('ses_review', 'Review of retry logic', 8, { parentID: 'ses_r3', metadata: { openchamber: { kind: 'review', originalSessionID: 'ses_r3' } } }),
];

const results = (query: string, selectedId = '', eligible: readonly Session[] = sessions) => scheduledTaskTargetResults({
  eligible,
  known: sessions,
  query,
  selectedId,
  compare: newestFirst,
});

const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

describe('scheduled task target results', () => {
  test('an empty query lists root sessions in order, a review among them, and says subagents are a search away', () => {
    const found = results('');
    expect(ids(found.rows)).toEqual(['ses_r2', 'ses_review', 'ses_r3', 'ses_r1']);
    expect(found.more).toBe(true);
  });

  test('a title query lists matching roots, then matching subagents with their parent titles', () => {
    const found = results('retry');
    expect(ids(found.rows.slice(0, 3)).sort()).toEqual(['ses_r1', 'ses_r3', 'ses_review']);
    expect(found.rows[3]).toEqual({ id: 'ses_c1', title: 'Explore retry logic', subagent: true, parentTitle: 'Fix retry logic' });
    expect(found.rows).toHaveLength(4);
    expect(found.more).toBe(false);
  });

  test('a subagent whose parent is unknown has no parent title', () => {
    expect(results('lockfile').rows).toEqual([{ id: 'ses_c2', title: 'Audit lockfile', subagent: true, parentTitle: null }]);
  });

  test('a full session id finds that session, a partial id finds nothing', () => {
    expect(ids(results('SES_C1').rows)).toEqual(['ses_c1']);
    expect(results('ses_c').rows).toEqual([]);
  });

  test('a title that starts like a session id is still found by its title', () => {
    const titled = session('ses_t1', 'ses_store migration', 20);
    const found = scheduledTaskTargetResults({ eligible: [titled], known: [titled], query: 'ses_store', selectedId: '', compare: newestFirst });
    expect(ids(found.rows)).toEqual(['ses_t1']);
  });

  test('sessions an agent runs for its own work never appear', () => {
    expect(ids(results('worker').rows)).toEqual([]);
    expect(ids(results('ses_w1').rows)).toEqual([]);
    expect(ids(results('').rows)).not.toContain('ses_w1');
  });

  test('the saved target comes first on an empty query, even as a subagent', () => {
    const found = results('', 'ses_c1');
    expect(found.selected).toEqual({ id: 'ses_c1', title: 'Explore retry logic', subagent: true, parentTitle: 'Fix retry logic' });
    expect(ids(found.rows)).toEqual(['ses_r2', 'ses_review', 'ses_r3', 'ses_r1']);
  });

  test('the saved target shows when it is not eligible or not loaded at all', () => {
    expect(results('', 'ses_r1', sessions.filter((entry) => entry.id !== 'ses_r1')).selected?.title).toBe('Fix retry logic');
    expect(results('', 'ses_missing').selected).toEqual({ id: 'ses_missing', title: 'ses_missing', subagent: false, parentTitle: null });
  });

  test('the saved target is not repeated in the rows', () => {
    expect(ids(results('', 'ses_r3').rows)).toEqual(['ses_r2', 'ses_review', 'ses_r1']);
  });

  test('a search leaves the saved target to rank among the matches', () => {
    const found = results('notes', 'ses_r1');
    expect(found.selected).toBeNull();
    expect(ids(found.rows)).toEqual(['ses_r2']);
  });

  test('an untitled session shows its id', () => {
    const untitled = session('ses_blank', '  ', 20);
    const found = scheduledTaskTargetResults({ eligible: [untitled], known: [untitled], query: '', selectedId: '', compare: newestFirst });
    expect(found.rows).toEqual([{ id: 'ses_blank', title: 'ses_blank', subagent: false, parentTitle: null }]);
  });

  test('a saved target that became an agent worker is not offered as a row', () => {
    expect(results('', 'ses_w1').selected).toBeNull();
    expect(ids(results('', 'ses_w1').rows)).toEqual(['ses_r2', 'ses_review', 'ses_r3', 'ses_r1']);
    const none = results('', 'ses_w1', []);
    expect(none.selected).toBeNull();
    expect(none.rows).toEqual([]);
    expect(none.more).toBe(false);
  });

  test('an untitled session is found by the id it shows', () => {
    const untitled = session('ses_blank7', '', 20);
    const found = scheduledTaskTargetResults({ eligible: [untitled], known: [untitled], query: 'blank7', selectedId: '', compare: newestFirst });
    expect(found.rows.map((row) => row.id)).toEqual(['ses_blank7']);
  });

  test('rows stop at the limit and say more are a search away', () => {
    const many = Array.from({ length: SCHEDULED_TASK_TARGET_LIMIT + 5 }, (_, index) => session(`ses_m${index}`, `Many ${index}`, index));
    const found = scheduledTaskTargetResults({ eligible: many, known: many, query: '', selectedId: '', compare: newestFirst });
    expect(found.rows).toHaveLength(SCHEDULED_TASK_TARGET_LIMIT);
    expect(found.rows[0].id).toBe(`ses_m${SCHEDULED_TASK_TARGET_LIMIT + 4}`);
    expect(found.more).toBe(true);
  });
});

describe('scheduled task target candidates', () => {
  test('the session cache wins over a stale live copy, and live copies fill only what the cache lacks', () => {
    const cached = [session('ses_a', 'Cached title', 5, { time: { created: 0, updated: 5, archived: 9 } }), session('ses_b', 'Kept', 4)];
    const live = [session('ses_a', 'Stale live title', 3), session('ses_c', 'Only live', 2)];
    expect(scheduledTaskTargetCandidates(cached, [], live).map((entry) => `${entry.id}:${entry.title}`)).toEqual(['ses_b:Kept', 'ses_c:Only live']);
  });

  test('a session the cache holds as archived stays out, whatever a stale live copy says', () => {
    const archived = [session('ses_a', 'Archived', 5, { time: { created: 0, updated: 5, archived: 9 } })];
    const live = [session('ses_a', 'Stale live copy', 3), session('ses_c', 'Only live', 2)];
    expect(scheduledTaskTargetCandidates([session('ses_b', 'Kept', 4)], archived, live).map((entry) => entry.id)).toEqual(['ses_b', 'ses_c']);
  });
});

describe('scheduled task target load', () => {
  test('reads as loading until the session cache has loaded, even when live sessions are already checked', () => {
    expect(scheduledTaskTargetLoad({ eligibility: 'ready', eligibilityCoversCache: true, cacheLoaded: false, cacheStatus: 'loading', hasCandidates: true })).toBe('loading');
    expect(scheduledTaskTargetLoad({ eligibility: 'idle', eligibilityCoversCache: true, cacheLoaded: false, cacheStatus: 'idle', hasCandidates: false })).toBe('loading');
  });

  test('stays loading after the cache arrives until a check that covers the cache answers', () => {
    expect(scheduledTaskTargetLoad({ eligibility: 'ready', eligibilityCoversCache: false, cacheLoaded: true, cacheStatus: 'ready', hasCandidates: true })).toBe('loading');
    expect(scheduledTaskTargetLoad({ eligibility: 'ready', eligibilityCoversCache: true, cacheLoaded: true, cacheStatus: 'ready', hasCandidates: true })).toBe('ready');
  });

  test('a cache that failed to load, or a failed check, is a failure, never an empty list', () => {
    expect(scheduledTaskTargetLoad({ eligibility: 'ready', eligibilityCoversCache: true, cacheLoaded: false, cacheStatus: 'error', hasCandidates: true })).toBe('error');
    expect(scheduledTaskTargetLoad({ eligibility: 'error', eligibilityCoversCache: true, cacheLoaded: true, cacheStatus: 'ready', hasCandidates: true })).toBe('error');
  });

  test('once the cache has loaded, a refresh keeps the shown list, and no candidates means an empty project', () => {
    expect(scheduledTaskTargetLoad({ eligibility: 'ready', eligibilityCoversCache: true, cacheLoaded: true, cacheStatus: 'loading', hasCandidates: true })).toBe('ready');
    expect(scheduledTaskTargetLoad({ eligibility: 'idle', eligibilityCoversCache: true, cacheLoaded: true, cacheStatus: 'ready', hasCandidates: false })).toBe('ready');
    expect(scheduledTaskTargetLoad({ eligibility: 'loading', eligibilityCoversCache: true, cacheLoaded: true, cacheStatus: 'ready', hasCandidates: true })).toBe('loading');
  });

  test('a loaded cache with sessions that no check has covered yet reads as loading, not an empty project', () => {
    // The first full cache can arrive with no candidates seen before it, so no check has started.
    expect(scheduledTaskTargetLoad({ eligibility: 'idle', eligibilityCoversCache: false, cacheLoaded: true, cacheStatus: 'ready', hasCandidates: true })).toBe('loading');
    expect(scheduledTaskTargetLoad({ eligibility: 'loading', eligibilityCoversCache: false, cacheLoaded: true, cacheStatus: 'ready', hasCandidates: true })).toBe('loading');
    expect(scheduledTaskTargetLoad({ eligibility: 'ready', eligibilityCoversCache: true, cacheLoaded: true, cacheStatus: 'ready', hasCandidates: true })).toBe('ready');
  });
});
