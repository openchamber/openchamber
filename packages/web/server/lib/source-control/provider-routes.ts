import { Readable } from 'node:stream';
import express from 'express';
import { pipeline } from 'node:stream/promises';

import { hasProperties, isString } from '../shared/guards.js';
import { createOAuthFlowRegistry } from './oauth-flow-registry.js';
import { mutationReceipt } from './mutation-executor.js';
import { readBranchTip } from './change-id.js';
import { createChangeRequestStatusCache } from './status-cache.js';
import { allowsTopLevelProjects } from './project-path.js';
import { isProviderUserId, isProviderUsername } from './provider-id.js';
import { assertMutationContextObject } from './binding-input.js';
import type { SourceControlJson } from '@openchamber/sdk';
import type { Query, QueryValue, Request, RequestHandler, Response, Router } from '../shared/http-contracts.js';
import type { AccountIdentity, ProviderDescriptor, ProviderMutationContext, ProviderReadContext, ReadContextRequest } from './provider-contract.js';
import type { createMutationExecutor } from './mutation-executor.js';
import type { MutationRecord } from './mutation-storage.js';
import type { RegisteredMutationInput, RegisteredProvider, createSourceControlProviders } from './provider-registry.js';
import type { LiveSummariesResult, TrackedItemReaderOptions } from '../tracked-items/contracts.js';
import type { ChangeRequestFileInput, ChangeRequestReadInput } from '../walkthrough/pull-request.js';
import type { SourceRequest } from '../git/network-execution-contracts.js';

type Resources = RegisteredProvider['resources'];
type LiveSummariesInput = Parameters<NonNullable<TrackedItemReaderOptions['readLiveSummaries']>>[0];
type RegisteredMutations = NonNullable<RegisteredProvider['mutations']>;
type ResolvedMutation = Awaited<ReturnType<RegisteredMutations['resolveTarget']>>;
interface MutationNotice { context: ProviderMutationContext; kind: string; input: RegisteredMutationInput }
export interface ProviderRouteOptions {
  providers: ReturnType<typeof createSourceControlProviders>;
  validateReadContext?: ((input: ReadContextRequest) => Promise<ProviderReadContext>) | undefined;
  validateMutationContext?: ((input: SourceControlJson) => Promise<ProviderMutationContext>) | undefined;
  mutationExecutor?: Pick<ReturnType<typeof createMutationExecutor>, 'read' | 'execute'> | undefined;
  onMutationSucceeded?: ((notice: MutationNotice & { record: MutationRecord; replayed: boolean }) => void | Promise<void>) | undefined;
  onMutationStarting?: ((notice: MutationNotice & { target: ResolvedMutation['target'] }) => (() => void) | null | undefined) | undefined;
  oauthFlowRegistry?: ReturnType<typeof createOAuthFlowRegistry> | undefined;
}
type QueryRequest = Pick<Request, 'query'>;
type ProviderHandler = RequestHandler<SourceControlJson | undefined>;
interface RouteError {
  cause?: unknown;
  response?: unknown;
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  kind?: unknown;
  message?: unknown;
  current?: unknown;
  sourceControlResponse?: unknown;
  sourceControlIdentity?: unknown;
  sourceControlAccountUnavailable?: unknown;
  sourceControlAuthUnknown?: unknown;
  sourceControlPersistedAccount?: unknown;
  sourceControlServiceLogin?: unknown;
}
const isRouteError = (value: unknown): value is RouteError => value != null;
const routeError = (cause: unknown): RouteError | undefined => (isRouteError(cause) ? cause : undefined);
const isResponseStatus = (value: unknown): value is { status?: unknown } => value != null;
const isProviderResponse = (value: unknown): value is { status?: unknown; body?: unknown } => value != null;
const isFailedIdentity = (value: unknown): value is FailedIdentity => value != null;
const failedIdentity = (error: RouteError | undefined) => (isFailedIdentity(error?.sourceControlIdentity) ? error.sourceControlIdentity : undefined);
const isInteger = (value: unknown): value is number => Number.isInteger(value);
const isProjectKey = (value: string): value is 'id' | 'owner' | 'name' => ['id', 'owner', 'name'].includes(value);
const isReferenceKind = (value: string): value is 'issue' | 'pull' | 'discussion' => ['issue', 'pull', 'discussion'].includes(value);
const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);
const hasCapabilityKey = (value: unknown): value is Readonly<Record<string, unknown>> => value != null;
interface BoundReadInput { req: QueryRequest; res: Response; impl: RegisteredProvider; instance: string; directory: string; trustedContext: ProviderReadContext }
interface BoundReadChecks {
  validate?: (req: QueryRequest) => string | { error: string; code: string } | null;
  validateAfterInstance?: (req: QueryRequest) => string | null;
}
interface ListFilter { state: string; people: string; labels?: string[] }
interface SourceControlErrorBody { error: unknown; code: unknown; current?: unknown }
interface ChangeRequestStatus { fetchedAt?: unknown }
interface FailedIdentity { provider?: unknown; instance?: unknown; accountId?: unknown }
interface StartedMutation { settle: (() => void) | null }
const bodyField = <Body>(body: Body, key: string) => (hasProperties(body) ? body[key] : undefined);


const STATUS_CACHE_TTL_MS = 90_000;
const STATUS_RESOLVE_TIMEOUT_MS = 12_000;

const withTimeout = async <Value>(promise: Promise<Value>, timeoutMs: number, label: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`${label} timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const upstreamStatusOf = (cause: unknown) => {
  const error = routeError(cause);
  const nested = routeError(error?.cause)?.response;
  return (isResponseStatus(nested) ? nested.status : undefined)
    ?? (isResponseStatus(error?.response) ? error.response.status : undefined)
    ?? error?.status;
};

function errorStatus<Kind>(kind: Kind) {
  return kind === 'temporarily-unavailable' ? 503 : kind === 'unreachable' ? 502 : 500;
}

const hasCodePrefix = (error: RouteError | undefined, prefix: string) => isString(error?.code) && error.code.startsWith(prefix);

function sendAuthStorageError(res: Response, cause: unknown) {
  const answered = sendProviderResponse(res, cause);
  if (answered) return answered;
  const error = routeError(cause);
  if (hasCodePrefix(error, 'SOURCE_CONTROL_LOCK_')) {
    return res.status(error?.status).json({ error: error?.message, code: error?.code });
  }
  if (error?.code === 'INVALID_SOURCE_CONTROL_AUTH') {
    return res.status(500).json({ error: error.message, code: error.code });
  }
  return null;
}

function sendProviderResponse(res: Response, cause: unknown) {
  const response = routeError(cause)?.sourceControlResponse;
  return response && isProviderResponse(response) ? res.status(response.status).json(response.body) : null;
}

function requestText<Value>(value: Value) {
  return isString(value) ? value.trim() : '';
}

function requestNumber(value: QueryValue | undefined) {
  const number = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function requestIssueNumber(value: QueryValue | undefined) {
  const text = requestText(value);
  if (!/^[1-9]\d*$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

function readLabelFilter(value: QueryValue | undefined) {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const names = raw
    .map((entry) => requestText(entry))
    .filter((entry) => entry.length > 0 && entry.length <= 256);
  return [...new Set(names)].slice(0, 20);
}

function readListFilter(query: Query) {
  const state = requestText(query?.state);
  const people = requestText(query?.people);
  const states = requestText(query?.kind) === 'discussion' ? ['open', 'closed', 'all', 'unanswered'] : ['open', 'closed', 'merged', 'all'];
  const labels = readLabelFilter(query?.label);
  const filter: ListFilter = {
    state: states.includes(state) ? state : 'open',
    people: ['any', 'assigned', 'created', 'reviewRequested'].includes(people) ? people : 'any',
  };
  if (labels.length > 0) filter.labels = labels;
  return filter;
}

const UPLOAD_SECRET_RE = /^[0-9a-f]{32}$/;
const UPLOAD_MEDIA_TYPE_RE = /^(?:image\/(?:png|jpeg|gif|webp|avif)|video\/(?:mp4|webm|quicktime))$/;
const UPLOAD_EXTENSION_TYPES = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp'], ['avif', 'image/avif'],
  ['mp4', 'video/mp4'], ['m4v', 'video/mp4'], ['webm', 'video/webm'], ['mov', 'video/quicktime'],
]);

function uploadMediaType(upstreamType: string, filename: string) {
  const [mediaType = ''] = upstreamType.split(';');
  const type = mediaType.trim().toLowerCase();
  if (UPLOAD_MEDIA_TYPE_RE.test(type)) return type;
  if (type && type !== 'application/octet-stream') return null;
  return UPLOAD_EXTENSION_TYPES.get((filename.split('.').at(-1) ?? '').toLowerCase()) ?? null;
}
const UPLOAD_PASSED_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

function readUploadParams(params: Record<string, string>) {
  const secret = requestText(params?.secret);
  const filename = isString(params?.filename) ? params.filename : '';
  const plainName = filename && filename !== '.' && filename !== '..' && !/[/\\]/.test(filename);
  return UPLOAD_SECRET_RE.test(secret) && plainName ? { secret, filename } : null;
}

const isReadContextError = (error: RouteError | undefined) => hasCodePrefix(error, 'SOURCE_CONTROL_BINDING_')
  || hasCodePrefix(error, 'SOURCE_CONTROL_LOCK_')
  || error?.code === 'SOURCE_CONTROL_PROVIDER_UNAVAILABLE'
  || error?.code === 'INVALID_SOURCE_CONTROL_READ_CONTEXT'
  || error?.code === 'INVALID_SOURCE_CONTROL_BINDING';

const sourceControlErrorBody = (cause: unknown) => {
  const error = routeError(cause);
  const body: SourceControlErrorBody = { error: error?.message, code: error?.code };
  if (error !== undefined && Object.hasOwn(error, 'current')) body.current = error.current;
  return body;
};

const mutationConflict = () => Object.assign(
  new Error('Source control mutation idempotency key was already used with different input'),
  { code: 'SOURCE_CONTROL_MUTATION_CONFLICT', status: 409 },
);

const requireReplayMatch = (record: MutationRecord, kind: string, actor: AccountIdentity, context: ProviderMutationContext) => {
  if (record.kind !== kind
    || record.actor?.provider !== actor.provider
    || record.actor?.instance !== actor.instance
    || record.actor?.accountId !== actor.accountId
    || record.target?.repositoryId !== context.repositoryId
    || record.target?.bindingRevision !== context.bindingRevision
    || record.target?.primaryRemote !== context.primaryRemote) throw mutationConflict();
  const expected = context.target;
  for (const [key, value] of Object.entries(expected.project)) {
    if (isProjectKey(key) && record.target?.project?.[key] !== value) throw mutationConflict();
  }
  for (const key of ['number', 'head', 'base', 'headSha'] as const) {
    if (Object.hasOwn(expected, key) && record.target?.[key] !== expected[key]) throw mutationConflict();
  }
};

const classifyMutationError = (cause: unknown) => {
  const error = routeError(cause);
  const status = upstreamStatusOf(error);
  const localSourceControlError = hasCodePrefix(error, 'SOURCE_CONTROL_')
    || hasCodePrefix(error, 'INVALID_SOURCE_CONTROL_');
  if (!localSourceControlError && isInteger(status) && status >= 400 && status < 500) {
    if (error && !Number.isInteger(error.status)) error.status = status;
    return 'failed';
  }
  return 'outcome-unknown';
};

const changeRequestReceipt = (record: MutationRecord, replayed: boolean, providerAccountId: string) => {
  const receipt = mutationReceipt(record, replayed, providerAccountId);
  if (receipt.target.number !== undefined || !receipt.result || !isSafeInteger(receipt.result.number)) return receipt;
  const { number, ...result } = receipt.result;
  return { ...receipt, target: { ...receipt.target, number }, result };
};

const REVISION_RE = /^[0-9a-f]{40}$/;
const invalidReadContext = (message: string) => Object.assign(new Error(message), {
  code: 'INVALID_SOURCE_CONTROL_READ_CONTEXT', status: 400,
});
const namesRevision = <Value>(value: Value) => value !== undefined && value !== '';
const revisionProblem = <Value>(descriptor: ProviderDescriptor | null, value: Value) => {
  if (!namesRevision(value)) return null;
  if (!descriptor?.capabilities.revisions) return 'This source control provider does not keep change request revisions';
  return isString(value) && REVISION_RE.test(value.trim().toLowerCase()) ? null : 'revision must be a full commit SHA';
};
const readRevision = <Value>(descriptor: ProviderDescriptor | null, value: Value) => {
  const problem = revisionProblem(descriptor, value);
  if (problem) throw invalidReadContext(problem);
  return namesRevision(value) && isString(value) ? value.trim().toLowerCase() : undefined;
};
const withRevision = <Input>(input: Input, revision: string | undefined) => (revision === undefined ? input : { ...input, revision });

const unsupportedCapability = (res: Response) => res.status(501).json({
  error: 'This source control provider does not support this operation',
  code: 'SOURCE_CONTROL_CAPABILITY_UNSUPPORTED',
});

const enabled = (capabilities: ProviderDescriptor['capabilities'], capability: string) => capability.split('.')
  .reduce<unknown>((value, key) => (hasCapabilityKey(value) ? value[key] : undefined), capabilities);

const MUTATION_ROUTES = [
  ['/pr/create', 'changeRequests'],
  ['/pr/update', 'changeRequests'],
  ['/pr/merge', 'merge'],
  ['/pr/ready', 'draftChangeRequests'],
  ['/pr/draft', 'draftConversion'],
  ['/pr/comment', 'comments'],
  ['/pr/thread/start', 'reviewThreads.start'],
  ['/pr/thread/reply', 'reviewThreads.reply'],
  ['/pr/thread/resolve', 'reviewThreads.resolve'],
  ['/issues/comment', 'comments'],
  ['/issues/update', 'issues'],
  ['/pr/comment/update', 'commentEdit'],
  ['/pr/comment/delete', 'commentEdit'],
  ['/issues/comment/update', 'commentEdit'],
  ['/issues/comment/delete', 'commentEdit'],
  ['/pr/state', 'state'],
  ['/issues/state', 'state'],
  ['/pr/labels', 'labels'],
  ['/issues/labels', 'labels'],
  ['/pr/reviewers', 'reviewers'],
  ['/pr/review', 'reviews'],
  ['/pr/review/comment', 'reviewDrafts'],
  ['/pr/review/comment/update', 'reviewDrafts'],
  ['/pr/review/comment/delete', 'reviewDrafts'],
  ['/pr/review/discard', 'reviewDrafts'],
  ['/discussions/comment', 'discussions'],
  ['/discussions/comment/update', 'commentEdit'],
  ['/discussions/comment/delete', 'commentEdit'],
  ['/discussions/state', 'discussions'],
  ['/discussions/answer', 'discussions'],
  ['/discussions/labels', 'discussions'],
  ['/discussions/update', 'discussions'],
] as const;

export function registerProviderRoutes(app: Router, {
  providers,
  validateReadContext,
  validateMutationContext,
  mutationExecutor,
  onMutationSucceeded = async () => {},
  onMutationStarting = () => null,
  oauthFlowRegistry = createOAuthFlowRegistry(),
}: ProviderRouteOptions) {
  type StatusCache = ReturnType<typeof createChangeRequestStatusCache<ChangeRequestStatus>>;
  const statusCaches = new Map<string, StatusCache>();
  const statusCacheFor = (id: string) => {
    let cache = statusCaches.get(id);
    if (!cache) {
      cache = createChangeRequestStatusCache<ChangeRequestStatus>({ ttlMs: STATUS_CACHE_TTL_MS });
      statusCaches.set(id, cache);
    }
    return cache;
  };
  providers.events.subscribe({
    invalidated: ({ provider, instance, accountId }) => {
      statusCaches.get(provider)?.invalidate({ instance, accountId });
    },
  });

  const unavailableProvider = () => Object.assign(new Error('Source control provider is unavailable'), {
    code: 'SOURCE_CONTROL_PROVIDER_UNAVAILABLE', status: 404,
  });
  const loadImplementation = async (id: string) => {
    const impl = await providers.implementation(id);
    if (!impl) throw unavailableProvider();
    return impl;
  };

  for (const descriptor of providers.list()) registerProvider(descriptor);

  const extensionRouters = new Map<string, Router>();
  const EXTENSION_PATH = /^\/api\/source-control\/(ext-[a-z0-9-]+)(?:\/|$)/;
  const mountExtension = (descriptor: ProviderDescriptor) => {
    const router = express.Router();
    statusCaches.delete(descriptor.id);
    registerProvider(descriptor, router);
    extensionRouters.set(descriptor.id, router);
  };
  const unmountExtension = (id: string) => {
    extensionRouters.delete(id);
    statusCaches.delete(id);
  };
  const extensionDispatcher: RequestHandler = (req, res, next) => {
    const match = EXTENSION_PATH.exec(req.path);
    const router = match?.[1] === undefined ? null : extensionRouters.get(match[1]);
    if (!router) return next();
    return router(req, res, next);
  };

  function registerProvider(descriptor: ProviderDescriptor, target: Router = app) {
    const { id, label } = descriptor;
    const base = `/api/source-control/${id}`;
    const statusCache = statusCacheFor(id);
    const requestInstance = (req: QueryRequest) => descriptor.instance.normalize(
      (isString(req.query?.instance) ? req.query.instance.trim() : '') || (descriptor.instances?.legacyFlow?.instance ?? ''),
    );

    const aliases = descriptor.routeAliases ?? null;
    const extraNames = (suffix: string) => Object.entries(aliases?.extraAuthAliases ?? {})
      .filter(([, canonical]) => canonical === suffix).map(([alias]) => alias);
    const authPaths = (suffix: string) => {
      const paths = [suffix, ...extraNames(suffix)]
        .flatMap((name) => [...(aliases?.authAliasPrefix ? [`${aliases.authAliasPrefix}${name}`] : []), `${base}${name}`]);
      const [only] = paths;
      return paths.length === 1 && only !== undefined ? only : paths;
    };
    if (aliases?.authAliasPrefix) {
      const retired: ProviderHandler = (_req, res) => res.status(410).json({
        error: `Legacy ${label} repository API is retired`,
        code: 'SOURCE_CONTROL_CONTEXT_REQUIRED',
      });
      for (const suffix of aliases.retiredGet) target.get(`${aliases.authAliasPrefix}${suffix}`, retired);
      for (const suffix of aliases.retiredPost) target.post(`${aliases.authAliasPrefix}${suffix}`, retired);
    }

    const route = (method: 'get' | 'post', suffix: string, capability: string | null, handler: ProviderHandler, path: string | string[] = `${base}${suffix}`) => {
      if (capability && !enabled(descriptor.capabilities, capability)) {
        target[method](path, (_req, res) => unsupportedCapability(res));
        return;
      }
      target[method](path, handler);
    };

    const topLevelProjects = allowsTopLevelProjects(descriptor);
    const requestedProject = (req: QueryRequest) => {
      const owner = requestText(req.query?.owner);
      const name = requestText(req.query?.repo);
      if (name && (owner || topLevelProjects)) return { state: 'project', project: { owner, name } };
      return { state: owner || name ? 'incomplete' : 'none' };
    };
    const namesProject = (req: QueryRequest) => requestedProject(req).state === 'project';
    const optionalProject = (req: QueryRequest) => requestedProject(req).project;
    const projectSelectorProblem = (req: QueryRequest) => requestedProject(req).state === 'incomplete';

    const invalidateAccount = async (impl: RegisteredProvider, identity: FailedIdentity, persisted: boolean) => {
      statusCache.invalidate({ instance: identity.instance, accountId: identity.accountId });
      return impl.auth.invalidateAccount({ instance: identity.instance, accountId: identity.accountId, persisted });
    };

    const invalidateRefusedAccount = async (res: Response, impl: RegisteredProvider, cause: unknown) => {
      const error = routeError(cause);
      if (upstreamStatusOf(error) !== 401 || error?.sourceControlAccountUnavailable) return null;
      const identity = failedIdentity(error);
      if (!identity?.accountId) return null;
      try {
        await invalidateAccount(impl, identity, Boolean(error?.sourceControlPersistedAccount));
        return null;
      } catch (thrown) {
        const failure = routeError(thrown);
        if (hasCodePrefix(failure, 'SOURCE_CONTROL_LOCK_')) {
          return res.status(failure?.status).json({ error: failure?.message, code: failure?.code });
        }
        throw thrown;
      }
    };

    const sendResourceError = async (res: Response, impl: RegisteredProvider, cause: unknown) => {
      const error = routeError(cause);
      const upstreamStatus = upstreamStatusOf(error);
      const lockFailure = await invalidateRefusedAccount(res, impl, error);
      if (lockFailure) return lockFailure;
      const status = isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus < 600
        ? upstreamStatus
        : errorStatus(impl.classifyFailure(cause));
      return res.status(status).json({ error: error?.message || `${label} resource request failed` });
    };

    const isTransientFailure = (impl: RegisteredProvider, cause: unknown) => {
      const upstreamStatus = upstreamStatusOf(cause);
      if (upstreamStatus === 429 || (isInteger(upstreamStatus) && upstreamStatus >= 500)) return true;
      if (Number.isInteger(upstreamStatus)) return false;
      const kind = impl.classifyFailure(cause);
      return kind === 'unreachable' || kind === 'temporarily-unavailable';
    };

    const readContextOf = async (req: QueryRequest, instance: string, directory: string) => {
      const context = await validateReadContext?.({
        directory,
        repositoryId: req.query?.repositoryId,
        provider: id,
        instance,
        accountId: req.query?.accountId,
        bindingRevision: Number(req.query?.bindingRevision),
        primaryRemote: req.query?.primaryRemote,
      });
      return context && req.query?.linked === '1' ? { ...context, linked: true } : context;
    };

    const boundRead = (capability: string, suffix: string, read: (input: BoundReadInput) => Promise<Response>, { validate, validateAfterInstance }: BoundReadChecks = {}) => {
      route('get', suffix, capability, async (req, res) => {
        let impl;
        try {
          impl = await loadImplementation(id);
          const early = validate?.(req);
          if (early) return res.status(400).json(isString(early) ? { error: early } : early);
          const instance = requestInstance(req);
          const late = validateAfterInstance?.(req);
          if (late) return res.status(400).json({ error: late });
          const directory = requestText(req.query?.directory);
          const trustedContext = await readContextOf(req, instance, directory);
          if (!trustedContext) return res.status(501).json({ error: 'Bound source control status is unavailable' });
          return await read({ req, res, impl, instance, directory, trustedContext });
        } catch (error) {
          if (isReadContextError(routeError(error))) return res.status(routeError(error)?.status ?? 400).json(sourceControlErrorBody(error));
          if (!impl) return res.status(routeError(error)?.status ?? 500).json(sourceControlErrorBody(error));
          return sendProviderResponse(res, error) ?? sendResourceError(res, impl, error);
        }
      });
    };
    const sessionFor = (impl: RegisteredProvider, instance: string, accountId: string) => impl.auth.resolveAccount({ instance, accountId });
    const requireResource = <Method extends keyof Resources>(impl: RegisteredProvider, method: Method) => {
      const resource = impl.resources?.[method];
      if (!(resource instanceof Function)) {
        throw Object.assign(new Error('This source control provider does not support this operation'), {
          code: 'SOURCE_CONTROL_CAPABILITY_UNSUPPORTED', status: 501,
        });
      }
      return resource;
    };

    target.get(`${base}/capabilities`, async (req, res) => {
      let impl;
      try {
        impl = await loadImplementation(id);
        const instance = requestInstance(req);
        const dynamic = await impl.auth.capabilities({ instance });
        const { capabilities } = descriptor;
        const published = {
          identity: { provider: id, instance },
          ...dynamic,
          multipleAccounts: capabilities.multipleAccounts,
          projects: capabilities.projects,
          issues: capabilities.issues,
          changeRequests: capabilities.changeRequests,
          draftChangeRequests: capabilities.draftChangeRequests,
          mergeChangeRequests: Boolean(capabilities.merge),
          mergeMethods: capabilities.merge ? [...capabilities.merge.methods] : [],
          ci: capabilities.ci,
        };
        return res.json(capabilities.draftConversion ? { ...published, draftConversion: true } : published);
      } catch (error) {
        const kind = impl ? impl.classifyFailure(error) : 'provider-error';
        return res.status(errorStatus(kind)).json({ error: routeError(error)?.message || `Failed to probe ${label}`, status: kind });
      }
    });

    target.get(authPaths('/auth/status'), async (req, res) => {
      try {
        const impl = await loadImplementation(id);
        return res.json(await impl.auth.status({ instance: requestInstance(req) }));
      } catch (cause) {
        const lockResponse = sendAuthStorageError(res, cause);
        if (lockResponse) return lockResponse;
        const error = routeError(cause);
        if (error?.sourceControlAuthUnknown) {
          return res.status(errorStatus(error.kind)).json({ error: error.message });
        }
        if (error?.kind === 'unreachable' || error?.kind === 'temporarily-unavailable') {
          let instance;
          try {
            instance = requestInstance(req);
          } catch {
            return res.status(400).json({ error: `Invalid ${label} instance URL` });
          }
          return res.json({ provider: id, instance, status: error.kind, connected: false, message: error.message });
        }
        return res.status(400).json({ error: error?.message || `Failed to get ${label} auth status` });
      }
    });

    target.get(authPaths('/auth/accounts'), async (req, res) => {
      try {
        const impl = await loadImplementation(id);
        const instance = requestInstance(req);
        return res.json({ provider: id, instance, accounts: await impl.auth.accounts({ instance }) });
      } catch (error) {
        const lockResponse = sendAuthStorageError(res, error);
        if (lockResponse) return lockResponse;
        return res.status(400).json({ error: routeError(error)?.message || `Failed to list ${label} accounts` });
      }
    });

    const deviceFlow = descriptor.authMethods.device;
    route('post', '/auth/start', null, async (req, res) => {
      res.set('Cache-Control', 'no-store');
      let impl;
      try {
        impl = await loadImplementation(id);
        if (!deviceFlow || !(impl.auth.startDeviceFlow instanceof Function)) return unsupportedCapability(res);
        const instance = requestInstance(req);
        const { flow, result } = await impl.auth.startDeviceFlow({ instance });
        const { flowId } = oauthFlowRegistry.register({
          provider: id, instance, deviceCode: flow.deviceCode, clientId: flow.clientId, expiresIn: flow.expiresIn,
        });
        return res.json({ flowId, ...result });
      } catch (error) {
        const answered = sendProviderResponse(res, error);
        if (answered) return answered;
        const kind = impl ? impl.classifyFailure(error) : 'provider-error';
        return res.status(errorStatus(kind)).json({ error: routeError(error)?.message || `Failed to start ${label} device flow`, status: kind });
      }
    }, authPaths('/auth/start'));

    route('post', '/auth/complete', null, async (req, res) => {
      res.set('Cache-Control', 'no-store');
      let flowId = '';
      let acquired = false;
      let impl;
      try {
        impl = await loadImplementation(id);
        if (!deviceFlow || !(impl.auth.completeDeviceFlow instanceof Function)) return unsupportedCapability(res);
        const instance = requestInstance(req);
        const requestedFlowId = bodyField(req.body, 'flowId');
        flowId = isString(requestedFlowId) ? requestedFlowId.trim() : '';
        if (!flowId) return res.status(400).json({ error: 'flowId is required' });
        let flow;
        try {
          flow = oauthFlowRegistry.acquire({ flowId, provider: id, instance });
          acquired = true;
        } catch (cause) {
          const error = routeError(cause);
          if (error?.code === 'SOURCE_CONTROL_OAUTH_FLOW_BUSY') return res.status(409).json({ error: 'OAuth flow is busy', code: error.code });
          if (error?.code === 'SOURCE_CONTROL_OAUTH_FLOW_UNAVAILABLE') return res.status(410).json({ error: 'OAuth flow is unavailable', code: error.code });
          throw cause;
        }
        const outcome = await impl.auth.completeDeviceFlow({ instance, deviceCode: flow.deviceCode, clientId: flow.clientId }, {
          consume: () => {
            oauthFlowRegistry.consume(flowId);
            acquired = false;
          },
        });
        if (outcome.pending) {
          oauthFlowRegistry.release(flowId);
          acquired = false;
        }
        return res.json(outcome.body);
      } catch (error) {
        if (acquired) oauthFlowRegistry.release(flowId);
        const lockResponse = sendAuthStorageError(res, error);
        if (lockResponse) return lockResponse;
        const kind = impl ? impl.classifyFailure(error) : 'provider-error';
        return res.status(errorStatus(kind)).json({ error: routeError(error)?.message || `Failed to complete ${label} device flow`, status: kind });
      }
    }, authPaths('/auth/complete'));

    const takesUsername = descriptor.settings.some((field) => field.type === 'username');
    target.post(authPaths('/auth/token'), async (req, res) => {
      let impl;
      try {
        impl = await loadImplementation(id);
        if (!descriptor.authMethods.pat) return unsupportedCapability(res);
        let instance;
        try {
          instance = requestInstance(req);
        } catch (error) {
          return res.status(400).json({ error: routeError(error)?.message });
        }
        const requestedToken = bodyField(req.body, 'token');
        const token = isString(requestedToken) ? requestedToken.trim() : '';
        if (!token) return res.status(400).json({ error: 'token is required' });
        if (!takesUsername) return res.json(await impl.auth.connectToken({ instance, token }));
        const requestedUsername = bodyField(req.body, 'username');
        const username = isString(requestedUsername) ? requestedUsername.trim() : '';
        if (!isProviderUsername(username)) {
          return res.status(400).json({ error: 'username is required' });
        }
        return res.json(await impl.auth.connectToken({ instance, token, username }));
      } catch (cause) {
        const lockResponse = sendAuthStorageError(res, cause);
        if (lockResponse) return lockResponse;
        const error = routeError(cause);
        if (error?.kind === 'invalid-token') {
          return res.status(401).json({ error: error?.message || `${label} token is invalid`, code: 'INVALID_TOKEN' });
        }
        const kind = impl ? impl.classifyFailure(cause) : 'provider-error';
        return res.status(errorStatus(kind)).json({ error: error?.message || `Failed to verify ${label} token` });
      }
    });

    const takesSshUrl = descriptor.settings.some((field) => field.key === 'sshUrl');
    target.post(authPaths('/auth/ssh-url'), async (req, res) => {
      let impl;
      try {
        impl = await loadImplementation(id);
        if (!takesSshUrl || !(impl.auth.setSshUrl instanceof Function)) return unsupportedCapability(res);
        let instance;
        try { instance = requestInstance(req); }
        catch (error) { return res.status(400).json({ error: routeError(error)?.message }); }
        const value = bodyField(req.body, 'sshUrl');
        if (value !== undefined && value !== null && !isString(value)) {
          return res.status(400).json({ error: 'sshUrl must be a string' });
        }
        return res.json(await impl.auth.setSshUrl({ instance, sshUrl: isString(value) ? value : null }));
      } catch (error) {
        const lockResponse = sendAuthStorageError(res, error);
        if (lockResponse) return lockResponse;
        const answered = sendProviderResponse(res, error);
        if (answered) return answered;
        const kind = impl ? impl.classifyFailure(error) : 'provider-error';
        return res.status(errorStatus(kind)).json({ error: routeError(error)?.message || `Failed to save ${label} SSH URL` });
      }
    });

    target.post(authPaths('/auth/activate'), async (req, res) => {
      try {
        const impl = await loadImplementation(id);
        const instance = requestInstance(req);
        const requestedAccountId = bodyField(req.body, 'accountId');
        const accountId = isString(requestedAccountId) ? requestedAccountId : '';
        return res.json(await impl.auth.activate({ instance, accountId }));
      } catch (error) {
        const lockResponse = sendAuthStorageError(res, error);
        if (lockResponse) return lockResponse;
        return res.status(400).json({ error: routeError(error)?.message || `Failed to activate ${label} account` });
      }
    });

    target.post(authPaths('/auth/cli'), async (req, res) => {
      try {
        const impl = await loadImplementation(id);
        if (!descriptor.authMethods.cli || !(impl.auth.setCliDisabled instanceof Function)) return unsupportedCapability(res);
        const instance = requestInstance(req);
        return res.json(await impl.auth.setCliDisabled({ instance, disabled: Boolean(bodyField(req.body, 'disabled')) }));
      } catch (error) {
        const lockResponse = sendAuthStorageError(res, error);
        if (lockResponse) return lockResponse;
        const tool = descriptor.authMethods.cli ? descriptor.authMethods.cli.tool : label;
        return res.status(400).json({ error: routeError(error)?.message || `Failed to inspect ${tool} authentication` });
      }
    });

    target.delete(authPaths('/auth'), async (req, res) => {
      try {
        const impl = await loadImplementation(id);
        const instance = requestInstance(req);
        const requested = req.query?.accountId ?? bodyField(req.body, 'accountId');
        const accountId = requestText(requested);
        if (!accountId || requested !== accountId) return res.status(400).json({ error: 'accountId is required' });
        return res.json(await impl.auth.remove({ instance, accountId }));
      } catch (error) {
        const lockResponse = sendAuthStorageError(res, error);
        if (lockResponse) return lockResponse;
        return res.status(400).json({ error: routeError(error)?.message || `Failed to disconnect ${label}` });
      }
    });

    boundRead('changeRequests', '/pr/status', async ({ req, res, impl, instance, directory, trustedContext }) => {
      const branch = requestText(req.query?.branch);
      const force = req.query?.force === 'true' || req.query?.force === '1';
      const remote = trustedContext.primaryRemote;
      const session = await sessionFor(impl, instance, trustedContext.accountId);
      const cacheContext = {
        instance, accountId: session.accountId, credentialRevision: session.credentialRevision,
        repositoryId: trustedContext.repositoryId, bindingRevision: trustedContext.bindingRevision,
        directory, branch, remote,
        localTip: descriptor.capabilities.createVia === 'push' ? await readBranchTip(directory, branch) : null,
      };
      if (!force) {
        const fresh = statusCache.fresh(cacheContext);
        if (fresh) return res.json(fresh);
      }
      const started = statusCache.begin();
      try {
        const status = await withTimeout(
          impl.resources.changeRequestStatus({ session, context: trustedContext, directory, branch, remote, force }),
          STATUS_RESOLVE_TIMEOUT_MS,
          `${label} change request status`,
        );
        return res.json(statusCache.store(cacheContext, status, started));
      } catch (error) {
        if (isTransientFailure(impl, error)) {
          const last = statusCache.last(cacheContext);
          if (last) return res.json(last);
          return res.status(503).json({ error: routeError(error)?.message || `${label} is temporarily unavailable` });
        }
        throw error;
      }
    }, {
      validateAfterInstance: (req) => (!requestText(req.query?.directory) || !requestText(req.query?.branch)
        ? 'directory and branch are required' : null),
    });

    const executeMutation = async (impl: RegisteredProvider, mutations: RegisteredMutations, route: string, body: SourceControlJson) => {
      if (!(validateMutationContext instanceof Function)
        || !(mutationExecutor?.read instanceof Function)
        || !(mutationExecutor?.execute instanceof Function)) {
        throw Object.assign(new Error('Canonical source control mutations are unavailable'), {
          code: 'SOURCE_CONTROL_MUTATIONS_UNAVAILABLE', status: 501,
        });
      }
      const context = await validateMutationContext(body);
      assertMutationContextObject(body);
      const actor = { provider: id, instance: context.instance, accountId: context.accountId };
      const session = await sessionFor(impl, context.instance, context.accountId);
      if (session.accountId !== context.accountId
        || !isSafeInteger(session.credentialRevision) || session.credentialRevision < 1
        || !isProviderUserId(id, context.instance, session.providerUserId)) {
        throw Object.assign(new Error(`${label} account is unavailable`), {
          code: 'SOURCE_CONTROL_ACCOUNT_UNAVAILABLE', status: 401,
        });
      }
      const credential = { accountId: session.accountId, credentialRevision: session.credentialRevision };
      const existing = await mutationExecutor.read(context.idempotencyKey);
      const prepared = mutations.prepare({ route, input: body, context, actor, credential });
      const { kind, input } = prepared;
      const record = (target: ResolvedMutation['target']) => ({ key: context.idempotencyKey, inputDigest: prepared.digest(target), kind, actor, target });
      const classifyError = mutations.classifyError ?? classifyMutationError;
      let execution;
      const started: StartedMutation = { settle: null };
      const starting = (target: ResolvedMutation['target']) => {
        try { started.settle = onMutationStarting({ context, kind, input, target }) ?? null; }
        catch { started.settle = null; }
      };
      try {
        if (existing) {
          starting(existing.target);
          requireReplayMatch(existing, kind, actor, context);
          let replayResolution: ResolvedMutation | undefined;
          const resolveReplay = async () => {
            replayResolution ??= await mutations.resolveTarget({ session, context, kind, input, replayOf: existing });
            return replayResolution;
          };
          execution = await mutationExecutor.execute({
            record: record(existing.target),
            providerAccountId: session.providerUserId,
            perform: () => { throw mutationConflict(); },
            reconcile: async () => mutations.reconcile({ session, route, kind, input, resolved: await resolveReplay() }),
            classifyError,
          });
        } else {
          const resolved = await mutations.resolveTarget({ session, context, kind, input });
          starting(resolved.target);
          execution = await mutationExecutor.execute({
            record: record(resolved.target),
            providerAccountId: session.providerUserId,
            perform: () => mutations.perform({ session, route, kind, input, resolved }),
            reconcile: () => mutations.reconcile({ session, route, kind, input, resolved }),
            classifyError,
          });
        }
        statusCache.invalidate({ instance: context.instance, accountId: context.accountId, repositoryId: context.repositoryId });
        try { await onMutationSucceeded({ context, kind, input, record: execution.record, replayed: execution.replayed }); }
        catch (error) {
          console.warn('[source-control] post-mutation follow failed:', routeError(error)?.code ?? 'FOLLOW_FAILED');
        }
      } finally {
        started.settle?.();
      }
      if (mutations.afterSuccess instanceof Function) {
        try { await mutations.afterSuccess({ session, target: execution.record.target }); }
        catch { void 0; }
      }
      return changeRequestReceipt(execution.record, execution.replayed, session.providerUserId);
    };
    const sendMutationError = async (res: Response, impl: RegisteredProvider | undefined, cause: unknown) => {
      if (impl?.mutations?.presentError instanceof Function) {
        const lockFailure = await invalidateRefusedAccount(res, impl, cause);
        if (lockFailure) return lockFailure;
        const { status, body } = impl.mutations.presentError(cause);
        return res.status(status).json(body);
      }
      const failure = routeError(cause);
      if (hasCodePrefix(failure, 'SOURCE_CONTROL_') || hasCodePrefix(failure, 'INVALID_SOURCE_CONTROL_')) {
        return res.status(failure?.status ?? 409).json(sourceControlErrorBody(cause));
      }
      if (!impl) return res.status(500).json({ error: failure?.message || `${label} resource request failed` });
      return sendResourceError(res, impl, cause);
    };
    for (const [suffix, capability] of MUTATION_ROUTES) {
      route('post', suffix, capability, async (req, res) => {
        let impl;
        try {
          impl = await loadImplementation(id);
          if (!impl.mutations?.routes?.includes(suffix)) return unsupportedCapability(res);
          return res.json(await executeMutation(impl, impl.mutations, suffix, req.body ?? {}));
        } catch (error) {
          return sendMutationError(res, impl, error);
        }
      });
    }

    for (const [suffix, capability, method] of [
      ['/references/labels', 'labels', 'listLabels'],
      ['/references/reviewers', 'reviewers', 'listReviewerCandidates'],
    ] as const) {
      boundRead(capability, suffix, async ({ req, res, impl, instance, directory, trustedContext }) => {
        const read = requireResource(impl, method);
        const session = await sessionFor(impl, instance, trustedContext.accountId);
        const project = optionalProject(req);
        if (!project) return res.status(400).json({ error: 'a complete project selector is required' });
        return res.json({ connected: true, items: await read({ session, directory, project, context: trustedContext, remote: trustedContext.primaryRemote }) });
      }, {
        validate: (req) => (!namesProject(req) ? 'a complete project selector is required' : null),
      });
    }

    const discussions = descriptor.capabilities.discussions === true;
    boundRead('referencePicker', '/references', async ({ req, res, impl, instance, directory, trustedContext }) => {
      const kind = requestText(req.query?.kind);
      if (!isReferenceKind(kind)) return res.status(400).json({ error: 'directory and kind (issue, pull or discussion) are required' });
      if (kind === 'discussion' && !discussions) return unsupportedCapability(res);
      const read = requireResource(impl, 'references');
      const session = await sessionFor(impl, instance, trustedContext.accountId);
      return res.json(await read({
        session, directory, context: trustedContext, remote: trustedContext.primaryRemote,
        kind,
        ...readListFilter(req.query),
        query: requestText(req.query?.query),
        cursor: requestText(req.query?.cursor) || null,
      }));
    }, {
      validate: (req) => (!requestText(req.query?.directory) || !isReferenceKind(requestText(req.query?.kind))
        ? 'directory and kind (issue, pull or discussion) are required' : null),
    });

    route('post', '/references/across', 'referencePicker', async (req, res) => {
      let impl;
      try {
        impl = await loadImplementation(id);
        const read = requireResource(impl, 'referencesAcross');
        if (!(validateReadContext instanceof Function)) return res.status(501).json({ error: 'Bound source control read is unavailable' });
        return res.json(await read({
          body: req.body ?? {},
          validateReadContext: (context) => validateReadContext({ ...context, provider: id }),
        }));
      } catch (error) {
        return sendProviderResponse(res, error) ?? res.status(routeError(error)?.status ?? 500).json({ error: routeError(error)?.message || `${label} references request failed` });
      }
    });

    boundRead('referencePicker', '/references/detail', async ({ req, res, impl, instance, directory, trustedContext }) => {
      const kind = requestText(req.query?.kind) === 'discussion' ? 'discussion' : 'item';
      if (kind === 'discussion' && !discussions) return unsupportedCapability(res);
      const read = requireResource(impl, 'referenceDetail');
      const session = await sessionFor(impl, instance, trustedContext.accountId);
      const project = optionalProject(req);
      const number = requestIssueNumber(req.query?.number);
      if (!project || !number) return res.status(400).json({ error: 'directory, owner, repo and number are required' });
      return res.json(await read({
        session, directory, context: trustedContext, remote: trustedContext.primaryRemote,
        project,
        number,
        host: requestText(req.query?.host),
        kind,
      }));
    }, {
      validate: (req) => (!requestText(req.query?.directory) || !namesProject(req)
        || !requestIssueNumber(req.query?.number) ? 'directory, owner, repo and number are required' : null),
    });

    boundRead('reviewDrafts', '/pr/review/state', async ({ req, res, impl, directory, instance, trustedContext }) => {
      const read = requireResource(impl, 'reviewState');
      const session = await sessionFor(impl, instance, trustedContext.accountId);
      const project = optionalProject(req);
      const number = requestIssueNumber(req.query?.number);
      if (!project || !number) return res.status(400).json({ error: 'directory, owner, repo and number are required' });
      return res.json(await read({
        session, directory, context: trustedContext, remote: trustedContext.primaryRemote,
        project,
        number,
      }));
    }, {
      validate: (req) => (!requestText(req.query?.directory) || !namesProject(req)
        || !requestIssueNumber(req.query?.number) ? 'directory, owner, repo and number are required' : null),
    });

    boundRead('referencePicker', '/references/status', async ({ req, res, impl, directory, trustedContext }) => {
      const read = requireResource(impl, 'referenceStatuses');
      return res.json(await read({
        directory, context: trustedContext, remote: trustedContext.primaryRemote, pulls: requestText(req.query?.pulls),
      }));
    }, {
      validate: (req) => (!requestText(req.query?.directory) || !requestText(req.query?.pulls)
        ? 'directory and pulls (owner/repo#number, comma separated) are required' : null),
    });

    route('get', '/uploads/:secret/:filename', 'uploads', async (req, res) => {
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      let impl;
      try {
        impl = await loadImplementation(id);
        const project = optionalProject(req);
        const upload = readUploadParams(req.params);
        if (!project || !upload) return res.status(400).json({ error: 'a project selector and an upload path are required' });
        const instance = requestInstance(req);
        const directory = requestText(req.query?.directory);
        const trustedContext = await readContextOf(req, instance, directory);
        if (!trustedContext) return res.status(501).json({ error: 'Bound source control status is unavailable' });
        const readUpload = requireResource(impl, 'readUpload');
        const session = await sessionFor(impl, instance, trustedContext.accountId);
        const upstream = await readUpload({
          session, directory, project, context: trustedContext, remote: trustedContext.primaryRemote,
          ...upload,
          range: requestText(req.get('range')) || undefined,
          signal: abort.signal,
        });
        const type = uploadMediaType(upstream.headers.get('content-type') || '', upload.filename);
        if (!upstream.ok || !upstream.body || !type) {
          await upstream.body?.cancel().catch(() => {});
          return res.status(upstream.ok ? 415 : upstream.status === 416 ? 416 : 404).end();
        }
        res.status(upstream.status);
        res.setHeader('Content-Type', type);
        for (const header of UPLOAD_PASSED_HEADERS) {
          const value = upstream.headers.get(header);
          if (value) res.setHeader(header, value);
        }
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        await pipeline(Readable.fromWeb(upstream.body), res);
      } catch (error) {
        if (abort.signal.aborted) return undefined;
        if (res.headersSent) return res.destroy();
        if (isReadContextError(routeError(error))) return res.status(routeError(error)?.status ?? 400).json(sourceControlErrorBody(error));
        if (!impl) return res.status(routeError(error)?.status ?? 500).json(sourceControlErrorBody(error));
        return sendResourceError(res, impl, error);
      }
      return undefined;
    });

    boundRead('changeRequests', '/pulls/list', async ({ req, res, impl, instance, directory, trustedContext }) => {
      const session = await sessionFor(impl, instance, trustedContext.accountId);
      return res.json(await impl.resources.listChangeRequests({
        session,
        directory,
        page: requestNumber(req.query?.page) ?? 1,
        query: requestText(req.query?.query) || undefined,
        ...readListFilter(req.query),
        context: trustedContext, remote: trustedContext.primaryRemote,
      }));
    });

    boundRead('changeRequests', '/pulls/context', async ({ req, res, impl, instance, directory, trustedContext }) => {
      const number = requestNumber(req.query?.number);
      if (!number) return res.status(400).json({ error: 'number is required' });
      const revision = readRevision(descriptor, req.query?.revision);
      const session = await sessionFor(impl, instance, trustedContext.accountId);
      return res.json(await impl.resources.changeRequestContext(withRevision({
        session,
        directory,
        number,
        includeDiff: req.query?.diff === '1',
        includeCIDetails: req.query?.checkDetails === '1',
        includeTimeline: req.query?.timeline === '1',
        project: optionalProject(req),
        context: trustedContext, remote: trustedContext.primaryRemote,
      }, revision)));
    }, {
      validate: (req) => {
        if (projectSelectorProblem(req)) return 'complete project selector is required';
        const problem = revisionProblem(descriptor, req.query?.revision);
        return problem ? { error: problem, code: 'INVALID_SOURCE_CONTROL_READ_CONTEXT' } : null;
      },
    });

    boundRead('issues', '/issues/list', async ({ req, res, impl, instance, directory, trustedContext }) => {
      const session = await sessionFor(impl, instance, trustedContext.accountId);
      return res.json(await requireResource(impl, 'listIssues').call(impl.resources, {
        session,
        directory,
        page: requestNumber(req.query?.page) ?? 1,
        query: requestText(req.query?.query) || undefined,
        ...readListFilter(req.query),
        context: trustedContext, remote: trustedContext.primaryRemote,
      }));
    });

    for (const [suffix, method] of [['/issues/get', 'getIssue'], ['/issues/comments', 'issueComments']] as const) {
      boundRead('issues', suffix, async ({ req, res, impl, instance, directory, trustedContext }) => {
        const session = await sessionFor(impl, instance, trustedContext.accountId);
        const number = requestIssueNumber(req.query?.number);
        if (!number) return res.status(400).json({ error: 'valid number and complete project selector are required' });
        return res.json(await requireResource(impl, method).call(impl.resources, {
          session,
          directory,
          number,
          project: optionalProject(req),
          context: trustedContext, remote: trustedContext.primaryRemote,
        }));
      }, {
        validate: (req) => (!requestIssueNumber(req.query?.number)
          || projectSelectorProblem(req)
          ? 'valid number and complete project selector are required' : null),
      });
    }

    boundRead('projects', '/repo/upstream', async ({ res, impl, instance, directory, trustedContext }) => {
      const session = await sessionFor(impl, instance, trustedContext.accountId);
      return res.json(await impl.resources.projectUpstream({ session, directory, context: trustedContext, remote: trustedContext.primaryRemote }));
    });

    boundRead('projects', '/repo/branches', async ({ req, res, impl, instance, directory, trustedContext }) => {
      const session = await sessionFor(impl, instance, trustedContext.accountId);
      const project = optionalProject(req);
      if (!project) return res.status(400).json({ error: 'owner and repo are required' });
      return res.json({
        branches: await impl.resources.projectBranches({
          session,
          directory,
          project,
          context: trustedContext, remote: trustedContext.primaryRemote,
        }),
      });
    }, {
      validate: (req) => (!namesProject(req) ? 'owner and repo are required' : null),
    });

    target.get(authPaths('/me'), (_req, res) => res.status(410).json({
      error: `${label} account user route is retired`,
      code: 'SOURCE_CONTROL_ACCOUNT_CONTEXT_REQUIRED',
    }));
  }

  type BoundAccountInput = { session: Awaited<ReturnType<RegisteredProvider['auth']['resolveAccount']>>; directory: string; remote: string };
  const readWithBoundAccount = async <Input, Output>(
    context: ProviderReadContext | undefined,
    method: (resources: Resources) => ((input: BoundAccountInput & Input) => Promise<Output>) | undefined,
    input: Input,
  ) => {
    if (!context) throw unavailableProvider();
    const impl = await loadImplementation(context.provider);
    const read = method(impl.resources);
    if (!(read instanceof Function)) {
      throw Object.assign(new Error('This source control provider does not support this operation'), {
        code: 'SOURCE_CONTROL_CAPABILITY_UNSUPPORTED', status: 501,
      });
    }
    const session = await impl.auth.resolveAccount({ instance: context.instance, accountId: context.accountId });
    try {
      return await read({ session, directory: context.directory, remote: context.primaryRemote, ...input });
    } catch (cause) {
      const error = routeError(cause);
      const upstreamStatus = upstreamStatusOf(error);
      const identity = upstreamStatus === 401 && !error?.sourceControlAccountUnavailable ? failedIdentity(error) : undefined;
      if (identity?.accountId) {
        (isString(identity.provider) ? statusCaches.get(identity.provider) : undefined)?.invalidate({ instance: identity.instance, accountId: identity.accountId });
        await impl.auth.invalidateAccount({
          instance: identity.instance, accountId: identity.accountId, persisted: Boolean(error?.sourceControlPersistedAccount),
        });
      }
      if (error && isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus < 600) error.statusCode = upstreamStatus;
      throw cause;
    }
  };
  const linkedRead = (context: ProviderReadContext | undefined): { linked?: true } => (context?.linked ? { linked: true } : {});
  const invalidProvider = () => Object.assign(new Error('Change request source provider is invalid'), {
    code: 'INVALID_SOURCE_CONTROL_READ_CONTEXT', status: 400,
  });
  const requireProvider = (id: string | undefined) => {
    const descriptor = id === undefined ? null : providers.describe(id);
    if (!descriptor) throw invalidProvider();
    return descriptor;
  };
  const trustedRead = async <Input, Output>(
    input: { context?: ReadContextRequest | undefined },
    method: (resources: Resources) => ((input: BoundAccountInput & Input & { context: ProviderReadContext }) => Promise<Output>) | undefined,
    extra: (trusted: ProviderReadContext) => Input,
  ) => {
    requireProvider(isString(input?.context?.provider) ? input.context.provider : undefined);
    if (!(validateReadContext instanceof Function)) throw new TypeError('validateReadContext is not a function');
    const trusted = await validateReadContext(input.context ?? {});
    return readWithBoundAccount(trusted, method, { ...extra(trusted), context: trusted });
  };

  return Object.freeze({
    mountExtension,
    unmountExtension,
    extensionDispatcher,
    invalidateBranchStatus: ({ directory, branch }: { directory: string; branch: string }) => {
      for (const cache of statusCaches.values()) cache.invalidate({ directory, branch });
    },
    readLiveSummaries: async ({ provider, instance, accountId = null, refs, issueRefs, discussionRefs = [], details = false }: LiveSummariesInput): Promise<LiveSummariesResult> => {
      requireProvider(provider);
      const impl = await loadImplementation(provider);
      const descriptor = providers.describe(provider);
      if (!descriptor) throw new TypeError("Cannot read properties of null (reading 'capabilities')");
      const askedDiscussions = descriptor.capabilities.discussions === true ? discussionRefs : [];
      if (!(impl.resources?.liveSummaries instanceof Function)) return { connected: false };
      let session;
      try {
        session = await impl.auth.resolveAccount({
          instance: descriptor.instance.normalize(instance), accountId: accountId ?? '', orCurrent: true,
        });
      } catch (error) {
        if (routeError(error)?.sourceControlAccountUnavailable) return { connected: false };
        throw error;
      }
      try {
        return { connected: true, ...(await impl.resources.liveSummaries({ session, refs, issueRefs, discussionRefs: askedDiscussions, details })) };
      } catch (cause) {
        const error = routeError(cause);
        const identity = error?.sourceControlServiceLogin && error.code === 'ACCOUNT_CHANGED' ? failedIdentity(error) : undefined;
        if (identity?.accountId) {
          (isString(identity.provider) ? statusCaches.get(identity.provider) : undefined)?.invalidate({ instance: identity.instance, accountId: identity.accountId });
          await impl.auth.invalidateAccount({ instance: identity.instance, accountId: identity.accountId, persisted: false });
        }
        throw cause;
      }
    },
    readChangeRequestPatch: async ({ context, number, sourceRepo, revision }: ChangeRequestReadInput) => readWithBoundAccount(
      context, (resources) => resources.readChangeRequestPatch, withRevision({ number, sourceRepo, ...linkedRead(context) }, readRevision(context ? providers.describe(context.provider) : null, revision)),
    ),
    readChangeRequestFile: async ({ context, number, sourceRepo, path, previousPath, status, revision, binary }: ChangeRequestFileInput) => readWithBoundAccount(
      context, (resources) => resources.readChangeRequestFile,
      withRevision({ number, sourceRepo, path, previousPath, status, binary: binary || undefined, ...linkedRead(context) }, readRevision(context ? providers.describe(context.provider) : null, revision)),
    ),
    readChangeRequestHead: (input: { context?: ReadContextRequest | undefined; number: number }) => trustedRead(input, (resources) => resources.readChangeRequestHead, () => ({ number: input.number })),
    resolveChangeRequestSource: (input: SourceRequest) => trustedRead(input, (resources) => resources.resolveChangeRequestSource, () => ({
      project: input.project,
      number: input.number,
      expectedHeadSha: input.expectedHeadSha,
      requestedRemoteName: input.requestedRemoteName,
    })),
  });
}
