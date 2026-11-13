import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import express from 'express';
import { registerGitHubRoutes } from '../source-control/provider-routes.github.test-support.js';

const testDir = fs.mkdtempSync('/tmp/opencode/stack-context-');
const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
let accountId;

const context = () => ({
  directory: '/work/project', repositoryId: 'repo_1', bindingRevision: 3,
  provider: 'github', instance: 'github.com', accountId, primaryRemote: 'upstream',
});
const pull = (number, head, base) => ({
  number, title: `PR ${number}`, html_url: `https://github.com/acme/app/pull/${number}`, draft: false,
  head: { ref: head, sha: `sha-${number}`, repo: { full_name: 'acme/app' } },
  base: { ref: base, repo: { full_name: 'acme/app', default_branch: 'main' } },
});

const setup = (overrides = {}) => {
  const resolveGitHubRepoFromDirectory = vi.fn(async () => ({ repo: { owner: 'acme', repo: 'app' } }));
  const resolveRepoNetwork = vi.fn(async () => null);
  const validateReadContext = vi.fn(async (input) => input);
  const provider = registerGitHubRoutes(express(), { validateReadContext, resolveGitHubRepoFromDirectory, resolveRepoNetwork, ...overrides });
  return { provider, validateReadContext, resolveGitHubRepoFromDirectory, resolveRepoNetwork };
};

const serveGitHub = () => {
  const fetchMock = vi.fn(async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/repos/acme/app/pulls') {
      return Response.json(url.searchParams.get('state') === 'open'
        ? [pull(1, 'first', 'main'), pull(2, 'second', 'first')] : []);
    }
    if (url.pathname === '/repos/acme/app/stacks') return Response.json({ message: 'Not Found' }, { status: 404 });
    if (url.pathname.startsWith('/repos/acme/app/compare/')) return Response.json({ behind_by: 0, commits: [] });
    if (url.pathname === '/graphql') {
      const { variables } = JSON.parse(init.body);
      const data = {};
      for (const key of Object.keys(variables).filter((name) => name.startsWith('p'))) {
        const number = variables[key];
        data[`a${key.slice(1)}`] = { pullRequest: {
          number, title: `PR ${number}`, state: 'OPEN', isDraft: false, headRefOid: `sha-${number}`,
          baseRefName: number === 1 ? 'main' : 'first',
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
        } };
      }
      return Response.json({ data });
    }
    throw new Error(`Unexpected GitHub request ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

beforeAll(async () => {
  process.env.OPENCHAMBER_DATA_DIR = testDir;
  const auth = await import('./auth.js');
  auth.setGhCliDisabled(true);
  ({ accountId } = await auth.setGitHubAuth({ accessToken: 'fake-bound-token', user: { id: 71, login: 'bound' } }));
  await auth.setGitHubAuth({ accessToken: 'fake-ambient-token', user: { id: 72, login: 'ambient' } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(() => {
  if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('bound server stack context reader', () => {
  it('uses the exact validated account and primary remote when the active account differs', async () => {
    // Given a bound account distinct from the ambient account.
    const fetchMock = serveGitHub();
    const driver = setup();

    // When session context reads the anchor through the registered provider.
    const stack = await driver.provider.readPullStack({ context: context(), owner: 'acme', repo: 'app', number: 1 });

    // Then the live stack is read under only the validated authority.
    expect(stack.members.map((entry) => [entry.number, entry.head, entry.summary])).toEqual([[1, 'first', 'ok'], [2, 'second', 'ok']]);
    expect(driver.validateReadContext).toHaveBeenCalledExactlyOnceWith(context());
    expect(driver.resolveGitHubRepoFromDirectory).toHaveBeenCalledExactlyOnceWith('/work/project', 'upstream');
    expect(new Set(fetchMock.mock.calls.map(([, init]) => init.headers.authorization))).toEqual(new Set(['token fake-bound-token']));
  });

  it('rejects stale binding authority before account, repository or provider reads', async () => {
    // Given validation that refuses a stale revision.
    const fetchMock = serveGitHub();
    const stale = Object.assign(new Error('Binding changed'), { code: 'SOURCE_CONTROL_BINDING_STALE' });
    const driver = setup({ validateReadContext: async () => { throw stale; } });

    // When a turn attempts a stack read.
    const result = driver.provider.readPullStack({ context: context(), owner: 'acme', repo: 'app', number: 1 });

    // Then no later read can use stale authority.
    await expect(result).rejects.toBe(stale);
    expect(driver.resolveGitHubRepoFromDirectory).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an out-of-network anchor before reading its stack', async () => {
    // Given a valid binding whose network excludes the linked repository.
    const fetchMock = serveGitHub();
    const driver = setup();

    // When the session tries to follow another repository.
    const result = driver.provider.readPullStack({ context: context(), owner: 'outside', repo: 'private', number: 1 });

    // Then no provider request targets that repository.
    await expect(result).rejects.toThrow('Repository is not part of this project');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fall back to the ambient account when the exact credential is missing', async () => {
    // Given valid authority naming an unavailable exact credential.
    const fetchMock = serveGitHub();
    const driver = setup();

    // When resolving the anchor.
    const result = driver.provider.readPullStack({ context: { ...context(), accountId: 'missing-credential' }, owner: 'acme', repo: 'app', number: 1 });

    // Then the read fails before any GitHub request.
    await expect(result).rejects.toMatchObject({ status: 401, sourceControlAccountUnavailable: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
