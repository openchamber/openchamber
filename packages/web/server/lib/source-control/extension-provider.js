import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  SOURCE_CONTROL_OUTBOUND_METHODS,
  SOURCE_CONTROL_PROVIDER_IDLE_MS,
  SOURCE_CONTROL_PROVIDER_PATH,
  SOURCE_CONTROL_PROVIDER_RESPONSE_MAX,
  SOURCE_CONTROL_PROVIDER_WIRE_VERSION,
  sourceControlProviderTimeoutMs,
} from '@openchamber/sdk';
import { sourceControlProviderSchemasV1 } from '@openchamber/sdk/schemas';

import { GuestServiceError, proxyGuestServiceRequest } from '../guests/service.js';
import { isString } from '../shared/guards.js';
import { isSourceControlProviderGuest } from './extension-providers.js';
import { createPatAccountAuth } from './pat-account-auth.js';
import { isProviderUsername } from './provider-id.js';
import { createStandardMutations } from './standard-mutations.js';

/**
 * An installed extension's Git host (`ext-<guestId>`) as a provider
 * implementation behind the shared route shell. The extension's service
 * answers the forwarded calls (`POST /source-control` on its loopback, the
 * SDK's wire 1); everything that must not depend on a third party stays here:
 * the accounts and tokens (`pat-account-auth.js` over the provider's own auth
 * store section), the mutation kinds and digests (`standard-mutations.js`),
 * which failures write an account off, and which writes count as failed.
 *
 * Every call reads the guest's current catalog row (`currentGuest`), which
 * applies enterprise policy on each read, and takes the grants from it: a
 * guest that is no longer eligible (paused, unapproved, refused by policy)
 * is refused as `NO_SERVICE` before anything is sent, and the registered set
 * is reconciled.
 *
 * The service never holds a token. Each forwarded call carries a fresh handle
 * (`outbound-handles.js`) bound to the instance origin and, when the call acts
 * as an account, its token; the handle ends with the call. Only
 * `mutation.perform` may send writes through its handle; every other call's
 * handle carries `GET` alone, so a write happens only where the mutation
 * executor keys, records and audits it. What the proxy saw
 * the forge answer through that handle is the evidence this module trusts:
 *
 * - A 401 the service reports writes the account off only when the proxy saw
 *   the forge answer 401 on that handle. Otherwise the answer is malformed.
 * - A mutation counts as `failed` (recorded, never retried) only when the
 *   service was never reached, or no write went out, or every write got a
 *   4xx. Any other failure may have changed the forge: `outcome-unknown`.
 *
 * Answers are checked with the SDK's `sourceControlProviderSchemasV1`; one
 * that does not parse is `502 MALFORMED_PROVIDER_RESPONSE`, never an empty
 * answer.
 *
 * Inputs a service built against an older manifest would not understand go
 * out only to a host whose manifest declares them: a read's `revision` needs
 * `capabilities.revisions`, a review's `votes` needs `reviewModel: 'votes'`.
 * Otherwise the call is refused with a 400 before anything is sent, as the
 * shell refuses it, so a service never answers a question it ignored.
 */

const schemas = sourceControlProviderSchemasV1;

// A service that never took the call: nothing reached the forge.
const NOT_REACHED_CODES = new Set(['SERVICE_FAILED', 'NO_SERVICE', 'DISABLED']);

const failureKindOfServiceError = (code) => {
  if (NOT_REACHED_CODES.has(code)) return 'temporarily-unavailable';
  if (code === 'REQUEST_FAILED') return 'unreachable';
  return 'provider-error';
};

/** `kind` is what `classifyFailure` answers for the error; `outbound` what the proxy saw during the call. */
const callError = (message, { status, code, kind = 'provider-error', outbound = [], notReached = false } = {}) => {
  const error = new Error(message);
  if (status !== undefined) error.status = status;
  if (code !== undefined) error.code = code;
  error.kind = kind;
  error.sourceControlOutbound = outbound;
  error.sourceControlNotReached = notReached;
  return error;
};

const malformed = (label, detail, outbound = []) => callError(`${label} answered something OpenChamber cannot use: ${detail}`, {
  status: 502, code: 'MALFORMED_PROVIDER_RESPONSE', outbound,
});

/** Plain JSON of a value the shell built (frozen objects included), without `undefined` fields. */
const json = (value) => JSON.parse(JSON.stringify(value));

const TARGET_FIELDS = ['number', 'head', 'base', 'headSha'];
const PROJECT_FIELDS = ['id', 'owner', 'name'];

const READ_ONLY = Object.freeze(['GET']);
/** The forge methods a forwarded call may send. */
const outboundMethodsOf = (method) => (method === 'mutation.perform' ? SOURCE_CONTROL_OUTBOUND_METHODS : READ_ONLY);

/** A refusal of the input itself: nothing was sent, so a write it stopped counts as failed. */
const refusedInput = (code, message) => Object.assign(new Error(message), {
  status: 400, code, sourceControlNotReached: true,
});

const REVISION = /^[0-9a-f]{40}$/i;

/** Thrown into a running call's account write after its provider was unregistered. */
const disposedError = (label) => Object.assign(new Error(`${label} is no longer available`), {
  status: 404, code: 'SOURCE_CONTROL_PROVIDER_UNAVAILABLE',
});

/**
 * @param {{
 *   descriptor: import('./provider-contract').ProviderDescriptor,
 *   guest: { id: string, name: string, packageRoot: string, service: object, capabilityGrants: string[] },
 *   currentGuest: (guestId: string) => Promise<object | null>,
 *   reconcile: () => unknown,
 *   store: object,
 *   events: import('./provider-contract').AccountEvents,
 *   handles: ReturnType<typeof import('./outbound-handles.js').createOutboundHandles>,
 *   persistPath: string,
 *   proxy?: typeof proxyGuestServiceRequest,
 * }} input `store` is the provider's section of the auth store; `persistPath`
 * the extension store the guest service proxy reads its enabled flag from.
 * `currentGuest` reads the guest's catalog row as it is now (null when it is
 * gone); `reconcile` brings the registered set in step with the catalog.
 */
export function createExtensionProvider({
  descriptor, guest, currentGuest, reconcile, store: sectionStore, events, handles, persistPath, proxy = proxyGuestServiceRequest,
}) {
  const { id, label } = descriptor;
  const tokenFormat = descriptor.extension.token;
  const basicAuth = tokenFormat.scheme === 'basic';

  // After the registry unregisters the provider, a call still running (a
  // connect waiting on the service) must not write an account back into a
  // section that removal is about to drop or already dropped.
  let disposed = false;
  const guardedWrite = (write) => (...args) => {
    if (disposed) return Promise.reject(disposedError(label));
    return write(...args);
  };
  const store = Object.freeze({
    ...sectionStore,
    setAccount: guardedWrite(sectionStore.setAccount),
    activate: guardedWrite(sectionStore.activate),
    markAccountInvalid: guardedWrite(sectionStore.markAccountInvalid),
  });

  const serviceError = (error, outbound) => callError(`${label} could not answer (${error.code}): ${error.message}`, {
    kind: failureKindOfServiceError(error.code),
    outbound,
    notReached: NOT_REACHED_CODES.has(error.code),
  });

  /** The guest as the catalog has it now; a guest that may no longer serve is refused before anything is sent. */
  const eligibleGuest = async () => {
    let current;
    try {
      current = await currentGuest(guest.id);
    } catch (error) {
      throw serviceError(new GuestServiceError(`the extension catalog could not be read: ${error?.message ?? error}`, 'NO_SERVICE'), []);
    }
    if (current && isSourceControlProviderGuest(current)) return current;
    void Promise.resolve().then(reconcile).catch((error) => {
      console.warn('[source-control] Failed to withdraw an extension Git host:', error?.message ?? error);
    });
    throw serviceError(new GuestServiceError('the extension may no longer serve this Git host', 'NO_SERVICE'), []);
  };

  /**
   * One forwarded call. `token` is the secret the handle carries (null for
   * none), `user` the acting account (null before one is known), `login` the
   * username a `basic` token is sent with. Answers the parsed data and what
   * the proxy saw the call send to the forge.
   */
  const forward = async (method, { instance, token, user, login = null, input }) => {
    if (token && basicAuth && !isProviderUsername(login)) {
      throw refusedInput('SOURCE_CONTROL_USERNAME_REQUIRED', `${label} signs in with a username, and this account has none it can send`);
    }
    const current = await eligibleGuest();
    const timeoutMs = sourceControlProviderTimeoutMs(method);
    const credential = token ? { token, header: tokenFormat.header, scheme: tokenFormat.scheme } : null;
    if (credential && basicAuth) credential.login = login;
    const grant = handles.mint({
      guestId: guest.id,
      providerId: id,
      origin: new URL(instance).origin,
      credential,
      deadline: Date.now() + timeoutMs,
      methods: outboundMethodsOf(method),
    });
    try {
      let proxied;
      try {
        proxied = await proxy({
          guestId: guest.id,
          guestName: guest.name,
          packageRoot: guest.packageRoot,
          service: guest.service,
          granted: current.capabilityGrants,
          persistPath,
          method: 'POST',
          path: SOURCE_CONTROL_PROVIDER_PATH,
          body: JSON.stringify({
            v: SOURCE_CONTROL_PROVIDER_WIRE_VERSION,
            requestId: crypto.randomUUID(),
            method,
            provider: id,
            session: { instance, handle: grant.handle, user },
            input,
          }),
          timeoutMs,
          responseMax: SOURCE_CONTROL_PROVIDER_RESPONSE_MAX,
          idleStopMs: SOURCE_CONTROL_PROVIDER_IDLE_MS,
        });
      } catch (error) {
        if (!(error instanceof GuestServiceError)) throw error;
        throw serviceError(error, grant.outbound);
      }
      if (proxied.status !== 200) throw malformed(label, `HTTP ${proxied.status}`, grant.outbound);
      let envelope;
      try {
        envelope = schemas.envelope.safeParse(JSON.parse(proxied.body));
      } catch {
        throw malformed(label, 'not JSON', grant.outbound);
      }
      if (!envelope.success) throw malformed(label, 'not a source-control answer', grant.outbound);
      if (!envelope.data.ok) {
        const { message, status, code } = envelope.data.error;
        if (status === 401) {
          // The service's word alone never writes an account off.
          if (!grant.outbound.some((request) => request.status === 401)) {
            throw malformed(label, 'a 401 the forge did not give', grant.outbound);
          }
          throw callError(message, { status, code, kind: 'invalid-token', outbound: grant.outbound });
        }
        throw callError(message, { status, code, outbound: grant.outbound });
      }
      const data = schemas.data[method].safeParse(envelope.data.data);
      if (!data.success) throw malformed(label, `${method} does not match its schema`, grant.outbound);
      return { data: data.data, outbound: grant.outbound };
    } finally {
      grant.revoke();
    }
  };

  // The token behind a session stays in `pat-account-auth.js`; `tokenFor` reads it.
  // A `basic` host's token is checked together with the username it is sent with.
  const verify = async (origin, token, { username = null } = {}) => (await forward('auth.verify', {
    instance: origin, token, user: null, login: username, input: {},
  })).data.user;
  const probe = async (origin) => (await forward('auth.probe', { instance: origin, token: null, user: null, input: {} })).data;
  const classifyFailure = (error) => error?.kind ?? 'provider-error';
  const accounts = createPatAccountAuth({ descriptor, store, events, verify, probe, classifyFailure });

  const userOf = async (session) => {
    const account = await store.readAccount(session.instance, session.accountId, session.credentialRevision);
    const login = account?.user?.login ?? account?.user?.username;
    return Number.isSafeInteger(account?.user?.id) && login ? { id: account.user.id, login } : null;
  };

  /** A call as the session's account; a refused token carries the account for the shell's write-off. */
  const forwardAs = async (method, session, input) => {
    try {
      return await forward(method, {
        instance: session.instance,
        token: accounts.tokenFor(session) ?? null,
        user: await userOf(session),
        login: accounts.loginFor(session) ?? null,
        input,
      });
    } catch (error) {
      if (error?.status === 401) {
        error.sourceControlIdentity = { provider: id, instance: session.instance, accountId: session.accountId };
        error.sourceControlPersistedAccount = session.persisted;
      }
      throw error;
    }
  };

  /** `revision` goes out only to a host that declares revisions, and only as a commit sha. */
  const requireRevisionInput = (input) => {
    if (input.revision === undefined) return;
    if (!descriptor.capabilities.revisions) {
      throw refusedInput('INVALID_SOURCE_CONTROL_READ_CONTEXT', `${label} does not read change request revisions`);
    }
    if (!isString(input.revision) || !REVISION.test(input.revision)) {
      throw refusedInput('INVALID_SOURCE_CONTROL_READ_CONTEXT', 'revision must be a commit SHA');
    }
  };

  /** A resource read: the shell's input without the session, in plain JSON. */
  const read = (method) => async ({ session, ...input }) => {
    requireRevisionInput(input);
    return (await forwardAs(method, session, json(input))).data;
  };

  /** The head's clone URL on the instance, naming the head project; else the answer is malformed. */
  const requireEndpoint = (instance, source) => {
    let endpoint;
    try { endpoint = new URL(source.endpoint); } catch { endpoint = null; }
    const origin = new URL(instance);
    const loopbackHttp = origin.protocol === 'http:' && descriptor.presentation.instances.allowLoopbackHttp;
    const protocolAllowed = endpoint?.protocol === 'https:' || (loopbackHttp && endpoint?.protocol === 'http:');
    if (!endpoint || !protocolAllowed || endpoint.origin !== origin.origin || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash) {
      return false;
    }
    let path;
    try { path = decodeURIComponent(endpoint.pathname); } catch { return false; }
    return path.replace(/^\//, '').replace(/\.git$/, '') === `${source.sourceProject.owner}/${source.sourceProject.name}`;
  };

  const resolveChangeRequestSource = async ({ session, context, directory, remote, project, number, expectedHeadSha, requestedRemoteName }) => {
    const { data: source, outbound } = await forwardAs('resolveChangeRequestSource', session, json({ context, directory, remote, project, number, expectedHeadSha }));
    const expected = String(expectedHeadSha).toLowerCase();
    const sameRepository = source.sourceProject.id === source.targetProject.id;
    if (source.targetProject.id !== project.id || source.headSha !== expected
      || (source.classification === 'same-repository') !== sameRepository
      || !requireEndpoint(session.instance, source)) {
      throw malformed(label, 'the change request source does not match what was asked', outbound);
    }
    return Object.freeze({
      context,
      sourceProject: source.sourceProject,
      targetProject: source.targetProject,
      classification: source.classification,
      headSha: expected,
      headRef: source.headRef,
      endpoint: source.endpoint,
      requestedRemoteName,
    });
  };

  const changeRequestStatus = async ({ session, ...input }) => {
    const { data: status, outbound } = await forwardAs('changeRequestStatus', session, json(input));
    if (status.identity.provider !== id || status.identity.instance !== session.instance) {
      throw malformed(label, 'a status for another provider or instance', outbound);
    }
    return status;
  };

  const standardMutations = createStandardMutations(descriptor);
  /** The normalized input without the digest fields the host keeps for itself; votes only to a votes host. */
  const stepInput = (input) => {
    const { digest: _digest, ...rest } = input;
    if (rest.votes !== undefined && descriptor.capabilities.reviewModel !== 'votes') {
      throw refusedInput('INVALID_SOURCE_CONTROL_MUTATION_CONTEXT', `${label} reviews with a verdict, not votes`);
    }
    return json(rest);
  };

  /** The resolved target describes the context the shell validated, field by field. */
  const requireTargetOf = (context, target, outbound) => {
    const expected = context.target;
    const matches = target.repositoryId === context.repositoryId
      && target.bindingRevision === context.bindingRevision
      && target.primaryRemote === context.primaryRemote
      && PROJECT_FIELDS.every((key) => !Object.hasOwn(expected.project ?? {}, key) || target.project[key] === expected.project[key])
      && TARGET_FIELDS.every((key) => !Object.hasOwn(expected, key) || target[key] === expected[key]);
    if (!matches) throw malformed(label, 'a mutation target other than the one asked for', outbound);
  };

  const resolveTarget = async ({ session, context, kind, input, replayOf }) => {
    const request = { context: json(context), kind, input: stepInput(input) };
    if (replayOf) request.replayOf = json({ target: replayOf.target });
    const { data: resolved, outbound } = await forwardAs('mutation.resolveTarget', session, request);
    requireTargetOf(context, resolved.target, outbound);
    // A replay acts on exactly what the first attempt did; only a create is resolved again.
    if (replayOf && kind !== 'change-request-create' && !isDeepStrictEqual(json(resolved.target), json(replayOf.target))) {
      throw Object.assign(new Error('Source control mutation idempotency key was already used with different input'), {
        code: 'SOURCE_CONTROL_MUTATION_CONFLICT', status: 409,
      });
    }
    return resolved;
  };

  const mutationStep = (method) => async ({ session, route, kind, input, resolved }) => (await forwardAs(method, session, {
    route, kind, input: stepInput(input), resolved: json(resolved),
  })).data;

  /** Decided on what the proxy saw, never on the status the service reports. */
  const classifyError = (error) => {
    if (error?.sourceControlNotReached) return 'failed';
    const outbound = Array.isArray(error?.sourceControlOutbound) ? error.sourceControlOutbound : null;
    if (!outbound) return 'outcome-unknown';
    const writes = outbound.filter((request) => request.method !== 'GET');
    return writes.every((request) => Number.isInteger(request.status) && request.status >= 400 && request.status < 500)
      ? 'failed'
      : 'outcome-unknown';
  };

  return Object.freeze({
    descriptor,
    classifyFailure,
    auth: accounts.auth,
    transport: Object.freeze({ readCredential: accounts.readCredential }),
    resources: Object.freeze({
      changeRequestStatus,
      listChangeRequests: read('listChangeRequests'),
      changeRequestContext: read('changeRequestContext'),
      listIssues: read('listIssues'),
      getIssue: read('getIssue'),
      issueComments: read('issueComments'),
      projectUpstream: read('projectUpstream'),
      projectBranches: read('projectBranches'),
      listLabels: read('listLabels'),
      listReviewerCandidates: read('listReviewerCandidates'),
      readChangeRequestPatch: read('readChangeRequestPatch'),
      readChangeRequestFile: read('readChangeRequestFile'),
      liveSummaries: async ({ session, refs, issueRefs }) => (await forwardAs('liveSummaries', session, json({ refs, issueRefs }))).data,
      readChangeRequestHead: read('readChangeRequestHead'),
      resolveChangeRequestSource,
    }),
    mutations: Object.freeze({
      routes: standardMutations.routes,
      prepare: standardMutations.prepare,
      resolveTarget,
      perform: mutationStep('mutation.perform'),
      reconcile: mutationStep('mutation.reconcile'),
      classifyError,
    }),
    /** Called by the registry when it unregisters the provider: account writes still in flight are refused. */
    dispose: () => { disposed = true; },
  });
}
