import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GuestServiceError } from '../guests/service.js';
import { createSourceControlAuthStore } from './auth-storage.js';
import { buildExtensionDescriptor } from './extension-descriptor.js';
import { createExtensionProvider } from './extension-provider.js';
import { createOutboundHandles } from './outbound-handles.js';
import { createAccountEvents } from './provider-registry.js';

const manifest = JSON.parse(fs.readFileSync(
  new URL('../../../../sdk/examples/source-control-provider/package.json', import.meta.url), 'utf8',
));
const contribution = manifest.openchamber.contributes.sourceControl;
const guest = {
  id: 'forge', name: 'Forge', version: '1.0.0', packageRoot: '/pkg', service: { entry: 'service/main.js', provides: ['source-control'] },
  sourceControl: contribution, capabilityGrants: ['service'],
};
const INSTANCE = 'https://forge.example';
const SHA = 'b'.repeat(40);
const USER = { id: 7, login: 'mona' };
const project = { id: '1', owner: 'mona', name: 'teapot' };

let dir;
let calls;
let service;
let forgeStatuses;
let events;
let invalidated;
let provider;
let handles;
let store;
let currentRow;
let reconcile;
let granted;
let forgeHeaders;

const ok = (data) => ({ ok: true, data });
const fail = (error) => ({ ok: false, error });

/** The service answers with `service(request)`; `forge(status)` inside it sends one request through the handle. */
const setup = (descriptor = buildExtensionDescriptor({ guestId: 'forge', contribution, guest })) => {
  handles = createOutboundHandles({ fetch: async (_url, init) => {
    forgeHeaders.push(init.headers);
    return new Response('{}', { status: forgeStatuses.shift() ?? 200 });
  } });
  const authStore = createSourceControlAuthStore({ filePath: path.join(dir, 'source-control-auth.json') });
  store = authStore.section(descriptor.id);
  events = createAccountEvents();
  invalidated = vi.fn();
  events.subscribe({ invalidated });
  provider = createExtensionProvider({
    descriptor, guest, store, events, handles, persistPath: path.join(dir, 'extensions.json'),
    currentGuest: async (guestId) => (guestId === guest.id ? currentRow : null),
    reconcile,
    proxy: async ({ body, granted: grants }) => {
      const request = JSON.parse(body);
      calls.push(request);
      granted.push(grants);
      const forge = (method = 'GET') => handles.serve({ bearer: request.session.handle, body: { method, path: '/api/v1/x' } });
      const answer = await service(request, forge);
      return { status: answer.status ?? 200, body: answer.raw ?? JSON.stringify(answer) };
    },
  });
  return provider;
};

const connect = async () => {
  service = async (request, forge) => { await forge(); return request.method === 'auth.verify' ? ok({ user: USER }) : ok({ supported: true }); };
  await provider.auth.connectToken({ instance: INSTANCE, token: 'secret-token' });
  return provider.auth.resolveAccount({ instance: INSTANCE });
};

const readInput = (extra = {}) => ({ context: { provider: 'ext-forge', instance: INSTANCE }, directory: '/repo', remote: 'origin', ...extra });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-ext-provider-'));
  calls = [];
  forgeStatuses = [];
  currentRow = guest;
  reconcile = vi.fn(async () => undefined);
  granted = [];
  forgeHeaders = [];
  setup();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('an extension provider', () => {
  it('signs in through auth.verify with a handle that carries the token, never the token itself', async () => {
    const session = await connect();
    expect(session).toMatchObject({ instance: INSTANCE, providerUserId: `${INSTANCE}#7`, secretKind: 'pat' });
    const verify = calls.find((call) => call.method === 'auth.verify');
    expect(verify).toMatchObject({ v: 1, provider: 'ext-forge', session: { instance: INSTANCE, user: null }, input: {} });
    expect(verify.session.handle).toMatch(/^[\w-]{43}$/);
    expect(JSON.stringify(calls)).not.toContain('secret-token');
    expect(await provider.transport.readCredential({ instance: INSTANCE, credentialId: session.accountId }))
      .toMatchObject({ secret: 'secret-token', user: { id: 7, login: 'mona' } });
  });

  it('forwards a read as the account, without the session, and hands back what the service answered', async () => {
    const session = await connect();
    service = async () => ok({ items: [], page: 1, hasMore: false });
    await expect(provider.resources.listIssues({ session, ...readInput({ page: 1, state: 'open', people: 'any' }) }))
      .resolves.toEqual({ items: [], page: 1, hasMore: false });
    expect(calls.at(-1)).toMatchObject({
      method: 'listIssues', session: { instance: INSTANCE, user: USER }, input: { directory: '/repo', remote: 'origin', page: 1 },
    });
    expect(calls.at(-1).input).not.toHaveProperty('session');
  });

  it.each([
    ['a body that is not JSON', { raw: 'nope' }],
    ['a non-200 answer', { status: 500, raw: '{}' }],
    ['an answer outside the envelope', { data: 1 }],
    ['a head with a malformed sha', ok({ project, headSha: 'nope', headBranch: 'feature', headOwner: 'mona' })],
  ])('turns %s into 502 MALFORMED_PROVIDER_RESPONSE, never an empty answer', async (_name, answer) => {
    const session = await connect();
    service = async () => answer;
    await expect(provider.resources.readChangeRequestHead({ session, ...readInput({ number: 2 }) }))
      .rejects.toMatchObject({ status: 502, code: 'MALFORMED_PROVIDER_RESPONSE' });
  });

  it('a 401 the forge did not give is malformed and writes nothing off', async () => {
    const session = await connect();
    service = async () => fail({ message: 'token refused', status: 401 });
    const error = await provider.resources.getIssue({ session, ...readInput({ number: 1 }) }).catch((caught) => caught);
    expect(error).toMatchObject({ status: 502, code: 'MALFORMED_PROVIDER_RESPONSE' });
    expect(error.sourceControlIdentity).toBeUndefined();
    const status = await provider.auth.status({ instance: INSTANCE });
    expect(status.connected).toBe(false);
    expect(invalidated).not.toHaveBeenCalled();
    expect((await store.readInstance(INSTANCE)).accounts[0].status).toBe('valid');
  });

  it('a 401 the forge gave names the account for the write-off, and status writes it off', async () => {
    const session = await connect();
    service = async (_request, forge) => { forgeStatuses.push(401); await forge(); return fail({ message: 'token refused', status: 401 }); };
    await expect(provider.resources.getIssue({ session, ...readInput({ number: 1 }) })).rejects.toMatchObject({
      status: 401,
      kind: 'invalid-token',
      sourceControlIdentity: { provider: 'ext-forge', instance: INSTANCE, accountId: session.accountId },
      sourceControlPersistedAccount: true,
    });
    const status = await provider.auth.status({ instance: INSTANCE });
    expect(status.status).toBe('disconnected');
    expect(invalidated).toHaveBeenCalledWith({ provider: 'ext-forge', instance: INSTANCE, accountId: session.accountId });
    expect((await store.readInstance(INSTANCE)).accounts[0].status).toBe('invalid');
  });

  it('a refused token on sign-in is invalid-token and nothing is stored', async () => {
    service = async (_request, forge) => { forgeStatuses.push(401); await forge(); return fail({ message: 'bad token', status: 401 }); };
    await expect(provider.auth.connectToken({ instance: INSTANCE, token: 'wrong' })).rejects.toMatchObject({ kind: 'invalid-token' });
    expect((await store.readInstance(INSTANCE)).accounts).toEqual([]);
  });

  it('maps a service that could not answer to the shell failure kinds', async () => {
    const session = await connect();
    for (const [code, kind] of [['SERVICE_FAILED', 'temporarily-unavailable'], ['NO_SERVICE', 'temporarily-unavailable'],
      ['DISABLED', 'temporarily-unavailable'], ['REQUEST_FAILED', 'unreachable'], ['RESPONSE_TOO_LARGE', 'provider-error']]) {
      service = async () => { throw new GuestServiceError('down', code); };
      const error = await provider.resources.getIssue({ session, ...readInput({ number: 1 }) }).catch((caught) => caught);
      expect(provider.classifyFailure(error)).toBe(kind);
    }
  });

  describe('which failed writes count as failed', () => {
    const perform = async (session, scenario) => {
      service = scenario;
      return provider.mutations.perform({
        session, route: '/issues/comment', kind: 'issue-comment', input: { body: 'hi', digest: { body: 'hi' } },
        resolved: { providerTarget: {}, target: { repositoryId: 'r', bindingRevision: 1, primaryRemote: 'origin', project } },
      }).catch((error) => provider.mutations.classifyError(error));
    };

    it.each([
      ['the service was never reached', async () => { throw new GuestServiceError('down', 'SERVICE_FAILED'); }, [], 'failed'],
      ['no write went out', async (_r, forge) => { await forge('GET'); return fail({ message: 'no', status: 500 }); }, [200], 'failed'],
      ['every write got a 4xx', async (_r, forge) => { await forge('POST'); return fail({ message: 'no', status: 422 }); }, [422], 'failed'],
      ['a write landed, whatever the service says', async (_r, forge) => { await forge('POST'); return fail({ message: 'no', status: 422 }); }, [201], 'outcome-unknown'],
      ['a write got a 5xx', async (_r, forge) => { await forge('POST'); return fail({ message: 'no', status: 500 }); }, [503], 'outcome-unknown'],
      ['the call timed out after a write', async (_r, forge) => { await forge('POST'); throw new GuestServiceError('slow', 'REQUEST_FAILED'); }, [200], 'outcome-unknown'],
      ['the answer was malformed after a write', async (_r, forge) => { await forge('POST'); return ok({ unexpected: true }); }, [200], 'outcome-unknown'],
    ])('%s', async (_name, scenario, statuses, expected) => {
      const session = await connect();
      forgeStatuses.push(...statuses);
      expect(await perform(session, scenario)).toBe(expected);
    });

    it('sends the normalized input without the host digest fields', async () => {
      const session = await connect();
      await perform(session, async () => ok({}));
      expect(calls.at(-1).input).toMatchObject({ route: '/issues/comment', kind: 'issue-comment', input: { body: 'hi' } });
      expect(calls.at(-1).input.input).not.toHaveProperty('digest');
    });
  });

  describe('mutation targets', () => {
    const context = {
      provider: 'ext-forge', instance: INSTANCE, repositoryId: 'r', bindingRevision: 1, primaryRemote: 'origin',
      directory: '/repo', target: { project: { owner: 'mona', name: 'teapot' }, number: 2 },
    };
    const target = { repositoryId: 'r', bindingRevision: 1, primaryRemote: 'origin', project, number: 2, head: 'feature', base: 'main', headSha: SHA };

    it('accepts a target that describes the validated context, and refuses one that does not', async () => {
      const session = await connect();
      service = async () => ok({ providerTarget: { n: 2 }, target });
      await expect(provider.mutations.resolveTarget({ session, context, kind: 'change-request-merge', input: {} }))
        .resolves.toEqual({ providerTarget: { n: 2 }, target });
      service = async () => ok({ providerTarget: {}, target: { ...target, number: 3 } });
      await expect(provider.mutations.resolveTarget({ session, context, kind: 'change-request-merge', input: {} }))
        .rejects.toMatchObject({ status: 502, code: 'MALFORMED_PROVIDER_RESPONSE' });
      service = async () => ok({ providerTarget: {}, target: { ...target, bindingRevision: 2 } });
      await expect(provider.mutations.resolveTarget({ session, context, kind: 'change-request-merge', input: {} }))
        .rejects.toMatchObject({ code: 'MALFORMED_PROVIDER_RESPONSE' });
    });

    it('a replay acts on exactly the stored target, else it is a conflict', async () => {
      const session = await connect();
      service = async () => ok({ providerTarget: {}, target });
      await expect(provider.mutations.resolveTarget({ session, context, kind: 'change-request-merge', input: {}, replayOf: { target } }))
        .resolves.toMatchObject({ target });
      expect(calls.at(-1).input.replayOf).toEqual({ target });
      await expect(provider.mutations.resolveTarget({
        session, context, kind: 'change-request-merge', input: {}, replayOf: { target: { ...target, headSha: 'c'.repeat(40) } },
      })).rejects.toMatchObject({ status: 409, code: 'SOURCE_CONTROL_MUTATION_CONFLICT' });
    });
  });

  describe('the source of a change request', () => {
    const source = (overrides = {}) => ({
      sourceProject: project, targetProject: project, classification: 'same-repository', headSha: SHA,
      headRef: 'refs/heads/feature', endpoint: `${INSTANCE}/mona/teapot.git`, ...overrides,
    });
    const resolve = async (session, answer) => {
      service = async () => ok(answer);
      return provider.resources.resolveChangeRequestSource({
        session, ...readInput(), project, number: 2, expectedHeadSha: SHA.toUpperCase(), requestedRemoteName: 'pr-2',
      });
    };

    it('answers the checked source with the context and the requested remote name', async () => {
      const session = await connect();
      const resolved = await resolve(session, source());
      expect(resolved).toMatchObject({ ...source(), requestedRemoteName: 'pr-2', context: readInput().context });
      expect(Object.isFrozen(resolved)).toBe(true);
      expect(calls.at(-1).input).not.toHaveProperty('requestedRemoteName');
    });

    // Only the target must be the asked project: a contributor's fork is
    // reached through the change request, wherever it lives.
    it("answers a contributor fork's source when the target is the asked project", async () => {
      const session = await connect();
      const fork = { id: '7', owner: 'octo', name: 'teapot' };
      await expect(resolve(session, source({ sourceProject: fork, classification: 'contributor-fork', endpoint: `${INSTANCE}/octo/teapot.git` })))
        .resolves.toMatchObject({ sourceProject: fork, targetProject: project, classification: 'contributor-fork' });
    });

    it.each([
      ['an endpoint on another origin', { endpoint: 'https://evil.example/mona/teapot.git' }],
      ['an endpoint naming another project', { endpoint: `${INSTANCE}/mona/other.git` }],
      ['plain http on an https instance', { endpoint: 'http://forge.example/mona/teapot.git' }],
      ['credentials in the endpoint', { endpoint: 'https://user:pw@forge.example/mona/teapot.git' }],
      ['another head', { headSha: 'c'.repeat(40) }],
      ['another target project', { targetProject: { ...project, id: '9' } }],
      ['a classification the projects contradict', { classification: 'contributor-fork' }],
    ])('refuses %s', async (_name, overrides) => {
      const session = await connect();
      await expect(resolve(session, source(overrides))).rejects.toMatchObject({ status: 502, code: 'MALFORMED_PROVIDER_RESPONSE' });
    });

    it('allows a loopback http endpoint only when the extension allows loopback instances', async () => {
      const loopback = 'http://127.0.0.1:3000';
      const session = await (async () => {
        service = async (request) => (request.method === 'auth.verify' ? ok({ user: USER }) : ok({ supported: true }));
        await provider.auth.connectToken({ instance: loopback, token: 't' });
        return provider.auth.resolveAccount({ instance: loopback });
      })();
      service = async () => ok(source({ endpoint: `${loopback}/mona/teapot.git` }));
      await expect(provider.resources.resolveChangeRequestSource({
        session, ...readInput(), project, number: 2, expectedHeadSha: SHA, requestedRemoteName: 'pr-2',
      })).resolves.toMatchObject({ endpoint: `${loopback}/mona/teapot.git` });
    });
  });

  it('refuses a status for another provider', async () => {
    const session = await connect();
    service = async () => ok({ identity: { provider: 'gitea', instance: INSTANCE }, project: null, branch: 'main', changeRequest: null });
    await expect(provider.resources.changeRequestStatus({ session, ...readInput({ branch: 'main', force: false }) }))
      .rejects.toMatchObject({ code: 'MALFORMED_PROVIDER_RESPONSE' });
  });

  describe('the catalog row as it is now', () => {
    it.each([
      ['enterprise policy took the service grant', { ...guest, capabilityGrants: [], enterpriseBlocked: ['service'] }],
      ['the extension was paused', { ...guest, enabled: false }],
      ['the extension is gone', null],
    ])('refuses a call when %s, sends nothing and reconciles', async (_name, row) => {
      const session = await connect();
      const sent = calls.length;
      currentRow = row;
      service = async () => ok({ items: [], page: 1, hasMore: false });
      const error = await provider.resources.listIssues({ session, ...readInput({ page: 1, state: 'open', people: 'any' }) }).catch((caught) => caught);
      expect(error.message).toContain('NO_SERVICE');
      expect(provider.classifyFailure(error)).toBe('temporarily-unavailable');
      expect(provider.mutations.classifyError(error)).toBe('failed');
      expect(calls.length).toBe(sent);
      await vi.waitFor(() => expect(reconcile).toHaveBeenCalled());
    });

    it('hands the proxy the grants the catalog has now, not the ones it registered with', async () => {
      const session = await connect();
      currentRow = { ...guest, capabilityGrants: ['service', 'files'] };
      service = async () => ok({ items: [], page: 1, hasMore: false });
      await provider.resources.listIssues({ session, ...readInput({ page: 1, state: 'open', people: 'any' }) });
      expect(granted.at(-1)).toEqual(['service', 'files']);
      expect(reconcile).not.toHaveBeenCalled();
    });
  });

  describe('which calls may write to the forge', () => {
    it('a read cannot send a write through its handle', async () => {
      const session = await connect();
      let answer;
      service = async (_request, forge) => { answer = await forge('POST'); return ok({ items: [], page: 1, hasMore: false }); };
      await provider.resources.listIssues({ session, ...readInput({ page: 1, state: 'open', people: 'any' }) });
      expect(answer).toMatchObject({ status: 403, body: { error: { code: 'METHOD_NOT_ALLOWED' } } });
    });

    it('nor can resolveTarget or reconcile, while perform can', async () => {
      const session = await connect();
      const answers = [];
      service = async (request, forge) => {
        answers.push([request.method, (await forge('DELETE')).status]);
        return request.method === 'mutation.resolveTarget' ? ok({ providerTarget: {}, target: {} }) : ok({});
      };
      const resolved = { providerTarget: {}, target: { repositoryId: 'r', bindingRevision: 1, primaryRemote: 'origin', project } };
      const step = { session, route: '/issues/comment', kind: 'issue-comment', input: { body: 'hi', digest: { body: 'hi' } }, resolved };
      await provider.mutations.resolveTarget({ session, context: { repositoryId: 'r', target: {} }, kind: 'issue-comment', input: {} }).catch(() => null);
      await provider.mutations.reconcile(step).catch(() => null);
      await provider.mutations.perform(step).catch(() => null);
      expect(answers).toEqual([['mutation.resolveTarget', 403], ['mutation.reconcile', 403], ['mutation.perform', 200]]);
    });

    it('a malformed answer after the call reached the forge carries what the proxy saw', async () => {
      const session = await connect();
      const context = { provider: 'ext-forge', instance: INSTANCE, repositoryId: 'r', bindingRevision: 1, primaryRemote: 'origin', directory: '/repo', target: { number: 2 } };
      service = async (_request, forge) => {
        await forge('GET');
        return ok({ providerTarget: {}, target: { repositoryId: 'r', bindingRevision: 1, primaryRemote: 'origin', project, number: 3 } });
      };
      const target = await provider.mutations.resolveTarget({ session, context, kind: 'change-request-merge', input: {} }).catch((error) => error);
      expect(target).toMatchObject({ code: 'MALFORMED_PROVIDER_RESPONSE', sourceControlOutbound: [{ method: 'GET', status: 200 }] });
      service = async (_request, forge) => {
        await forge('GET');
        return ok({ identity: { provider: 'gitea', instance: INSTANCE }, project: null, branch: 'main', changeRequest: null });
      };
      const status = await provider.resources.changeRequestStatus({ session, ...readInput({ branch: 'main', force: false }) }).catch((error) => error);
      expect(status).toMatchObject({ code: 'MALFORMED_PROVIDER_RESPONSE', sourceControlOutbound: [{ method: 'GET', status: 200 }] });
    });
  });

  describe('change-based inputs', () => {
    const REVISION = 'c'.repeat(40);
    const changeBased = (overrides = {}) => setup(buildExtensionDescriptor({
      guestId: 'forge', guest, contribution: {
        ...contribution,
        capabilities: { ...contribution.capabilities, reviews: true, reviewModel: 'votes', revisions: true },
        ...overrides,
      },
    }));
    const resolved = { providerTarget: {}, target: { repositoryId: 'r', bindingRevision: 1, primaryRemote: 'origin', project, number: 2, headSha: SHA } };
    const review = (session, input) => provider.mutations.perform({
      session, route: '/pr/review', kind: 'change-request-review', input, resolved,
    });

    it.each(['changeRequestContext', 'readChangeRequestPatch', 'readChangeRequestFile'])(
      '%s forwards a revision to a host that declares revisions', async (method) => {
        changeBased();
        const session = await connect();
        service = async () => ok({});
        await provider.resources[method]({ session, ...readInput({ number: 2, revision: REVISION }) });
        expect(calls.at(-1)).toMatchObject({ method, input: { number: 2, revision: REVISION } });
      },
    );

    it('refuses a revision, before anything is sent, to a host that does not declare revisions', async () => {
      const session = await connect();
      const sent = calls.length;
      await expect(provider.resources.changeRequestContext({ session, ...readInput({ number: 2, revision: REVISION }) }))
        .rejects.toMatchObject({ status: 400, code: 'INVALID_SOURCE_CONTROL_READ_CONTEXT' });
      expect(calls.length).toBe(sent);
      service = async () => ok({});
      await provider.resources.changeRequestContext({ session, ...readInput({ number: 2 }) });
      expect(calls.at(-1).input).not.toHaveProperty('revision');
    });

    it('refuses a revision that is not a commit SHA', async () => {
      changeBased();
      const session = await connect();
      await expect(provider.resources.readChangeRequestPatch({ session, ...readInput({ number: 2, revision: 'HEAD' }) }))
        .rejects.toMatchObject({ status: 400, code: 'INVALID_SOURCE_CONTROL_READ_CONTEXT' });
    });

    it('forwards votes to a votes host', async () => {
      changeBased();
      const session = await connect();
      service = async () => ok({});
      const votes = { 'Code-Review': 2, Verified: 1 };
      await review(session, { votes, body: 'ship it', digest: { votes, body: 'ship it' } });
      expect(calls.at(-1).input).toMatchObject({ route: '/pr/review', input: { votes, body: 'ship it' } });
    });

    it('refuses votes to a verdict host before anything is sent, as a failed write', async () => {
      const session = await connect();
      const sent = calls.length;
      const error = await review(session, { votes: { 'Code-Review': 2 }, digest: {} }).catch((caught) => caught);
      expect(error).toMatchObject({ status: 400, code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT' });
      expect(provider.mutations.classifyError(error)).toBe('failed');
      await expect(provider.mutations.resolveTarget({ session, context: { repositoryId: 'r', target: {} }, kind: 'change-request-review', input: { votes: {} } }))
        .rejects.toMatchObject({ status: 400 });
      expect(calls.length).toBe(sent);
    });

    describe('a basic host', () => {
      const basic = () => changeBased({ token: { header: 'authorization', scheme: 'basic', username: true, scopes: [] } });

      const basicHeader = (login, token) => `Basic ${Buffer.from(`${login}:${token}`).toString('base64')}`;

      it('verifies with the typed username, then sends the stored login on every call', async () => {
        basic();
        service = async (request, forge) => { await forge(); return request.method === 'auth.verify' ? ok({ user: USER }) : ok({ supported: true }); };
        await provider.auth.connectToken({ instance: INSTANCE, token: 'http-password', username: 'mona' });
        const verifyIndex = calls.findIndex((call) => call.method === 'auth.verify');
        expect(forgeHeaders[verifyIndex].authorization).toBe(basicHeader('mona', 'http-password'));
        // The probe never carries a token, whatever the host's scheme.
        expect(forgeHeaders[calls.findIndex((call) => call.method === 'auth.probe')]).not.toHaveProperty('authorization');

        const session = await provider.auth.resolveAccount({ instance: INSTANCE });
        service = async (_request, forge) => { await forge(); return ok({ items: [], page: 1, hasMore: false }); };
        await provider.resources.listIssues({ session, ...readInput({ page: 1, state: 'open', people: 'any' }) });
        expect(forgeHeaders.at(-1).authorization).toBe(basicHeader('mona', 'http-password'));
        expect(JSON.stringify(calls)).not.toContain('http-password');
      });

      it('refuses to sign in without a username, sending nothing', async () => {
        basic();
        service = async () => ok({ user: USER });
        await expect(provider.auth.connectToken({ instance: INSTANCE, token: 'http-password' })).rejects.toThrow(/username/);
        expect(calls).toEqual([]);
        expect((await store.readInstance(INSTANCE)).accounts).toEqual([]);
      });

      it('refuses a call as an account whose login Basic auth cannot carry, as a failed write', async () => {
        basic();
        await store.setAccount(INSTANCE, { token: 'http-password', user: { id: 7, login: 'mo:na' }, source: 'pat' });
        const session = await provider.auth.resolveAccount({ instance: INSTANCE });
        const error = await review(session, { votes: { 'Code-Review': 1 }, digest: {} }).catch((caught) => caught);
        expect(error).toMatchObject({ status: 400, code: 'SOURCE_CONTROL_USERNAME_REQUIRED' });
        expect(provider.mutations.classifyError(error)).toBe('failed');
        expect(calls).toEqual([]);
      });
    });
  });

  describe('after the registry disposed it', () => {
    it('a connect still waiting on the service stores nothing', async () => {
      let release;
      const waiting = new Promise((resolve) => { release = resolve; });
      service = async (request) => {
        if (request.method === 'auth.verify') {
          await waiting;
          return ok({ user: USER });
        }
        return ok({ supported: true });
      };
      const connecting = provider.auth.connectToken({ instance: INSTANCE, token: 'secret-token' });
      await vi.waitFor(() => expect(calls.some((call) => call.method === 'auth.verify')).toBe(true));
      provider.dispose();
      release();
      await expect(connecting).rejects.toMatchObject({ code: 'SOURCE_CONTROL_PROVIDER_UNAVAILABLE' });
      expect((await store.readInstance(INSTANCE)).accounts).toEqual([]);
    });

    it('refuses to activate or write off an account', async () => {
      const session = await connect();
      provider.dispose();
      await expect(provider.auth.activate({ instance: INSTANCE, accountId: session.accountId }))
        .rejects.toMatchObject({ code: 'SOURCE_CONTROL_PROVIDER_UNAVAILABLE' });
      await expect(provider.auth.invalidateAccount({ instance: INSTANCE, accountId: session.accountId }))
        .rejects.toMatchObject({ code: 'SOURCE_CONTROL_PROVIDER_UNAVAILABLE' });
      expect((await store.readInstance(INSTANCE)).accounts[0].status).toBe('valid');
    });
  });
});
