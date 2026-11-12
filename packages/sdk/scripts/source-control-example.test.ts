import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FAKE_FORGE_FORK, FAKE_FORGE_STRANGER, startFakeForge, type FakeForge } from '../examples/source-control-provider/fake-forge';
import { sourceControlProviderSchemasV1 as schemas } from '../src/service-provider-schemas';
import {
  OPENCHAMBER_HOST_CALLBACK_URL,
  SOURCE_CONTROL_OUTBOUND_PATH,
  SOURCE_CONTROL_OUTBOUND_RESPONSE_HEADERS,
  SOURCE_CONTROL_PROVIDER_PATH,
  type SourceControlJson,
  type SourceControlJsonObject,
  type SourceControlProviderMethod,
} from '../src/service-providers';

// Runs the checked-in service bundle the way OpenChamber does: a loopback
// port and bearer, a callback listener that plays OpenChamber's outbound
// proxy (handle → instance origin and token), and a fake forge behind it.

const serviceEntry = fileURLToPath(new URL('../examples/source-control-provider/service/main.js', import.meta.url));
const PROVIDER = 'ext-source-control-provider';

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = Object(server.address());
    server.close(() => resolve(Number(port)));
  });
});

let forge: FakeForge;
let repository: string;
let service: ChildProcess;
let servicePort: number;
const serviceToken = randomBytes(16).toString('hex');
const handles = new Map<string, { origin: string; token: string | null }>();
let callback: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  forge = await startFakeForge();
  repository = await mkdtemp(path.join(tmpdir(), 'oc-scm-example-'));
  spawnSync('git', ['init', '-q', repository]);
  spawnSync('git', ['-C', repository, 'remote', 'add', 'origin', `${forge.origin}/mona/teapot.git`]);
  spawnSync('git', ['-C', repository, 'remote', 'add', 'fork', `${forge.origin}/${FAKE_FORGE_FORK.owner}/${FAKE_FORGE_FORK.name}.git`]);
  spawnSync('git', ['-C', repository, 'remote', 'add', 'stranger', `${forge.origin}/${FAKE_FORGE_STRANGER.owner}/${FAKE_FORGE_STRANGER.name}.git`]);

  callback = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const grant = handles.get((request.headers.get('authorization') ?? '').replace(/^Bearer /, ''));
      if (new URL(request.url).pathname !== SOURCE_CONTROL_OUTBOUND_PATH || !grant) {
        return Response.json({ error: { message: 'Unknown handle', code: 'HANDLE_UNKNOWN' } }, { status: 403 });
      }
      const outbound = schemas.outboundRequest.safeParse(await request.json());
      if (!outbound.success) return Response.json({ error: { message: 'Malformed request', code: 'BAD_REQUEST' } }, { status: 400 });
      const url = new URL(outbound.data.path, grant.origin);
      if (url.origin !== grant.origin) return Response.json({ error: { message: 'Off the instance', code: 'OFF_ORIGIN' } }, { status: 403 });
      for (const [key, value] of Object.entries(outbound.data.query ?? {})) url.searchParams.set(key, value);
      const headers = new Headers(outbound.data.headers);
      if (grant.token) headers.set('authorization', `token ${grant.token}`);
      const answer = await fetch(url, { method: outbound.data.method, headers, body: outbound.data.body, redirect: 'manual' });
      const relayed: Record<string, string> = {};
      for (const name of SOURCE_CONTROL_OUTBOUND_RESPONSE_HEADERS) {
        const value = answer.headers.get(name);
        if (value !== null) relayed[name] = value;
      }
      return Response.json({ status: answer.status, headers: relayed, body: await answer.text() });
    },
  });

  servicePort = await freePort();
  service = spawn('node', [serviceEntry], {
    env: {
      PATH: process.env.PATH,
      OPENCHAMBER_SERVICE_PORT: String(servicePort),
      OPENCHAMBER_SERVICE_TOKEN: serviceToken,
      [OPENCHAMBER_HOST_CALLBACK_URL]: `http://127.0.0.1:${callback.port}`,
    },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await fetch(`http://127.0.0.1:${servicePort}/health`, { headers: { authorization: `Bearer ${serviceToken}` } })
      .then((response) => response.ok, () => false);
    if (ready) return;
    await Bun.sleep(50);
  }
  throw new Error('The example service never became ready');
});

afterAll(async () => {
  service?.kill();
  callback?.stop(true);
  await forge?.close();
  if (repository) await rm(repository, { recursive: true, force: true });
});

/** One call as OpenChamber makes it: a fresh handle, revoked when the call ends. */
const call = async (
  method: SourceControlProviderMethod,
  input: SourceControlJsonObject,
  { token = 'good', user = true }: { token?: string | null; user?: boolean } = {},
) => {
  const handle = randomBytes(32).toString('hex');
  handles.set(handle, { origin: forge.origin, token });
  try {
    const response = await fetch(`http://127.0.0.1:${servicePort}${SOURCE_CONTROL_PROVIDER_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        v: 1, requestId: `req-${handle.slice(0, 8)}`, method, provider: PROVIDER,
        session: { instance: forge.origin, handle, user: user ? { id: 7, login: 'mona' } : null },
        input,
      }),
    });
    expect(response.status).toBe(200);
    return schemas.envelope.parse(await response.json());
  } finally {
    handles.delete(handle);
  }
};

/** The data of a successful call, checked with the schema OpenChamber applies to that method. */
const data = async (method: SourceControlProviderMethod, input: SourceControlJsonObject, options?: { token?: string | null; user?: boolean }) => {
  const result = await call(method, input, options);
  if (!result.ok) throw new Error(`${method}: ${result.error.message}`);
  const checked = schemas.data[method].safeParse(result.data);
  if (!checked.success) throw new Error(`${method} answered a malformed ${JSON.stringify(result.data)}`);
  return result.data;
};

const field = (value: SourceControlJson, ...keys: Array<string | number>): SourceControlJson => keys.reduce<SourceControlJson>(
  (current, key) => (Object(current) === current && current !== null ? Object(current)[key] ?? null : null),
  value,
);

describe('source-control provider example', () => {
  const read = () => ({ context: {}, directory: repository, remote: 'origin' });
  const mutationContext = (target: SourceControlJsonObject) => ({
    directory: repository, primaryRemote: 'origin', repositoryId: 'repo-1', bindingRevision: 1,
    target: { repositoryId: 'repo-1', bindingRevision: 1, primaryRemote: 'origin', project: { id: '1', owner: 'mona', name: 'teapot' }, ...target },
  });

  test('signs in: the account behind a token, and whether the instance is this forge', async () => {
    expect(await data('auth.verify', {}, { user: false })).toEqual({
      user: { id: 7, login: 'mona', name: 'Mona Teapot', email: 'mona@example.com' },
    });
    expect(await data('auth.probe', {}, { token: null, user: false })).toEqual({ supported: true, version: '1.22.0' });
    forge.refuseToken('revoked');
    const refused = await call('auth.verify', {}, { token: 'revoked', user: false });
    expect(refused).toMatchObject({ ok: false, error: { status: 401 } });
  });

  test('reads resolve the repository from the bound remote and answer as OpenChamber DTOs', async () => {
    const status = await data('changeRequestStatus', { ...read(), branch: 'feature', force: false });
    expect(field(status, 'changeRequest', 'number')).toBe(2);
    expect(field(status, 'identity')).toEqual({ provider: PROVIDER, instance: forge.origin });
    expect(field(await data('changeRequestStatus', { ...read(), branch: 'nothing', force: false }), 'changeRequest')).toBeNull();

    expect(field(await data('listChangeRequests', { ...read(), page: 1, state: 'open', people: 'any' }), 'items', 0, 'head')).toBe('feature');
    const issues = await data('listIssues', { ...read(), page: 1, state: 'open', people: 'any' });
    expect(field(issues, 'items', 0, 'number')).toBe(1);
    expect(field(issues, 'hasMore')).toBe(false);
    expect(field(await data('getIssue', { ...read(), number: 1 }), 'title')).toBe('Kettle whistles too early');
    expect(await data('issueComments', { ...read(), number: 1 })).toEqual([]);
    expect(field(await data('changeRequestContext', {
      ...read(), number: 2, includeDiff: false, includeCIDetails: false, includeTimeline: false,
    }), 'changeRequest', 'base')).toBe('main');
    expect(await data('projectBranches', { ...read(), project: { owner: 'mona', name: 'teapot' } })).toEqual(['main', 'feature', 'docs']);
    expect(await data('projectUpstream', read())).toEqual({ identity: { provider: PROVIDER, instance: forge.origin }, isFork: false, upstream: null });
    expect(await call('listLabels', { ...read(), project: { owner: 'mona', name: 'teapot' } })).toMatchObject({ ok: false, error: { status: 501 } });
  });

  test('a pull request\'s diff, split per file in its context, and both sides of a changed file', async () => {
    const patch = await data('readChangeRequestPatch', { ...read(), number: 2 });
    expect(field(patch, 'meta')).toEqual({ owner: 'mona', repo: 'teapot', number: 2 });
    const diff = String(field(patch, 'patch'));
    expect(diff).toStartWith('diff --git a/README.md b/README.md\n');
    expect(diff).toContain('+Steep for three minutes.\n');

    const context = await data('changeRequestContext', {
      ...read(), number: 2, includeDiff: true, includeCIDetails: false, includeTimeline: false,
    });
    expect(field(context, 'diff')).toBe(diff);
    expect(field(context, 'files')).toEqual([{ path: 'README.md', status: 'modified', additions: 2, deletions: 1, changes: 3, patch: diff }]);

    expect(await data('readChangeRequestFile', { ...read(), number: 2, path: 'README.md', status: 'M' })).toEqual({
      original: 'Steep for two minutes.\n', modified: 'Steep for three minutes.\nThen pour.\n',
    });
    expect(await data('readChangeRequestFile', { ...read(), number: 2, path: 'README.md', status: 'A' })).toEqual({
      original: '', modified: 'Steep for three minutes.\nThen pour.\n',
    });
    // Only the bound repository's network, and only paths inside the repository.
    expect(await call('readChangeRequestPatch', { ...read(), number: 2, sourceRepo: { owner: 'mona', repo: 'kettle' } }))
      .toMatchObject({ ok: false, error: { status: 404, code: 'NOT_IN_NETWORK' } });
    expect(await call('readChangeRequestFile', { ...read(), number: 2, path: '../secrets', status: 'M' }))
      .toMatchObject({ ok: false, error: { status: 400 } });
  });

  test('live summaries leave out an item the forge cannot answer', async () => {
    const live = await data('liveSummaries', {
      refs: [{ owner: 'mona', repo: 'teapot', number: 2 }],
      issueRefs: [{ owner: 'mona', repo: 'teapot', number: 1 }, { owner: 'mona', repo: 'teapot', number: 99 }],
    });
    expect(field(live, 'summaries', 0, 'state')).toBe('open');
    expect(field(live, 'issueSummaries')).toEqual([{ owner: 'mona', repo: 'teapot', number: 1, title: 'Kettle whistles too early', state: 'open' }]);
  });

  test('a change request head and its source, for a worktree', async () => {
    const head = await data('readChangeRequestHead', { ...read(), number: 2 });
    expect(head).toEqual({ project: { id: '1', owner: 'mona', name: 'teapot' }, headSha: 'b'.repeat(40), headBranch: 'feature', headOwner: 'mona' });
    const source = await data('resolveChangeRequestSource', {
      ...read(), project: { id: '1', owner: 'mona', name: 'teapot' }, number: 2, expectedHeadSha: 'b'.repeat(40),
    });
    expect(source).toMatchObject({ classification: 'same-repository', headRef: 'refs/heads/feature', endpoint: `${forge.origin}/mona/teapot.git` });
    expect(await call('resolveChangeRequestSource', {
      ...read(), project: { id: '1', owner: 'mona', name: 'teapot' }, number: 2, expectedHeadSha: 'f'.repeat(40),
    })).toMatchObject({ ok: false, error: { status: 409 } });
  });

  test('mutations: resolve, write once, and reconcile from what the forge shows', async () => {
    const before = forge.writes.length;
    const create = await data('mutation.resolveTarget', {
      context: mutationContext({ head: 'docs', base: 'main' }), kind: 'change-request-create', input: { title: 'Docs', draft: false },
    });
    expect(field(create, 'target')).toEqual({
      repositoryId: 'repo-1', bindingRevision: 1, primaryRemote: 'origin', project: { id: '1', owner: 'mona', name: 'teapot' }, head: 'docs', base: 'main',
    });
    const resolved = { providerTarget: field(create, 'providerTarget'), target: field(create, 'target') };
    const step = { route: '/pr/create', kind: 'change-request-create', input: { title: 'Docs', body: 'Adds docs', draft: false }, resolved };
    expect(await data('mutation.perform', step)).toEqual({ number: 3 });
    expect(forge.writes.length).toBe(before + 1);
    expect(await data('mutation.reconcile', step)).toEqual({ state: 'succeeded', result: { number: 3 } });
    expect(forge.writes.length).toBe(before + 1);

    const comment = await data('mutation.resolveTarget', { context: mutationContext({ number: 1 }), kind: 'issue-comment', input: { body: 'Seen it' } });
    expect(await data('mutation.perform', {
      route: '/issues/comment', kind: 'issue-comment', input: { body: 'Seen it' },
      resolved: { providerTarget: field(comment, 'providerTarget'), target: field(comment, 'target') },
    })).toEqual({});
    expect(await data('issueComments', { ...read(), number: 1 })).toMatchObject([{ body: 'Seen it' }]);

    const merge = await data('mutation.resolveTarget', { context: mutationContext({ number: 2 }), kind: 'change-request-merge', input: { method: 'merge' } });
    expect(field(merge, 'target', 'headSha')).toBe('b'.repeat(40));
    const mergeStep = {
      route: '/pr/merge', kind: 'change-request-merge', input: { method: 'merge' },
      resolved: { providerTarget: field(merge, 'providerTarget'), target: field(merge, 'target') },
    };
    expect(await data('mutation.perform', mergeStep)).toEqual({ merged: true });
    expect(await data('mutation.reconcile', mergeStep)).toEqual({ state: 'succeeded', result: { merged: true } });

    // A head that moved since the user looked is refused before anything is written.
    forge.push('docs', 'd'.repeat(40));
    const stale = await call('mutation.resolveTarget', {
      context: mutationContext({ number: 3, headSha: 'c'.repeat(40) }), kind: 'change-request-merge', input: { method: 'merge' },
    });
    expect(stale).toMatchObject({ ok: false, error: { status: 409, code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH' } });
  });

  test('a merged branch shows its pull request, not an offer to open one', async () => {
    // Merged in the test above, so it is no longer among the open pull requests.
    const status = await data('changeRequestStatus', { ...read(), branch: 'feature', force: false });
    expect(field(status, 'changeRequest', 'number')).toBe(2);
    expect(field(status, 'changeRequest', 'state')).toBe('merged');
    expect(field(status, 'canMerge')).toBe(false);
  });

  test('edits a pull request and reconciles the edit by reading it back', async () => {
    const before = forge.writes.length;
    const resolution = await data('mutation.resolveTarget', {
      context: mutationContext({ number: 3 }), kind: 'change-request-update', input: { title: 'Docs, revised', body: 'More docs' },
    });
    const step = {
      route: '/pr/update', kind: 'change-request-update', input: { title: 'Docs, revised', body: 'More docs' },
      resolved: { providerTarget: field(resolution, 'providerTarget'), target: field(resolution, 'target') },
    };
    expect(await call('mutation.reconcile', step)).toMatchObject({ ok: true, data: { state: 'outcome-unknown' } });
    expect(await data('mutation.perform', step)).toEqual({});
    expect(forge.writes.length).toBe(before + 1);
    expect(await data('mutation.reconcile', step)).toEqual({ state: 'succeeded', result: {} });
    const context = await data('changeRequestContext', {
      ...read(), number: 3, includeDiff: false, includeCIDetails: false, includeTimeline: false,
    });
    expect(field(context, 'changeRequest', 'title')).toBe('Docs, revised');
    expect(field(context, 'changeRequest', 'body')).toBe('More docs');
  });

  test('opens a pull request from a fork remote as owner:branch, and refuses a remote outside the network', async () => {
    const before = forge.writes.length;
    const input = { title: 'From the fork', draft: false, headRemote: 'fork' };
    const resolution = await data('mutation.resolveTarget', {
      context: mutationContext({ head: 'fork-feature', base: 'main' }), kind: 'change-request-create', input,
    });
    expect(field(resolution, 'providerTarget')).toEqual({ repoId: 1, owner: 'mona', name: 'teapot', sourceRepoId: 2, sourceOwner: 'octo' });
    const step = {
      route: '/pr/create', kind: 'change-request-create', input,
      resolved: { providerTarget: field(resolution, 'providerTarget'), target: field(resolution, 'target') },
    };
    const created = await data('mutation.perform', step);
    expect(forge.writes.length).toBe(before + 1);
    const number = field(created, 'number');
    expect(await data('mutation.reconcile', step)).toEqual({ state: 'succeeded', result: { number } });
    const head = await data('readChangeRequestHead', { ...read(), number });
    expect(head).toMatchObject({ headBranch: 'fork-feature', headOwner: 'octo', headSha: 'e'.repeat(40) });
    // A same-named branch in the target repository is a different pull request: reconcile does not take it for this one.
    const sameName = { ...step, resolved: { ...step.resolved, providerTarget: { repoId: 1, owner: 'mona', name: 'teapot', sourceRepoId: 1, sourceOwner: 'mona' } } };
    expect(await data('mutation.reconcile', sameName)).toEqual({ state: 'outcome-unknown' });

    for (const refused of [{ headRemote: 'stranger' }, { remote: 'fork' }]) {
      const answer = await call('mutation.resolveTarget', {
        context: mutationContext({ head: 'main', base: 'main' }), kind: 'change-request-create', input: { title: 'Nope', draft: false, ...refused },
      });
      expect(answer).toMatchObject({ ok: false, error: { status: 409, code: 'SOURCE_CONTROL_MUTATION_REMOTE_MISMATCH' } });
    }
    expect(forge.writes.length).toBe(before + 1);
  });
});
