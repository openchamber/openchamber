import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMutationExecutor } from './mutation-executor.js';
import { createSourceControlAuthStore } from './auth-storage.js';
import { buildExtensionDescriptor } from './extension-descriptor.js';
import { createExtensionProvider } from './extension-provider.js';
import { createOutboundHandles } from './outbound-handles.js';
import { createProviderDescriptors } from './provider-descriptors.js';
import { createAccountEvents } from './provider-registry.js';
import { registerSourceControlRoutes } from './routes.js';
import { githubDescriptor } from '../github/descriptor.js';

const contribution = JSON.parse(fs.readFileSync(
  new URL('../../../../sdk/examples/source-control-provider/package.json', import.meta.url), 'utf8',
)).openchamber.contributes.sourceControl;
const descriptor = buildExtensionDescriptor({ guestId: 'forge', contribution, guest: { name: 'Forge', version: '1.2.0' } });

/** A registry with GitHub (never loaded) and extensions whose implementations `buildImplementation` supplies. */
const fakeProviders = (buildImplementation) => {
  const descriptors = createProviderDescriptors([githubDescriptor]);
  const impls = new Map();
  return {
    descriptors,
    events: createAccountEvents(),
    has: (id) => descriptors.has(id),
    list: () => descriptors.list(),
    describe: (id) => descriptors.get(id),
    implementation: async (id) => impls.get(id) ?? null,
    readTransportCredential: async () => null,
    registerExtension: ({ descriptor: added, guest }) => {
      descriptors.attachExtension(added);
      impls.set(added.id, buildImplementation
        ? buildImplementation({ descriptor: added, guest })
        : {
          descriptor: added,
          classifyFailure: () => 'provider-error',
          auth: {
            status: async ({ instance }) => ({ provider: added.id, instance, status: 'disconnected', connected: false }),
            listInstances: async () => [],
            listConnectedAccounts: async () => [],
          },
        });
    },
    unregisterExtension: (id) => {
      impls.delete(id);
      return descriptors.detachExtension(id);
    },
  };
};

let server;
let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-ext-routes-'));
});
afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

const start = async ({ providers = fakeProviders(), bindingService = {}, mutationExecutor } = {}) => {
  const app = express();
  app.use(express.json());
  const shell = registerSourceControlRoutes(app, { providers, bindingService, mutationExecutor });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, body === undefined ? undefined : {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const get = (path) => send('GET', path);
  const post = (path, body) => send('POST', path, body ?? {});
  return { shell, get, post, providers };
};

const guest = {
  id: 'forge', name: 'Forge', version: '1.2.0', packageRoot: '/pkg',
  service: { entry: 'service/main.js', provides: ['source-control'] },
  sourceControl: contribution, capabilityGrants: ['service'],
};
const reviewState = {
  connected: true, viewerIsAuthor: false, headSha: 'b'.repeat(40),
  draft: null, threads: [], truncated: false,
};

/** A real extension implementation whose guest service answers auth, reads the review state and takes mutations. */
const implementationFor = ({ descriptor: added, guest: record }, { onReview, onMutation, performError, reviewAnswer = reviewState } = {}) => {
  const authStore = createSourceControlAuthStore({ filePath: path.join(dir, 'source-control-auth.json') });
  return createExtensionProvider({
    descriptor: added,
    guest: record,
    store: authStore.section(added.id),
    events: createAccountEvents(),
    handles: createOutboundHandles({ fetch: async () => new Response('{}', { status: 200 }) }),
    persistPath: path.join(dir, 'extensions.json'),
    currentGuest: async (guestId) => (guestId === record.id ? record : null),
    reconcile: async () => undefined,
    proxy: async ({ body }) => {
      const request = JSON.parse(body);
      if (request.method === 'auth.probe') {
        return { status: 200, body: JSON.stringify({ ok: true, data: { supported: true } }) };
      }
      if (request.method === 'auth.verify') {
        return { status: 200, body: JSON.stringify({ ok: true, data: { user: { id: 7, login: 'mona' } } }) };
      }
      if (request.method === 'reviewState') {
        onReview?.(request.input);
        return { status: 200, body: JSON.stringify({ ok: true, data: reviewAnswer }) };
      }
      if (request.method === 'mutation.resolveTarget') {
        const { context } = request.input;
        return {
          status: 200,
          body: JSON.stringify({
            ok: true,
            data: {
              providerTarget: { repoId: 1, owner: context.target.project.owner, name: context.target.project.name, number: context.target.number },
              target: {
                ...context.target,
                repositoryId: context.repositoryId,
                bindingRevision: context.bindingRevision,
                primaryRemote: context.primaryRemote,
              },
            },
          }),
        };
      }
      if (request.method === 'mutation.perform') {
        onMutation?.(request.input);
        if (performError) return { status: 200, body: JSON.stringify({ ok: false, error: performError }) };
        return { status: 200, body: JSON.stringify({ ok: true, data: {} }) };
      }
      if (request.method === 'mutation.reconcile') {
        return { status: 200, body: JSON.stringify({ ok: true, data: { state: 'succeeded', result: {} } }) };
      }
      return { status: 200, body: JSON.stringify({ ok: true, data: {} }) };
    },
  });
};

const mount = async (declared, hooks = {}) => {
  const providers = fakeProviders((input) => implementationFor(input, hooks));
  const trusted = { accountId: null };
  const setup = await start({
    providers,
    bindingService: {
      validateReadContext: async (context) => ({ ...context, accountId: trusted.accountId }),
      validateMutationContext: async (body) => ({ ...body, accountId: trusted.accountId, instance: 'https://forge.example' }),
    },
    mutationExecutor: createMutationExecutor({ store: makeStore() }),
  });
  const descriptor = buildExtensionDescriptor({
    guestId: 'forge', contribution: declared, guest: { name: 'Forge', version: '1.2.0' },
  });
  setup.shell.registerExtensionProvider({ descriptor, guest: { ...guest, sourceControl: declared } });
  const impl = await providers.implementation('ext-forge');
  await impl.auth.connectToken({ instance: 'https://forge.example', token: 'secret-token' });
  trusted.accountId = (await impl.auth.resolveAccount({ instance: 'https://forge.example' })).accountId;
  return { ...setup, accountId: trusted.accountId };
};

const makeStore = () => {
  const records = new Map();
  return {
    records,
    withExecutionLock: async (_key, operation) => operation(),
    async read(key) { return records.get(key) ?? null; },
    async claim(record) {
      const existing = records.get(record.key);
      if (existing) return existing.inputDigest === record.inputDigest
        ? { status: 'existing', record: existing }
        : { status: 'conflict', record: existing };
      const running = { ...record, state: 'running' };
      records.set(record.key, running);
      return { status: 'claimed', record: running };
    },
    async complete(key, inputDigest, completion) {
      const existing = records.get(key);
      if (!existing || existing.inputDigest !== inputDigest || existing.state !== 'running') throw new Error('conflict');
      const completed = { ...existing, ...completion };
      records.set(key, completed);
      return completed;
    },
  };
};
const statePath = '/api/source-control/ext-forge/pr/review/state?directory=/repo&owner=mona&repo=teapot&number=2&instance=https%3A%2F%2Fforge.example';

describe('extension provider routes', () => {
  it('serve a mounted extension, fall through to the catch-all once unmounted, and list it with its marker', async () => {
    const { shell, get } = await start();
    const statusPath = '/api/source-control/ext-forge/auth/status?instance=https%3A%2F%2Fforge.example';
    expect(await get(statusPath)).toMatchObject({ status: 404, body: { code: 'SOURCE_CONTROL_PROVIDER_UNAVAILABLE' } });

    shell.registerExtensionProvider({ descriptor, guest: { id: 'forge' } });
    expect(await get(statusPath)).toEqual({ status: 200, body: {
      provider: 'ext-forge', instance: 'https://forge.example', status: 'disconnected', connected: false,
    } });
    // A capability the extension turns off still answers, with the stable 501.
    expect((await get('/api/source-control/ext-forge/references/labels?directory=/r&owner=a&repo=b')).status).toBe(501);
    const { body } = await get('/api/source-control/providers');
    expect(body.providers.map((provider) => provider.id)).toEqual(['github', 'ext-forge']);
    expect(body.providers[0]).not.toHaveProperty('extension');
    expect(body.providers[1].extension).toEqual({ guestId: 'forge', name: 'Forge', version: '1.2.0' });

    shell.unregisterExtensionProvider('ext-forge');
    expect(await get(statusPath)).toMatchObject({ status: 404, body: { code: 'SOURCE_CONTROL_PROVIDER_UNAVAILABLE' } });
    expect((await get('/api/source-control/providers')).body.providers.map((provider) => provider.id)).toEqual(['github']);
  });

  it('answers the review state read by forwarding to a guest that declares review drafts', async () => {
    const forwarded = [];
    const { get } = await mount(contribution, { onReview: (input) => forwarded.push(input) });
    expect(await get(statePath)).toEqual({ status: 200, body: reviewState });
    expect(forwarded.at(-1)).toMatchObject({
      directory: '/repo', number: 2, project: { owner: 'mona', name: 'teapot' },
    });
  });

  it('offers Reply or Resolve on a thread an extension reads back only where its manifest declares that write', async () => {
    const thread = {
      id: 't1', path: 'README.md', side: 'new', line: 2, startLine: null, resolved: false,
      canReply: true, canResolve: true, comments: [],
    };
    const withThreads = (reviewThreads) => ({ ...contribution, capabilities: { ...contribution.capabilities, reviewThreads } });
    const undeclared = await mount(withThreads(undefined), { reviewAnswer: { ...reviewState, threads: [thread] } });
    expect(await undeclared.get(statePath)).toEqual({
      status: 200, body: { ...reviewState, threads: [{ ...thread, canReply: false, canResolve: false }] },
    });
    const replyOnly = await mount(withThreads({ reply: true }), { reviewAnswer: { ...reviewState, threads: [
      { ...thread, outdated: true }, { ...thread, id: 't2', canReply: false }, { ...thread, id: 'threads/3' },
    ] } });
    // A thread id the thread routes would refuse stays readable but offers no write.
    expect(await replyOnly.get(statePath)).toEqual({
      status: 200, body: { ...reviewState, threads: [
        { ...thread, outdated: true, canResolve: false }, { ...thread, id: 't2', canReply: false, canResolve: false },
        { ...thread, id: 'threads/3', canReply: false, canResolve: false },
      ] },
    });
  });

  const draftBody = (accountId, input = {}, key = 'review-draft-one') => ({
    directory: '/repo', repositoryId: 'repo-1', bindingRevision: 1, primaryRemote: 'origin',
    accountId, instance: 'https://forge.example', idempotencyKey: key,
    target: { project: { id: '1', owner: 'mona', name: 'teapot' }, number: 2, headSha: 'b'.repeat(40) },
    ...input,
  });
  const draftWrites = [
    ['/pr/review/comment', { path: 'README.md', side: 'new', line: 2, body: 'Draft one' },
      { position: { path: 'README.md', side: 'new', line: 2 }, body: 'Draft one' }],
    ['/pr/review/comment/update', { commentId: '501', body: 'Draft edited' }, { commentId: '501', body: 'Draft edited' }],
    ['/pr/review/comment/delete', { commentId: '501' }, { commentId: '501' }],
    ['/pr/review/discard', {}, {}],
  ];

  it.each(draftWrites)('forwards %s to a guest that declares review drafts', async (route, input, expected) => {
    const performs = [];
    const { post, accountId } = await mount(contribution, { onMutation: (request) => performs.push(request) });
    const response = await post(`/api/source-control/ext-forge${route}`, draftBody(accountId, input));
    expect(response).toMatchObject({ status: 200 });
    expect(response.body).toMatchObject({ status: 'succeeded', replayed: false, result: {} });
    expect(performs).toHaveLength(1);
    expect(performs[0]).toMatchObject({ route, kind: expect.stringContaining('change-request-review'), input: expected });
  });

  it('reads back a draft comment on a path as long as the write accepted', async () => {
    const longPath = `${'deep/'.repeat(400)}README.md`;
    expect(longPath.length).toBeGreaterThan(1_024);
    const performs = [];
    const { post, accountId } = await mount(contribution, { onMutation: (request) => performs.push(request) });
    const written = await post('/api/source-control/ext-forge/pr/review/comment', draftBody(accountId, { path: longPath, side: 'new', line: 2, body: 'Deep' }));
    expect(written).toMatchObject({ status: 200 });
    expect(performs[0]).toMatchObject({ input: { position: { path: longPath } } });

    const draft = {
      id: 'r1', body: '',
      comments: [{ id: '501', path: longPath, side: 'new', line: 2, startLine: null, body: 'Deep', author: { login: 'mona' } }],
    };
    const { get } = await mount(contribution, { reviewAnswer: { ...reviewState, draft } });
    expect(await get(statePath)).toEqual({ status: 200, body: { ...reviewState, draft } });
  });

  it('reports a guest that refuses a draft write before sending anything as failed, with its reason', async () => {
    const performError = { message: 'Gitea cannot remove one review comment; discard the review instead', status: 422 };
    const { post, accountId } = await mount(contribution, { performError });
    const response = await post('/api/source-control/ext-forge/pr/review/comment/delete', draftBody(accountId, { commentId: '501' }));
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toContain('cannot remove one review comment');
  });

  it('refuses a whole-file draft comment before the guest when the manifest turns file comments off', async () => {
    const performs = [];
    const { post, accountId } = await mount(contribution, { onMutation: (request) => performs.push(request) });
    expect(contribution.capabilities.reviewDrafts).toEqual({ fileComments: false });
    const response = await post('/api/source-control/ext-forge/pr/review/comment', draftBody(accountId, { path: 'README.md', body: 'On the file' }));
    expect(response).toMatchObject({ status: 400, body: { code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT' } });
    expect(performs).toHaveLength(0);
  });

  it.each(draftWrites)('answers 501 for %s when the manifest does not declare review drafts', async (route, input) => {
    const performs = [];
    const withoutDrafts = { ...contribution, capabilities: { ...contribution.capabilities, reviewDrafts: undefined } };
    const { post, accountId } = await mount(withoutDrafts, { onMutation: (request) => performs.push(request) });
    const response = await post(`/api/source-control/ext-forge${route}`, draftBody(accountId, input));
    expect(response).toMatchObject({ status: 501, body: { code: 'SOURCE_CONTROL_CAPABILITY_UNSUPPORTED' } });
    expect(performs).toHaveLength(0);
  });

  it('still refuses the review state read when the manifest does not declare review drafts', async () => {
    const withoutDrafts = { ...contribution, capabilities: { ...contribution.capabilities, reviewDrafts: undefined } };
    const { get } = await mount(withoutDrafts);
    expect(await get(statePath)).toMatchObject({ status: 501, body: { code: 'SOURCE_CONTROL_CAPABILITY_UNSUPPORTED' } });
  });

  it('never reaches an extension router for a path that only looks like one', async () => {
    const { shell, get } = await start();
    shell.registerExtensionProvider({ descriptor, guest: { id: 'forge' } });
    expect((await get('/api/source-control/ext-forgery/auth/status')).status).toBe(404);
    expect((await get('/api/source-control/ext-forge/nothing-here')).body.code).toBe('SOURCE_CONTROL_PROVIDER_UNAVAILABLE');
  });
});
