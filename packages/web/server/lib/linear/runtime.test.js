import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLinearIntegrationRuntime, formatSessionErrorForComment } from './runtime.js';
import { LinearIntegrationStore } from './store.js';
import { LinearLinkStore } from './link-store.js';

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-runtime-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const ISSUE = {
  id: 'issue-1',
  identifier: 'ENG-42',
  title: 'Fix login',
  url: 'https://linear.app/acme/issue/ENG-42/fix-login',
  team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
};

let harnessCounter = 0;

function createHarness({
  settings = {},
  connected = true,
  issue = ISSUE,
  sessionCreate,
  commentFails = false,
  attachmentFails = false,
} = {}) {
  // Unique files per harness — one test may build several isolated harnesses.
  harnessCounter += 1;
  const store = new LinearIntegrationStore({
    filePath: path.join(tmpDir, `integration-${harnessCounter}.json`),
  });
  if (connected) {
    store.setAuth({ apiKey: 'lin_api_secret', viewer: { id: 'u1', name: 'Ada' } });
  }
  store.updateSettings({ defaultProjectId: 'proj-1', ...settings });
  const linkStore = new LinearLinkStore({
    filePath: path.join(tmpDir, `links-${harnessCounter}.json`),
  });

  const client = {
    fetchViewer: vi.fn(async () => ({ viewer: { id: 'u1', name: 'Ada' }, organization: null })),
    listTeams: vi.fn(async () => [{ id: 'team-1', key: 'ENG', name: 'Engineering' }]),
    fetchIssue: vi.fn(async () => issue),
    listTriggerIssues: vi.fn(async () => []),
    createComment: vi.fn(async () => {
      if (commentFails) throw new Error('comment boom');
      return { id: 'c1' };
    }),
    createAttachment: vi.fn(async () => {
      if (attachmentFails) throw new Error('attachment boom');
      return { id: 'a1' };
    }),
  };

  const sessionService = {
    create:
      sessionCreate ??
      vi.fn(async () => ({ sessionId: 'ses_abc', directory: '/repo', promptDispatched: true })),
  };

  const runtime = createLinearIntegrationRuntime({
    store,
    linkStore,
    client,
    sessionService,
    getAppBaseUrl: () => 'http://127.0.0.1:9384',
    logger: { log: () => {}, warn: () => {} },
  });

  return { runtime, store, linkStore, client, sessionService };
}

describe('startSessionFromIssue', () => {
  it('creates a session with issue context and links back to the issue', async () => {
    const { runtime, linkStore, client, sessionService } = createHarness();
    const result = await runtime.startSessionFromIssue({ issue: 'ENG-42' });

    expect(sessionService.create).toHaveBeenCalledWith({
      projectId: 'proj-1',
      title: 'ENG-42: Fix login',
      prompt: expect.stringContaining('Linear issue ENG-42: Fix login'),
    });
    expect(result.sessionId).toBe('ses_abc');
    expect(result.sessionUrl).toBe('http://127.0.0.1:9384/?session=ses_abc');
    expect(result.linkback).toEqual({ attached: true, commented: true, error: null });

    expect(client.createAttachment).toHaveBeenCalledWith({
      issueId: 'issue-1',
      title: 'OpenChamber session',
      subtitle: 'ENG-42: Fix login',
      url: 'http://127.0.0.1:9384/?session=ses_abc',
    });
    expect(client.createComment).toHaveBeenCalledWith({
      issueId: 'issue-1',
      body: expect.stringContaining('http://127.0.0.1:9384/?session=ses_abc'),
    });
    expect(linkStore.getByIssueId('issue-1')?.sessionId).toBe('ses_abc');
  });

  it('prefers a team mapping over the default project', async () => {
    const { runtime, sessionService } = createHarness({
      settings: {
        teamMappings: [{ teamId: 'team-1', teamKey: 'ENG', projectId: 'proj-eng' }],
      },
    });
    await runtime.startSessionFromIssue({ issue: 'ENG-42' });
    expect(sessionService.create).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-eng' }),
    );
  });

  it('rejects when no project is mapped', async () => {
    const { runtime, sessionService } = createHarness({ settings: { defaultProjectId: null } });
    await expect(runtime.startSessionFromIssue({ issue: 'ENG-42' })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(sessionService.create).not.toHaveBeenCalled();
  });

  it('rejects an already linked issue with 409', async () => {
    const { runtime } = createHarness();
    await runtime.startSessionFromIssue({ issue: 'ENG-42' });
    await expect(runtime.startSessionFromIssue({ issue: 'ENG-42' })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('keeps the local link and reports partial linkback when Linear posting fails', async () => {
    const { runtime, linkStore } = createHarness({ attachmentFails: true, commentFails: true });
    const result = await runtime.startSessionFromIssue({ issue: 'ENG-42' });
    expect(result.linkback.attached).toBe(false);
    expect(result.linkback.commented).toBe(false);
    expect(result.linkback.error).toContain('boom');
    expect(linkStore.getByIssueId('issue-1')?.sessionId).toBe('ses_abc');
  });

  it('skips the start comment when status updates are disabled', async () => {
    const { runtime, client } = createHarness({ settings: { postStatusUpdates: false } });
    const result = await runtime.startSessionFromIssue({ issue: 'ENG-42' });
    expect(client.createAttachment).toHaveBeenCalled();
    expect(client.createComment).not.toHaveBeenCalled();
    expect(result.linkback.commented).toBe(false);
  });

  it('rejects malformed issue references', async () => {
    const { runtime, client } = createHarness();
    await expect(runtime.startSessionFromIssue({ issue: 'garbage input' })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(client.fetchIssue).not.toHaveBeenCalled();
  });
});

describe('lifecycle status comments', () => {
  async function startLinked(overrides = {}) {
    const harness = createHarness(overrides);
    await harness.runtime.startSessionFromIssue({ issue: 'ENG-42' });
    harness.client.createComment.mockClear();
    return harness;
  }

  it('posts a completion comment on session.idle, once per transition', async () => {
    const { runtime, client } = await startLinked();
    await runtime._handleGlobalEvent({
      payload: { type: 'session.idle', properties: { sessionID: 'ses_abc' } },
    });
    await runtime._handleGlobalEvent({
      payload: { type: 'session.idle', properties: { sessionID: 'ses_abc' } },
    });
    expect(client.createComment).toHaveBeenCalledTimes(1);
    expect(client.createComment.mock.calls[0][0].body).toContain('finished a run');
  });

  it('posts a failure comment with the error text on session.error', async () => {
    const { runtime, client } = await startLinked();
    await runtime._handleGlobalEvent({
      payload: {
        type: 'session.error',
        properties: { sessionID: 'ses_abc', error: { data: { message: 'model exploded' } } },
      },
    });
    expect(client.createComment).toHaveBeenCalledTimes(1);
    expect(client.createComment.mock.calls[0][0].body).toContain('model exploded');
  });

  it('posts an attention comment when a permission is requested', async () => {
    const { runtime, client } = await startLinked();
    await runtime._handleGlobalEvent({
      payload: { type: 'permission.asked', properties: { sessionID: 'ses_abc' } },
    });
    expect(client.createComment).toHaveBeenCalledTimes(1);
    expect(client.createComment.mock.calls[0][0].body).toContain('needs your attention');
  });

  it('ignores events for sessions without a link', async () => {
    const { runtime, client } = await startLinked();
    await runtime._handleGlobalEvent({
      payload: { type: 'session.idle', properties: { sessionID: 'ses_other' } },
    });
    expect(client.createComment).not.toHaveBeenCalled();
  });

  it('stays silent when status updates are disabled', async () => {
    const { runtime, client } = await startLinked({ settings: { postStatusUpdates: false } });
    await runtime._handleGlobalEvent({
      payload: { type: 'session.idle', properties: { sessionID: 'ses_abc' } },
    });
    expect(client.createComment).not.toHaveBeenCalled();
  });
});

describe('pollOnce', () => {
  it('starts sessions for new trigger-labeled issues and skips linked ones', async () => {
    const { runtime, client, sessionService } = createHarness({
      settings: { autoStartEnabled: true },
    });
    client.listTriggerIssues.mockResolvedValue([ISSUE]);

    const first = await runtime.pollOnce();
    expect(first.started).toHaveLength(1);
    expect(client.listTriggerIssues).toHaveBeenCalledWith({ label: 'openchamber' });
    expect(sessionService.create).toHaveBeenCalledTimes(1);

    // Second sweep sees the same issue — already linked, nothing starts.
    const second = await runtime.pollOnce();
    expect(second.started).toHaveLength(0);
    expect(sessionService.create).toHaveBeenCalledTimes(1);
  });

  it('does nothing when auto-start is disabled or disconnected', async () => {
    const { runtime, client } = createHarness({ settings: { autoStartEnabled: false } });
    await runtime.pollOnce();
    expect(client.listTriggerIssues).not.toHaveBeenCalled();

    const disconnected = createHarness({ connected: false, settings: { autoStartEnabled: true } });
    await disconnected.runtime.pollOnce();
    expect(disconnected.client.listTriggerIssues).not.toHaveBeenCalled();
  });

  it('accepts API-provided issue ids that the user-input parser would reject', async () => {
    // Ids returned by the Linear API are trusted verbatim; only pasted user
    // input goes through reference-shape parsing.
    const oddIdIssue = { ...ISSUE, id: 'not_a_uuid_or_identifier' };
    const { runtime, client, sessionService } = createHarness({
      settings: { autoStartEnabled: true },
      issue: oddIdIssue,
    });
    client.listTriggerIssues.mockResolvedValue([oddIdIssue]);
    const result = await runtime.pollOnce();
    expect(result.started).toHaveLength(1);
    expect(client.fetchIssue).toHaveBeenCalledWith('not_a_uuid_or_identifier');
    expect(sessionService.create).toHaveBeenCalledTimes(1);
  });

  it('one failed issue does not block the others', async () => {
    const issueB = { ...ISSUE, id: 'issue-2', identifier: 'ENG-43' };
    const { runtime, client, sessionService } = createHarness({
      settings: { autoStartEnabled: true },
    });
    client.listTriggerIssues.mockResolvedValue([ISSUE, issueB]);
    client.fetchIssue.mockImplementation(async (ref) => {
      if (ref === 'issue-1') throw new Error('linear hiccup');
      return issueB;
    });

    const result = await runtime.pollOnce();
    expect(result.started).toHaveLength(1);
    expect(result.started[0].issue.id).toBe('issue-2');
    expect(sessionService.create).toHaveBeenCalledTimes(1);
  });
});

describe('connect / disconnect', () => {
  it('validates the key before persisting and never returns it', async () => {
    const { runtime, store, client } = createHarness({ connected: false });
    const status = await runtime.connect({ apiKey: 'lin_api_new' });
    expect(client.fetchViewer).toHaveBeenCalledWith({ apiKeyOverride: 'lin_api_new' });
    expect(store.getApiKey()).toBe('lin_api_new');
    expect(status.connected).toBe(true);
    expect(JSON.stringify(status)).not.toContain('lin_api_new');
  });

  it('keeps the previous key when validation fails', async () => {
    const { runtime, store, client } = createHarness();
    client.fetchViewer.mockRejectedValue(new Error('bad key'));
    await expect(runtime.connect({ apiKey: 'lin_api_bad' })).rejects.toThrow('bad key');
    expect(store.getApiKey()).toBe('lin_api_secret');
  });

  it('disconnect clears auth', async () => {
    const { runtime, store } = createHarness();
    const status = runtime.disconnect();
    expect(status.connected).toBe(false);
    expect(store.getApiKey()).toBeNull();
  });
});

describe('formatSessionErrorForComment', () => {
  it('extracts nested error messages', () => {
    expect(
      formatSessionErrorForComment({ error: { data: { message: 'provider timeout' } } }),
    ).toBe('provider timeout');
    expect(formatSessionErrorForComment({ message: 'plain' })).toBe('plain');
  });

  it('clips long messages and falls back to a generic line', () => {
    expect(formatSessionErrorForComment({ message: 'x'.repeat(400) }).length).toBeLessThanOrEqual(
      281,
    );
    expect(formatSessionErrorForComment({})).toBe('OpenCode session error');
  });
});
