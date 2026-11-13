import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SOURCE_CONTROL_OUTBOUND_PATH, createSourceControlForge, OPENCHAMBER_HOST_CALLBACK_URL } from '@openchamber/sdk';
import { startFakeForge } from '../../../../sdk/examples/source-control-provider/fake-forge.ts';
import { listInstalledGuests } from '../guests/catalog.js';
import { hostCallbackUrl, setHostCallbackRoute, stopHostCallbackListener } from '../guests/host-callback.js';
import { extensionsPersistPath } from '../guests/persist.js';
import { registerGuestRoutes } from '../guests/routes.js';
import { beginGuestServiceHost, beginGuestServiceShutdown, stopAllGuestServices } from '../guests/service.js';
import { createSourceControlAuthStore } from './auth-storage.js';
import { createExtensionProviders } from './extension-providers.js';
import { createMutationStore } from './mutation-storage.js';
import { createOutboundHandles } from './outbound-handles.js';
import { detachExtensionDescriptors } from './provider-descriptors.test-support.js';
import { createSourceControlProviders } from './provider-registry.js';
import { registerSourceControlRoutes } from './routes.js';

// The source-control role end to end: the checked-in example extension,
// installed and approved through the guest routes, its real service spawned
// by the guest service host, reaching the fake forge only through the
// callback listener and outbound handles, behind the real route shell,
// binding service, mutation executor and auth store.

const exampleDir = fileURLToPath(new URL('../../../../sdk/examples/source-control-provider', import.meta.url));
const GUEST = 'source-control-provider';
const PROVIDER = `ext-${GUEST}`;
const TOKEN = 'forge-secret-token';

let dataDir;
let repository;
let forge;
let server;
let base;
let shell;
let providers;
let authStore;
let handles;
let extensionProviders;
let changes = 0;
/** Rewrites what the forge answered before the service sees it: a stand-in for a service that misreports. */
let tamper = null;
let failNextComplete = false;

const request = async (method, route, body) => {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const git = (...args) => {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-scm-contract-'));
  repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-scm-contract-repo-')));
  beginGuestServiceHost();
  forge = await startFakeForge();
  git('init', '-q', repository);
  git('-C', repository, 'remote', 'add', 'origin', `${forge.origin}/mona/teapot.git`);

  handles = createOutboundHandles();
  setHostCallbackRoute(SOURCE_CONTROL_OUTBOUND_PATH, {
    refusal: handles.refusal,
    serve: async (input) => {
      const answer = await handles.serve(input);
      return tamper && answer.status === 200 ? { ...answer, body: tamper(answer.body) } : answer;
    },
  });
  const persistPath = extensionsPersistPath(dataDir);
  authStore = createSourceControlAuthStore({ filePath: path.join(dataDir, 'source-control-auth.json') });
  providers = createSourceControlProviders({ authStore, configRoot: dataDir, extensionServices: {
    handles,
    persistPath,
    currentGuest: async (guestId) => (await listInstalledGuests({ persistPath })).find((guest) => guest.id === guestId) ?? null,
    reconcile: () => extensionProviders.reconcile(),
  } });
  const mutationStore = createMutationStore({ filePath: path.join(dataDir, 'source-control-mutations.json') });
  const app = express();
  app.use(express.json());
  shell = registerSourceControlRoutes(app, {
    configRoot: dataDir,
    providers,
    mutationStore: {
      ...mutationStore,
      // A crash between the forge write and its record leaves the record running.
      complete: (...args) => {
        if (!failNextComplete) return mutationStore.complete(...args);
        failNextComplete = false;
        return Promise.reject(new Error('the server stopped'));
      },
    },
  });
  extensionProviders = createExtensionProviders({
    listGuests: () => listInstalledGuests({ persistPath }),
    register: shell.registerExtensionProvider,
    unregister: shell.unregisterExtensionProvider,
    dropSection: (id) => authStore.dropSection(id),
    emitChanged: () => { changes += 1; },
  });
  registerGuestRoutes(app, {
    openchamberDataDir: dataDir,
    openchamberVersion: '99.0.0',
    resolveGitBinaryForSpawn: () => 'git',
    resolveOptionalProjectDirectory: async () => null,
    getSmallModelService: () => null,
    onGuestDeactivated: (event) => extensionProviders.deactivated(event),
    onGuestActivated: () => extensionProviders.reconcile(),
  });
  await extensionProviders.reconcile();
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  beginGuestServiceShutdown();
  await stopAllGuestServices();
  await stopHostCallbackListener();
  detachExtensionDescriptors();
  await new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await forge?.close();
  for (const dir of [dataDir, repository]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const instanceQuery = () => `instance=${encodeURIComponent(forge.origin)}`;
const state = {};

const readQuery = (extra = {}) => new URLSearchParams({
  directory: repository,
  repositoryId: state.repositoryId,
  instance: forge.origin,
  accountId: state.accountId,
  bindingRevision: String(state.bindingRevision),
  primaryRemote: 'origin',
  ...extra,
}).toString();
const read = (suffix, extra) => request('GET', `/api/source-control/${PROVIDER}${suffix}?${readQuery(extra)}`);
const readContext = () => ({
  directory: repository, repositoryId: state.repositoryId, provider: PROVIDER, instance: forge.origin,
  accountId: state.accountId, bindingRevision: state.bindingRevision, primaryRemote: 'origin',
});
const mutate = (suffix, key, target, input) => request('POST', `/api/source-control/${PROVIDER}${suffix}`, {
  ...readContext(), idempotencyKey: key, target: { project: { owner: 'mona', name: 'teapot' }, ...target }, ...input,
});

describe('an extension as a Git host, end to end', () => {
  it('installs and approves through the guest routes, and lists the provider with its marker', async () => {
    const installed = await request('POST', '/api/guests', { path: exampleDir });
    expect(installed.status).toBe(201);
    expect(installed.body.guest.sourceControl).toEqual({ label: 'Teahouse', defaultInstances: [], custom: true });
    expect((await request('GET', '/api/source-control/providers')).body.providers.map(({ id }) => id)).not.toContain(PROVIDER);
    const approved = await request('PUT', `/api/guests/${GUEST}/capabilities`, { granted: installed.body.guest.capabilities.requested });
    expect(approved.status).toBe(200);
    const listed = (await request('GET', '/api/source-control/providers')).body.providers;
    expect(listed.map(({ id }) => id)).toEqual(['github', 'gitlab', 'gitea', 'gerrit', 'forgejo', PROVIDER]);
    expect(listed.at(-1)).toMatchObject({ label: 'Teahouse', extension: { guestId: GUEST, name: 'Teahouse Git host', version: '1.0.0' } });
    expect(changes).toBe(1);
  });

  it('connects a personal access token, verified through the service', async () => {
    const connected = await request('POST', `/api/source-control/${PROVIDER}/auth/token?${instanceQuery()}`, { token: TOKEN });
    expect(connected).toMatchObject({ status: 200, body: { connected: true, user: { id: 7, login: 'mona' } } });
    const status = await request('GET', `/api/source-control/${PROVIDER}/auth/status?${instanceQuery()}`);
    expect(status.body).toMatchObject({ status: 'connected', user: { login: 'mona' } });
    const accounts = await request('GET', `/api/source-control/${PROVIDER}/auth/accounts?${instanceQuery()}`);
    expect(accounts.body.accounts).toHaveLength(1);
    state.accountId = accounts.body.accounts[0].id;
    expect(JSON.stringify([status.body, accounts.body])).not.toContain(TOKEN);
  });

  it('binds a repository whose remote is on the forge', async () => {
    const context = await request('GET', `/api/source-control/repository-context?directory=${encodeURIComponent(repository)}`);
    expect(context.status).toBe(200);
    state.repositoryId = context.body.repositoryId;
    const bound = await request('POST', '/api/source-control/binding/provider', {
      directory: repository, expectedRepositoryId: state.repositoryId, expectedRevision: 0, operation: 'add',
      provider: { provider: PROVIDER, instance: forge.origin, accountId: state.accountId, primaryRemote: 'origin' },
    });
    expect(bound.status).toBe(200);
    state.bindingRevision = bound.body.revision;
    expect(bound.body.binding.providers[0]).toMatchObject({ provider: PROVIDER, readiness: 'ready', repository: { owner: 'mona', name: 'teapot' } });
  });

  it('serves every forwarded read through its shell route', async () => {
    const status = await read('/pr/status', { branch: 'feature' });
    expect(status).toMatchObject({ status: 200, body: { changeRequest: { number: 2, head: 'feature' }, identity: { provider: PROVIDER } } });
    expect((await read('/pulls/list')).body.items.map(({ number }) => number)).toEqual([2]);
    expect((await read('/pulls/context', { number: '2' })).body).toMatchObject({ changeRequest: { number: 2, base: 'main' } });
    expect((await read('/issues/list')).body.items.map(({ number }) => number)).toEqual([1]);
    expect((await read('/issues/get', { number: '1' })).body).toMatchObject({ number: 1, title: 'Kettle whistles too early' });
    expect((await read('/issues/comments', { number: '1' })).body).toEqual([]);
    expect((await read('/repo/upstream')).body).toMatchObject({ isFork: false, upstream: null });
    expect((await read('/repo/branches', { owner: 'mona', repo: 'teapot' })).body).toEqual({ branches: ['main', 'feature', 'docs'] });
    // Off in the manifest: the shell answers, the service is never asked.
    expect((await read('/references/labels', { owner: 'mona', repo: 'teapot' })).status).toBe(501);
  });

  it('answers the reads other modules make with a validated context', async () => {
    await expect(shell.readLiveSummaries({
      provider: PROVIDER, instance: forge.origin, accountId: state.accountId,
      refs: [{ owner: 'mona', repo: 'teapot', number: 2 }], issueRefs: [{ owner: 'mona', repo: 'teapot', number: 1 }],
    })).resolves.toMatchObject({ connected: true, summaries: [{ number: 2, state: 'open' }], issueSummaries: [{ number: 1, state: 'open' }] });
    // The comparison view and walkthroughs: the diff, then both sides of its one file.
    const { patch, meta } = await shell.readChangeRequestPatch({ context: readContext(), number: 2 });
    expect(meta).toEqual({ owner: 'mona', repo: 'teapot', number: 2 });
    expect(patch).toMatch(/^diff --git a\/README\.md b\/README\.md\n/);
    await expect(shell.readChangeRequestFile({ context: readContext(), number: 2, path: 'README.md', status: 'M' })).resolves.toEqual({
      original: 'Steep for two minutes.\n', modified: 'Steep for three minutes.\nThen pour.\n',
    });
    // A worktree from a change request: the head read with the bound account, then its source.
    const worktree = await shell.resolveChangeRequestWorktreeSource({ directory: repository, number: 2 });
    expect(worktree).toMatchObject({
      headBranch: 'feature',
      sourceRequest: { context: { provider: PROVIDER }, project: { id: '1', owner: 'mona', name: 'teapot' }, expectedHeadSha: 'b'.repeat(40) },
    });
    const source = await shell.resolveChangeRequestSource(worktree.sourceRequest);
    expect(source).toMatchObject({
      classification: 'same-repository', headRef: 'refs/heads/feature', endpoint: `${forge.origin}/mona/teapot.git`,
      requestedRemoteName: worktree.sourceRequest.requestedRemoteName,
    });
  });

  it('writes a change request once, replays it, and refuses the same key with other input', async () => {
    const writes = forge.writes.length;
    const created = await mutate('/pr/create', 'create-docs', { head: 'docs', base: 'main' }, { title: 'Docs', body: 'Adds docs' });
    expect(created).toMatchObject({ status: 200, body: { status: 'succeeded', replayed: false, target: { number: 3 } } });
    const replayed = await mutate('/pr/create', 'create-docs', { head: 'docs', base: 'main' }, { title: 'Docs', body: 'Adds docs' });
    expect(replayed).toMatchObject({ status: 200, body: { status: 'succeeded', replayed: true, target: { number: 3 } } });
    expect(forge.writes.length).toBe(writes + 1);
    const conflict = await mutate('/pr/create', 'create-docs', { head: 'docs', base: 'main' }, { title: 'Other docs' });
    expect(conflict).toMatchObject({ status: 409, body: { code: 'SOURCE_CONTROL_MUTATION_CONFLICT' } });
    expect(forge.writes.length).toBe(writes + 1);
  });

  it('reconciles a write left running by a crash, without writing again', async () => {
    const writes = forge.writes.length;
    failNextComplete = true;
    const crashed = await mutate('/pr/create', 'create-feature', { head: 'feature', base: 'docs' }, { title: 'Feature on docs' });
    expect(crashed.status).toBe(409);
    expect(crashed.body.code).toBe('SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN');
    expect(forge.writes.length).toBe(writes + 1);
    const recovered = await mutate('/pr/create', 'create-feature', { head: 'feature', base: 'docs' }, { title: 'Feature on docs' });
    expect(recovered).toMatchObject({ status: 200, body: { status: 'succeeded', replayed: true, target: { number: 4 } } });
    expect(forge.writes.length).toBe(writes + 1);
  });

  it('edits a change request, and reconciles an edit left running by a crash from what the forge shows', async () => {
    const writes = forge.writes.length;
    const edited = await mutate('/pr/update', 'update-docs', { number: 3 }, { title: 'Docs, revised', body: 'More docs' });
    expect(edited).toMatchObject({ status: 200, body: { status: 'succeeded', replayed: false, target: { number: 3 } } });
    expect(forge.writes.length).toBe(writes + 1);
    expect((await read('/pulls/context', { number: '3' })).body.changeRequest).toMatchObject({ title: 'Docs, revised', body: 'More docs' });

    failNextComplete = true;
    const crashed = await mutate('/pr/update', 'update-docs-again', { number: 3 }, { title: 'Docs, final' });
    expect(crashed.body.code).toBe('SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN');
    expect(forge.writes.length).toBe(writes + 2);
    const recovered = await mutate('/pr/update', 'update-docs-again', { number: 3 }, { title: 'Docs, final' });
    expect(recovered).toMatchObject({ status: 200, body: { status: 'succeeded', replayed: true, target: { number: 3 } } });
    expect(forge.writes.length).toBe(writes + 2);
  });

  it('a 401 the service claims without the forge giving one is a 502 and writes nothing off', async () => {
    tamper = (body) => ({ ...body, status: 401 });
    try {
      expect((await read('/issues/get', { number: '1' })).status).toBe(502);
    } finally {
      tamper = null;
    }
    const accounts = await request('GET', `/api/source-control/${PROVIDER}/auth/accounts?${instanceQuery()}`);
    expect(accounts.body.accounts[0].status).toBe('valid');
  });

  it('a malformed service answer is a 502, never an empty one', async () => {
    tamper = (body) => (body.body.includes('"head"') ? { ...body, body: body.body.replaceAll('b'.repeat(40), 'not-a-sha') } : body);
    try {
      await expect(shell.resolveChangeRequestWorktreeSource({ directory: repository, number: 2 }))
        .rejects.toMatchObject({ code: 'MALFORMED_PROVIDER_RESPONSE', statusCode: 502 });
    } finally {
      tamper = null;
    }
  });

  it('keeps the service on the instance: other origins, expired and ended handles are refused', async () => {
    const forgeClient = createSourceControlForge({ env: { [OPENCHAMBER_HOST_CALLBACK_URL]: await hostCallbackUrl() } });
    const live = handles.mint({ guestId: GUEST, providerId: PROVIDER, methods: ['GET'], origin: forge.origin, credential: null, deadline: Date.now() + 5_000 });
    await expect(forgeClient.request(live.handle, { method: 'GET', path: '/api/v1/version' })).resolves.toMatchObject({ status: 200 });
    await expect(forgeClient.request(live.handle, { method: 'GET', path: 'https://evil.example/api/v1/version' }))
      .rejects.toMatchObject({ status: 400 });
    await expect(forgeClient.request(live.handle, { method: 'GET', path: '/a/../../b' }))
      .rejects.toMatchObject({ code: 'OFF_ORIGIN' });
    live.revoke();
    await expect(forgeClient.request(live.handle, { method: 'GET', path: '/api/v1/version' })).rejects.toMatchObject({ code: 'HANDLE_UNKNOWN' });
    const expired = handles.mint({ guestId: GUEST, providerId: PROVIDER, methods: ['GET'], origin: forge.origin, credential: null, deadline: Date.now() - 1 });
    await expect(forgeClient.request(expired.handle, { method: 'GET', path: '/api/v1/version' })).rejects.toMatchObject({ code: 'HANDLE_EXPIRED' });
  });

  it('hands Git transport the stored secret with the declared username', async () => {
    const credential = await providers.readTransportCredential({ provider: PROVIDER, instance: forge.origin, credentialId: state.accountId });
    expect(credential).toMatchObject({ secret: TOKEN, user: { id: 7, login: 'mona' }, providerUserId: `${forge.origin}#7`, status: 'valid' });
    expect(providers.describe(PROVIDER).transport.httpsUsername).toEqual({ kind: 'login' });
  });

  it('a paused extension serves nothing, and enabling it again restores everything', async () => {
    expect((await request('PUT', `/api/guests/${GUEST}/enabled`, { enabled: false })).status).toBe(200);
    expect(await read('/issues/list')).toMatchObject({ status: 404, body: { code: 'SOURCE_CONTROL_PROVIDER_UNAVAILABLE' } });
    await expect(shell.validateReadContext(readContext())).rejects.toMatchObject({ code: 'SOURCE_CONTROL_PROVIDER_UNAVAILABLE', status: 422 });
    expect((await request('GET', '/api/source-control/providers')).body.providers.map(({ id }) => id)).not.toContain(PROVIDER);
    expect((await request('PUT', `/api/guests/${GUEST}/enabled`, { enabled: true })).status).toBe(200);
    expect((await read('/issues/list')).status).toBe(200);
  });

  it('enterprise mode turned on at runtime stops the extension at its next call', async () => {
    expect((await read('/issues/list')).status).toBe(200);
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    try {
      const refused = await read('/issues/list');
      expect(refused.status).not.toBe(200);
      await vi.waitFor(async () => {
        expect((await request('GET', '/api/source-control/providers')).body.providers.map(({ id }) => id)).not.toContain(PROVIDER);
      });
    } finally {
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    }
    await extensionProviders.reconcile();
    expect((await read('/issues/list')).status).toBe(200);
  });

  it('a 401 the forge gives writes the account off and its bindings become unavailable', async () => {
    expect((await read('/pr/status', { branch: 'feature' })).status).toBe(200);
    forge.refuseToken(TOKEN);
    expect((await read('/issues/list')).status).toBe(401);
    const accounts = await request('GET', `/api/source-control/${PROVIDER}/auth/accounts?${instanceQuery()}`);
    expect(accounts.body.accounts[0].status).toBe('invalid');
    const binding = await request('GET', `/api/source-control/binding?directory=${encodeURIComponent(repository)}`);
    expect(binding.body.binding.providers[0].readiness).toBe('account-unavailable');
    // No last-known answer survives the account: the badge read does not come from the cache.
    expect((await read('/pr/status', { branch: 'feature', bindingRevision: String(binding.body.revision) })).status).not.toBe(200);
  });

  it('removing the extension forgets its accounts', async () => {
    const before = JSON.parse(fs.readFileSync(path.join(dataDir, 'source-control-auth.json'), 'utf8'));
    expect(JSON.stringify(before)).toContain(PROVIDER);
    expect((await request('DELETE', `/api/guests/${GUEST}`)).status).toBe(204);
    const after = JSON.parse(fs.readFileSync(path.join(dataDir, 'source-control-auth.json'), 'utf8'));
    expect(JSON.stringify(after)).not.toContain(PROVIDER);
    expect((await request('GET', '/api/source-control/providers')).body.providers.map(({ id }) => id)).toEqual(['github', 'gitlab', 'gitea', 'gerrit', 'forgejo']);
  });
});
