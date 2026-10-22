import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearLinearAuth, setLinearAuth } from './auth.js';
import {
  LINEAR_TRACKER_DESCRIPTOR,
  createLinearTracker,
  linearPriority,
  linearStateCategory,
  linearStatusOfStateFilter,
  linearTracker,
  matchLinearUrl,
  toTrackerAuthStatus,
} from './tracker.js';
import { linearLikeTrackerDescriptor } from '../../../../ui/src/lib/trackers/descriptor.fixture.ts';
import { LINEAR_URL_CASES } from '../../../../ui/src/lib/trackers/linearUrlCases.fixture.ts';

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const relatedNode = (identifier, type) => ({
  id: `uuid-${identifier}`,
  identifier,
  title: `Title ${identifier}`,
  url: `https://linear.app/openchamber/issue/${identifier}`,
  priority: 3,
  updatedAt: '2026-09-30T10:00:00.000Z',
  state: { id: `state-${type}`, name: type, type },
  assignee: null,
  team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
});

const issueNode = {
  ...relatedNode('ENG-12', 'started'),
  title: 'Broken login',
  priority: 1,
  state: { id: 'state-started', name: 'In Progress', type: 'started' },
  assignee: { name: 'Ada', displayName: 'Ada Lovelace', avatarUrl: 'https://example.com/a.png' },
  labels: { nodes: [{ id: 'label-bug', name: 'Bug', color: 'EB5757' }] },
  parent: relatedNode('ENG-1', 'unstarted'),
  children: {
    nodes: [{ state: { type: 'completed' } }, { state: { type: 'started' } }, { state: { type: 'canceled' } }],
    pageInfo: { hasNextPage: true },
  },
};

const fullIssueNode = {
  ...issueNode,
  description: 'Users cannot sign in.',
  comments: { nodes: [{ id: 'c-1', body: 'Still broken', createdAt: '2026-09-30T11:00:00.000Z', user: { name: 'Bob', displayName: null, avatarUrl: null } }] },
  subIssues: {
    nodes: [
      { ...relatedNode('ENG-14', 'completed'), subIssueSortOrder: 2 },
      { ...relatedNode('ENG-13', 'backlog'), subIssueSortOrder: 1 },
    ],
    pageInfo: { hasNextPage: false },
  },
};

describe('Linear tracker mapping rules', () => {
  it('maps every Linear state type to a category', () => {
    expect(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled', 'duplicate'].map(linearStateCategory))
      .toEqual(['triage', 'backlog', 'todo', 'in-progress', 'done', 'canceled', 'canceled']);
    expect(linearStateCategory('other')).toBeNull();
    expect(linearStateCategory(null)).toBeNull();
    expect(linearStateCategory('toString')).toBeNull();
  });

  it('maps priority 0 to 4', () => {
    expect([0, 1, 2, 3, 4].map(linearPriority)).toEqual(['none', 'urgent', 'high', 'medium', 'low']);
    expect([5, -1, 1.5, null, '1'].map(linearPriority)).toEqual([null, null, null, null, null]);
  });

  it('maps every descriptor state filter to a Linear list status', () => {
    expect(LINEAR_TRACKER_DESCRIPTOR.stateFilters.map(linearStatusOfStateFilter)).toEqual([
      'open', 'all', 'backlog', 'todo', 'started', 'inReview', 'completed', 'canceled', 'duplicate',
    ]);
    expect(linearStatusOfStateFilter('triage')).toBeNull();
    expect(linearStatusOfStateFilter('started')).toBeNull();
  });

  // One table with the UI's link opener (`matchTrackerUrl.test.ts`); the session-link writer calls this matcher.
  it.each(LINEAR_URL_CASES)('matchUrl(%s) is %s', (url, identifier) => {
    expect(matchLinearUrl(url)).toBe(identifier);
  });

  it('keeps the descriptor plain JSON', () => {
    expect(JSON.parse(JSON.stringify(LINEAR_TRACKER_DESCRIPTOR))).toEqual(LINEAR_TRACKER_DESCRIPTOR);
    // The UI's fixture, which the web adapter's older-server fallback is checked against.
    expect(LINEAR_TRACKER_DESCRIPTOR).toEqual(linearLikeTrackerDescriptor());
    expect(new RegExp(LINEAR_TRACKER_DESCRIPTOR.identifierPattern).test('ENG-12')).toBe(true);
  });

  it('turns workspaces into accounts without tokens or email', () => {
    const status = toTrackerAuthStatus({
      connected: true,
      user: { id: 'u', name: 'Ada', displayName: 'Ada Lovelace', email: 'ada@example.com', avatarUrl: null },
      organization: { id: 'org-1', name: 'OpenChamber' },
      workspaces: [
        { id: 'org-1', name: 'OpenChamber', urlKey: 'oc', current: true, user: { id: 'u', name: 'Ada', displayName: 'Ada Lovelace', email: 'ada@example.com', avatarUrl: null }, authorizedAt: 10 },
        { id: 'org-2', name: null, urlKey: null, current: false, user: null, authorizedAt: null },
      ],
    });
    expect(status).toEqual({
      connected: true,
      account: { id: 'org-1', name: 'OpenChamber', user: { name: 'Ada Lovelace', avatarUrl: null }, current: true, authorizedAt: 10 },
      accounts: [
        { id: 'org-1', name: 'OpenChamber', user: { name: 'Ada Lovelace', avatarUrl: null }, current: true, authorizedAt: 10 },
        { id: 'org-2', name: null, user: null, current: false, authorizedAt: null },
      ],
    });
    expect(toTrackerAuthStatus({ connected: false })).toEqual({ connected: false });
  });
});

describe('Linear tracker over the Linear libraries', () => {
  let dataDir;
  let previousDataDir;
  let tracker;

  beforeEach(async () => {
    previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-linear-tracker-'));
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    setLinearAuth({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 86_400_000,
      scope: 'read,write,comments:create',
    });
    tracker = await linearTracker.load();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearLinearAuth();
    if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists neutral summaries with category, priority, container, parent and progress', async () => {
    const graphql = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      expect(body.variables.filter).toEqual({
        state: { type: { eq: 'started' }, name: { neqIgnoreCase: 'In Review' } },
        assignee: { isMe: { eq: true } },
        team: { id: { eq: 'team-eng' } },
        priority: { eq: 2 },
      });
      return jsonResponse({ data: { issues: { nodes: [issueNode], pageInfo: { hasNextPage: true, endCursor: 'next' } } } });
    });
    vi.stubGlobal('fetch', graphql);

    const result = await tracker.list({ state: 'in-progress', people: 'me', priority: 'high', containerId: 'team-eng' });
    expect(result).toEqual({
      connected: true,
      cursor: 'next',
      hasMore: true,
      items: [{
        provider: 'linear',
        id: 'uuid-ENG-12',
        identifier: 'ENG-12',
        title: 'Broken login',
        url: 'https://linear.app/openchamber/issue/ENG-12',
        state: { id: 'state-started', name: 'In Progress', category: 'in-progress' },
        priority: 'urgent',
        assignee: { name: 'Ada Lovelace', avatarUrl: 'https://example.com/a.png' },
        container: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
        updatedAt: '2026-09-30T10:00:00.000Z',
        labels: [{ id: 'label-bug', name: 'Bug', color: '#eb5757' }],
        parent: {
          provider: 'linear',
          id: 'uuid-ENG-1',
          identifier: 'ENG-1',
          title: 'Title ENG-1',
          url: 'https://linear.app/openchamber/issue/ENG-1',
          state: { id: 'state-unstarted', name: 'unstarted', category: 'todo' },
          priority: 'medium',
          assignee: null,
          container: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
          updatedAt: '2026-09-30T10:00:00.000Z',
        },
        progress: { total: 3, done: 2, more: true },
      }],
    });
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it('refuses a state filter Linear does not have', async () => {
    await expect(tracker.list({ state: 'triage' })).rejects.toMatchObject({ userError: true });
  });

  it('gets an item with description, comments and children in Linear order', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: { issue: fullIssueNode } })));
    const { connected, item } = await tracker.get('ENG-12');
    expect(connected).toBe(true);
    expect(item.description).toBe('Users cannot sign in.');
    expect(item.comments).toEqual([{ id: 'c-1', body: 'Still broken', createdAt: '2026-09-30T11:00:00.000Z', author: { name: 'Bob', avatarUrl: null } }]);
    expect(item.children.map((child) => [child.identifier, child.state.category])).toEqual([['ENG-13', 'backlog'], ['ENG-14', 'done']]);
    expect(item.children[0]).not.toHaveProperty('labels');
    expect(item.childrenMore).toBe(false);
    expect(item.progress).toEqual({ total: 3, done: 2, more: true });
  });

  it('lists workflow states in Linear order with categories', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      data: { team: { states: { nodes: [
        { id: 's-done', name: 'Done', type: 'completed', position: 0 },
        { id: 's-review', name: 'In Review', type: 'started', position: 2 },
        { id: 's-progress', name: 'In Progress', type: 'started', position: 1 },
        { id: 's-triage', name: 'Triage', type: 'triage', position: 0 },
      ] } } },
    })));
    expect(await tracker.states('team-eng')).toEqual({
      connected: true,
      states: [
        { id: 's-triage', name: 'Triage', category: 'triage', position: 0 },
        { id: 's-progress', name: 'In Progress', category: 'in-progress', position: 1 },
        { id: 's-review', name: 'In Review', category: 'in-progress', position: 2 },
        { id: 's-done', name: 'Done', category: 'done', position: 0 },
      ],
    });
  });

  it('returns live summaries with the category and, for older clients, the Linear type', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: {
      i0: { identifier: 'ENG-12', title: 'Broken login', state: { name: 'Done', type: 'completed' } },
      i1: { identifier: 'ENG-13', title: 'Odd', state: { name: 'Mystery', type: 'unknown' } },
    } })));
    expect(await tracker.liveSummaries(['ENG-12', 'ENG-13'])).toEqual({
      connected: true,
      items: [
        { identifier: 'ENG-12', title: 'Broken login', state: { name: 'Done', category: 'done', type: 'completed' } },
        // A type this build does not map keeps its item, as an open one.
        { identifier: 'ENG-13', title: 'Odd', state: { name: 'Mystery', category: 'todo', type: 'unknown' } },
      ],
    });
  });

  it('answers disconnected without a workspace', async () => {
    clearLinearAuth();
    expect(await tracker.list({})).toEqual({ connected: false });
    expect(await tracker.get('ENG-12')).toEqual({ connected: false });
    expect(await tracker.liveSummaries(['ENG-12'])).toEqual({ connected: false });
    expect(await tracker.mapping.get()).toEqual({ connected: false });
    expect(await tracker.mapping.set({ defaultProjectPath: '/p', containerProjectPaths: {} })).toEqual({ connected: false });
    expect(await tracker.hostAccess.account()).toEqual({ connected: false, label: '' });
  });

  it('stores the mapping under neutral names', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: { teams: {
      nodes: [{ id: 'team-eng', key: 'ENG', name: 'Engineering' }],
      pageInfo: { hasNextPage: false },
    } } })));
    expect(await tracker.mapping.set({ defaultProjectPath: '/repo', containerProjectPaths: { 'team-eng': '/eng' } })).toEqual({
      connected: true,
      defaultProjectPath: '/repo',
      containers: [{ id: 'team-eng', key: 'ENG', name: 'Engineering', projectPath: '/eng' }],
    });
    expect((await tracker.mapping.get()).containers[0].projectPath).toBe('/eng');
  });

  it('round-trips the session comments preference', async () => {
    expect(await tracker.preferences.get()).toEqual({ sessionComments: false });
    expect(await tracker.preferences.set({ sessionComments: true })).toEqual({ sessionComments: true });
    expect(await tracker.preferences.get()).toEqual({ sessionComments: true });
  });
});

describe('Linear tracker auth', () => {
  const libraries = (overrides = {}) => ({
    startAuthorization: vi.fn(async () => ({ authorizationUrl: 'https://linear.app/oauth/authorize?x', expiresIn: 600, scope: 'read' })),
    activateLinearAuth: vi.fn(() => false),
    getLinearAuth: vi.fn(() => null),
    getLinearAuthWorkspaces: vi.fn(() => []),
    toLinearPublicStatus: vi.fn(),
    ...overrides,
  });

  it('starts authorization without the scope and maps a missing client id to a user error', async () => {
    const libs = libraries();
    const tracker = createLinearTracker(libs);
    expect(await tracker.auth.start({ origin: 'desktop' })).toEqual({ authorizationUrl: 'https://linear.app/oauth/authorize?x', expiresIn: 600 });
    expect(libs.startAuthorization).toHaveBeenCalledWith({ origin: 'desktop' });

    libs.startAuthorization.mockRejectedValueOnce(Object.assign(new Error('No client id'), { code: 'LINEAR_CLIENT_ID_MISSING' }));
    await expect(tracker.auth.start()).rejects.toMatchObject({ message: 'No client id', userError: true });
  });

  it('answers null when activating a workspace that is not stored', async () => {
    const tracker = createLinearTracker(libraries());
    expect(await tracker.auth.activate('org-x')).toBeNull();
  });

  it('passes the session status input under Linear names', async () => {
    const postLinearSessionStatus = vi.fn(async () => ({ connected: true, posted: true }));
    const tracker = createLinearTracker(libraries({ postLinearSessionStatus }));
    await tracker.sessionStatus.post({ kind: 'started', sessionId: 's', identifier: 'ENG-12', sessionOrigin: 'https://x.example.com' });
    expect(postLinearSessionStatus).toHaveBeenCalledWith({ kind: 'started', sessionId: 's', issueIdentifier: 'ENG-12', sessionOrigin: 'https://x.example.com' });
  });
});
