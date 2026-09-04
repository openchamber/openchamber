import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setLinearAuth, clearLinearAuth } from './auth.js';
import { getLinearIssue, listLinearIssues, listLinearIssueStates, parseLinearIssueRef, createLinearIssueComment, updateLinearIssue } from './issues.js';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-linear-issues-'));

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const issueNode = {
  id: 'issue-uuid-1',
  identifier: 'ENG-12',
  title: 'Broken login',
  url: 'https://linear.app/openchamber/issue/ENG-12',
  priority: 1,
  state: { id: 'state-started', name: 'In Progress', type: 'started' },
  assignee: { name: 'Ada', displayName: 'Ada Lovelace', avatarUrl: 'https://example.com/a.png' },
  team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
  labels: { nodes: [{ id: 'label-bug', name: 'Bug', color: 'EB5757' }] },
};

describe('parseLinearIssueRef', () => {
  it('reads identifiers, URLs, and UUIDs', () => {
    expect(parseLinearIssueRef('eng-12')).toEqual({ kind: 'identifier', value: 'ENG-12' });
    expect(parseLinearIssueRef('https://linear.app/openchamber/issue/ENG-12/broken-login'))
      .toEqual({ kind: 'identifier', value: 'ENG-12' });
    expect(parseLinearIssueRef('11111111-2222-3333-4444-555555555555'))
      .toEqual({ kind: 'id', value: '11111111-2222-3333-4444-555555555555' });
    expect(parseLinearIssueRef('login redirect')).toBeNull();
  });
});

describe('Linear issue list/get', () => {
  let dataDir;
  let previousDataDir;

  beforeEach(() => {
    previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    dataDir = makeTempDir();
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    setLinearAuth({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 86_400_000,
      scope: 'read,write,comments:create',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearLinearAuth();
    if (previousDataDir === undefined) {
      delete process.env.OPENCHAMBER_DATA_DIR;
    } else {
      process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns disconnected without calling Linear when there is no auth', async () => {
    clearLinearAuth();
    const graphql = vi.fn();
    vi.stubGlobal('fetch', graphql);
    await expect(listLinearIssues()).resolves.toEqual({ connected: false });
    expect(graphql).not.toHaveBeenCalled();
  });

  it('lists incomplete issues and never returns the token', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      expect(body.query).toContain('query ListLinearIssues');
      expect(body.variables.filter.state.type.nin).toEqual(['completed', 'canceled', 'duplicate']);
      expect(options.headers.Authorization).toBe('Bearer access-1');
      expect(options.headers['public-file-urls-expire-in']).toBe('3600');
      return jsonResponse({
        data: {
          issues: {
            nodes: [issueNode],
            pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
          },
        },
      });
    }));

    const result = await listLinearIssues();
    expect(result).toEqual({
      connected: true,
      issues: [{
        id: 'issue-uuid-1',
        identifier: 'ENG-12',
        title: 'Broken login',
        url: 'https://linear.app/openchamber/issue/ENG-12',
        state: { id: 'state-started', name: 'In Progress', type: 'started' },
        assignee: { name: 'Ada', displayName: 'Ada Lovelace', avatarUrl: 'https://example.com/a.png' },
        team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
        priority: 1,
        labels: [{ id: 'label-bug', name: 'Bug', color: '#eb5757' }],
      }],
      cursor: 'cursor-2',
      hasMore: true,
    });
    expect(JSON.stringify(result)).not.toContain('access-1');
  });

  it('includes priority and labels and drops invalid values', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      data: {
        issues: {
          nodes: [{
            ...issueNode,
            priority: 9,
            labels: {
              nodes: [
                { id: 'label-ok', name: 'Bug', color: '#EB5757' },
                { id: 'label-bad-color', name: 'Nope', color: 'red' },
                { id: '', name: 'Missing id' },
              ],
            },
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    })));

    const result = await listLinearIssues();
    expect(result.issues?.[0]?.priority).toBeNull();
    expect(result.issues?.[0]?.labels).toEqual([
      { id: 'label-ok', name: 'Bug', color: '#eb5757' },
      { id: 'label-bad-color', name: 'Nope', color: null },
    ]);
  });

  it('searches by text and looks up an identifier directly', async () => {
    const graphql = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.query.includes('SearchLinearIssues')) {
        expect(body.variables.term).toBe('login');
        return jsonResponse({
          data: {
            searchIssues: {
              nodes: [issueNode],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      expect(body.variables.id).toBe('ENG-12');
      return jsonResponse({
        data: {
          issue: {
            ...issueNode,
            description: 'Users cannot sign in.',
            comments: {
              nodes: [{
                id: 'comment-1',
                body: 'Still broken',
                createdAt: '2026-08-24T10:00:00.000Z',
                user: { name: 'Ada', displayName: 'Ada Lovelace' },
              }],
            },
          },
        },
      });
    });
    vi.stubGlobal('fetch', graphql);

    const search = await listLinearIssues({ query: 'login' });
    expect(search.issues).toHaveLength(1);
    expect(search.hasMore).toBe(false);

    const byId = await listLinearIssues({ query: 'https://linear.app/openchamber/issue/ENG-12' });
    expect(byId.issues?.[0]?.identifier).toBe('ENG-12');
    expect(byId.hasMore).toBe(false);
  });

  it('applies status, assignee, team, and priority list filters', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      expect(body.variables.filter).toEqual({
        state: { type: { eq: 'started' }, name: { neqIgnoreCase: 'In Review' } },
        assignee: { isMe: { eq: true } },
        team: { id: { eq: 'team-eng' } },
        priority: { eq: 1 },
      });
      return jsonResponse({
        data: {
          issues: {
            nodes: [issueNode],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }));

    const result = await listLinearIssues({
      status: 'started',
      assignee: 'me',
      teamId: 'team-eng',
      priority: 'urgent',
    });
    expect(result.issues).toHaveLength(1);
  });

  it('filters each panel status to a Linear state type or name', async () => {
    const filters = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      filters.push(JSON.parse(options.body).variables.filter);
      return jsonResponse({
        data: {
          issues: {
            nodes: [issueNode],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }));

    await listLinearIssues({ status: 'todo' });
    await listLinearIssues({ status: 'backlog' });
    await listLinearIssues({ status: 'started' });
    await listLinearIssues({ status: 'inReview' });
    await listLinearIssues({ status: 'completed' });
    await listLinearIssues({ status: 'canceled' });
    await listLinearIssues({ status: 'duplicate' });
    expect(filters).toEqual([
      { state: { type: { eq: 'unstarted' } } },
      { state: { type: { eq: 'backlog' } } },
      { state: { type: { eq: 'started' }, name: { neqIgnoreCase: 'In Review' } } },
      { state: { name: { eqIgnoreCase: 'In Review' } } },
      { state: { type: { eq: 'completed' } } },
      { state: { type: { eq: 'canceled' }, name: { neqIgnoreCase: 'Duplicate' } } },
      { state: { or: [{ type: { eq: 'duplicate' } }, { name: { eqIgnoreCase: 'Duplicate' } }] } },
    ]);
  });

  it('omits the state filter when listing all issues', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      expect(body.variables.filter).toBeUndefined();
      return jsonResponse({
        data: {
          issues: {
            nodes: [issueNode],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }));

    await listLinearIssues({ status: 'all' });
  });

  it('filters no-priority issues as Linear priority 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      expect(body.variables.filter).toEqual({
        priority: { eq: 0 },
      });
      return jsonResponse({
        data: {
          issues: {
            nodes: [issueNode],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }));

    await listLinearIssues({ status: 'all', priority: 'none' });
  });

  it('looks up an identifier without applying list filters', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      expect(body.query).toContain('GetLinearIssue');
      expect(body.variables.id).toBe('ENG-12');
      expect(body.variables.filter).toBeUndefined();
      return jsonResponse({ data: { issue: issueNode } });
    }));

    const result = await listLinearIssues({
      query: 'ENG-12',
      status: 'completed',
      assignee: 'me',
      teamId: 'team-eng',
      priority: 'urgent',
    });
    expect(result.issues?.[0]?.identifier).toBe('ENG-12');
  });

  it('loads one issue with comments', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      data: {
        issue: {
          ...issueNode,
          description: 'Users cannot sign in.',
          comments: { nodes: [{ id: 'comment-1', body: 'Still broken', createdAt: '2026-08-24T10:00:00.000Z', user: { name: 'Ada', displayName: null, avatarUrl: 'https://linear.app/avatar/ada.png' } }] },
        },
      },
    })));

    const result = await getLinearIssue('ENG-12');
    expect(result.connected).toBe(true);
    expect(result.issue?.description).toBe('Users cannot sign in.');
    expect(result.issue?.priority).toBe(1);
    expect(result.issue?.labels).toEqual([{ id: 'label-bug', name: 'Bug', color: '#eb5757' }]);
    expect(result.issue?.comments).toEqual([{
      id: 'comment-1',
      body: 'Still broken',
      createdAt: '2026-08-24T10:00:00.000Z',
      user: { name: 'Ada', displayName: null, avatarUrl: 'https://linear.app/avatar/ada.png' },
    }]);
  });

  it('creates a comment on the resolved issue UUID', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.query.includes('query GetLinearIssue')) {
        expect(body.variables.id).toBe('ENG-12');
        return jsonResponse({
          data: {
            issue: {
              ...issueNode,
              description: null,
              comments: { nodes: [] },
            },
          },
        });
      }
      expect(body.query).toContain('mutation CommentCreate');
      expect(body.variables.input).toEqual({
        issueId: 'issue-uuid-1',
        body: 'OpenChamber session started.',
      });
      expect(options.headers.Authorization).toBe('Bearer access-1');
      return jsonResponse({
        data: {
          commentCreate: {
            success: true,
            comment: { id: 'comment-9' },
          },
        },
      });
    }));

    const result = await createLinearIssueComment({
      issueId: 'ENG-12',
      body: 'OpenChamber session started.',
    });
    expect(result).toEqual({ connected: true, comment: { id: 'comment-9' } });
    expect(JSON.stringify(result)).not.toContain('access-1');
  });

  it('clears auth and reports disconnected after a GraphQL 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ errors: [{ message: 'Unauthorized' }] }, 401)));
    await expect(listLinearIssues()).resolves.toEqual({ connected: false });
    await expect(listLinearIssues()).resolves.toEqual({ connected: false });
  });

  it('lists team workflow states in Linear workflow order', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      expect(body.query).toContain('query TeamWorkflowStates');
      expect(body.variables.id).toBe('team-eng');
      expect(options.headers.Authorization).toBe('Bearer access-1');
      return jsonResponse({
        data: {
          team: {
            states: {
              nodes: [
                { id: 'state-done', name: 'Done', type: 'completed', position: 0 },
                { id: 'state-review', name: 'In Review', type: 'started', position: 1 },
                { id: 'state-todo', name: 'Todo', type: 'unstarted', position: 0 },
                { id: 'state-dup', name: 'Duplicate', type: 'canceled', position: 1 },
                { id: 'state-progress', name: 'In Progress', type: 'started', position: 0 },
                { id: 'state-backlog', name: 'Backlog', type: 'backlog', position: 0 },
                { id: 'state-canceled', name: 'Canceled', type: 'canceled', position: 0 },
              ],
            },
          },
        },
      });
    }));

    const result = await listLinearIssueStates('team-eng');
    expect(result.states?.map((state) => state.name)).toEqual([
      'Backlog',
      'Todo',
      'In Progress',
      'In Review',
      'Done',
      'Canceled',
      'Duplicate',
    ]);
  });

  it('rejects workflow states without a team id', async () => {
    await expect(listLinearIssueStates('')).rejects.toMatchObject({
      message: 'teamId is required',
      code: 'INVALID',
    });
  });

  it('updates an issue state and returns the issue', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      expect(body.query).toContain('mutation IssueUpdate');
      expect(body.variables).toEqual({
        id: 'issue-uuid-1',
        input: { stateId: 'state-done' },
      });
      expect(options.headers.Authorization).toBe('Bearer access-1');
      return jsonResponse({
        data: {
          issueUpdate: {
            success: true,
            issue: {
              ...issueNode,
              state: { id: 'state-done', name: 'Done', type: 'completed' },
              description: null,
              comments: { nodes: [] },
            },
          },
        },
      });
    }));

    const result = await updateLinearIssue({ id: 'issue-uuid-1', stateId: 'state-done' });
    expect(result.connected).toBe(true);
    expect(result.issue?.state).toEqual({ id: 'state-done', name: 'Done', type: 'completed' });
    expect(JSON.stringify(result)).not.toContain('access-1');
  });

  it('rejects an issue update without id or stateId', async () => {
    await expect(updateLinearIssue({ id: 'issue-uuid-1' })).rejects.toMatchObject({
      message: 'id and stateId are required',
      code: 'INVALID',
    });
  });

  it('resolves an issue identifier before issueUpdate', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.query.includes('query GetLinearIssue')) {
        expect(body.variables.id).toBe('ENG-12');
        return jsonResponse({
          data: {
            issue: {
              ...issueNode,
              description: null,
              comments: { nodes: [] },
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
              ...issueNode,
              state: { id: 'state-done', name: 'Done', type: 'completed' },
              description: null,
              comments: { nodes: [] },
            },
          },
        },
      });
    }));

    const result = await updateLinearIssue({ id: 'ENG-12', stateId: 'state-done' });
    expect(result.connected).toBe(true);
    expect(result.issue?.id).toBe('issue-uuid-1');
    expect(result.issue?.state).toEqual({ id: 'state-done', name: 'Done', type: 'completed' });
  });

  it('surfaces Linear validation constraints from GraphQL errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      data: null,
      errors: [{
        message: 'Argument Validation Error',
        extensions: {
          code: 'INVALID_INPUT',
          userError: true,
          userPresentableMessage: 'stateId must be a UUID.',
          validationErrors: [{
            property: 'stateId',
            constraints: { isUuid: 'stateId must be a UUID.' },
          }],
        },
      }],
    })));

    await expect(updateLinearIssue({ id: 'issue-uuid-1', stateId: 'not-a-uuid' })).rejects.toMatchObject({
      name: 'LinearApiError',
      message: 'stateId must be a UUID.',
      status: 400,
      userError: true,
    });
  });
});
