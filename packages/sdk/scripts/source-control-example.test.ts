import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startExampleService } from './fixtures/example-service';
import { FAKE_FORGE_FORK, FAKE_FORGE_OWNER, FAKE_FORGE_REPO, FAKE_FORGE_STRANGER, startFakeForge, type FakeForge } from '../examples/source-control-provider/fake-forge';
import { readReferences } from '../examples/source-control-provider/service/references';
import { readReviews } from '../examples/source-control-provider/service/reviewer-states';
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

  ({ service, port: servicePort } = await startExampleService({
    entry: serviceEntry,
    token: serviceToken,
    env: {
      [OPENCHAMBER_HOST_CALLBACK_URL]: `http://127.0.0.1:${callback.port}`,
    },
  }));
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

  test('the timeline references the host asked for, mapped and deduped', async () => {
    const detail = await data('getIssue', { ...read(), number: 1, includeReferences: true });
    expect(field(detail, 'references')).toEqual([{
      kind: 'pull', number: 2, url: `${forge.origin}/mona/teapot/pulls/2`, createdAt: '2026-10-03T10:00:00Z',
      title: 'Steep longer', repo: 'mona/teapot', author: { login: 'octo', avatarUrl: 'https://avatars.example.com/octo.png' },
    }]);
    expect(Object.hasOwn(await data('getIssue', { ...read(), number: 1 }), 'references')).toBe(false);

    const context = await data('changeRequestContext', {
      ...read(), number: 2, includeDiff: false, includeCIDetails: false, includeTimeline: true, includeReferences: true,
    });
    expect(field(context, 'references')).toEqual([
      { kind: 'issue', number: 5, url: `${forge.origin}/mona/kettle/issues/5`, createdAt: '2026-10-02T10:00:00Z', title: 'Steam wand', repo: 'mona/kettle', author: { login: 'mona' } },
      { kind: 'issue', number: 1, url: `${forge.origin}/mona/teapot/issues/1`, createdAt: '2026-10-06T10:00:00Z', title: 'Kettle whistles too early', repo: 'mona/teapot', author: { login: 'mona' } },
    ]);
    expect(field(context, 'reviewerStates')).toContainEqual({ user: { id: '9', username: 'ann' }, state: 'approved' });
    expect(Object.hasOwn(await data('changeRequestContext', {
      ...read(), number: 2, includeDiff: false, includeCIDetails: false, includeTimeline: true,
    }), 'references')).toBe(false);
  });

  test('a recent mention past a first timeline page of ordinary events is still read', async () => {
    const comment = { type: 'comment', created_at: '2026-10-01T10:00:00Z' };
    const mention = { type: 'issue_ref', created_at: '2026-10-09T10:00:00Z', ref_issue: { number: 9, html_url: `${forge.origin}/mona/teapot/issues/9` } };
    const pages = [Array(50).fill(comment), Array(50).fill(comment), [comment, mention]];
    const asked: number[] = [];
    const references = await readReferences(async (page) => {
      asked.push(page);
      return { data: pages[page - 1] ?? [], total: 102 };
    });
    expect(references).toEqual([{ kind: 'issue', number: 9, url: mention.ref_issue.html_url, createdAt: mention.created_at }]);
    expect(asked.sort()).toEqual([1, 2, 3]);
  });

  test('a stalled timeline gives up its references instead of the whole detail', async () => {
    expect(await readReferences(() => new Promise(() => undefined), 10)).toEqual([]);
  });

  test('a short review page with more after it does not end the roster', async () => {
    const reviews = await readReviews(2, async (page) => ({
      data: page === 1 ? [{ user: { id: 9, login: 'ann' }, state: 'APPROVED' }] : page === 2 ? [{ user: { id: 10, login: 'bob' }, state: 'APPROVED' }] : [],
      total: 4,
    }), 1_000);
    expect(reviews?.map((review) => review.user?.login)).toEqual(['ann', 'bob']);
  });

  test('a stalled second review page drops partial reviewer states', async () => {
    const asked: number[] = [];
    const reviews = await readReviews(1, async (page) => {
      asked.push(page);
      return page === 1
        ? { data: [{ user: { id: 9, login: 'ann' }, state: 'APPROVED' }], total: 2 }
        : new Promise(() => undefined);
    }, 10);
    expect(asked).toEqual([1, 2]);
    expect(reviews).toBeNull();
  }, 500);

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

  test('dismisses and restores a review it lists, and reads each back from the forge', async () => {
    const readContext = () => data('changeRequestContext', {
      ...read(), number: 2, includeDiff: false, includeCIDetails: false, includeTimeline: true,
    });
    const reviewOf = async (id: string) => (
      await fetch(`${forge.origin}/api/v1/repos/mona/teapot/pulls/2/reviews/${id}`, { headers: { authorization: 'token good' } })
    ).json();
    const context = await readContext();
    // Mona owns the repository, so the example offers the dismissal Gitea would let her make.
    expect(field(context, 'canDismissReviews')).toBe(true);
    const reviews = field(context, 'reviews');
    expect(reviews).toContainEqual({ id: '402', state: 'changes_requested', author: { login: 'bob' }, submittedAt: '2026-10-01T10:01:00Z' });
    expect(reviews).toContainEqual(expect.objectContaining({ id: '404', state: 'dismissed', author: { login: 'dee' } }));

    const before = forge.writes.length;
    const step = async (input: SourceControlJsonObject) => {
      const resolved = await data('mutation.resolveTarget', { context: mutationContext({ number: 2 }), kind: 'change-request-review-dismiss', input });
      const call = {
        route: '/pr/review/dismiss', kind: 'change-request-review-dismiss', input,
        resolved: { providerTarget: field(resolved, 'providerTarget'), target: field(resolved, 'target') },
      };
      expect(await data('mutation.perform', call)).toEqual({});
      return data('mutation.reconcile', call);
    };

    expect(await step({ reviewId: '402', dismissed: true, message: 'Addressed in the rewrite' })).toEqual({ state: 'succeeded', result: {} });
    expect(await reviewOf('402')).toMatchObject({ id: 402, dismissed: true });
    expect(field(await readContext(), 'reviews')).toContainEqual(expect.objectContaining({ id: '402', state: 'dismissed' }));

    expect(await step({ reviewId: '402', dismissed: false })).toEqual({ state: 'succeeded', result: {} });
    expect(await reviewOf('402')).toMatchObject({ id: 402, dismissed: false });
    expect(field(await readContext(), 'reviews')).toContainEqual(expect.objectContaining({ id: '402', state: 'changes_requested' }));
    expect(forge.writes.length).toBe(before + 2);

    // Ann's review reads back without a dismissal flag, so a restart cannot call a restore of it done.
    const restart = await data('mutation.resolveTarget', { context: mutationContext({ number: 2 }), kind: 'change-request-review-dismiss', input: {} });
    expect(await data('mutation.reconcile', {
      route: '/pr/review/dismiss', kind: 'change-request-review-dismiss', input: { reviewId: '401', dismissed: false },
      resolved: { providerTarget: field(restart, 'providerTarget'), target: field(restart, 'target') },
    })).toEqual({ state: 'outcome-unknown' });

    // A review that is not on this pull request is refused before anything is written.
    const resolved = await data('mutation.resolveTarget', { context: mutationContext({ number: 2 }), kind: 'change-request-review-dismiss', input: {} });
    expect(await call('mutation.perform', {
      route: '/pr/review/dismiss', kind: 'change-request-review-dismiss', input: { reviewId: '9999', dismissed: true, message: 'x' },
      resolved: { providerTarget: field(resolved, 'providerTarget'), target: field(resolved, 'target') },
    })).toMatchObject({ ok: false, error: { status: 409, code: 'SOURCE_CONTROL_MUTATION_TARGET_INVALID' } });
    expect(forge.writes.length).toBe(before + 2);
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

  test('a pull request context names each reviewer\'s state, and leaves the field out when there is none', async () => {
    const context = await data('changeRequestContext', {
      ...read(), number: 2, includeDiff: false, includeCIDetails: false, includeTimeline: true,
    });
    expect(field(context, 'reviewerStates')).toEqual([
      { user: { id: '9', username: 'ann' }, state: 'approved' },
      { user: { id: '10', username: 'bob' }, state: 'changes_requested' },
      // A dismissed approval is no longer an approval, though it sits on the
      // second page of reviews, after an approval on the first.
      { user: { id: '12', username: 'dee' }, state: 'pending' },
      { user: { id: '11', username: 'cid' }, state: 'pending' },
    ]);
    const none = await data('changeRequestContext', {
      ...read(), number: 3, includeDiff: false, includeCIDetails: false, includeTimeline: true,
    });
    expect(field(none, 'reviewerStates')).toBeNull();
  });

  test('a comment is edited or deleted only on the item it belongs to', async () => {
    const commentsOn = async (number: number): Promise<Array<{ id: number; body: string }>> => (
      await fetch(`${forge.origin}/api/v1/repos/mona/teapot/issues/${number}/comments`, { headers: { authorization: 'token good' } })
    ).json();
    const post = async (number: number, kind: 'issue-comment' | 'change-request-comment', body: string) => {
      const resolved = await data('mutation.resolveTarget', { context: mutationContext({ number }), kind, input: { body } });
      await data('mutation.perform', {
        route: kind === 'issue-comment' ? '/issues/comment' : '/pr/comment', kind, input: { body },
        resolved: { providerTarget: field(resolved, 'providerTarget'), target: field(resolved, 'target') },
      });
      const comment = (await commentsOn(number)).find((entry) => entry.body === body);
      if (!comment) throw new Error(`${body} was not posted`);
      return String(comment.id);
    };
    const step = async (number: number, kind: string, input: SourceControlJsonObject) => {
      const resolved = await data('mutation.resolveTarget', { context: mutationContext({ number }), kind, input });
      return {
        route: kind.startsWith('issue-') ? '/issues/comment' : '/pr/comment', kind, input,
        resolved: { providerTarget: field(resolved, 'providerTarget'), target: field(resolved, 'target') },
      };
    };
    const onIssue = await post(1, 'issue-comment', 'Kept on the issue');
    // Gitea leaves `issue_url` empty on a pull request comment and names the pull request instead.
    const onPull = await post(2, 'change-request-comment', 'Kept on the pull request');
    const before = forge.writes.length;

    // Another item's comment id is refused before anything is written.
    for (const wrong of [
      await step(1, 'issue-comment-update', { commentId: onPull, body: 'Hijacked' }),
      await step(1, 'issue-comment-delete', { commentId: onPull }),
      await step(2, 'change-request-comment-update', { commentId: onIssue, body: 'Hijacked' }),
      await step(2, 'change-request-comment-delete', { commentId: onIssue }),
    ]) {
      expect(await call('mutation.perform', wrong), wrong.kind).toMatchObject({ ok: false, error: { status: 409, code: 'SOURCE_CONTROL_MUTATION_TARGET_INVALID' } });
    }
    expect(forge.writes.length).toBe(before);

    // Each on its own item lands.
    expect(await data('mutation.perform', await step(1, 'issue-comment-update', { commentId: onIssue, body: 'Edited on the issue' }))).toEqual({});
    expect(await data('issueComments', { ...read(), number: 1 })).toMatchObject(expect.arrayContaining([expect.objectContaining({ body: 'Edited on the issue' })]));
    expect(await data('mutation.perform', await step(2, 'change-request-comment-delete', { commentId: onPull }))).toEqual({});
    expect((await commentsOn(2)).map((entry) => String(entry.id))).not.toContain(onPull);
    expect(forge.writes.length).toBe(before + 2);
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

  test('answers a failed route with a fixed message instead of the request text', async () => {
    const answer = await fetch(`${forge.origin}/api/v1/repos/${FAKE_FORGE_OWNER}/${FAKE_FORGE_REPO}/issues/1/comments`, {
      method: 'POST',
      headers: { authorization: 'token good', 'content-type': 'application/json' },
      body: '{"body": reflectedmarker}',
    });
    const text = await answer.text();
    expect(answer.status).toBe(500);
    expect(text).not.toContain('reflectedmarker');
    expect(JSON.parse(text)).toEqual({ message: 'The fake forge could not handle this request.' });
    expect(answer.headers.get('content-type')).toBe('application/json');
  });
});

describe('source-control provider review drafts', () => {
  const read = () => ({ context: {}, directory: repository, remote: 'origin' });
  const mutationContext = (target: SourceControlJsonObject) => ({
    directory: repository, primaryRemote: 'origin', repositoryId: 'repo-1', bindingRevision: 1,
    target: { repositoryId: 'repo-1', bindingRevision: 1, primaryRemote: 'origin', project: { id: '1', owner: 'mona', name: 'teapot' }, ...target },
  });
  const stepFor = async (number: number, kind: string, input: SourceControlJsonObject, route: string) => {
    const resolution = await data('mutation.resolveTarget', { context: mutationContext({ number }), kind, input });
    return {
      route, kind, input,
      resolved: { providerTarget: field(resolution, 'providerTarget'), target: field(resolution, 'target') },
    };
  };

  test('finds the viewer\'s pending review on a second page of reviews', async () => {
    const state = await data('reviewState', { ...read(), number: 6 });
    expect(field(state, 'draft', 'id')).toBe('701');
  });

  test('reads past a first page that another viewer\'s hidden pending review left short', async () => {
    const answer = await fetch(`${forge.origin}/api/v1/repos/mona/teapot/pulls/6/reviews?page=1&limit=50`, {
      headers: { authorization: 'token good' },
    });
    // The forge counted zoe's pending review, then hid it from this page.
    expect(answer.headers.get('x-total-count')).toBe('51');
    expect(await answer.json()).toHaveLength(49);
    expect(field(await data('reviewState', { ...read(), number: 6 }), 'draft', 'id')).toBe('701');
    // The draft still exists, so a discard replay cannot report success.
    const discard = await stepFor(6, 'change-request-review-discard', {}, '/pr/review/discard');
    expect(await data('mutation.reconcile', discard)).toEqual({ state: 'outcome-unknown' });
  });

  test('keeps a draft review pending on the pull request until it is discarded', async () => {
    const initial = await data('reviewState', { ...read(), number: 3 });
    expect(initial).toEqual({
      connected: true, viewerIsAuthor: true, headSha: 'd'.repeat(40), draft: null, threads: [], truncated: false,
    });

    const before = forge.writes.length;
    const create = await stepFor(3, 'change-request-review-comment', {
      position: { path: 'README.md', side: 'new', line: 2 }, body: 'Draft one',
    }, '/pr/review/comment');
    expect(await data('mutation.perform', create)).toEqual({});
    const createOld = await stepFor(3, 'change-request-review-comment', {
      position: { path: 'README.md', side: 'old', line: 1 }, body: 'Draft on the old side',
    }, '/pr/review/comment');
    expect(await data('mutation.perform', createOld)).toEqual({});
    expect(forge.writes.slice(before)).toEqual([
      { method: 'POST', path: '/api/v1/repos/mona/teapot/pulls/3/reviews' },
      { method: 'POST', path: '/api/v1/repos/mona/teapot/pulls/3/reviews' },
    ]);
    const opened = await data('reviewState', { ...read(), number: 3 });
    expect(field(opened, 'draft', 'body')).toBe('\u200b');
    expect(field(opened, 'draft', 'comments')).toEqual([
      { id: '501', path: 'README.md', side: 'new', line: 2, startLine: null, body: 'Draft one', author: { login: 'mona' } },
      { id: '502', path: 'README.md', side: 'old', line: 1, startLine: null, body: 'Draft on the old side', author: { login: 'mona' } },
    ]);

    const update = await stepFor(3, 'change-request-review-comment-update', { commentId: '501', body: 'Draft edited' }, '/pr/review/comment/update');
    expect(await data('mutation.perform', update)).toEqual({});
    expect(forge.writes.at(-1)).toEqual({ method: 'PATCH', path: '/api/v1/repos/mona/teapot/issues/comments/501' });
    expect(field(await data('reviewState', { ...read(), number: 3 }), 'draft', 'comments', 0, 'body')).toBe('Draft edited');

    // Gitea answers 204 to that DELETE and keeps the comment, so the service refuses before
    // writing anything; with no write sent, the host reports the refusal instead of an unknown outcome.
    const remove = await stepFor(3, 'change-request-review-comment-delete', { commentId: '501' }, '/pr/review/comment/delete');
    const writesBeforeDelete = forge.writes.length;
    const refused = await call('mutation.perform', remove);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? null : refused.error).toMatchObject({ status: 422, message: expect.stringContaining('cannot remove one review comment') });
    expect(forge.writes.length).toBe(writesBeforeDelete);
    expect(field(await data('reviewState', { ...read(), number: 3 }), 'draft', 'comments')).toHaveLength(2);

    const discard = await stepFor(3, 'change-request-review-discard', {}, '/pr/review/discard');
    expect(await data('mutation.perform', discard)).toEqual({});
    expect(await data('mutation.reconcile', discard)).toEqual({ state: 'succeeded', result: {} });
    expect(field(await data('reviewState', { ...read(), number: 3 }), 'draft')).toBeNull();
  });

  test('saves a comment on one line and refuses a range before writing to the forge', async () => {
    const before = forge.writes.length;
    const single = await stepFor(8, 'change-request-review-comment', {
      position: { path: 'README.md', side: 'new', line: 2 }, body: 'One line',
    }, '/pr/review/comment');
    expect(await data('mutation.perform', single)).toEqual({});
    expect(forge.writes.slice(before)).toEqual([{ method: 'POST', path: '/api/v1/repos/mona/teapot/pulls/8/reviews' }]);
    expect(field(await data('reviewState', { ...read(), number: 8 }), 'draft', 'comments')).toEqual([
      { id: expect.any(String), path: 'README.md', side: 'new', line: 2, startLine: null, body: 'One line', author: { login: 'mona' } },
    ]);

    const range = await stepFor(8, 'change-request-review-comment', {
      position: { path: 'README.md', side: 'new', startLine: 1, line: 3 }, body: 'Three lines',
    }, '/pr/review/comment');
    const refused = await call('mutation.perform', range);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? null : refused.error.message).toContain('one line only');
    expect(forge.writes.length).toBe(before + 1);
    expect(field(await data('reviewState', { ...read(), number: 8 }), 'draft', 'comments')).toHaveLength(1);
  });

  test('reads a review list longer than its scan as a failure, never as no draft', async () => {
    const state = await call('reviewState', { ...read(), number: 7 });
    expect(state.ok).toBe(false);
    expect(state.ok ? null : state.error.message).toContain('more reviews than this Git host scans');

    const before = forge.writes.length;
    const discard = await stepFor(7, 'change-request-review-discard', {}, '/pr/review/discard');
    expect((await call('mutation.perform', discard)).ok).toBe(false);
    expect(await data('mutation.reconcile', discard)).toEqual({ state: 'outcome-unknown' });
    expect(forge.writes.length).toBe(before);
  });
});
