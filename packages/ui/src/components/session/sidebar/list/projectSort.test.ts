import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { ProjectSortOrder } from '@/stores/useSessionDisplayStore';

import {
  deriveProjectActivityByProjectId,
  orderProjectsByLiveActivity,
  sortProjectsByOrder,
  type ProjectActivitySignal,
} from './projectSort';

const projects = [
  { id: 'beta', label: 'Beta', path: '/repos/beta', addedAt: 300, lastOpenedAt: 100 },
  { id: 'alpha', label: 'alpha', path: '/repos/alpha', addedAt: 100, lastOpenedAt: 300 },
  { id: 'gamma', label: null, path: '/repos/gamma', addedAt: 200, lastOpenedAt: 200 },
];

const ids = (list: ReadonlyArray<{ id: string }>): string[] => list.map((project) => project.id);

describe('sortProjectsByOrder', () => {
  // A label-less project compares by its whole path, so it sorts under '/'.
  // Both surfaces fill the label in before rendering; this only pins the
  // fallback down.
  test('orders by label case-insensitively, falling back to the path', () => {
    expect(ids(sortProjectsByOrder(projects, 'a-z', []))).toEqual(['gamma', 'alpha', 'beta']);
    expect(ids(sortProjectsByOrder(projects, 'z-a', []))).toEqual(['beta', 'alpha', 'gamma']);
  });

  test('puts the newest first for date-added and the most recently opened first for recent', () => {
    expect(ids(sortProjectsByOrder(projects, 'date-added', []))).toEqual(['beta', 'gamma', 'alpha']);
    expect(ids(sortProjectsByOrder(projects, 'recent', []))).toEqual(['alpha', 'gamma', 'beta']);
  });

  test('follows the manual order and keeps unlisted projects at the end', () => {
    expect(ids(sortProjectsByOrder(projects, 'manual', ['gamma', 'alpha']))).toEqual(['gamma', 'alpha', 'beta']);
  });

  test('leaves the input untouched', () => {
    const input = [...projects];
    sortProjectsByOrder(input, 'a-z', []);
    expect(ids(input)).toEqual(['beta', 'alpha', 'gamma']);
  });

  test('treats a missing timestamp as the oldest', () => {
    const withoutStamps = [{ id: 'none', path: '/repos/none' }, ...projects];
    expect(ids(sortProjectsByOrder(withoutStamps, 'recent', []))).toEqual(['alpha', 'gamma', 'beta', 'none']);
  });
});

describe('orderProjectsByLiveActivity', () => {
  const signal = (
    hasActiveSession: boolean,
    latestSessionActivityAt = 0,
  ): ProjectActivitySignal => ({ hasActiveSession, latestSessionActivityAt });

  test('date-added promotes running projects while preserving the mode order inside each tier', () => {
    const input = [
      { id: 'beta', path: '/repos/beta', addedAt: 300, lastOpenedAt: 100 },
      { id: 'alpha', path: '/repos/alpha', addedAt: 100, lastOpenedAt: 300 },
      { id: 'gamma', path: '/repos/gamma', addedAt: 200, lastOpenedAt: 200 },
    ];
    const activity = new Map([
      ['beta', signal(true)],
      ['alpha', signal(false)],
      ['gamma', signal(true)],
    ]);

    expect(ids(orderProjectsByLiveActivity(input, 'date-added', activity))).toEqual(['beta', 'gamma', 'alpha']);
  });

  test('recent uses the latest session lifecycle value as a recency signal', () => {
    const input = [
      { id: 'alpha', path: '/repos/alpha', lastOpenedAt: 300 },
      { id: 'beta', path: '/repos/beta', lastOpenedAt: 200 },
    ];
    const activity = new Map([
      ['alpha', signal(false, 0)],
      ['beta', signal(false, 500)],
    ]);

    expect(ids(orderProjectsByLiveActivity(input, 'recent', activity))).toEqual(['beta', 'alpha']);
  });

  test('recent keeps the higher lastOpenedAt when it exceeds live activity', () => {
    // Incoming order is `recent` order. An activity-only key would rank beta
    // first (500 > 10); the max-based key keeps alpha first (1000 > 500).
    const input = [
      { id: 'alpha', path: '/repos/alpha', lastOpenedAt: 1000 },
      { id: 'beta', path: '/repos/beta', lastOpenedAt: 100 },
    ];
    const activity = new Map([
      ['alpha', signal(false, 10)],
      ['beta', signal(false, 500)],
    ]);

    expect(ids(orderProjectsByLiveActivity(input, 'recent', activity))).toEqual(['alpha', 'beta']);
  });

  test('recent still promotes a running project whose recency key is lower', () => {
    const input = [
      { id: 'alpha', path: '/repos/alpha', lastOpenedAt: 900 },
      { id: 'beta', path: '/repos/beta', lastOpenedAt: 100 },
    ];
    const activity = new Map([
      ['alpha', signal(false, 0)],
      ['beta', signal(true, 200)],
    ]);

    expect(ids(orderProjectsByLiveActivity(input, 'recent', activity))).toEqual(['beta', 'alpha']);
  });

  test('recent preserves the incoming order when recency keys tie', () => {
    // Incoming order intentionally contradicts the id order, so a tie broken
    // by anything other than the incoming position would flip this result.
    const input = [
      { id: 'second', path: '/repos/second', lastOpenedAt: 500 },
      { id: 'first', path: '/repos/first', lastOpenedAt: 500 },
    ];
    const activity = new Map([
      ['second', signal(false, 0)],
      ['first', signal(false, 0)],
    ]);

    expect(ids(orderProjectsByLiveActivity(input, 'recent', activity))).toEqual(['second', 'first']);
  });

  test('manual, a-z, and z-a return the input order untouched', () => {
    const input = [
      { id: 'beta', path: '/repos/beta', addedAt: 300, lastOpenedAt: 100 },
      { id: 'alpha', path: '/repos/alpha', addedAt: 100, lastOpenedAt: 300 },
    ];
    const activity = new Map([['alpha', signal(true, 500)]]);

    for (const order of ['manual', 'a-z', 'z-a'] as const) {
      const output = orderProjectsByLiveActivity(input, order, activity);
      expect(output).toBe(input);
      expect(ids(output)).toEqual(['beta', 'alpha']);
    }
  });

  test('keeps the input reference when nothing moves', () => {
    const input = [
      { id: 'alpha', path: '/repos/alpha', addedAt: 300 },
      { id: 'beta', path: '/repos/beta', addedAt: 100 },
    ];
    const activity = new Map([['alpha', signal(true)], ['beta', signal(false)]]);

    expect(orderProjectsByLiveActivity(input, 'date-added', activity)).toBe(input);
  });
});

const session = (id: string, directory: string, updated: number): Session => ({
  id,
  slug: id,
  projectID: 'project',
  title: id,
  version: '1',
  directory,
  time: { created: updated, updated },
});

const sessionRanks = (entries: ReadonlyArray<readonly [string, number]>): ReadonlyMap<string, number> =>
  new Map(entries);

describe('deriveProjectActivityByProjectId', () => {
  const resolveByDirectory = (entry: Session): string | null =>
    entry.directory === '/repos/beta' ? 'beta' : 'alpha';

  test('collects active membership and the latest lifecycle value per resolved project', () => {
    const alpha = session('ses_alpha', '/repos/alpha', 10);
    const idle = session('ses_idle', '/repos/alpha', 30);
    const beta = session('ses_beta', '/repos/beta', 20);
    const activity = deriveProjectActivityByProjectId({
      projectIds: ['alpha', 'beta'],
      sessions: [alpha, idle, beta],
      activeSessionIds: new Set([beta.id]),
      sessionOrderRanks: sessionRanks([[alpha.id, 500], [idle.id, 100], [beta.id, 200]]),
      resolveProjectId: resolveByDirectory,
    });

    expect(activity.get('alpha')).toEqual({ hasActiveSession: false, latestSessionActivityAt: 500 });
    expect(activity.get('beta')).toEqual({ hasActiveSession: true, latestSessionActivityAt: 200 });
  });

  test('ignores unresolved sessions so orphans cannot stamp a project', () => {
    const orphan = session('ses_orphan', '/elsewhere', 5);
    const activity = deriveProjectActivityByProjectId({
      projectIds: ['alpha'],
      sessions: [orphan],
      activeSessionIds: new Set([orphan.id]),
      sessionOrderRanks: sessionRanks([]),
      resolveProjectId: () => null,
    });

    expect(activity.get('alpha')).toEqual({ hasActiveSession: false, latestSessionActivityAt: 0 });
    expect(activity.has('beta')).toBe(false);
  });

  test('falls back to the session timestamp when it has no live rank', () => {
    const rankedByTimestamp = session('ses_no_rank', '/repos/alpha', 1234);
    const activity = deriveProjectActivityByProjectId({
      projectIds: ['alpha'],
      sessions: [rankedByTimestamp],
      activeSessionIds: new Set(),
      sessionOrderRanks: sessionRanks([]),
      resolveProjectId: resolveByDirectory,
    });

    expect(activity.get('alpha')).toEqual({ hasActiveSession: false, latestSessionActivityAt: 1234 });
  });
});

// The mobile sheet composes the same steps: mode sort, activity derivation
// from its flattened session list, then live promotion.
describe('mobile project promotion flow', () => {
  const projects = [
    { id: 'beta', label: 'Beta', path: '/repos/beta', addedAt: 300, lastOpenedAt: 100 },
    { id: 'alpha', label: 'Alpha', path: '/repos/alpha', addedAt: 100, lastOpenedAt: 300 },
  ];
  const betaLive = session('ses_beta_live', '/repos/beta', 10);
  const alphaLive = session('ses_alpha_live', '/repos/alpha', 20);
  const alphaIdle = session('ses_alpha_idle', '/repos/alpha', 30);
  const betaIdle = session('ses_beta_idle', '/repos/beta', 40);
  const allSessions = [betaLive, alphaLive, alphaIdle, betaIdle];
  // Beta's live rank is deliberately the lowest, so only the promotion tier
  // (not recency) can put it ahead of alpha in `recent`.
  const ranks = sessionRanks([[betaLive.id, 100], [alphaLive.id, 900], [alphaIdle.id, 50], [betaIdle.id, 40]]);
  const resolveProjectId = (entry: Session): string | null =>
    entry.directory === '/repos/beta' ? 'beta' : 'alpha';

  const orderFor = (
    order: ProjectSortOrder,
    manualOrder: readonly string[],
    activeSessions: readonly Session[],
  ) => {
    const activity = deriveProjectActivityByProjectId({
      projectIds: projects.map((project) => project.id),
      sessions: allSessions,
      activeSessionIds: new Set(activeSessions.map((entry) => entry.id)),
      sessionOrderRanks: ranks,
      resolveProjectId,
    });
    return orderProjectsByLiveActivity(
      sortProjectsByOrder(projects, order, manualOrder),
      order,
      activity,
    );
  };

  test('recent promotes the live project even when its recency key is lower', () => {
    expect(ids(orderFor('recent', [], [betaLive]))).toEqual(['beta', 'alpha']);
  });

  test('date-added promotes the live project above a newer project', () => {
    expect(ids(orderFor('date-added', [], [alphaLive]))).toEqual(['alpha', 'beta']);
  });

  test('manual, a-z, and z-a ignore live activity entirely', () => {
    expect(ids(orderFor('a-z', [], [betaLive]))).toEqual(['alpha', 'beta']);
    expect(ids(orderFor('z-a', [], [alphaLive]))).toEqual(['beta', 'alpha']);
    expect(ids(orderFor('manual', ['beta', 'alpha'], [alphaLive]))).toEqual(['beta', 'alpha']);
  });
});
