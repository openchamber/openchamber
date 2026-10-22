import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeFetchOptions } from '@openchamber/ui/lib/runtime-fetch';
import { linearLikeTrackerDescriptor } from '@openchamber/ui/lib/trackers/descriptor.fixture';
import { BUILT_IN_LINEAR_TRACKER, createWebTrackerAPI } from './trackers';

const fetchMock = vi.fn(async (_input: string, _init?: RuntimeFetchOptions): Promise<Response> => Response.json({}));

afterEach(() => {
  fetchMock.mockReset();
});

const lastPath = (): string | undefined => fetchMock.mock.calls.at(-1)?.[0];
/** The last request's body as sent. */
const lastBody = (): string => String(fetchMock.mock.calls.at(-1)?.[1]?.body);

const neutralItem = {
  provider: 'linear',
  id: 'uuid-12',
  identifier: 'ENG-12',
  title: 'Broken login',
  url: 'https://linear.app/openchamber/issue/ENG-12',
  state: { id: 's-started', name: 'In Progress', category: 'in-progress' },
  priority: 'urgent',
  assignee: { name: 'Ada', avatarUrl: null },
  container: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
  labels: [{ id: 'l1', name: 'Bug', color: 'EB5757' }],
  parent: null,
  progress: { total: 2, done: 1, more: false },
  updatedAt: '2026-09-30T10:00:00.000Z',
};

/** A server that serves `/api/tracker`; `answer` answers everything after the providers read. */
const trackerServer = (answer: (path: string) => Response) => {
  fetchMock.mockImplementation(async (path: string) => (
    path === '/api/tracker/providers' ? Response.json({ providers: [BUILT_IN_LINEAR_TRACKER] }) : answer(path)
  ));
};

describe('web trackers: providers', () => {
  it('reads the trackers the server serves', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ providers: [{ ...BUILT_IN_LINEAR_TRACKER, name: 'Linear EU' }] }));
    const providers = await createWebTrackerAPI({ fetch: fetchMock }).providers();
    expect(providers.map((provider) => [provider.id, provider.name])).toEqual([['linear', 'Linear EU']]);
    expect(lastPath()).toBe('/api/tracker/providers');
  });

  it('answers with the built-in Linear descriptor when the server predates the route', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    await expect(createWebTrackerAPI({ fetch: fetchMock }).providers()).resolves.toEqual([BUILT_IN_LINEAR_TRACKER]);
  });

  // The fixture is checked against the server's own descriptor in `server/lib/linear/tracker.test.js`.
  it('keeps the built-in descriptor identical to the server\'s', () => {
    expect(BUILT_IN_LINEAR_TRACKER).toEqual(linearLikeTrackerDescriptor());
  });

  it('keeps the built-in descriptor valid against the UI schema', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ providers: [BUILT_IN_LINEAR_TRACKER] }));
    await expect(createWebTrackerAPI({ fetch: fetchMock }).providers()).resolves.toEqual([BUILT_IN_LINEAR_TRACKER]);
  });

  it('fails instead of answering an empty list when the read fails or is unreadable', async () => {
    const api = createWebTrackerAPI({ fetch: fetchMock });
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Trackers unavailable' }, { status: 503 }));
    await expect(api.providers()).rejects.toThrow('Trackers unavailable');
    fetchMock.mockResolvedValueOnce(Response.json({ providers: [{ id: 'linear', name: 'Linear' }] }));
    await expect(api.providers()).rejects.toThrow('no readable tracker');
    fetchMock.mockResolvedValueOnce(Response.json({ providers: [] }));
    await expect(api.providers()).resolves.toEqual([]);
  });

  it('reads a 2xx answer that is not JSON as a server that predates the route', async () => {
    const api = createWebTrackerAPI({ fetch: fetchMock });
    fetchMock.mockResolvedValueOnce(new Response('<!doctype html><title>app</title>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    await expect(api.providers()).resolves.toEqual([BUILT_IN_LINEAR_TRACKER]);
    fetchMock.mockResolvedValueOnce(Response.json({ connected: false }));
    await api.authStatus('linear');
    expect(lastPath()).toBe('/api/linear/auth/status');
  });

  it('still fails on a refused, failing or malformed JSON answer', async () => {
    const api = createWebTrackerAPI({ fetch: fetchMock });
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    await expect(api.providers()).rejects.toThrow('Unauthorized');
    fetchMock.mockResolvedValueOnce(new Response('oops', { status: 500, headers: { 'content-type': 'text/html' } }));
    await expect(api.providers()).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(new Response('{"providers": [', { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(api.providers()).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(Response.json({ trackers: [] }));
    await expect(api.providers()).rejects.toThrow();
  });

  it('asks the new runtime which wire it speaks after a switch', async () => {
    let runtime = 'url:https://new.example';
    const api = createWebTrackerAPI({ fetch: fetchMock, runtimeKey: () => runtime });
    fetchMock.mockResolvedValueOnce(Response.json({ providers: [BUILT_IN_LINEAR_TRACKER] }));
    await api.providers();

    // The older server has no `/api/tracker`; its first call asks before it reads.
    runtime = 'url:https://old.example';
    fetchMock.mockImplementation(async (path: string) => (
      path === '/api/tracker/providers' ? new Response('Not Found', { status: 404 }) : Response.json({ connected: false })
    ));
    await api.authStatus('linear');
    expect(fetchMock.mock.calls.slice(-2).map(([path]) => path)).toEqual(['/api/tracker/providers', '/api/linear/auth/status']);
  });
});

describe('web trackers: the neutral routes', () => {
  it('names the tracker in every path and sends the list filters as asked', async () => {
    trackerServer(() => Response.json({ connected: true, items: [neutralItem, { id: 'broken' }], cursor: 'c2', hasMore: true }));
    const api = createWebTrackerAPI({ fetch: fetchMock });
    const result = await api.list('linear', { query: ' login ', state: 'in-progress', people: 'me', priority: 'high', containerId: 'team-eng' });
    expect(lastPath()).toBe('/api/tracker/linear/items/list?query=login&state=in-progress&people=me&priority=high&containerId=team-eng');
    // One malformed item is dropped, never the list; label colours read as `#rrggbb`.
    expect(result).toEqual({
      connected: true,
      items: [{ ...neutralItem, labels: [{ id: 'l1', name: 'Bug', color: '#eb5757' }] }],
      cursor: 'c2',
      hasMore: true,
    });
  });

  it('reads an item with its comments and children', async () => {
    trackerServer(() => Response.json({
      connected: true,
      item: {
        ...neutralItem,
        description: 'Users cannot sign in.',
        comments: [{ id: 'c1', body: 'Still broken', createdAt: null, author: { name: 'Bob', avatarUrl: null } }],
        children: [{ ...neutralItem, id: 'uuid-13', identifier: 'ENG-13', labels: undefined, progress: undefined, parent: undefined }],
        childrenMore: true,
      },
    }));
    const result = await createWebTrackerAPI({ fetch: fetchMock }).get('linear', 'uuid-12');
    expect(lastPath()).toBe('/api/tracker/linear/items/get?id=uuid-12');
    if (!result.connected || !result.item) throw new Error('expected an item');
    expect(result.item.comments).toEqual([{ id: 'c1', body: 'Still broken', createdAt: null, author: { name: 'Bob', avatarUrl: null } }]);
    expect(result.item.children?.map((child) => child.identifier)).toEqual(['ENG-13']);
    expect(result.item.childrenMore).toBe(true);
  });

  it('passes a disconnected answer through and rejects a failed one', async () => {
    trackerServer(() => Response.json({ connected: false }));
    const api = createWebTrackerAPI({ fetch: fetchMock });
    await expect(api.states('linear', 'team-eng')).resolves.toEqual({ connected: false });
    expect(lastPath()).toBe('/api/tracker/linear/states?containerId=team-eng');

    fetchMock.mockResolvedValueOnce(Response.json({ error: 'This tracker does not support this action', code: 'UNSUPPORTED' }, { status: 404 }));
    await expect(api.mappingGet('linear')).rejects.toThrow('does not support');
  });

  it('sends writes with their neutral bodies', async () => {
    trackerServer((path) => Response.json(path.endsWith('/preferences') ? { sessionComments: true } : { connected: true, posted: true, commentId: 'c1' }));
    const api = createWebTrackerAPI({ fetch: fetchMock });
    await api.sessionStatusPost('linear', { kind: 'started', sessionId: 's1', identifier: 'ENG-12' });
    expect(lastPath()).toBe('/api/tracker/linear/session-status');
    expect(lastBody()).toBe(JSON.stringify({ kind: 'started', sessionId: 's1', identifier: 'ENG-12' }));
    await expect(api.preferencesSet('linear', { sessionComments: true })).resolves.toEqual({ sessionComments: true });
    expect(fetchMock.mock.calls.at(-1)?.[1]?.method).toBe('PUT');
  });
});

describe('web trackers: a server from before /api/tracker', () => {
  const legacyServer = (answer: (path: string) => Response) => {
    fetchMock.mockImplementation(async (path: string) => (
      path.startsWith('/api/tracker') ? new Response('Not Found', { status: 404 }) : answer(path)
    ));
  };

  it('reads Linear through the legacy routes in the neutral shapes', async () => {
    legacyServer((path) => {
      if (path.startsWith('/api/linear/auth/status')) {
        return Response.json({
          connected: true,
          user: { id: 'u', name: 'ada', displayName: 'Ada', email: 'ada@example.com', avatarUrl: null },
          organization: { id: 'org-1', name: 'OpenChamber', urlKey: 'oc' },
          workspaces: [{ id: 'org-1', name: 'OpenChamber', urlKey: 'oc', current: true, user: null, authorizedAt: 5 }],
        });
      }
      return Response.json({
        connected: true,
        issues: [{
          id: 'uuid-12',
          identifier: 'ENG-12',
          title: 'Broken login',
          url: 'https://linear.app/openchamber/issue/ENG-12',
          state: { id: 's-started', name: 'In Progress', type: 'started' },
          assignee: { name: 'ada', displayName: 'Ada', avatarUrl: null },
          team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
          priority: 1,
          labels: [],
          parent: null,
          subIssueProgress: null,
        }],
        cursor: null,
        hasMore: false,
      });
    });
    const api = createWebTrackerAPI({ fetch: fetchMock });
    await expect(api.providers()).resolves.toEqual([BUILT_IN_LINEAR_TRACKER]);

    await expect(api.authStatus('linear')).resolves.toEqual({
      connected: true,
      account: { id: 'org-1', name: 'OpenChamber', current: true, user: null, authorizedAt: 5 },
      accounts: [{ id: 'org-1', name: 'OpenChamber', current: true, user: null, authorizedAt: 5 }],
    });

    const listed = await api.list('linear', { state: 'in-progress', people: 'me', containerId: 'team-eng' });
    expect(lastPath()).toBe('/api/linear/issues/list?status=started&assignee=me&teamId=team-eng');
    expect(listed).toEqual({
      connected: true,
      items: [{
        provider: 'linear',
        id: 'uuid-12',
        identifier: 'ENG-12',
        title: 'Broken login',
        url: 'https://linear.app/openchamber/issue/ENG-12',
        state: { id: 's-started', name: 'In Progress', category: 'in-progress' },
        priority: 'urgent',
        assignee: { name: 'Ada', avatarUrl: null },
        container: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
        updatedAt: null,
        labels: [],
        parent: null,
        progress: null,
      }],
      cursor: null,
      hasMore: false,
    });
  });

  it('writes in Linear field names and refuses any other tracker', async () => {
    legacyServer(() => Response.json({ connected: true, defaultProjectPath: '/repo', teams: [{ id: 'team-eng', key: 'ENG', name: 'Engineering', projectPath: '/eng' }] }));
    const api = createWebTrackerAPI({ fetch: fetchMock });
    const mapping = await api.mappingSet('linear', { defaultProjectPath: '/repo', containerProjectPaths: { 'team-eng': '/eng' } });
    expect(lastPath()).toBe('/api/linear/mapping');
    expect(lastBody()).toBe(JSON.stringify({ defaultProjectPath: '/repo', teamProjectPaths: { 'team-eng': '/eng' } }));
    expect(mapping).toEqual({ connected: true, defaultProjectPath: '/repo', containers: [{ id: 'team-eng', key: 'ENG', name: 'Engineering', projectPath: '/eng' }] });

    await api.authActivate('linear', 'org-2').catch(() => undefined);
    expect(lastBody()).toBe(JSON.stringify({ organizationId: 'org-2' }));
    await expect(api.list('jira')).rejects.toThrow('Unknown tracker');
  });
});
