import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setLinearAuth, clearLinearAuth, setLinearSessionCommentsEnabled } from './auth.js';
import { createLinearSessionStatusRuntime } from './status-runtime.js';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-linear-status-runtime-'));

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const issueNode = {
  id: 'issue-uuid-1',
  identifier: 'ENG-12',
  title: 'Broken login',
  url: 'https://linear.app/openchamber/issue/ENG-12',
  state: { name: 'In Progress', type: 'started' },
  assignee: null,
  team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
  description: null,
  comments: { nodes: [] },
};

function stubLinearGraphql({ commentId = 'comment-1' } = {}) {
  return vi.fn(async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.query.includes('query GetLinearIssue')) {
      return jsonResponse({ data: { issue: issueNode } });
    }
    if (body.query.includes('mutation CommentCreate')) {
      return jsonResponse({
        data: {
          commentCreate: {
            success: true,
            comment: { id: commentId },
          },
        },
      });
    }
    throw new Error(`unexpected query: ${body.query}`);
  });
}

describe('Linear session status runtime', () => {
  let dataDir;
  let previousDataDir;
  let previousPort;

  beforeEach(() => {
    previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    previousPort = process.env.OPENCHAMBER_PORT;
    dataDir = makeTempDir();
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    process.env.OPENCHAMBER_PORT = '3001';
    setLinearAuth({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 86_400_000,
      scope: 'read,write,comments:create',
    });
    setLinearSessionCommentsEnabled(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearLinearAuth();
    if (previousDataDir === undefined) {
      delete process.env.OPENCHAMBER_DATA_DIR;
    } else {
      process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    }
    if (previousPort === undefined) {
      delete process.env.OPENCHAMBER_PORT;
    } else {
      process.env.OPENCHAMBER_PORT = previousPort;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('posts completed on the first idle after started, then ignores later idles', async () => {
    const { postLinearSessionStatus } = await import('./status.js');
    vi.stubGlobal('fetch', stubLinearGraphql({ commentId: 'started' }));
    await postLinearSessionStatus({
      kind: 'started',
      sessionId: 'ses_1',
      issueIdentifier: 'ENG-12',
      sessionOrigin: 'https://app.example.com',
    });

    const graphql = stubLinearGraphql({ commentId: 'done' });
    vi.stubGlobal('fetch', graphql);
    const runtime = createLinearSessionStatusRuntime();
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'idle' } },
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'idle' } },
    });
    await vi.waitFor(() => {
      const commentCalls = graphql.mock.calls.filter(([, options]) => {
        return JSON.parse(options.body).query.includes('mutation CommentCreate');
      });
      expect(commentCalls).toHaveLength(1);
    });
    runtime.stop();
  });

  it('posts failure on session.error and skips user abort', async () => {
    const { postLinearSessionStatus } = await import('./status.js');
    vi.stubGlobal('fetch', stubLinearGraphql({ commentId: 'started' }));
    await postLinearSessionStatus({
      kind: 'started',
      sessionId: 'ses_1',
      issueIdentifier: 'ENG-12',
      sessionOrigin: 'https://app.example.com',
    });

    const graphql = stubLinearGraphql({ commentId: 'fail' });
    vi.stubGlobal('fetch', graphql);
    const runtime = createLinearSessionStatusRuntime();
    runtime.processPayload({
      type: 'session.error',
      properties: {
        sessionID: 'ses_1',
        error: { name: 'MessageAbortedError', message: 'stopped' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(graphql).not.toHaveBeenCalled();

    runtime.processPayload({
      type: 'session.error',
      properties: {
        sessionID: 'ses_1',
        error: { name: 'ProviderError', message: 'boom' },
      },
    });
    await vi.waitFor(() => {
      const commentCalls = graphql.mock.calls.filter(([, options]) => {
        return JSON.parse(options.body).query.includes('mutation CommentCreate');
      });
      expect(commentCalls).toHaveLength(1);
      const body = JSON.parse(commentCalls[0][1].body).variables.input.body;
      expect(body).toContain('OpenChamber session failed');
    });
    runtime.stop();
  });

  it('does not treat busy as completed', async () => {
    const graphql = stubLinearGraphql();
    vi.stubGlobal('fetch', graphql);
    const runtime = createLinearSessionStatusRuntime();
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'busy' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(graphql).not.toHaveBeenCalled();
    runtime.stop();
  });
});
