import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  issueReference, pullReference, readReferencesAcross, readReferencesAcrossRequest, resetReferencePageCache,
} from './references-across.js';

const ORIGIN = 'https://gitea.example.com';
const REPO = { id: '1', owner: 'acme', name: 'app', url: `${ORIGIN}/acme/app` };

const context = (directory, accountId = 'acct-1') => ({
  directory,
  repositoryId: `repo-${directory}`,
  provider: 'gitea',
  instance: ORIGIN,
  accountId,
  bindingRevision: 1,
  primaryRemote: 'origin',
});

const request = (contexts, extra = {}) => readReferencesAcrossRequest({ contexts, kind: 'issue', ...extra }, 'gitea');

const rawIssue = (number, updated, extra = {}) => ({
  number,
  title: `Issue ${number}`,
  html_url: `${ORIGIN}/acme/app/issues/${number}`,
  state: 'open',
  user: { login: 'alice', avatar_url: `${ORIGIN}/avatars/alice` },
  labels: [{ name: 'bug', color: '#d73a4a' }, { name: 'task' }, { bogus: true }],
  comments: 2,
  body: 'Steps to reproduce',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: updated,
  ...extra,
});

const rawPull = (number, updated, extra = {}) => ({
  number,
  title: `PR ${number}`,
  html_url: `${ORIGIN}/acme/app/pulls/${number}`,
  state: 'open',
  user: { login: 'alice' },
  labels: [],
  comments: 1,
  body: 'A change',
  head: {
    ref: 'feature',
    sha: 'a'.repeat(40),
    repo: {
      name: 'app', owner: { login: 'acme' }, html_url: `${ORIGIN}/acme/app`,
      clone_url: `${ORIGIN}/acme/app.git`, ssh_url: 'git@gitea.example.com:acme/app.git',
    },
  },
  base: { ref: 'main' },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: updated,
  ...extra,
});

/** A resource service whose pages are given per page number. */
const serviceWith = (pages, { repo = REPO, detail } = {}) => ({
  listReferenceCandidates: vi.fn(async (_directory, options) => {
    const page = pages[options.page] ?? { items: [], hasMore: false };
    return { repo, items: page.items, hasMore: page.hasMore, needsDetail: page.needsDetail };
  }),
  readPullDetail: vi.fn(async (_directory, number) => detail(number)),
});

const healthy = async (context) => ({ ...context, primaryRemote: 'origin' });

beforeEach(() => resetReferencePageCache());

describe('readReferencesAcrossRequest', () => {
  it('keeps one context per folder, in the order asked, and remembers every directory', () => {
    const first = context('/a');
    const second = context('/b');
    const input = readReferencesAcrossRequest({
      contexts: [first, { ...first }, second],
      kind: 'pull',
      state: 'closed',
      people: 'created',
      query: ' crash ',
      cursor: null,
    }, 'gitea');

    expect(input.contexts).toEqual([first, second]);
    expect(input.directories).toEqual(['/a', '/a', '/b']);
    expect(input).toMatchObject({ kind: 'pull', state: 'closed', people: 'created', query: ' crash ' });
  });

  it('refuses another provider, an unknown field, a bad kind and more than 100 folders', () => {
    expect(readReferencesAcrossRequest({
      contexts: [{ ...context('/a'), provider: 'forgejo' }], kind: 'issue',
    }, 'gitea')).toBeNull();
    expect(readReferencesAcrossRequest({ contexts: [context('/a')], kind: 'issue', extra: true }, 'gitea')).toBeNull();
    expect(readReferencesAcrossRequest({ contexts: [context('/a')], kind: 'commit' }, 'gitea')).toBeNull();
    expect(readReferencesAcrossRequest({ contexts: [{ ...context('/a'), bindingRevision: -1 }], kind: 'issue' }, 'gitea')).toBeNull();
    expect(readReferencesAcrossRequest({
      contexts: Array.from({ length: 101 }, (_value, index) => context(`/folder/${index}`)), kind: 'issue',
    }, 'gitea')).toBeNull();
  });
});

describe('Gitea reference mapping', () => {
  it('maps an issue with its author, labels, comments and body preview', () => {
    expect(issueReference(rawIssue(7, '2026-10-01T00:00:00Z'), REPO, '/repo')).toEqual({
      kind: 'issue',
      number: 7,
      title: 'Issue 7',
      url: `${ORIGIN}/acme/app/issues/7`,
      body: 'Steps to reproduce',
      bodyTruncated: false,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
      author: { login: 'alice', avatarUrl: `${ORIGIN}/avatars/alice` },
      labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'task' }],
      commentCount: 2,
      sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
      // Gitea sends no close reason, so a closed issue reads as done.
      state: 'open',
      directory: '/repo',
    });
    expect(issueReference(rawIssue(8, '2026-10-01T00:00:00Z', { state: 'closed' }), REPO, '/repo'))
      .toMatchObject({ state: 'completed' });
  });

  it('skips a pull request in the issue list, and an unmappable issue', () => {
    expect(issueReference(rawIssue(9, '2026-10-01T00:00:00Z', { pull_request: { merged: false } }), REPO, '/repo')).toBeNull();
    expect(issueReference(rawIssue(10, '2026-10-01T00:00:00Z', { html_url: undefined }), REPO, '/repo')).toBeNull();
    expect(issueReference(rawIssue(11, '2026-10-01T00:00:00Z', { state: 'draft' }), REPO, '/repo')).toBeNull();
  });

  it('cuts a long body at the preview size', () => {
    const mapped = issueReference(rawIssue(12, '2026-10-01T00:00:00Z', { body: 'x'.repeat(20_001) }), REPO, '/repo');
    expect(mapped.body).toHaveLength(20_000);
    expect(mapped.bodyTruncated).toBe(true);
  });

  it('maps a pull request with its branches, head repository and state', () => {
    expect(pullReference(rawPull(3, '2026-10-02T00:00:00Z'), REPO, '/repo')).toEqual({
      kind: 'pull',
      number: 3,
      title: 'PR 3',
      url: `${ORIGIN}/acme/app/pulls/3`,
      body: 'A change',
      bodyTruncated: false,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-10-02T00:00:00Z',
      author: { login: 'alice' },
      labels: [],
      commentCount: 1,
      sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
      state: 'open',
      draft: false,
      head: 'feature',
      base: 'main',
      headSha: 'a'.repeat(40),
      headRepo: {
        owner: 'acme',
        repo: 'app',
        url: `${ORIGIN}/acme/app`,
        cloneUrl: `${ORIGIN}/acme/app.git`,
        sshUrl: 'git@gitea.example.com:acme/app.git',
      },
      directory: '/repo',
    });
    expect(pullReference(rawPull(4, '2026-10-02T00:00:00Z', { merged: true }), REPO, '/repo')).toMatchObject({ state: 'merged' });
    expect(pullReference(rawPull(5, '2026-10-02T00:00:00Z', { draft: true }), REPO, '/repo')).toMatchObject({ draft: true });
    expect(pullReference(rawPull(6, '2026-10-02T00:00:00Z', { title: 'WIP: half done' }), REPO, '/repo')).toMatchObject({ draft: true });
  });

  it('skips a pull request without a head commit or base branch, and one with a gone head repository', () => {
    expect(pullReference(rawPull(7, '2026-10-02T00:00:00Z', { head: { ref: 'feature', repo: null } }), REPO, '/repo')).toBeNull();
    expect(pullReference(rawPull(8, '2026-10-02T00:00:00Z', { base: {} }), REPO, '/repo')).toBeNull();
    expect(pullReference(rawPull(9, '2026-10-02T00:00:00Z', { head: { ref: 'feature', sha: 'b'.repeat(40), repo: null } }), REPO, '/repo'))
      .toMatchObject({ headRepo: null });
  });
});

describe('readReferencesAcross', () => {
  it('merges the folders newest first and pages through them', async () => {
    const pages = {
      '/a': { 1: { items: Array.from({ length: 20 }, (_value, index) => rawIssue(index + 1, `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00Z`)), hasMore: false } },
      '/b': { 1: { items: Array.from({ length: 20 }, (_value, index) => rawIssue(index + 101, `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00Z`)), hasMore: false } },
    };
    const services = {
      '/a': serviceWith(pages['/a']),
      '/b': serviceWith(pages['/b']),
    };
    const input = request([context('/a'), context('/b')]);
    const read = (cursor) => readReferencesAcross({
      input: { ...input, cursor },
      providerId: 'gitea',
      validateReadContext: healthy,
      resolveService: async (trusted) => services[trusted.directory],
    });

    const first = await read(null);
    expect(first.items).toHaveLength(30);
    expect(first.items[0]).toMatchObject({ number: 20, directory: '/a' });
    expect(first.items.at(-1)).toMatchObject({ number: 111, directory: '/b' });
    expect(first).toMatchObject({ cursor: '30', hasMore: true, total: 40 });
    expect(first.repositories).toEqual([
      { directory: '/a', status: 'included', repo: { owner: 'acme', repo: 'app', url: `${ORIGIN}/acme/app` } },
      { directory: '/b', status: 'included', repo: { owner: 'acme', repo: 'app', url: `${ORIGIN}/acme/app` } },
    ]);

    const second = await read('30');
    expect(second.items).toHaveLength(10);
    expect(second.items[0]).toMatchObject({ number: 110, directory: '/b' });
    expect(second.items.at(-1)).toMatchObject({ number: 101, directory: '/b' });
    expect(second).toMatchObject({ cursor: null, hasMore: false, total: 40 });
    // The first page of each folder is cached, so paging reads nothing again.
    expect(services['/a'].listReferenceCandidates).toHaveBeenCalledTimes(1);
    expect(services['/b'].listReferenceCandidates).toHaveBeenCalledTimes(1);
  });

  it('keeps reading a folder until the window is covered, and stops at the per-folder cap', async () => {
    const items = (from, to) => Array.from({ length: to - from }, (_value, index) => rawIssue(from + index, '2026-10-01T00:00:00Z'));
    const pages = {
      1: { items: items(1, 51), hasMore: true },
      2: { items: items(51, 101), hasMore: true },
      3: { items: items(101, 151), hasMore: true },
      4: { items: items(151, 201), hasMore: false },
    };
    const service = serviceWith(pages);
    const input = request([context('/a')]);
    const read = (cursor) => readReferencesAcross({
      input: { ...input, cursor }, providerId: 'gitea', validateReadContext: healthy, resolveService: async () => service,
    });

    const first = await read(null);
    expect(first).toMatchObject({ total: 50, cursor: '30', hasMore: true });
    const second = await read('30');
    expect(second).toMatchObject({ total: 100, cursor: '60', hasMore: true });
    expect(service.listReferenceCandidates.mock.calls.map((call) => call[1].page)).toEqual([1, 2]);
    const third = await read('60');
    expect(third).toMatchObject({ total: 100, cursor: '90', hasMore: true });
    const fourth = await read('90');
    expect(fourth).toMatchObject({ total: 150, cursor: '120', hasMore: true });
    const fifth = await read('120');
    expect(fifth).toMatchObject({ total: 200, cursor: '150', hasMore: true });
    expect(service.listReferenceCandidates.mock.calls.map((call) => call[1].page)).toEqual([1, 2, 3, 4]);
    const sixth = await read('150');
    expect(sixth).toMatchObject({ total: 200, cursor: '180', hasMore: true });
    // The cap holds: page 4 is the deepest page read, and the search ends there.
    const last = await read('180');
    expect(last.items).toHaveLength(20);
    expect(last).toMatchObject({ total: 200, cursor: null, hasMore: false });
    expect(service.listReferenceCandidates.mock.calls.map((call) => call[1].page)).toEqual([1, 2, 3, 4]);
  });

  it('reports each folder it could not read and still answers the others', async () => {
    const failures = {
      '/signed-out': Object.assign(new Error('signed out'), { status: 401 }),
      '/stale': Object.assign(new Error('stale'), { code: 'SOURCE_CONTROL_BINDING_STALE' }),
    };
    const failureCalls = [];
    // One account reads every folder, so one service answers them all; a
    // folder without a repository on the instance fails its own read.
    const service = {
      listReferenceCandidates: vi.fn(async (directory) => {
        if (directory === '/no-repo') throw Object.assign(new Error('no repo'), { code: 'SOURCE_CONTROL_NO_REPOSITORY' });
        if (directory === '/broken') throw new Error('boom');
        return { repo: REPO, items: [rawIssue(1, '2026-10-01T00:00:00Z')], hasMore: false };
      }),
      readPullDetail: vi.fn(async () => null),
    };
    const input = request([context('/ok'), context('/signed-out'), context('/no-repo'), context('/stale'), context('/broken'), context('/empty')]);
    const page = await readReferencesAcross({
      input,
      providerId: 'gitea',
      validateReadContext: async (candidate) => {
        if (failures[candidate.directory]) throw failures[candidate.directory];
        if (candidate.directory === '/empty') return null;
        return { ...candidate, primaryRemote: 'origin' };
      },
      resolveService: async () => service,
      onFolderFailure: async (error, identity) => failureCalls.push({ error, identity }),
    });

    expect(page.items.map((item) => item.number)).toEqual([1]);
    // The refused account is reported with the identity it was read under.
    expect(failureCalls).toContainEqual({
      error: expect.objectContaining({ status: 401 }),
      identity: expect.objectContaining({ directory: '/signed-out', instance: ORIGIN, accountId: 'acct-1' }),
    });
    expect(page.repositories).toEqual([
      { directory: '/ok', status: 'included', repo: { owner: 'acme', repo: 'app', url: `${ORIGIN}/acme/app` } },
      { directory: '/signed-out', status: 'disconnected' },
      { directory: '/no-repo', status: 'no-repo' },
      { directory: '/stale', status: 'invalid-context' },
      { directory: '/broken', status: 'error' },
      { directory: '/empty', status: 'invalid-context' },
    ]);
  });

  it('reads the pull requests that land on the page and drops one that moved away', async () => {
    const listed = [
      rawIssue(1, '2026-10-03T00:00:00Z', { pull_request: { merged: false } }),
      rawIssue(2, '2026-10-02T00:00:00Z', { pull_request: { merged: false } }),
      rawIssue(3, '2026-10-01T00:00:00Z', { pull_request: { merged: false } }),
    ];
    const service = serviceWith(
      { 1: { items: listed, hasMore: false, needsDetail: true } },
      { detail: (number) => {
        if (number === 2) throw Object.assign(new Error('gone'), { status: 404 });
        return rawPull(number, number === 1 ? '2026-10-03T00:00:00Z' : '2026-10-01T00:00:00Z');
      } },
    );
    const input = request([context('/a')], { kind: 'pull' });
    const page = await readReferencesAcross({
      input, providerId: 'gitea', validateReadContext: healthy, resolveService: async () => service,
    });

    expect(service.readPullDetail.mock.calls.map((call) => call[1])).toEqual([1, 2, 3]);
    expect(page.items.map((item) => [item.number, item.head, item.base, item.headSha])).toEqual([
      [1, 'feature', 'main', 'a'.repeat(40)],
      [3, 'feature', 'main', 'a'.repeat(40)],
    ]);
  });

  it('answers an empty page for discussions, which these providers do not keep', async () => {
    const input = request([context('/a'), context('/b')], { kind: 'discussion' });
    const page = await readReferencesAcross({
      input,
      providerId: 'gitea',
      validateReadContext: () => { throw new Error('should not be read'); },
      resolveService: () => { throw new Error('should not be read'); },
    });
    expect(page).toEqual({
      items: [],
      cursor: null,
      hasMore: false,
      total: 0,
      repositories: [
        { directory: '/a', status: 'included', repo: null },
        { directory: '/b', status: 'included', repo: null },
      ],
    });
  });

  it('refuses a cursor that is not an offset', async () => {
    const input = request([context('/a')]);
    for (const cursor of ['abc', '-1', '1.5', '9007199254740992']) {
      await expect(readReferencesAcross({
        input: { ...input, cursor }, providerId: 'gitea', validateReadContext: healthy, resolveService: async () => serviceWith({}),
      })).rejects.toMatchObject({ status: 400, code: 'INVALID_REFERENCES_CURSOR' });
    }
  });
});
