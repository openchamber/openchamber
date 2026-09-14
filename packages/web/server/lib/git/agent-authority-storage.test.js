import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGitAgentAuthorityStore, registerGitAgentAuthorityRoutes } from './agent-authority-storage.js';

const REPOSITORY = `repo_${'a'.repeat(43)}`;
const OTHER = `repo_${'b'.repeat(43)}`;
const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

const store = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-agent-authority-'));
  directories.push(directory);
  const filePath = path.join(directory, 'git-agent-authority.json');
  return { filePath, store: createGitAgentAuthorityStore({ filePath }) };
};

describe('createGitAgentAuthorityStore', () => {
  test('answers yes for a repository nobody excluded', async () => {
    const { store: authority } = await store();
    expect(await authority.isEnabled(REPOSITORY)).toBe(true);
  });

  test('remembers an exclusion and lets it be taken back', async () => {
    const { store: authority, filePath } = await store();
    expect(await authority.setEnabled(REPOSITORY, false)).toBe(false);
    expect(await authority.isEnabled(REPOSITORY)).toBe(false);
    // Only the excluded repository is affected.
    expect(await authority.isEnabled(OTHER)).toBe(true);

    const reopened = createGitAgentAuthorityStore({ filePath });
    expect(await reopened.isEnabled(REPOSITORY)).toBe(false);

    await authority.setEnabled(REPOSITORY, true);
    expect(await authority.isEnabled(REPOSITORY)).toBe(true);
    expect(JSON.parse(await fs.readFile(filePath, 'utf8')).excluded).toEqual([]);
  });

  test('records an exclusion once, however many times it is asked for', async () => {
    const { store: authority, filePath } = await store();
    await authority.setEnabled(REPOSITORY, false);
    await authority.setEnabled(REPOSITORY, false);
    expect(JSON.parse(await fs.readFile(filePath, 'utf8')).excluded).toEqual([REPOSITORY]);
  });

  test('keeps OpenChamber out when the store cannot be read', async () => {
    const { store: authority, filePath } = await store();
    await fs.writeFile(filePath, 'not json', 'utf8');
    // An unreadable file must not hand the agent an identity that may have
    // been excluded, so it answers no rather than assuming yes.
    expect(await authority.isEnabled(REPOSITORY)).toBe(false);
  });

  test('refuses anything that is not a repository identity', async () => {
    const { store: authority } = await store();
    expect(await authority.isEnabled('not-a-repository')).toBe(false);
    await expect(authority.setEnabled('not-a-repository', false)).rejects.toThrow(/invalid/i);
  });
});

describe('registerGitAgentAuthorityRoutes', () => {
  const routes = (overrides = {}) => {
    const handlers = new Map();
    const state = new Map();
    registerGitAgentAuthorityRoutes({ get: (p, h) => handlers.set(`GET ${p}`, h), put: (p, h) => handlers.set(`PUT ${p}`, h) }, {
      store: {
        isEnabled: async (repositoryId) => state.get(repositoryId) !== false,
        setEnabled: async (repositoryId, enabled) => { state.set(repositoryId, enabled); return enabled; },
      },
      resolveRepositoryId: async (directory) => {
        if (directory === '/not-a-repo') throw new Error('Not a repository');
        return REPOSITORY;
      },
      ...overrides,
    });
    const call = async (key, request) => {
      let status = 200;
      let body;
      await handlers.get(key)(request, {
        status: (code) => { status = code; return { json: (value) => { body = value; } }; },
        json: (value) => { body = value; },
      });
      return { status, body };
    };
    return { call, state };
  };

  test('reads and writes the answer for a directory', async () => {
    const { call, state } = routes();
    expect(await call('GET /api/git/agent-authority', { query: { directory: '/repo' } }))
      .toEqual({ status: 200, body: { enabled: true } });
    expect(await call('PUT /api/git/agent-authority', { body: { directory: '/repo', enabled: false } }))
      .toEqual({ status: 200, body: { enabled: false } });
    expect(state.get(REPOSITORY)).toBe(false);
    expect(await call('GET /api/git/agent-authority', { query: { directory: '/repo' } }))
      .toEqual({ status: 200, body: { enabled: false } });
  });

  test('rejects a directory that is not a repository, and a value that is not a boolean', async () => {
    const { call } = routes();
    expect((await call('GET /api/git/agent-authority', { query: { directory: '/not-a-repo' } })).status).toBe(404);
    expect((await call('PUT /api/git/agent-authority', { body: { directory: '/repo', enabled: 'yes' } })).status).toBe(400);
    expect((await call('PUT /api/git/agent-authority', { body: { enabled: true } })).status).toBe(404);
  });
});
