import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.OPENCHAMBER_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), `openchamber-jira-routes-${crypto.randomBytes(4).toString('hex')}-`),
);

const { registerJiraRoutes } = await import('./routes.js');
const { clearJiraConnection, setJiraConnection } = await import('./auth.js');
const { JIRA_CONFIG_FILE } = await import('./config.js');
const { JIRA_LINKS_FILE, recordJiraSessionLink } = await import('./links.js');
const { JiraApiError } = await import('./client.js');

function createApp({ sessionStarter } = {}) {
  const app = express();
  registerJiraRoutes(app, { sessionStarter });
  return app;
}

const jsonResponse = (data, { status = 200 } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(data),
});

let originalFetch;
function stubFetch(handler) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(handler);
}

beforeEach(() => {
  clearJiraConnection();
  for (const file of [JIRA_CONFIG_FILE, JIRA_LINKS_FILE]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = undefined;
  vi.restoreAllMocks();
});

describe('GET /api/jira/status', () => {
  it('reports disconnected with default config and never leaks the token', async () => {
    const res = await request(createApp()).get('/api/jira/status');
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
    expect(res.body.connection).toBeNull();
    expect(res.body.config.issueListener.enabled).toBe(false);
  });

  it('reports the stored connection without credentials', async () => {
    setJiraConnection({
      deployment: 'cloud',
      baseUrl: 'https://acme.atlassian.net',
      email: 'dev@acme.example',
      apiToken: 'super-secret',
      user: { accountId: 'a1', displayName: 'Dev' },
    });
    const res = await request(createApp()).get('/api/jira/status');
    expect(res.body.connected).toBe(true);
    expect(res.body.connection.baseUrl).toBe('https://acme.atlassian.net');
    expect(JSON.stringify(res.body)).not.toContain('super-secret');
  });
});

describe('POST /api/jira/connect', () => {
  it('validates credentials against /myself before storing', async () => {
    stubFetch(async (url) => {
      if (String(url).includes('/rest/api/2/myself')) {
        return jsonResponse({ accountId: 'a1', displayName: 'Dev', emailAddress: 'dev@acme.example' });
      }
      throw new Error(`unexpected ${url}`);
    });
    const res = await request(createApp())
      .post('/api/jira/connect')
      .send({ deployment: 'cloud', baseUrl: 'acme.atlassian.net', email: 'dev@acme.example', apiToken: 'tok' });
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.connection.user.displayName).toBe('Dev');

    const status = await request(createApp()).get('/api/jira/status');
    expect(status.body.connected).toBe(true);
  });

  it('rejects bad credentials without storing them', async () => {
    stubFetch(async () => jsonResponse({ errorMessages: ['Unauthorized'] }, { status: 401 }));
    const res = await request(createApp())
      .post('/api/jira/connect')
      .send({ deployment: 'cloud', baseUrl: 'acme.atlassian.net', email: 'dev@acme.example', apiToken: 'bad' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('auth_invalid');

    const status = await request(createApp()).get('/api/jira/status');
    expect(status.body.connected).toBe(false);
  });

  it('requires an email for cloud and a token always', async () => {
    const noEmail = await request(createApp())
      .post('/api/jira/connect')
      .send({ deployment: 'cloud', baseUrl: 'acme.atlassian.net', apiToken: 'tok' });
    expect(noEmail.status).toBe(400);
    expect(noEmail.body.code).toBe('missing_credentials');

    const noToken = await request(createApp())
      .post('/api/jira/connect')
      .send({ deployment: 'server', baseUrl: 'jira.corp.example' });
    expect(noToken.status).toBe(400);

    const badUrl = await request(createApp())
      .post('/api/jira/connect')
      .send({ deployment: 'server', baseUrl: 'ftp://x', apiToken: 'tok' });
    expect(badUrl.status).toBe(400);
    expect(badUrl.body.code).toBe('invalid_base_url');
  });
});

describe('DELETE /api/jira/auth', () => {
  it('disconnects', async () => {
    setJiraConnection({ deployment: 'server', baseUrl: 'https://jira.corp.example', apiToken: 'pat' });
    const res = await request(createApp()).delete('/api/jira/auth');
    expect(res.status).toBe(200);
    const status = await request(createApp()).get('/api/jira/status');
    expect(status.body.connected).toBe(false);
  });
});

describe('PUT /api/jira/config', () => {
  it('persists partial updates', async () => {
    const res = await request(createApp())
      .put('/api/jira/config')
      .send({ projectMappings: [{ projectKey: 'abc', directory: '/repo' }], issueListener: { enabled: true } });
    expect(res.status).toBe(200);
    expect(res.body.config.projectMappings).toEqual([{ projectKey: 'ABC', directory: '/repo' }]);
    expect(res.body.config.issueListener.enabled).toBe(true);
  });
});

describe('GET /api/jira/issue', () => {
  it('requires a connection and a valid key', async () => {
    const badKey = await request(createApp()).get('/api/jira/issue?key=nope');
    expect(badKey.status).toBe(400);
    expect(badKey.body.code).toBe('invalid_issue_key');

    const noConnection = await request(createApp()).get('/api/jira/issue?key=ABC-1');
    expect(noConnection.status).toBe(400);
    expect(noConnection.body.code).toBe('not_connected');
  });

  it('returns an issue preview', async () => {
    setJiraConnection({ deployment: 'server', baseUrl: 'https://jira.corp.example', apiToken: 'pat' });
    stubFetch(async () => jsonResponse({
      key: 'ABC-1',
      fields: {
        summary: 'Fix it',
        status: { name: 'To Do' },
        issuetype: { name: 'Bug' },
        project: { key: 'ABC', name: 'Acme' },
      },
    }));
    const res = await request(createApp()).get('/api/jira/issue?key=abc-1');
    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({
      key: 'ABC-1',
      summary: 'Fix it',
      status: 'To Do',
      projectKey: 'ABC',
      url: 'https://jira.corp.example/browse/ABC-1',
    });
  });

  it('maps permission-hidden issues to an explicit 404', async () => {
    setJiraConnection({ deployment: 'server', baseUrl: 'https://jira.corp.example', apiToken: 'pat' });
    stubFetch(async () => jsonResponse({ errorMessages: ['Issue does not exist'] }, { status: 404 }));
    const res = await request(createApp()).get('/api/jira/issue?key=ABC-1');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });
});

describe('POST /api/jira/sessions', () => {
  it('delegates to the session starter with the request origin', async () => {
    const sessionStarter = {
      startSessionFromIssue: vi.fn(async () => ({ sessionId: 'ses_1', promptDispatched: true })),
    };
    const res = await request(createApp({ sessionStarter }))
      .post('/api/jira/sessions')
      .set('Host', 'chamber.example')
      .send({ issueKey: 'ABC-1', agent: 'build' });
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe('ses_1');
    expect(sessionStarter.startSessionFromIssue).toHaveBeenCalledWith(expect.objectContaining({
      issueKey: 'ABC-1',
      agent: 'build',
      requestOrigin: 'http://chamber.example',
      source: 'api',
    }));
  });

  it('maps starter failures to explicit statuses', async () => {
    const sessionStarter = {
      startSessionFromIssue: vi.fn(async () => {
        throw new JiraApiError('No OpenChamber project is mapped', { status: 400, code: 'no_project_mapping' });
      }),
    };
    const res = await request(createApp({ sessionStarter }))
      .post('/api/jira/sessions')
      .send({ issueKey: 'ABC-1' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('no_project_mapping');
  });
});

describe('GET /api/jira/links', () => {
  it('filters links by session and issue', async () => {
    recordJiraSessionLink({ issueKey: 'ABC-1', sessionId: 'ses_1', source: 'api' });
    recordJiraSessionLink({ issueKey: 'ABC-2', sessionId: 'ses_2', source: 'listener' });

    const all = await request(createApp()).get('/api/jira/links');
    expect(all.body.links).toHaveLength(2);

    const bySession = await request(createApp()).get('/api/jira/links?sessionId=ses_1');
    expect(bySession.body.links).toHaveLength(1);
    expect(bySession.body.links[0].issueKey).toBe('ABC-1');

    const byIssue = await request(createApp()).get('/api/jira/links?issueKey=abc-2');
    expect(byIssue.body.links).toHaveLength(1);
    expect(byIssue.body.links[0].sessionId).toBe('ses_2');
  });
});
