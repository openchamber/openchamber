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
import { isSourceControlString as isString, isSourceControlInteger } from './input-guards.js';
import { isSourceControlProviderGuest } from './extension-providers.js';
import { createPatAccountAuth } from './pat-account-auth.js';
import { isProviderUsername } from './provider-id.js';
import { createStandardMutations } from './standard-mutations.js';
import type { z } from 'zod';
import type { SourceControlJson, SourceControlProviderInputs, SourceControlProviderMethod, SourceControlResourceMethod, ServiceContribution } from '@openchamber/sdk';
import type { ProviderDescriptor, ProviderReadContext, ProviderSession } from './provider-contract.js';
import type { GuestRecord } from '../guests/contracts.js';
import type { PatAccountAuthOptions } from './pat-account-auth.js';
import type { OutboundAttempt, OutboundCredential, createOutboundHandles } from './outbound-handles.js';
import type { StandardMutationInput } from './standard-mutations.js';
import type { MutationContextInput } from './binding-service-contracts.js';
import type { MutationRecord } from './mutation-storage.js';

type ProviderData<M extends SourceControlProviderMethod> = z.output<typeof sourceControlProviderSchemasV1.data[M]>;
type ProviderGuest = Pick<GuestRecord, 'id' | 'name' | 'packageRoot' | 'capabilityGrants'> & { service: ServiceContribution };
interface ProviderCallFailure {
  message?: unknown;
  code?: unknown;
  kind?: unknown;
  status?: unknown;
  sourceControlServiceLogin?: unknown;
  sourceControlNotReached?: unknown;
  sourceControlOutbound?: unknown;
  sourceControlIdentity?: unknown;
  sourceControlPersistedAccount?: unknown;
}
type FailureKind = 'provider-error' | 'temporarily-unavailable' | 'unreachable' | 'invalid-token';
interface ForwardInput {
  instance: string;
  token: string | null | undefined;
  user: { id: number | string; login: string } | null;
  login?: string | null;
  input: SourceControlJson;
  tokenless?: boolean;
}
type ReadInput<M extends SourceControlResourceMethod> = Omit<SourceControlProviderInputs[M], 'context'> & {
  session: ProviderSession; context?: ProviderReadContext; revision?: SourceControlJson;
};
type SourceInput = {
  session: ProviderSession;
  context: ProviderReadContext;
  directory: string;
  remote: string;
  project: { id: string; owner: string; name: string };
  number: number;
  expectedHeadSha: string;
  requestedRemoteName: string;
};
interface MutationStepInput {
  session: ProviderSession;
  route: string;
  kind: string;
  input: StandardMutationInput;
  resolved: ProviderData<'mutation.resolveTarget'>;
}
type MutationTargetRequest = {
  context: SourceControlJson;
  kind: string;
  input: SourceControlJson;
  replayOf?: SourceControlJson;
};
interface SessionAccount {
  user: ReturnType<ReturnType<typeof createPatAccountAuth>['userFor']>;
}
export interface ExtensionProviderOptions {
  descriptor: ProviderDescriptor & { extension: NonNullable<ProviderDescriptor['extension']> };
  guest: ProviderGuest;
  currentGuest(guestId: string): Promise<GuestRecord | null>;
  reconcile(): void;
  store: PatAccountAuthOptions['store'];
  events: PatAccountAuthOptions['events'];
  handles: ReturnType<typeof createOutboundHandles>;
  persistPath: string;
  proxy?: typeof proxyGuestServiceRequest;
}

const isCallFailure = (value: unknown): value is ProviderCallFailure => value !== null && value !== undefined;
const isAttemptList = (value: unknown): value is unknown[] => Array.isArray(value);
const hasAttemptFields = (value: unknown): value is { method?: unknown; status?: unknown } => value !== null && value !== undefined;
const attemptField = <Value>(value: Value, field: 'method' | 'status') => {
  if (!hasAttemptFields(value)) throw new TypeError(`Cannot read properties of ${value} (reading '${field}')`);
  return value[field];
};
const isInteger = (value: unknown): value is number => Number.isInteger(value);
const hasIntegerAttemptStatus = (value: unknown): value is { status: number } => isInteger(attemptField(value, 'status'));
const isStringUserId = (value: unknown): value is string => typeof value === 'string';

const schemas = sourceControlProviderSchemasV1;
const dataSchemas: { [M in SourceControlProviderMethod]: z.ZodType<ProviderData<M>> } = schemas.data;

const NOT_REACHED_CODES = new Set(['SERVICE_FAILED', 'NO_SERVICE', 'DISABLED']);

const failureKindOfServiceError = (code: GuestServiceError['code']) => {
  if (NOT_REACHED_CODES.has(code)) return 'temporarily-unavailable';
  if (code === 'REQUEST_FAILED') return 'unreachable';
  return 'provider-error';
};

const callError = (message: string, { status, code, kind = 'provider-error', outbound = [], notReached = false }: {
  status?: number | undefined; code?: string | undefined; kind?: FailureKind; outbound?: OutboundAttempt[]; notReached?: boolean;
} = {}) => {
  const error: Error & ProviderCallFailure = new Error(message);
  if (status !== undefined) error.status = status;
  if (code !== undefined) error.code = code;
  error.kind = kind;
  error.sourceControlOutbound = outbound;
  error.sourceControlNotReached = notReached;
  return error;
};

const malformed = (label: string, detail: string, outbound: OutboundAttempt[] = []) => callError(`${label} answered something OpenChamber cannot use: ${detail}`, {
  status: 502, code: 'MALFORMED_PROVIDER_RESPONSE', outbound,
});

const json = <Value extends object>(value: Value): SourceControlJson => JSON.parse(JSON.stringify(value));

const TARGET_FIELDS = ['number', 'head', 'base', 'headSha'] satisfies Array<keyof ProviderData<'mutation.resolveTarget'>['target']>;
const PROJECT_FIELDS = ['id', 'owner', 'name'] satisfies Array<keyof ProviderData<'mutation.resolveTarget'>['target']['project']>;

const READ_ONLY = Object.freeze(['GET']);
const outboundMethodsOf = (method: SourceControlProviderMethod) => (method === 'mutation.perform' ? SOURCE_CONTROL_OUTBOUND_METHODS : READ_ONLY);

const refusedInput = (code: string, message: string) => Object.assign(new Error(message), {
  status: 400, code, sourceControlNotReached: true,
});

const REVISION = /^[0-9a-f]{40}$/i;

const disposedError = (label: string) => Object.assign(new Error(`${label} is no longer available`), {
  status: 404, code: 'SOURCE_CONTROL_PROVIDER_UNAVAILABLE',
});

export function createExtensionProvider({
  descriptor, guest, currentGuest, reconcile, store: sectionStore, events, handles, persistPath, proxy = proxyGuestServiceRequest,
}: ExtensionProviderOptions) {
  const { id, label } = descriptor;
  const tokenFormat = descriptor.extension.token;
  const basicAuth = tokenFormat?.scheme === 'basic';
  const serviceLogin = descriptor.authMethods.cli !== false && descriptor.authMethods.cli?.kind === 'service';

  let disposed = false;
  const guardedWrite = <Args extends unknown[], Result>(write: (...args: Args) => Promise<Result>) => (...args: Args) => {
    if (disposed) return Promise.reject(disposedError(label));
    return write(...args);
  };
  const store = Object.freeze({
    ...sectionStore,
    setAccount: guardedWrite(sectionStore.setAccount),
    activate: guardedWrite(sectionStore.activate),
    markAccountInvalid: guardedWrite(sectionStore.markAccountInvalid),
    setCliActive: guardedWrite(sectionStore.setCliActive),
    setCliDisabled: guardedWrite(sectionStore.setCliDisabled),
  });

  const serviceError = (error: GuestServiceError, outbound: OutboundAttempt[]) => callError(`${label} could not answer (${error.code}): ${error.message}`, {
    kind: failureKindOfServiceError(error.code),
    outbound,
    notReached: NOT_REACHED_CODES.has(error.code),
  });

  const eligibleGuest = async () => {
    let current;
    try {
      current = await currentGuest(guest.id);
    } catch (error) {
      throw serviceError(new GuestServiceError(`the extension catalog could not be read: ${isCallFailure(error) ? error.message ?? error : error}`, 'NO_SERVICE'), []);
    }
    if (current && isSourceControlProviderGuest(current)) return current;
    void Promise.resolve().then(reconcile).catch((error) => {
      console.warn('[source-control] Failed to withdraw an extension Git host:', isCallFailure(error) ? error.message ?? error : error);
    });
    throw serviceError(new GuestServiceError('the extension may no longer serve this Git host', 'NO_SERVICE'), []);
  };

  const forward = async <M extends SourceControlProviderMethod>(method: M, { instance, token, user, login = null, input, tokenless = false }: ForwardInput) => {
    if (token && basicAuth && !isProviderUsername(login)) {
      throw refusedInput('SOURCE_CONTROL_USERNAME_REQUIRED', `${label} signs in with a username, and this account has none it can send`);
    }
    const current = await eligibleGuest();
    const timeoutMs = sourceControlProviderTimeoutMs(method);
    if (token && !tokenFormat) throw new TypeError('Cannot read properties of undefined (reading \'header\')');
    const credential: OutboundCredential | null = token && tokenFormat ? { token, header: tokenFormat.header, scheme: tokenFormat.scheme } : null;
    if (credential && basicAuth) credential.login = login;
    const grant = handles.mint({
      guestId: guest.id,
      providerId: id,
      origin: new URL(instance).origin,
      credential,
      deadline: Date.now() + timeoutMs,
      methods: tokenless ? [] : outboundMethodsOf(method),
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
        if (tokenless && user && code === 'ACCOUNT_CHANGED') {
          throw callError(message, { status: 401, code, kind: 'invalid-token', outbound: grant.outbound });
        }
        if (status === 401) {
          if (!grant.outbound.some((request) => request.status === 401)) {
            throw malformed(label, 'a 401 the forge did not give', grant.outbound);
          }
          throw callError(message, { status, code, kind: 'invalid-token', outbound: grant.outbound });
        }
        throw callError(message, { status, code, outbound: grant.outbound });
      }
      const data = dataSchemas[method].safeParse(envelope.data.data);
      if (!data.success) throw malformed(label, `${method} does not match its schema`, grant.outbound);
      return { data: data.data, outbound: grant.outbound };
    } catch (error) {
      if (tokenless) {
        if (!isCallFailure(error)) throw new TypeError(`Cannot set properties of ${error} (setting 'sourceControlServiceLogin')`);
        error.sourceControlServiceLogin = true;
      }
      throw error;
    } finally {
      grant.revoke();
    }
  };

  const verify = async (origin: string, token: string | undefined, { username = null }: { username?: string | null | undefined } = {}) => (await forward('auth.verify', {
    instance: origin, token, user: null, login: username, input: {},
  })).data.user;
  const probe = async (origin: string) => (await forward('auth.probe', { instance: origin, token: null, user: null, input: {} })).data;
  const classifyFailure = (error: Parameters<PatAccountAuthOptions['classifyFailure']>[0]) => error?.kind ?? 'provider-error';
  const cli = serviceLogin ? {
    status: async (instance: string) => (await forward('auth.status', {
      instance, token: null, user: null, input: {}, tokenless: true,
    })).data.user,
    listInstances: async () => [...descriptor.instance.defaultInstances],
  } : null;
  const accounts = createPatAccountAuth({ descriptor, store, events, verify, probe, classifyFailure, cli });

  const userOf = async (session: ProviderSession) => {
    const account: SessionAccount | null = session.persisted
      ? await store.readAccount(session.instance, session.accountId, session.credentialRevision)
      : { user: accounts.userFor(session) };
    const login = account?.user?.login ?? account?.user?.username;
    const userId = account?.user?.id;
    const validId = isSourceControlInteger(userId) && userId > 0
      || isStringUserId(userId) && userId.length > 0 && userId.length <= 256;
    return validId && login ? { id: userId, login } : null;
  };

  const forwardAs = async <M extends SourceControlProviderMethod>(method: M, session: ProviderSession, input: SourceControlJson) => {
    try {
      return await forward(method, {
        instance: session.instance,
        token: accounts.tokenFor(session) ?? null,
        user: await userOf(session),
        login: accounts.loginFor(session) ?? null,
        input,
        tokenless: serviceLogin && session.secretKind === 'cli',
      });
    } catch (error) {
      if (isCallFailure(error) && error.status === 401) {
        error.sourceControlIdentity = { provider: id, instance: session.instance, accountId: session.accountId };
        error.sourceControlPersistedAccount = session.persisted;
      }
      throw error;
    }
  };

  const requireRevisionInput = (input: { revision?: SourceControlJson | undefined }) => {
    if (input.revision === undefined) return;
    if (!descriptor.capabilities.revisions) {
      throw refusedInput('INVALID_SOURCE_CONTROL_READ_CONTEXT', `${label} does not read change request revisions`);
    }
    if (!isString(input.revision) || !REVISION.test(input.revision)) {
      throw refusedInput('INVALID_SOURCE_CONTROL_READ_CONTEXT', 'revision must be a commit SHA');
    }
  };

  const read = <M extends SourceControlResourceMethod>(method: M) => async ({ session, ...input }: ReadInput<M>) => {
    requireRevisionInput(input);
    return (await forwardAs(method, session, json(input))).data;
  };

  const requireEndpoint = (instance: string, source: ProviderData<'resolveChangeRequestSource'>) => {
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

  const resolveChangeRequestSource = async ({ session, context, directory, remote, project, number, expectedHeadSha, requestedRemoteName }: SourceInput) => {
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

  const changeRequestStatus = async ({ session, ...input }: { session: ProviderSession } & Omit<SourceControlProviderInputs['changeRequestStatus'], 'context'> & { context: ProviderReadContext }) => {
    const { data: status, outbound } = await forwardAs('changeRequestStatus', session, json(input));
    if (status.identity.provider !== id || status.identity.instance !== session.instance) {
      throw malformed(label, 'a status for another provider or instance', outbound);
    }
    return status;
  };

  const standardMutations = createStandardMutations(descriptor);
  const stepInput = (input: StandardMutationInput) => {
    const { digest: _digest, ...rest } = input;
    if (rest.votes !== undefined && descriptor.capabilities.reviewModel !== 'votes') {
      throw refusedInput('INVALID_SOURCE_CONTROL_MUTATION_CONTEXT', `${label} reviews with a verdict, not votes`);
    }
    return json(rest);
  };

  const requireTargetOf = (context: MutationContextInput & { target: { project: { id?: string } } }, target: ProviderData<'mutation.resolveTarget'>['target'], outbound: OutboundAttempt[]) => {
    const expected = context.target;
    const matches = target.repositoryId === context.repositoryId
      && target.bindingRevision === context.bindingRevision
      && target.primaryRemote === context.primaryRemote
      && PROJECT_FIELDS.every((key) => !Object.hasOwn(expected.project ?? {}, key) || target.project[key] === expected.project[key])
      && TARGET_FIELDS.every((key) => !Object.hasOwn(expected, key) || target[key] === expected[key]);
    if (!matches) throw malformed(label, 'a mutation target other than the one asked for', outbound);
  };

  const resolveTarget = async ({ session, context, kind, input, replayOf }: {
    session: ProviderSession; context: MutationContextInput; kind: string; input: StandardMutationInput; replayOf?: MutationRecord;
  }) => {
    const request: MutationTargetRequest = { context: json(context), kind, input: stepInput(input) };
    if (replayOf) request.replayOf = json({ target: replayOf.target });
    const { data: resolved, outbound } = await forwardAs('mutation.resolveTarget', session, request);
    requireTargetOf(context, resolved.target, outbound);
    if (replayOf && kind !== 'change-request-create' && !isDeepStrictEqual(json(resolved.target), json(replayOf.target))) {
      throw Object.assign(new Error('Source control mutation idempotency key was already used with different input'), {
        code: 'SOURCE_CONTROL_MUTATION_CONFLICT', status: 409,
      });
    }
    return resolved;
  };

  const mutationStep = <M extends 'mutation.perform' | 'mutation.reconcile'>(method: M) => async ({ session, route, kind, input, resolved }: MutationStepInput) => (await forwardAs(method, session, {
    route, kind, input: stepInput(input), resolved: json(resolved),
  })).data;

  const classifyError = (cause: unknown) => {
    const error = isCallFailure(cause) ? cause : undefined;
    if (error?.sourceControlNotReached) return 'failed';
    if (error?.sourceControlServiceLogin) return 'outcome-unknown';
    const outbound = isAttemptList(error?.sourceControlOutbound) ? error.sourceControlOutbound : null;
    if (!outbound) return 'outcome-unknown';
    const writes = outbound.filter((request) => attemptField(request, 'method') !== 'GET');
    return writes.every((request) => hasIntegerAttemptStatus(request) && request.status >= 400 && request.status < 500)
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
      liveSummaries: async ({ session, refs, issueRefs }: { session: ProviderSession } & SourceControlProviderInputs['liveSummaries']) => (await forwardAs('liveSummaries', session, json({ refs, issueRefs }))).data,
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
    dispose: () => { disposed = true; },
  });
}
