import { describe, it, expect, vi } from 'vitest';
import { createJiraClient, summarizeJiraUser, JiraApiError } from './client.js';

const cloudConnection = {
  deployment: 'cloud',
  baseUrl: 'https://acme.atlassian.net',
  email: 'dev@acme.example',
  apiToken: 'cloud-token',
};

const serverConnection = {
  deployment: 'server',
  baseUrl: 'https://jira.corp.example/jira',
  apiToken: 'server-pat',
};

const jsonResponse = (data, { status = 200 } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(data),
});

describe('createJiraClient auth and URLs', () => {
  it('uses Basic email:token auth for cloud against /rest/api/2', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ accountId: 'a1' }));
    await createJiraClient(cloudConnection, { fetchImpl }).getMyself();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://acme.atlassian.net/rest/api/2/myself');
    const expected = `Basic ${Buffer.from('dev@acme.example:cloud-token').toString('base64')}`;
    expect(init.headers.authorization).toBe(expected);
  });

  it('uses Bearer PAT auth for server and preserves the context path', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ name: 'dev' }));
    await createJiraClient(serverConnection, { fetchImpl }).getMyself();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://jira.corp.example/jira/rest/api/2/myself');
    expect(init.headers.authorization).toBe('Bearer server-pat');
  });

  it('throws not_connected without credentials', () => {
    expect(() => createJiraClient(null)).toThrow(JiraApiError);
  });
});

describe('createJiraClient error mapping', () => {
  const clientWithStatus = (status, body) => createJiraClient(cloudConnection, {
    fetchImpl: vi.fn(async () => jsonResponse(body ?? {}, { status })),
  });

  it('maps 401/403/404 to explicit codes', async () => {
    await expect(clientWithStatus(401).getMyself()).rejects.toMatchObject({ code: 'auth_invalid', status: 401 });
    await expect(clientWithStatus(403).getMyself()).rejects.toMatchObject({ code: 'permission_denied', status: 403 });
    await expect(clientWithStatus(404).getIssue('ABC-1')).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('surfaces Jira errorMessages and field errors', async () => {
    const client = clientWithStatus(400, {
      errorMessages: ['Issue does not exist'],
      errors: { labels: 'Field labels is required' },
    });
    await expect(client.getIssue('ABC-1')).rejects.toThrow(/Issue does not exist.*labels: Field labels is required/);
  });

  it('treats redirects as auth failures instead of following into HTML', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 302, text: async () => '' }));
    await expect(createJiraClient(serverConnection, { fetchImpl }).getMyself())
      .rejects.toMatchObject({ code: 'auth_invalid' });
  });

  it('wraps network failures as network_error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    await expect(createJiraClient(cloudConnection, { fetchImpl }).getMyself())
      .rejects.toMatchObject({ code: 'network_error' });
  });
});

describe('createJiraClient issue operations', () => {
  it('posts comments as plain v2 string bodies', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: '1' }));
    await createJiraClient(cloudConnection, { fetchImpl }).addComment('ABC-1', 'hello');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://acme.atlassian.net/rest/api/2/issue/ABC-1/comment');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ body: 'hello' });
  });

  it('creates remote links with a stable globalId', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 1 }));
    await createJiraClient(cloudConnection, { fetchImpl }).createRemoteLink('ABC-1', {
      globalId: 'openchamber-session-ses_1',
      url: 'https://chamber.example/?session=ses_1',
      title: 'OpenChamber session',
    });
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.globalId).toBe('openchamber-session-ses_1');
    expect(body.object.url).toBe('https://chamber.example/?session=ses_1');
  });

  it('removes labels through an issue update', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 204, text: async () => '' }));
    await createJiraClient(cloudConnection, { fetchImpl }).removeLabel('ABC-1', 'openchamber');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://acme.atlassian.net/rest/api/2/issue/ABC-1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ update: { labels: [{ remove: 'openchamber' }] } });
  });
});

describe('createJiraClient search deployment difference', () => {
  it('uses /search/jql on cloud', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ issues: [{ key: 'ABC-1' }] }));
    const issues = await createJiraClient(cloudConnection, { fetchImpl }).searchIssues('labels = "x"');
    expect(fetchImpl.mock.calls[0][0]).toContain('/rest/api/2/search/jql?');
    expect(issues).toEqual([{ key: 'ABC-1' }]);
  });

  it('uses classic /search on server/data center', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ issues: [] }));
    await createJiraClient(serverConnection, { fetchImpl }).searchIssues('labels = "x"');
    const url = fetchImpl.mock.calls[0][0];
    expect(url).toContain('/rest/api/2/search?');
    expect(url).not.toContain('/search/jql');
  });
});

describe('summarizeJiraUser', () => {
  it('summarizes a cloud user by accountId', () => {
    expect(summarizeJiraUser({
      accountId: 'a1',
      displayName: 'Dev',
      emailAddress: 'dev@acme.example',
      avatarUrls: { '48x48': 'https://avatar.example/a.png' },
    })).toEqual({
      accountId: 'a1',
      displayName: 'Dev',
      emailAddress: 'dev@acme.example',
      avatarUrl: 'https://avatar.example/a.png',
    });
  });

  it('falls back to the server username when accountId is absent', () => {
    expect(summarizeJiraUser({ name: 'dev', displayName: 'Dev' })).toMatchObject({ accountId: 'dev' });
  });

  it('returns null for junk payloads', () => {
    expect(summarizeJiraUser(null)).toBeNull();
    expect(summarizeJiraUser('nope')).toBeNull();
  });
});
