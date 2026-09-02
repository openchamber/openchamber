import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerLinearRoutes } from './routes.js';
import { setLinearAuth, setLinearSessionCommentsEnabled } from './auth.js';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-linear-routes-'));

const createApp = () => {
  const app = express();
  registerLinearRoutes(app);
  return app;
};

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

describe('Linear auth routes', () => {
  let dataDir;
  let previousDataDir;

  beforeEach(() => {
    previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    dataDir = makeTempDir();
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    process.env.OPENCHAMBER_PORT = '3001';
    process.env.OPENCHAMBER_LINEAR_REDIRECT_URI = 'http://127.0.0.1:3001/linear/oauth/callback';
    delete process.env.OPENCHAMBER_LINEAR_CLIENT_ID;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousDataDir === undefined) {
      delete process.env.OPENCHAMBER_DATA_DIR;
    } else {
      process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    }
    delete process.env.OPENCHAMBER_PORT;
    delete process.env.OPENCHAMBER_LINEAR_REDIRECT_URI;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('starts authorization and completes it from the public callback', async () => {
    const app = createApp();
    const start = await request(app)
      .post('/api/linear/auth/start')
      .send({ origin: 'desktop' })
      .expect(200);

    expect(start.body.authorizationUrl).toContain('https://linear.app/oauth/authorize');
    const state = new URL(start.body.authorizationUrl).searchParams.get('state');

    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const target = String(url);
      if (target === 'https://api.linear.app/oauth/token') {
        return jsonResponse({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          token_type: 'Bearer',
          expires_in: 86399,
          scope: 'read,write,comments:create',
        });
      }
      if (target === 'https://api.linear.app/graphql') {
        return jsonResponse({
          data: {
            viewer: {
              id: 'user-1',
              name: 'Ada',
              displayName: 'Ada Lovelace',
              email: 'ada@example.com',
              avatarUrl: 'https://example.com/a.png',
            },
            organization: { id: 'org-1', name: 'OpenChamber', urlKey: 'openchamber' },
          },
        });
      }
      throw new Error(`unexpected fetch: ${target}`);
    }));

    const callback = await request(app)
      .get('/linear/oauth/callback')
      .query({ state, code: 'auth-code' })
      .expect(200);

    expect(callback.text).toContain('Authorization Complete');
    expect(callback.text).toContain('openchamber://focus/linear-auth');

    const status = await request(app).get('/api/linear/auth/status').expect(200);
    expect(status.body.connected).toBe(true);
    expect(status.body.user).toEqual({
      id: 'user-1',
      name: 'Ada',
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      avatarUrl: 'https://example.com/a.png',
    });
    expect(status.body.organization).toEqual({ id: 'org-1', name: 'OpenChamber', urlKey: 'openchamber' });
    expect(status.body.scope).toBe('read,write,comments:create');
    expect(status.body.workspaces).toEqual([{
      id: 'org-1',
      name: 'OpenChamber',
      urlKey: 'openchamber',
      current: true,
      user: {
        id: 'user-1',
        name: 'Ada',
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
        avatarUrl: 'https://example.com/a.png',
      },
      authorizedAt: expect.any(Number),
    }]);
    expect(JSON.stringify(status.body)).not.toContain('access-1');
    expect(JSON.stringify(status.body)).not.toContain('refresh-1');

    const again = await request(app).get('/api/linear/auth/status').expect(200);
    expect(again.body.workspaces[0].authorizedAt).toBe(status.body.workspaces[0].authorizedAt);
  });

  it('never exchanges a code whose state is unknown', async () => {
    const tokenFetch = vi.fn();
    vi.stubGlobal('fetch', tokenFetch);
    const app = createApp();
    const response = await request(app)
      .get('/linear/oauth/callback')
      .query({ state: 'forged', code: 'attacker-code' })
      .expect(400);
    expect(tokenFetch).not.toHaveBeenCalled();
    expect(response.text).toContain('Authorization Failed');
    expect(response.text).not.toContain('openchamber://');
  });

  it('omits the desktop deep link for flows started outside the desktop shell', async () => {
    const app = createApp();
    const start = await request(app)
      .post('/api/linear/auth/start')
      .send({ origin: 'web' })
      .expect(200);
    const state = new URL(start.body.authorizationUrl).searchParams.get('state');

    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const target = String(url);
      if (target.includes('/oauth/token')) {
        return jsonResponse({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 86399,
        });
      }
      return jsonResponse({
        data: { viewer: { id: 'user-1', name: 'Ada' }, organization: null },
      });
    }));

    const response = await request(app)
      .get('/linear/oauth/callback')
      .query({ state, code: 'auth-code' })
      .expect(200);
    expect(response.text).not.toContain('openchamber://');
  });

  it('disconnects and revokes the refresh token', async () => {
    const app = createApp();
    const start = await request(app).post('/api/linear/auth/start').send({}).expect(200);
    const state = new URL(start.body.authorizationUrl).searchParams.get('state');
    const fetchMock = vi.fn(async (url) => {
      const target = String(url);
      if (target.includes('/oauth/token')) {
        return jsonResponse({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 86399,
        });
      }
      if (target.includes('/graphql')) {
        return jsonResponse({ data: { viewer: { id: 'user-1', name: 'Ada' } } });
      }
      if (target.includes('/oauth/revoke')) {
        return new Response('', { status: 200 });
      }
      throw new Error(`unexpected fetch: ${target}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await request(app).get('/linear/oauth/callback').query({ state, code: 'auth-code' }).expect(200);
    await request(app).delete('/api/linear/auth').expect(200);

    const revokeCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/oauth/revoke'));
    expect(revokeCall).toBeTruthy();
    const body = new URLSearchParams(revokeCall[1].body);
    expect(body.get('token')).toBe('refresh-1');
    expect(body.get('token_type_hint')).toBe('refresh_token');

    const status = await request(app).get('/api/linear/auth/status').expect(200);
    expect(status.body).toEqual({ connected: false });
  });

  it('stores a second workspace, switches current, and disconnects only that one', async () => {
    const app = createApp();

    const startA = await request(app).post('/api/linear/auth/start').send({}).expect(200);
    const stateA = new URL(startA.body.authorizationUrl).searchParams.get('state');
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const target = String(url);
      if (target.includes('/oauth/token')) {
        return jsonResponse({
          access_token: 'access-a',
          refresh_token: 'refresh-a',
          expires_in: 86399,
          scope: 'read,write,comments:create',
        });
      }
      if (target.includes('/graphql')) {
        return jsonResponse({
          data: {
            viewer: { id: 'user-a', name: 'Ada' },
            organization: { id: 'org-a', name: 'Alpha', urlKey: 'alpha' },
          },
        });
      }
      throw new Error(`unexpected fetch: ${target}`);
    }));
    await request(app).get('/linear/oauth/callback').query({ state: stateA, code: 'code-a' }).expect(200);

    const startB = await request(app).post('/api/linear/auth/start').send({}).expect(200);
    const stateB = new URL(startB.body.authorizationUrl).searchParams.get('state');
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const target = String(url);
      if (target.includes('/oauth/token')) {
        return jsonResponse({
          access_token: 'access-b',
          refresh_token: 'refresh-b',
          expires_in: 86399,
          scope: 'read,write,comments:create',
        });
      }
      if (target.includes('/graphql')) {
        return jsonResponse({
          data: {
            viewer: { id: 'user-b', name: 'Ben' },
            organization: { id: 'org-b', name: 'Beta', urlKey: 'beta' },
          },
        });
      }
      if (target.includes('/oauth/revoke')) {
        return new Response('', { status: 200 });
      }
      throw new Error(`unexpected fetch: ${target}`);
    }));
    await request(app).get('/linear/oauth/callback').query({ state: stateB, code: 'code-b' }).expect(200);

    const both = await request(app).get('/api/linear/auth/status').expect(200);
    expect(both.body.organization.id).toBe('org-b');
    expect(both.body.workspaces).toHaveLength(2);

    await request(app).post('/api/linear/auth/activate').send({}).expect(400);
    await request(app).post('/api/linear/auth/activate').send({ organizationId: 'missing' }).expect(404);

    const activated = await request(app)
      .post('/api/linear/auth/activate')
      .send({ organizationId: 'org-a' })
      .expect(200);
    expect(activated.body.organization.id).toBe('org-a');
    expect(activated.body.workspaces.find((entry) => entry.id === 'org-a').current).toBe(true);
    expect(activated.body.workspaces.find((entry) => entry.id === 'org-b').current).toBe(false);

    await request(app).delete('/api/linear/auth').expect(200);
    const remaining = await request(app).get('/api/linear/auth/status').expect(200);
    expect(remaining.body.connected).toBe(true);
    expect(remaining.body.organization.id).toBe('org-b');
    expect(remaining.body.workspaces).toHaveLength(1);
    expect(remaining.body.workspaces[0].id).toBe('org-b');
  });

  it('lists and gets issues through authenticated routes without leaking tokens', async () => {
    setLinearAuth({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 86_400_000,
      scope: 'read',
    });
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.query.includes('GetLinearIssue')) {
        return jsonResponse({
          data: {
            issue: {
              id: 'issue-1',
              identifier: 'ENG-12',
              title: 'Broken login',
              url: 'https://linear.app/openchamber/issue/ENG-12',
              state: { name: 'Todo', type: 'unstarted' },
              assignee: null,
              description: 'Users cannot sign in.',
              comments: { nodes: [] },
            },
          },
        });
      }
      return jsonResponse({
        data: {
          issues: {
            nodes: [{
              id: 'issue-1',
              identifier: 'ENG-12',
              title: 'Broken login',
              url: 'https://linear.app/openchamber/issue/ENG-12',
              state: { name: 'Todo', type: 'unstarted' },
              assignee: null,
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }));

    const app = createApp();
    const list = await request(app).get('/api/linear/issues/list').expect(200);
    expect(list.body.connected).toBe(true);
    expect(list.body.issues).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('access-1');

    const missing = await request(app).get('/api/linear/issues/get').expect(400);
    expect(missing.body.error).toBe('id is required');

    const got = await request(app).get('/api/linear/issues/get').query({ id: 'ENG-12' }).expect(200);
    expect(got.body.issue.identifier).toBe('ENG-12');
    expect(got.body.issue.description).toBe('Users cannot sign in.');
    expect(got.body.issue.state).toEqual({ id: null, name: 'Todo', type: 'unstarted' });
  });

  it('passes list filters from query params to Linear', async () => {
    setLinearAuth({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 86_400_000,
      scope: 'read',
    });
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      expect(body.variables.filter).toEqual({
        state: { type: { eq: 'completed' } },
        assignee: { isMe: { eq: true } },
        team: { id: { eq: 'team-eng' } },
        priority: { eq: 1 },
      });
      return jsonResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }));

    const app = createApp();
    const list = await request(app).get('/api/linear/issues/list').query({
      status: 'completed',
      assignee: 'me',
      teamId: 'team-eng',
      priority: 'urgent',
    }).expect(200);
    expect(list.body.connected).toBe(true);
    expect(list.body.issues).toEqual([]);
  });

  it('lists workflow states and updates issue status without leaking tokens', async () => {
    setLinearAuth({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 86_400_000,
      scope: 'write',
    });
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.query.includes('TeamWorkflowStates')) {
        expect(body.variables.id).toBe('team-eng');
        expect(options.headers.Authorization).toBe('Bearer access-1');
        return jsonResponse({
          data: {
            team: {
              states: {
                nodes: [
                  { id: 'state-todo', name: 'Todo', type: 'unstarted', position: 1 },
                  { id: 'state-done', name: 'Done', type: 'completed', position: 2 },
                ],
              },
            },
          },
        });
      }
      expect(body.query).toContain('mutation IssueUpdate');
      expect(body.variables).toEqual({
        id: 'issue-uuid-1',
        input: { stateId: 'state-done' },
      });
      return jsonResponse({
        data: {
          issueUpdate: {
            success: true,
            issue: {
              id: 'issue-uuid-1',
              identifier: 'ENG-12',
              title: 'Broken login',
              url: 'https://linear.app/openchamber/issue/ENG-12',
              state: { id: 'state-done', name: 'Done', type: 'completed' },
              assignee: null,
              description: null,
              comments: { nodes: [] },
            },
          },
        },
      });
    }));

    const app = createApp();
    const missingTeam = await request(app).get('/api/linear/issues/states').expect(400);
    expect(missingTeam.body.error).toBe('teamId is required');

    const states = await request(app).get('/api/linear/issues/states').query({ teamId: 'team-eng' }).expect(200);
    expect(states.body.connected).toBe(true);
    expect(states.body.states).toEqual([
      { id: 'state-todo', name: 'Todo', type: 'unstarted', position: 1 },
      { id: 'state-done', name: 'Done', type: 'completed', position: 2 },
    ]);
    expect(JSON.stringify(states.body)).not.toContain('access-1');

    const missingBody = await request(app).post('/api/linear/issues/update').send({}).expect(400);
    expect(missingBody.body.error).toBe('id and stateId are required');

    const updated = await request(app).post('/api/linear/issues/update').send({
      id: 'issue-uuid-1',
      stateId: 'state-done',
    }).expect(200);
    expect(updated.body.connected).toBe(true);
    expect(updated.body.issue.identifier).toBe('ENG-12');
    expect(updated.body.issue.state).toEqual({ id: 'state-done', name: 'Done', type: 'completed' });
    expect(JSON.stringify(updated.body)).not.toContain('access-1');
  });

  it('returns 400 for Linear validation and not-found GraphQL errors', async () => {
    setLinearAuth({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 86_400_000,
      scope: 'write',
    });
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.query.includes('TeamWorkflowStates')) {
        return jsonResponse({
          data: null,
          errors: [{
            message: 'Entity not found: Team',
            extensions: {
              code: 'INPUT_ERROR',
              userError: true,
              userPresentableMessage: 'Could not find referenced Team.',
            },
          }],
        });
      }
      return jsonResponse({
        data: null,
        errors: [{
          message: 'Argument Validation Error',
          extensions: {
            code: 'INVALID_INPUT',
            userError: true,
            userPresentableMessage: 'stateId must be a UUID.',
          },
        }],
      });
    }));

    const app = createApp();
    const states = await request(app).get('/api/linear/issues/states').query({ teamId: 'missing-team' }).expect(400);
    expect(states.body.error).toBe('Could not find referenced Team.');

    const updated = await request(app).post('/api/linear/issues/update').send({
      id: 'issue-uuid-1',
      stateId: 'not-a-uuid',
    }).expect(400);
    expect(updated.body.error).toBe('stateId must be a UUID.');
  });

  it('returns disconnected for issue routes when Linear is not connected', async () => {
    const app = createApp();
    const list = await request(app).get('/api/linear/issues/list').expect(200);
    expect(list.body).toEqual({ connected: false });
    const got = await request(app).get('/api/linear/issues/get').query({ id: 'ENG-12' }).expect(200);
    expect(got.body).toEqual({ connected: false });
    const states = await request(app).get('/api/linear/issues/states').query({ teamId: 'team-eng' }).expect(200);
    expect(states.body).toEqual({ connected: false });
    const updated = await request(app).post('/api/linear/issues/update').send({
      id: 'issue-1',
      stateId: 'state-done',
    }).expect(200);
    expect(updated.body).toEqual({ connected: false });
  });

  it('returns disconnected mapping when Linear is not connected', async () => {
    const app = createApp();
    const mapping = await request(app).get('/api/linear/mapping').expect(200);
    expect(mapping.body).toEqual({ connected: false });
    const saved = await request(app).put('/api/linear/mapping').send({
      defaultProjectPath: '/tmp/project',
      teamProjectPaths: {},
    }).expect(200);
    expect(saved.body).toEqual({ connected: false });
  });

  it('saves and reads Linear team-to-project mapping without leaking tokens', async () => {
    setLinearAuth({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 86_400_000,
      scope: 'read',
    });
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      expect(body.query).toContain('query ListLinearTeams');
      expect(options.headers.Authorization).toBe('Bearer access-1');
      return jsonResponse({
        data: {
          teams: {
            nodes: [
              { id: 'team-eng', key: 'ENG', name: 'Engineering' },
              { id: 'team-des', key: 'DES', name: 'Design' },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }));

    const app = createApp();
    const empty = await request(app).get('/api/linear/mapping').expect(200);
    expect(empty.body).toEqual({
      connected: true,
      defaultProjectPath: null,
      teams: [
        { id: 'team-eng', key: 'ENG', name: 'Engineering', projectPath: null },
        { id: 'team-des', key: 'DES', name: 'Design', projectPath: null },
      ],
    });
    expect(JSON.stringify(empty.body)).not.toContain('access-1');

    const saved = await request(app).put('/api/linear/mapping').send({
      defaultProjectPath: '/Users/ada/openchamber',
      teamProjectPaths: { 'team-eng': '/Users/ada/eng' },
    }).expect(200);
    expect(saved.body).toEqual({
      connected: true,
      defaultProjectPath: '/Users/ada/openchamber',
      teams: [
        { id: 'team-eng', key: 'ENG', name: 'Engineering', projectPath: '/Users/ada/eng' },
        { id: 'team-des', key: 'DES', name: 'Design', projectPath: null },
      ],
    });
    expect(JSON.stringify(saved.body)).not.toContain('access-1');

    const reread = await request(app).get('/api/linear/mapping').expect(200);
    expect(reread.body.defaultProjectPath).toBe('/Users/ada/openchamber');
    expect(reread.body.teams[0].projectPath).toBe('/Users/ada/eng');
  });

  it('posts a session status comment and never leaks the token', async () => {
    setLinearSessionCommentsEnabled(true);
    setLinearAuth({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 86_400_000,
      scope: 'read,write,comments:create',
    });
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.query.includes('query GetLinearIssue')) {
        return jsonResponse({
          data: {
            issue: {
              id: 'issue-1',
              identifier: 'ENG-12',
              title: 'Broken login',
              url: 'https://linear.app/openchamber/issue/ENG-12',
              state: { name: 'Todo', type: 'unstarted' },
              assignee: null,
              description: null,
              comments: { nodes: [] },
            },
          },
        });
      }
      expect(body.query).toContain('mutation CommentCreate');
      return jsonResponse({
        data: {
          commentCreate: {
            success: true,
            comment: { id: 'comment-1' },
          },
        },
      });
    }));

    const app = createApp();
    const missing = await request(app).post('/api/linear/session-status').send({
      kind: 'started',
    }).expect(400);
    expect(missing.body.error).toBe('kind and sessionId are required');

    const posted = await request(app).post('/api/linear/session-status').send({
      kind: 'started',
      sessionId: 'ses_1',
      issueIdentifier: 'ENG-12',
      sessionOrigin: 'https://app.example.com',
    }).expect(200);
    expect(posted.body).toEqual({
      connected: true,
      posted: true,
      commentId: 'comment-1',
    });
    expect(JSON.stringify(posted.body)).not.toContain('access-1');
  });

  it('reads and writes the session-comment preference', async () => {
    const app = createApp();
    const initial = await request(app).get('/api/linear/preferences').expect(200);
    expect(initial.body).toEqual({ sessionComments: false });

    const invalid = await request(app).put('/api/linear/preferences').send({ sessionComments: 'yes' }).expect(400);
    expect(invalid.body.error).toBe('sessionComments must be a boolean');

    const enabled = await request(app).put('/api/linear/preferences').send({ sessionComments: true }).expect(200);
    expect(enabled.body).toEqual({ sessionComments: true });
    const reread = await request(app).get('/api/linear/preferences').expect(200);
    expect(reread.body).toEqual({ sessionComments: true });
  });

  it('returns disconnected session-status when Linear is not connected', async () => {
    const app = createApp();
    const response = await request(app).post('/api/linear/session-status').send({
      kind: 'started',
      sessionId: 'ses_1',
      issueIdentifier: 'ENG-12',
    }).expect(200);
    expect(response.body).toEqual({ connected: false });
  });
});
