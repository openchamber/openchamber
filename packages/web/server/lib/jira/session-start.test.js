import { describe, it, expect, vi } from 'vitest';
import { createJiraSessionStarter, normalizeJiraIssueKey, buildSessionWebUrl } from './session-start.js';
import { JiraApiError } from './client.js';

const connection = {
  deployment: 'cloud',
  baseUrl: 'https://acme.atlassian.net',
  email: 'dev@acme.example',
  apiToken: 'token',
};

const issuePayload = {
  key: 'ABC-42',
  fields: {
    summary: 'Fix the login flow',
    description: 'Broken on Safari',
    project: { key: 'ABC', name: 'Acme' },
  },
};

const defaultConfig = {
  projectMappings: [{ projectKey: 'ABC', directory: '/repo/acme' }],
  defaultDirectory: null,
  appBaseUrl: 'https://chamber.corp.example',
  updates: { started: true, completed: true, failed: true, attention: true },
  issueListener: { enabled: false, triggerLabel: 'openchamber', removeTriggerLabel: true, intervalMs: 60_000 },
};

function setup(overrides = {}) {
  const client = {
    getIssue: vi.fn(async () => issuePayload),
    createRemoteLink: vi.fn(async () => ({})),
    addComment: vi.fn(async () => ({})),
    ...overrides.client,
  };
  const sessionService = {
    create: vi.fn(async (payload) => ({
      sessionId: 'ses_new',
      directory: payload.directory,
      promptDispatched: true,
    })),
    ...overrides.sessionService,
  };
  const statusUpdates = { watchSession: vi.fn(() => true) };
  const recordLink = vi.fn();
  const starter = createJiraSessionStarter({
    sessionService,
    statusUpdates,
    getConnection: overrides.getConnection || (() => connection),
    getConfig: overrides.getConfig || (() => defaultConfig),
    createClient: () => client,
    recordLink,
  });
  return { starter, client, sessionService, statusUpdates, recordLink };
}

describe('startSessionFromIssue', () => {
  it('creates a session with issue context, links it back, and arms updates', async () => {
    const { starter, client, sessionService, statusUpdates, recordLink } = setup();
    const result = await starter.startSessionFromIssue({ issueKey: 'abc-42' });

    expect(client.getIssue).toHaveBeenCalledWith('ABC-42');
    const createPayload = sessionService.create.mock.calls[0][0];
    expect(createPayload.directory).toBe('/repo/acme');
    expect(createPayload.title).toBe('ABC-42: Fix the login flow');
    expect(createPayload.prompt).toContain('Broken on Safari');

    expect(recordLink).toHaveBeenCalledWith(expect.objectContaining({
      issueKey: 'ABC-42',
      sessionId: 'ses_new',
      directory: '/repo/acme',
      source: 'api',
    }));
    expect(client.createRemoteLink).toHaveBeenCalledWith('ABC-42', expect.objectContaining({
      globalId: 'openchamber-session-ses_new',
      url: 'https://chamber.corp.example/?session=ses_new',
    }));
    expect(client.addComment).toHaveBeenCalledTimes(1);
    expect(client.addComment.mock.calls[0][1]).toContain('https://chamber.corp.example/?session=ses_new');
    expect(statusUpdates.watchSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'ses_new',
      issueKey: 'ABC-42',
    }));

    expect(result).toMatchObject({
      sessionId: 'ses_new',
      directory: '/repo/acme',
      sessionUrl: 'https://chamber.corp.example/?session=ses_new',
      promptDispatched: true,
      issue: { key: 'ABC-42', projectKey: 'ABC' },
      linkage: { recorded: true, remoteLinkCreated: true, commentPosted: true, errors: [] },
    });
  });

  it('fails explicitly when Jira is not connected', async () => {
    const { starter } = setup({ getConnection: () => null });
    await expect(starter.startSessionFromIssue({ issueKey: 'ABC-1' }))
      .rejects.toMatchObject({ code: 'not_connected' });
  });

  it('rejects invalid issue keys before touching Jira', async () => {
    const { starter, client } = setup();
    await expect(starter.startSessionFromIssue({ issueKey: 'not a key' }))
      .rejects.toMatchObject({ code: 'invalid_issue_key' });
    expect(client.getIssue).not.toHaveBeenCalled();
  });

  it('explains permission/private-project failures on issue fetch', async () => {
    const { starter } = setup({
      client: {
        getIssue: vi.fn(async () => {
          throw new JiraApiError('Issue does not exist', { status: 404, code: 'not_found' });
        }),
      },
    });
    await expect(starter.startSessionFromIssue({ issueKey: 'ABC-9' }))
      .rejects.toThrow(/issue permissions, and private project access/);
  });

  it('fails explicitly when no project mapping applies', async () => {
    const { starter, sessionService } = setup({
      getConfig: () => ({ ...defaultConfig, projectMappings: [], defaultDirectory: null }),
    });
    await expect(starter.startSessionFromIssue({ issueKey: 'ABC-42' }))
      .rejects.toMatchObject({ code: 'no_project_mapping' });
    expect(sessionService.create).not.toHaveBeenCalled();
  });

  it('lets an explicit directory override the mapping', async () => {
    const { starter, sessionService } = setup();
    await starter.startSessionFromIssue({ issueKey: 'ABC-42', directory: '/repo/other' });
    expect(sessionService.create.mock.calls[0][0].directory).toBe('/repo/other');
  });

  it('propagates session creation failures without posting to Jira', async () => {
    const failure = Object.assign(new Error('Invalid directory'), { statusCode: 400 });
    const { starter, client } = setup({
      sessionService: { create: vi.fn(async () => { throw failure; }) },
    });
    await expect(starter.startSessionFromIssue({ issueKey: 'ABC-42' })).rejects.toThrow('Invalid directory');
    expect(client.createRemoteLink).not.toHaveBeenCalled();
    expect(client.addComment).not.toHaveBeenCalled();
  });

  it('reports Jira-side linkage failures without failing the session', async () => {
    const { starter } = setup({
      client: {
        getIssue: vi.fn(async () => issuePayload),
        createRemoteLink: vi.fn(async () => {
          throw new JiraApiError('forbidden', { status: 403, code: 'permission_denied' });
        }),
        addComment: vi.fn(async () => {
          throw new JiraApiError('forbidden', { status: 403, code: 'permission_denied' });
        }),
      },
    });
    const result = await starter.startSessionFromIssue({ issueKey: 'ABC-42' });
    expect(result.sessionId).toBe('ses_new');
    expect(result.linkage.remoteLinkCreated).toBe(false);
    expect(result.linkage.commentPosted).toBe(false);
    expect(result.linkage.errors.length).toBe(2);
  });

  it('falls back to the request origin when no app base URL is configured', async () => {
    const { starter, client } = setup({
      getConfig: () => ({ ...defaultConfig, appBaseUrl: null }),
    });
    const result = await starter.startSessionFromIssue({
      issueKey: 'ABC-42',
      requestOrigin: 'http://localhost:3001',
    });
    expect(result.sessionUrl).toBe('http://localhost:3001/?session=ses_new');
    expect(client.createRemoteLink).toHaveBeenCalled();
  });

  it('reports the missing base URL explicitly when no link can be built', async () => {
    const { starter, client } = setup({
      getConfig: () => ({ ...defaultConfig, appBaseUrl: null }),
    });
    const result = await starter.startSessionFromIssue({ issueKey: 'ABC-42' });
    expect(result.sessionUrl).toBeNull();
    expect(client.createRemoteLink).not.toHaveBeenCalled();
    expect(result.linkage.errors.some((e) => /base URL/.test(e))).toBe(true);
    // The started comment still goes out with the session id.
    expect(client.addComment.mock.calls[0][1]).toContain('ses_new');
  });

  it('skips the started comment when updates.started is disabled', async () => {
    const { starter, client } = setup({
      getConfig: () => ({ ...defaultConfig, updates: { ...defaultConfig.updates, started: false } }),
    });
    await starter.startSessionFromIssue({ issueKey: 'ABC-42' });
    expect(client.addComment).not.toHaveBeenCalled();
  });

  it('does not watch sessions whose prompt never landed', async () => {
    const { starter, statusUpdates } = setup({
      sessionService: {
        create: vi.fn(async (payload) => ({
          sessionId: 'ses_new',
          directory: payload.directory,
          promptDispatched: false,
          promptError: 'prompt vanished',
        })),
      },
    });
    const result = await starter.startSessionFromIssue({ issueKey: 'ABC-42' });
    expect(result.promptDispatched).toBe(false);
    expect(result.promptError).toBe('prompt vanished');
    expect(statusUpdates.watchSession).not.toHaveBeenCalled();
  });
});

describe('normalizeJiraIssueKey', () => {
  it('normalizes and validates issue keys', () => {
    expect(normalizeJiraIssueKey(' abc-12 ')).toBe('ABC-12');
    expect(normalizeJiraIssueKey('A1_B-3')).toBe('A1_B-3');
    expect(normalizeJiraIssueKey('ABC')).toBeNull();
    expect(normalizeJiraIssueKey('1AB-2')).toBeNull();
    expect(normalizeJiraIssueKey(undefined)).toBeNull();
  });
});

describe('buildSessionWebUrl', () => {
  it('builds the ?session deep link and requires both parts', () => {
    expect(buildSessionWebUrl('https://x.example', 'ses_1')).toBe('https://x.example/?session=ses_1');
    expect(buildSessionWebUrl(null, 'ses_1')).toBeNull();
    expect(buildSessionWebUrl('https://x.example', null)).toBeNull();
  });
});
