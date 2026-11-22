import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { clearLinearAuth, setLinearAuth } from './auth.js';
import { listLinearTeams } from './teams.js';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-linear-teams-'));

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

describe('Linear teams list', () => {
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
    await expect(listLinearTeams()).resolves.toEqual({ connected: false });
    expect(graphql).not.toHaveBeenCalled();
  });

  it('lists teams across pages and never returns the token', async () => {
    const graphql = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      expect(body.query).toContain('query ListLinearTeams');
      expect(options.headers.Authorization).toBe('Bearer access-1');
      if (!body.variables.after) {
        return jsonResponse({
          data: {
            teams: {
              nodes: [{ id: 'team-eng', key: 'ENG', name: 'Engineering' }],
              pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
            },
          },
        });
      }
      expect(body.variables.after).toBe('cursor-2');
      return jsonResponse({
        data: {
          teams: {
            nodes: [{ id: 'team-des', key: 'DES', name: 'Design' }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    });
    vi.stubGlobal('fetch', graphql);

    const result = await listLinearTeams();
    expect(result).toEqual({
      connected: true,
      teams: [
        { id: 'team-eng', key: 'ENG', name: 'Engineering' },
        { id: 'team-des', key: 'DES', name: 'Design' },
      ],
      teamsMore: false,
    });
    expect(JSON.stringify(result)).not.toContain('access-1');
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it('returns teamsMore when the 20-page cap is hit with a next page remaining', async () => {
    let calls = 0;
    const graphql = vi.fn(async () => {
      calls += 1;
      return jsonResponse({
        data: {
          teams: {
            nodes: [{ id: `team-${calls}`, key: `T${calls}`, name: `Team ${calls}` }],
            pageInfo: { hasNextPage: true, endCursor: `cursor-${calls + 1}` },
          },
        },
      });
    });
    vi.stubGlobal('fetch', graphql);

    const result = await listLinearTeams();
    expect(graphql).toHaveBeenCalledTimes(20);
    expect(result.connected).toBe(true);
    expect(result.teamsMore).toBe(true);
    expect(result.teams).toHaveLength(20);
    expect(result.teams[0]).toEqual({ id: 'team-1', key: 'T1', name: 'Team 1' });
    expect(result.teams[19]).toEqual({ id: 'team-20', key: 'T20', name: 'Team 20' });
  });

  it('returns teamsMore when a next page is claimed but no cursor is given', async () => {
    const graphql = vi.fn(async () => jsonResponse({
      data: {
        teams: {
          nodes: [{ id: 'team-eng', key: 'ENG', name: 'Engineering' }],
          pageInfo: { hasNextPage: true, endCursor: null },
        },
      },
    }));
    vi.stubGlobal('fetch', graphql);

    await expect(listLinearTeams()).resolves.toEqual({
      connected: true,
      teams: [{ id: 'team-eng', key: 'ENG', name: 'Engineering' }],
      teamsMore: true,
    });
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it('clears auth and reports disconnected after a GraphQL 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ errors: [{ message: 'Unauthorized' }] }, 401)));
    await expect(listLinearTeams()).resolves.toEqual({ connected: false });
  });
});
