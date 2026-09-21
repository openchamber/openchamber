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
    });
    expect(JSON.stringify(result)).not.toContain('access-1');
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it('clears auth and reports disconnected after a GraphQL 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ errors: [{ message: 'Unauthorized' }] }, 401)));
    await expect(listLinearTeams()).resolves.toEqual({ connected: false });
  });
});
