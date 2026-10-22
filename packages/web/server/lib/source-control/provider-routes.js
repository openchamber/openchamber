import { Readable } from 'node:stream';
import express from 'express';
import { pipeline } from 'node:stream/promises';

import { isString } from '../shared/guards.js';
import { createOAuthFlowRegistry } from './oauth-flow-registry.js';
import { mutationReceipt } from './mutation-executor.js';
import { createChangeRequestStatusCache } from './status-cache.js';

/**
 * The generic source-control route shell. For every registered provider it
 * owns the HTTP surface under `/api/source-control/<id>/`: request parsing,
 * instance normalization, read-context validation through the binding
 * service, account resolution, the change-request status cache, the durable
 * mutation executor, upload streaming and error mapping. The provider's
 * implementation (`<provider>/provider.js`) answers in plain JSON.
 *
 * Routes are literal per id, not `/:provider/`, so the shell's own
 * `/api/source-control/binding/*` routes never collide and an unknown id falls
 * through to the module's 404 catch-all instead of the OpenCode proxy. A
 * capability the descriptor turns off still gets a route: a stable 501, never
 * a fall-through.
 */

const STATUS_CACHE_TTL_MS = 90_000;
const STATUS_RESOLVE_TIMEOUT_MS = 12_000;

const withTimeout = async (promise, timeoutMs, label) => {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
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

/** The HTTP status a provider answered with, wherever its SDK put it. */
const upstreamStatusOf = (error) => error?.cause?.response?.status ?? error?.response?.status ?? error?.status;

function errorStatus(kind) {
  return kind === 'temporarily-unavailable' ? 503 : kind === 'unreachable' ? 502 : 500;
}

/** An answer the implementation chose itself, or a storage failure that is never an empty answer; else null. */
function sendAuthStorageError(res, error) {
  const answered = sendProviderResponse(res, error);
  if (answered) return answered;
  if (error?.code?.startsWith('SOURCE_CONTROL_LOCK_')) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  if (error?.code === 'INVALID_SOURCE_CONTROL_AUTH') {
    return res.status(500).json({ error: error.message, code: error.code });
  }
  return null;
}

/** An answer the implementation chose itself (`sourceControlResponse`). */
function sendProviderResponse(res, error) {
  const response = error?.sourceControlResponse;
  return response ? res.status(response.status).json(response.body) : null;
}

function requestText(value) {
  return isString(value) ? value.trim() : '';
}

function requestNumber(value) {
  const number = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function requestIssueNumber(value) {
  const text = requestText(value);
  if (!/^[1-9]\d*$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

/** A list's state and whose items, from the query; unknown values read as open and anyone. */
function readListFilter(query) {
  const state = requestText(query?.state);
  const people = requestText(query?.people);
  return {
    state: ['open', 'closed', 'merged', 'all'].includes(state) ? state : 'open',
    people: ['any', 'assigned', 'created', 'reviewRequested'].includes(people) ? people : 'any',
  };
}

// A provider writes a file attached in Markdown as `/uploads/<32-hex secret>/<name>`.
const UPLOAD_SECRET_RE = /^[0-9a-f]{32}$/;
// Only what an `img` or a `video` draws is served; an uploaded page or SVG
// opened from this server's origin could run script in it.
const UPLOAD_MEDIA_TYPE_RE = /^(?:image\/(?:png|jpeg|gif|webp|avif)|video\/(?:mp4|webm|quicktime))$/;
// GitLab's uploads API sends every file as `application/octet-stream`; then
// the name says which of the types above it is, and anything else is refused.
const UPLOAD_EXTENSION_TYPES = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp'], ['avif', 'image/avif'],
  ['mp4', 'video/mp4'], ['m4v', 'video/mp4'], ['webm', 'video/webm'], ['mov', 'video/quicktime'],
]);

/** The media type to serve an upload as; null when it is not a picture or a clip. */
function uploadMediaType(upstreamType, filename) {
  const type = upstreamType.split(';')[0].trim().toLowerCase();
  if (UPLOAD_MEDIA_TYPE_RE.test(type)) return type;
  if (type && type !== 'application/octet-stream') return null;
  return UPLOAD_EXTENSION_TYPES.get(filename.split('.').at(-1).toLowerCase()) ?? null;
}
const UPLOAD_PASSED_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

/** Express has decoded the name already; a `/`, `.` or `..` would leave the upload's folder. */
function readUploadParams(params) {
  const secret = requestText(params?.secret);
  const filename = isString(params?.filename) ? params.filename : '';
  const plainName = filename && filename !== '.' && filename !== '..' && !/[/\\]/.test(filename);
  return UPLOAD_SECRET_RE.test(secret) && plainName ? { secret, filename } : null;
}

const isReadContextError = (error) => error?.code?.startsWith('SOURCE_CONTROL_BINDING_')
  || error?.code?.startsWith('SOURCE_CONTROL_LOCK_')
  || error?.code === 'SOURCE_CONTROL_PROVIDER_UNAVAILABLE'
  || error?.code === 'INVALID_SOURCE_CONTROL_READ_CONTEXT'
  || error?.code === 'INVALID_SOURCE_CONTROL_BINDING';

const sourceControlErrorBody = (error) => {
  const body = { error: error.message, code: error.code };
  if (Object.hasOwn(error, 'current')) body.current = error.current;
  return body;
};

const mutationConflict = () => Object.assign(
  new Error('Source control mutation idempotency key was already used with different input'),
  { code: 'SOURCE_CONTROL_MUTATION_CONFLICT', status: 409 },
);

const requireReplayMatch = (record, kind, actor, context) => {
  if (record.kind !== kind
    || record.actor?.provider !== actor.provider
    || record.actor?.instance !== actor.instance
    || record.actor?.accountId !== actor.accountId
    || record.target?.repositoryId !== context.repositoryId
    || record.target?.bindingRevision !== context.bindingRevision
    || record.target?.primaryRemote !== context.primaryRemote) throw mutationConflict();
  const expected = context.target;
  for (const key of ['id', 'owner', 'name']) {
    if (Object.hasOwn(expected.project, key) && record.target?.project?.[key] !== expected.project[key]) throw mutationConflict();
  }
  for (const key of ['number', 'head', 'base', 'headSha']) {
    if (Object.hasOwn(expected, key) && record.target?.[key] !== expected[key]) throw mutationConflict();
  }
};

/** A 4xx the provider answered after dispatch is a definite failure; anything else may have happened. */
const classifyMutationError = (error) => {
  const status = upstreamStatusOf(error);
  const localSourceControlError = error?.code?.startsWith('SOURCE_CONTROL_')
    || error?.code?.startsWith('INVALID_SOURCE_CONTROL_');
  if (!localSourceControlError && Number.isInteger(status) && status >= 400 && status < 500) {
    if (!Number.isInteger(error.status)) error.status = status;
    return 'failed';
  }
  return 'outcome-unknown';
};

/**
 * A create's claim target has no number yet; when the provider recorded the
 * number it made, the receipt names it in the target, where clients link it.
 */
const changeRequestReceipt = (record, replayed, providerAccountId) => {
  const receipt = mutationReceipt(record, replayed, providerAccountId);
  if (receipt.target.number !== undefined || !Number.isSafeInteger(receipt.result?.number)) return receipt;
  const { number, ...result } = receipt.result;
  return { ...receipt, target: { ...receipt.target, number }, result };
};

const unsupportedCapability = (res) => res.status(501).json({
  error: 'This source control provider does not support this operation',
  code: 'SOURCE_CONTROL_CAPABILITY_UNSUPPORTED',
});

const enabled = (capabilities, capability) => capability.split('.').reduce((value, key) => value?.[key], capabilities);

/**
 * The mutation routes and the capability each one needs. A provider whose
 * descriptor turns the capability off answers 501 there.
 */
const MUTATION_ROUTES = [
  ['/pr/create', 'changeRequests'],
  ['/pr/update', 'changeRequests'],
  ['/pr/merge', 'merge'],
  ['/pr/ready', 'draftChangeRequests'],
  ['/pr/comment', 'comments'],
  ['/pr/thread/start', 'reviewThreads.start'],
  ['/pr/thread/reply', 'reviewThreads.reply'],
  ['/pr/thread/resolve', 'reviewThreads.resolve'],
  ['/issues/comment', 'comments'],
  ['/pr/state', 'state'],
  ['/issues/state', 'state'],
  ['/pr/labels', 'labels'],
  ['/issues/labels', 'labels'],
  ['/pr/reviewers', 'reviewers'],
  ['/pr/review', 'reviews'],
];

/**
 * Registers every shell-served provider's routes and returns the reads other
 * modules make with a context they have already validated, dispatched by the
 * context's provider.
 */
export function registerProviderRoutes(app, {
  providers,
  validateReadContext,
  validateMutationContext,
  mutationExecutor,
  oauthFlowRegistry = createOAuthFlowRegistry(),
}) {
  const statusCaches = new Map();
  const statusCacheFor = (id) => {
    if (!statusCaches.has(id)) statusCaches.set(id, createChangeRequestStatusCache({ ttlMs: STATUS_CACHE_TTL_MS }));
    return statusCaches.get(id);
  };
  // An account the provider wrote off has no last-known answers left.
  providers.events.subscribe({
    invalidated: ({ provider, instance, accountId }) => {
      statusCaches.get(provider)?.invalidate({ instance, accountId });
    },
  });

  const unavailableProvider = () => Object.assign(new Error('Source control provider is unavailable'), {
    code: 'SOURCE_CONTROL_PROVIDER_UNAVAILABLE', status: 404,
  });
  const loadImplementation = async (id) => {
    const impl = await providers.implementation(id);
    if (!impl) throw unavailableProvider();
    return impl;
  };

  for (const descriptor of providers.list()) registerProvider(descriptor);

  /*
   * Extension providers appear and go while the server runs, so their routes
   * cannot be registered once like the built-ins'. Each gets its own router
   * with the same literal paths, kept here by id; one dispatcher, mounted by
   * the caller after the built-ins and before the module's catch-all, hands a
   * request under `/api/source-control/ext-<id>/` to that router. Without a
   * router the request falls through to the catch-all's 404.
   */
  const extensionRouters = new Map();
  const EXTENSION_PATH = /^\/api\/source-control\/(ext-[a-z0-9-]+)(?:\/|$)/;
  const mountExtension = (descriptor) => {
    const router = express.Router();
    // A remount (a newer version) starts without the old descriptor's answers.
    statusCaches.delete(descriptor.id);
    registerProvider(descriptor, router);
    extensionRouters.set(descriptor.id, router);
  };
  const unmountExtension = (id) => {
    extensionRouters.delete(id);
    statusCaches.delete(id);
  };
  const extensionDispatcher = (req, res, next) => {
    const match = EXTENSION_PATH.exec(req.path);
    const router = match ? extensionRouters.get(match[1]) : null;
    if (!router) return next();
    return router(req, res, next);
  };

  function registerProvider(descriptor, target = app) {
    const { id, label } = descriptor;
    const base = `/api/source-control/${id}`;
    const statusCache = statusCacheFor(id);
    // A request without an instance names the provider's legacy instance
    // (github.com for GitHub's own account flow), else none.
    const requestInstance = (req) => descriptor.instance.normalize(
      (isString(req.query?.instance) ? req.query.instance.trim() : '') || (descriptor.instances?.legacyFlow?.instance ?? ''),
    );

    // Declarative aliases a provider keeps for older clients
    // (`descriptor.routeAliases`): its account routes under another prefix,
    // extra names for a route, and retired paths that answer 410.
    const aliases = descriptor.routeAliases ?? null;
    const extraNames = (suffix) => Object.entries(aliases?.extraAuthAliases ?? {})
      .filter(([, canonical]) => canonical === suffix).map(([alias]) => alias);
    /** An account route's paths: the canonical one, its alias prefix, and its extra names under both. */
    const authPaths = (suffix) => {
      const paths = [suffix, ...extraNames(suffix)]
        .flatMap((name) => [...(aliases?.authAliasPrefix ? [`${aliases.authAliasPrefix}${name}`] : []), `${base}${name}`]);
      return paths.length === 1 ? paths[0] : paths;
    };
    if (aliases?.authAliasPrefix) {
      const retired = (_req, res) => res.status(410).json({
        error: `Legacy ${label} repository API is retired`,
        code: 'SOURCE_CONTROL_CONTEXT_REQUIRED',
      });
      for (const suffix of aliases.retiredGet) target.get(`${aliases.authAliasPrefix}${suffix}`, retired);
      for (const suffix of aliases.retiredPost) target.post(`${aliases.authAliasPrefix}${suffix}`, retired);
    }

    /** A capability-gated route; off in the descriptor, it answers 501 and never reaches the proxy. */
    const route = (method, suffix, capability, handler, path = `${base}${suffix}`) => {
      if (capability && !enabled(descriptor.capabilities, capability)) {
        target[method](path, (_req, res) => unsupportedCapability(res));
        return;
      }
      target[method](path, handler);
    };

    const invalidateAccount = async (impl, identity, persisted) => {
      statusCache.invalidate({ instance: identity.instance, accountId: identity.accountId });
      return impl.auth.invalidateAccount({ instance: identity.instance, accountId: identity.accountId, persisted });
    };

    /** A 401 from the provider writes off only the acting account. Answers a lock failure itself; else null. */
    const invalidateRefusedAccount = async (res, impl, error) => {
      if (upstreamStatusOf(error) !== 401 || error?.sourceControlAccountUnavailable || !error?.sourceControlIdentity?.accountId) return null;
      try {
        await invalidateAccount(impl, error.sourceControlIdentity, Boolean(error.sourceControlPersistedAccount));
        return null;
      } catch (failure) {
        if (failure?.code?.startsWith('SOURCE_CONTROL_LOCK_')) {
          return res.status(failure.status).json({ error: failure.message, code: failure.code });
        }
        throw failure;
      }
    };

    const sendResourceError = async (res, impl, error) => {
      const upstreamStatus = upstreamStatusOf(error);
      const lockFailure = await invalidateRefusedAccount(res, impl, error);
      if (lockFailure) return lockFailure;
      const status = Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus < 600
        ? upstreamStatus
        : errorStatus(impl.classifyFailure(error));
      return res.status(status).json({ error: error?.message || `${label} resource request failed` });
    };

    const isTransientFailure = (impl, error) => {
      const upstreamStatus = upstreamStatusOf(error);
      if (upstreamStatus === 429 || (Number.isInteger(upstreamStatus) && upstreamStatus >= 500)) return true;
      if (Number.isInteger(upstreamStatus)) return false;
      const kind = impl.classifyFailure(error);
      return kind === 'unreachable' || kind === 'temporarily-unavailable';
    };

    const readContextOf = (req, instance, directory) => validateReadContext?.({
      directory,
      repositoryId: req.query?.repositoryId,
      provider: id,
      instance,
      accountId: req.query?.accountId,
      bindingRevision: Number(req.query?.bindingRevision),
      primaryRemote: req.query?.primaryRemote,
    });

    /**
     * A bound read: validates the context before any credential lookup, then
     * resolves the exact bound account and hands both to `read`.
     */
    const boundRead = (capability, suffix, read, { validate, validateAfterInstance } = {}) => {
      route('get', suffix, capability, async (req, res) => {
        let impl;
        try {
          impl = await loadImplementation(id);
          const early = validate?.(req);
          if (early) return res.status(400).json({ error: early });
          const instance = requestInstance(req);
          const late = validateAfterInstance?.(req);
          if (late) return res.status(400).json({ error: late });
          const directory = requestText(req.query?.directory);
          const trustedContext = await readContextOf(req, instance, directory);
          if (!trustedContext) return res.status(501).json({ error: 'Bound source control status is unavailable' });
          return await read({ req, res, impl, instance, directory, trustedContext });
        } catch (error) {
          if (isReadContextError(error)) return res.status(error.status ?? 400).json(sourceControlErrorBody(error));
          if (!impl) return res.status(error.status ?? 500).json(sourceControlErrorBody(error));
          return sendProviderResponse(res, error) ?? sendResourceError(res, impl, error);
        }
      });
    };
    const sessionFor = (impl, instance, accountId) => impl.auth.resolveAccount({ instance, accountId });
    const requireResource = (impl, method) => {
      if (!(impl.resources?.[method] instanceof Function)) {
        throw Object.assign(new Error('This source control provider does not support this operation'), {
          code: 'SOURCE_CONTROL_CAPABILITY_UNSUPPORTED', status: 501,
        });
      }
      return impl.resources[method];
    };

    // Capabilities: the static ones from the descriptor, the authentication
    // methods probed on the instance.
    target.get(`${base}/capabilities`, async (req, res) => {
      let impl;
      try {
        impl = await loadImplementation(id);
        const instance = requestInstance(req);
        const dynamic = await impl.auth.capabilities({ instance });
        const { capabilities } = descriptor;
        return res.json({
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
        });
      } catch (error) {
        const kind = impl ? impl.classifyFailure(error) : 'provider-error';
        return res.status(errorStatus(kind)).json({ error: error?.message || `Failed to probe ${label}`, status: kind });
      }
    });

    target.get(authPaths('/auth/status'), async (req, res) => {
      try {
        const impl = await loadImplementation(id);
        return res.json(await impl.auth.status({ instance: requestInstance(req) }));
      } catch (error) {
        const lockResponse = sendAuthStorageError(res, error);
        if (lockResponse) return lockResponse;
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
        return res.status(400).json({ error: error?.message || `Failed to list ${label} accounts` });
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
        return res.status(errorStatus(kind)).json({ error: error?.message || `Failed to start ${label} device flow`, status: kind });
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
        flowId = isString(req.body?.flowId) ? req.body.flowId.trim() : '';
        if (!flowId) return res.status(400).json({ error: 'flowId is required' });
        let flow;
        try {
          flow = oauthFlowRegistry.acquire({ flowId, provider: id, instance });
          acquired = true;
        } catch (error) {
          if (error?.code === 'SOURCE_CONTROL_OAUTH_FLOW_BUSY') return res.status(409).json({ error: 'OAuth flow is busy', code: error.code });
          if (error?.code === 'SOURCE_CONTROL_OAUTH_FLOW_UNAVAILABLE') return res.status(410).json({ error: 'OAuth flow is unavailable', code: error.code });
          throw error;
        }
        const outcome = await impl.auth.completeDeviceFlow({ instance, deviceCode: flow.deviceCode, clientId: flow.clientId }, {
          // A terminal answer spends the flow before the account is stored.
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
        return res.status(errorStatus(kind)).json({ error: error?.message || `Failed to complete ${label} device flow`, status: kind });
      }
    }, authPaths('/auth/complete'));

    target.post(authPaths('/auth/token'), async (req, res) => {
      let impl;
      try {
        impl = await loadImplementation(id);
        if (!descriptor.authMethods.pat) return unsupportedCapability(res);
        // A token goes to the instance next, so one that is not a valid
        // instance stops here, before any request.
        let instance;
        try {
          instance = requestInstance(req);
        } catch (error) {
          return res.status(400).json({ error: error.message });
        }
        const token = isString(req.body?.token) ? req.body.token.trim() : '';
        if (!token) return res.status(400).json({ error: 'token is required' });
        return res.json(await impl.auth.connectToken({ instance, token }));
      } catch (error) {
        const lockResponse = sendAuthStorageError(res, error);
        if (lockResponse) return lockResponse;
        // The reason a token was refused is the person's to act on, so it is
        // named by a code the interface can translate rather than folded into a
        // generic failure.
        if (error?.kind === 'invalid-token') {
          return res.status(401).json({ error: error?.message || `${label} token is invalid`, code: 'INVALID_TOKEN' });
        }
        const kind = impl ? impl.classifyFailure(error) : 'provider-error';
        return res.status(errorStatus(kind)).json({ error: error?.message || `Failed to verify ${label} token` });
      }
    });

    target.post(authPaths('/auth/activate'), async (req, res) => {
      try {
        const impl = await loadImplementation(id);
        const instance = requestInstance(req);
        const accountId = isString(req.body?.accountId) ? req.body.accountId : '';
        return res.json(await impl.auth.activate({ instance, accountId }));
      } catch (error) {
        const lockResponse = sendAuthStorageError(res, error);
        if (lockResponse) return lockResponse;
        return res.status(400).json({ error: error?.message || `Failed to activate ${label} account` });
      }
    });

    target.post(authPaths('/auth/cli'), async (req, res) => {
      try {
        const impl = await loadImplementation(id);
        if (!descriptor.authMethods.cli || !(impl.auth.setCliDisabled instanceof Function)) return unsupportedCapability(res);
        const instance = requestInstance(req);
        return res.json(await impl.auth.setCliDisabled({ instance, disabled: Boolean(req.body?.disabled) }));
      } catch (error) {
        const lockResponse = sendAuthStorageError(res, error);
        if (lockResponse) return lockResponse;
        const tool = descriptor.authMethods.cli ? descriptor.authMethods.cli.tool : label;
        return res.status(400).json({ error: error?.message || `Failed to inspect ${tool} authentication` });
      }
    });

    // Removal names the exact account; it never falls back to the current one.
    target.delete(authPaths('/auth'), async (req, res) => {
      try {
        const impl = await loadImplementation(id);
        const instance = requestInstance(req);
        const requested = req.query?.accountId ?? req.body?.accountId;
        const accountId = requestText(requested);
        if (!accountId || requested !== accountId) return res.status(400).json({ error: 'accountId is required' });
        return res.json(await impl.auth.remove({ instance, accountId }));
      } catch (error) {
        const lockResponse = sendAuthStorageError(res, error);
        if (lockResponse) return lockResponse;
        return res.status(400).json({ error: error?.message || `Failed to disconnect ${label}` });
      }
    });

    // A badge keeps its last-known state through an outage: a fresh repeat is
    // answered from the cache, a transient failure with the last answer.
    boundRead('changeRequests', '/pr/status', async ({ req, res, impl, instance, directory, trustedContext }) => {
      const branch = requestText(req.query?.branch);
      const force = req.query?.force === 'true' || req.query?.force === '1';
      const remote = trustedContext.primaryRemote;
      // The account is resolved before the cache is consulted, so a removed or
      // rotated credential never receives an answer it did not earn.
      const session = await sessionFor(impl, instance, trustedContext.accountId);
      const cacheContext = {
        instance, accountId: session.accountId, credentialRevision: session.credentialRevision,
        repositoryId: trustedContext.repositoryId, bindingRevision: trustedContext.bindingRevision,
        directory, branch, remote,
      };
      if (!force) {
        const fresh = statusCache.fresh(cacheContext);
        if (fresh) return res.json(fresh);
      }
      // A mutation that lands while this read runs keeps the read from storing.
      const started = statusCache.begin();
      try {
        const status = await withTimeout(
          impl.resources.changeRequestStatus({ session, context: trustedContext, directory, branch, remote, force }),
          STATUS_RESOLVE_TIMEOUT_MS,
          `${label} change request status`,
        );
        return res.json(statusCache.store(cacheContext, status, started));
      } catch (error) {
        // The client treats a 503 as "keep what you have" when nothing was seen yet.
        if (isTransientFailure(impl, error)) {
          const last = statusCache.last(cacheContext);
          if (last) return res.json(last);
          return res.status(503).json({ error: error?.message || `${label} is temporarily unavailable` });
        }
        throw error;
      }
    }, {
      validateAfterInstance: (req) => (!requestText(req.query?.directory) || !requestText(req.query?.branch)
        ? 'directory and branch are required' : null),
    });

    const mutationAvailable = () => validateMutationContext instanceof Function
      && mutationExecutor?.read instanceof Function
      && mutationExecutor?.execute instanceof Function;
    /**
     * One durable mutation: validated binding context, the exact bound
     * account, a provider-owned kind and digest, and the shared executor that
     * claims the idempotency key before the provider is called once.
     */
    const executeMutation = async (impl, route, body) => {
      if (!mutationAvailable()) {
        throw Object.assign(new Error('Canonical source control mutations are unavailable'), {
          code: 'SOURCE_CONTROL_MUTATIONS_UNAVAILABLE', status: 501,
        });
      }
      const context = await validateMutationContext(body);
      const actor = { provider: id, instance: context.instance, accountId: context.accountId };
      const session = await sessionFor(impl, context.instance, context.accountId);
      if (session.accountId !== context.accountId
        || !Number.isSafeInteger(session.credentialRevision) || session.credentialRevision < 1
        || !isString(session.providerUserId) || !session.providerUserId.startsWith(`${context.instance}#`)
        || !/^\d+$/.test(session.providerUserId.slice(context.instance.length + 1))) {
        throw Object.assign(new Error(`${label} account is unavailable`), {
          code: 'SOURCE_CONTROL_ACCOUNT_UNAVAILABLE', status: 401,
        });
      }
      const credential = { accountId: session.accountId, credentialRevision: session.credentialRevision };
      const existing = await mutationExecutor.read(context.idempotencyKey);
      const prepared = impl.mutations.prepare({ route, input: body, context, actor, credential });
      const { kind, input } = prepared;
      const record = (target) => ({ key: context.idempotencyKey, inputDigest: prepared.digest(target), kind, actor, target });
      const classifyError = impl.mutations.classifyError ?? classifyMutationError;
      let execution;
      if (existing) {
        requireReplayMatch(existing, kind, actor, context);
        let replayResolution;
        const resolveReplay = async () => {
          replayResolution ??= await impl.mutations.resolveTarget({ session, context, kind, input, replayOf: existing });
          return replayResolution;
        };
        execution = await mutationExecutor.execute({
          record: record(existing.target),
          providerAccountId: session.providerUserId,
          perform: () => { throw mutationConflict(); },
          reconcile: async () => impl.mutations.reconcile({ session, route, kind, input, resolved: await resolveReplay() }),
          classifyError,
        });
      } else {
        const resolved = await impl.mutations.resolveTarget({ session, context, kind, input });
        execution = await mutationExecutor.execute({
          record: record(resolved.target),
          providerAccountId: session.providerUserId,
          perform: () => impl.mutations.perform({ session, route, kind, input, resolved }),
          reconcile: () => impl.mutations.reconcile({ session, route, kind, input, resolved }),
          classifyError,
        });
      }
      statusCache.invalidate({ instance: context.instance, accountId: context.accountId, repositoryId: context.repositoryId });
      // Cache invalidation after the write is durable and best effort: the write
      // landed, and a stale cache must not turn that into an error.
      if (impl.mutations.afterSuccess instanceof Function) {
        try { await impl.mutations.afterSuccess({ session, target: execution.record.target }); }
        catch { /* the next read refreshes what stayed cached */ }
      }
      return changeRequestReceipt(execution.record, execution.replayed, session.providerUserId);
    };
    /**
     * A provider that words its own failures (`mutations.presentError`) gets
     * every error after the shell wrote off a refused account; otherwise the
     * module's own errors answer as they are and the provider's as resource
     * errors.
     */
    const sendMutationError = async (res, impl, error) => {
      if (impl?.mutations?.presentError instanceof Function) {
        const lockFailure = await invalidateRefusedAccount(res, impl, error);
        if (lockFailure) return lockFailure;
        const { status, body } = impl.mutations.presentError(error);
        return res.status(status).json(body);
      }
      if (error?.code?.startsWith('SOURCE_CONTROL_') || error?.code?.startsWith('INVALID_SOURCE_CONTROL_')) {
        return res.status(error.status ?? 409).json(sourceControlErrorBody(error));
      }
      if (!impl) return res.status(500).json({ error: error?.message || `${label} resource request failed` });
      return sendResourceError(res, impl, error);
    };
    for (const [suffix, capability] of MUTATION_ROUTES) {
      route('post', suffix, capability, async (req, res) => {
        let impl;
        try {
          impl = await loadImplementation(id);
          if (!impl.mutations?.routes?.includes(suffix)) return unsupportedCapability(res);
          return res.json(await executeMutation(impl, suffix, req.body ?? {}));
        } catch (error) {
          return sendMutationError(res, impl, error);
        }
      });
    }

    // The project's labels and who can review in it, for the board's pickers.
    for (const [suffix, capability, method] of [
      ['/references/labels', 'labels', 'listLabels'],
      ['/references/reviewers', 'reviewers', 'listReviewerCandidates'],
    ]) {
      boundRead(capability, suffix, async ({ req, res, impl, instance, directory, trustedContext }) => {
        const read = requireResource(impl, method);
        const session = await sessionFor(impl, instance, trustedContext.accountId);
        const project = { owner: requestText(req.query?.owner), name: requestText(req.query?.repo) };
        return res.json({ connected: true, items: await read({ session, directory, project, context: trustedContext, remote: trustedContext.primaryRemote }) });
      }, {
        validate: (req) => (!requestText(req.query?.owner) || !requestText(req.query?.repo)
          ? 'a complete project selector is required' : null),
      });
    }

    // The reference picker: a searched page of issues or change requests, the
    // same search across several folders, an item's detail, and what colours
    // the change requests a page shows.
    boundRead('referencePicker', '/references', async ({ req, res, impl, instance, directory, trustedContext }) => {
      const read = requireResource(impl, 'references');
      const session = await sessionFor(impl, instance, trustedContext.accountId);
      return res.json(await read({
        session, directory, context: trustedContext, remote: trustedContext.primaryRemote,
        kind: requestText(req.query?.kind),
        ...readListFilter(req.query),
        query: requestText(req.query?.query),
        cursor: requestText(req.query?.cursor) || null,
      }));
    }, {
      validate: (req) => (!requestText(req.query?.directory) || !['issue', 'pull'].includes(requestText(req.query?.kind))
        ? 'directory and kind (issue or pull) are required' : null),
    });

    // Every folder's context is validated, and read with its own account, by the provider.
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
        return sendProviderResponse(res, error) ?? res.status(error?.status ?? 500).json({ error: error?.message || `${label} references request failed` });
      }
    });

    boundRead('referencePicker', '/references/detail', async ({ req, res, impl, instance, directory, trustedContext }) => {
      const read = requireResource(impl, 'referenceDetail');
      const session = await sessionFor(impl, instance, trustedContext.accountId);
      return res.json(await read({
        session, directory, context: trustedContext, remote: trustedContext.primaryRemote,
        project: { owner: requestText(req.query?.owner), name: requestText(req.query?.repo) },
        number: requestIssueNumber(req.query?.number),
        host: requestText(req.query?.host),
      }));
    }, {
      validate: (req) => (!requestText(req.query?.directory) || !requestText(req.query?.owner) || !requestText(req.query?.repo)
        || !requestIssueNumber(req.query?.number) ? 'directory, owner, repo and number are required' : null),
    });

    // Statuses are read with each listed host's own account, so no bound session is resolved here.
    boundRead('referencePicker', '/references/status', async ({ req, res, impl, directory, trustedContext }) => {
      const read = requireResource(impl, 'referenceStatuses');
      return res.json(await read({
        directory, context: trustedContext, remote: trustedContext.primaryRemote, pulls: requestText(req.query?.pulls),
      }));
    }, {
      validate: (req) => (!requestText(req.query?.directory) || !requestText(req.query?.pulls)
        ? 'directory and pulls (owner/repo#number, comma separated) are required' : null),
    });

    // A picture or a clip attached to an issue, a change request or a note,
    // for the board. The path keeps the provider's own shape, so the file name
    // ends it. The route accepts the URL auth token, since `img` and `video`
    // cannot send headers.
    // TODO(provider-registry): `ui-auth/ui-auth.js` allows URL auth only for
    // `/api/source-control/gitlab/uploads/`; a further provider with `uploads`
    // needs its prefix there too.
    route('get', '/uploads/:secret/:filename', 'uploads', async (req, res) => {
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      let impl;
      try {
        impl = await loadImplementation(id);
        const owner = requestText(req.query?.owner);
        const repo = requestText(req.query?.repo);
        const upload = readUploadParams(req.params);
        if (!owner || !repo || !upload) return res.status(400).json({ error: 'a project selector and an upload path are required' });
        const instance = requestInstance(req);
        const directory = requestText(req.query?.directory);
        const trustedContext = await readContextOf(req, instance, directory);
        if (!trustedContext) return res.status(501).json({ error: 'Bound source control status is unavailable' });
        const readUpload = requireResource(impl, 'readUpload');
        const session = await sessionFor(impl, instance, trustedContext.accountId);
        const upstream = await readUpload({
          session, directory, project: { owner, name: repo }, context: trustedContext, remote: trustedContext.primaryRemote,
          ...upload,
          range: requestText(req.get('range')) || undefined,
          signal: abort.signal,
        });
        const type = uploadMediaType(upstream.headers.get('content-type') || '', upload.filename);
        if (!upstream.ok || !upstream.body || !type) {
          await upstream.body?.cancel().catch(() => {});
          // A refused read is the file's answer, never the account's: it does not invalidate it.
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
        if (isReadContextError(error)) return res.status(error.status ?? 400).json(sourceControlErrorBody(error));
        if (!impl) return res.status(error.status ?? 500).json(sourceControlErrorBody(error));
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
      const owner = requestText(req.query?.owner);
      const repo = requestText(req.query?.repo);
      const session = await sessionFor(impl, instance, trustedContext.accountId);
      return res.json(await impl.resources.changeRequestContext({
        session,
        directory,
        number,
        includeDiff: req.query?.diff === '1',
        includeCIDetails: req.query?.checkDetails === '1',
        includeTimeline: req.query?.timeline === '1',
        project: owner ? { owner, name: repo } : undefined,
        context: trustedContext, remote: trustedContext.primaryRemote,
      }));
    }, {
      validate: (req) => (Boolean(requestText(req.query?.owner)) !== Boolean(requestText(req.query?.repo))
        ? 'complete project selector is required' : null),
    });

    boundRead('issues', '/issues/list', async ({ req, res, impl, instance, directory, trustedContext }) => {
      const session = await sessionFor(impl, instance, trustedContext.accountId);
      return res.json(await impl.resources.listIssues({
        session,
        directory,
        page: requestNumber(req.query?.page) ?? 1,
        query: requestText(req.query?.query) || undefined,
        ...readListFilter(req.query),
        context: trustedContext, remote: trustedContext.primaryRemote,
      }));
    });

    for (const [suffix, method] of [['/issues/get', 'getIssue'], ['/issues/comments', 'issueComments']]) {
      boundRead('issues', suffix, async ({ req, res, impl, instance, directory, trustedContext }) => {
        const owner = requestText(req.query?.owner);
        const repo = requestText(req.query?.repo);
        const session = await sessionFor(impl, instance, trustedContext.accountId);
        return res.json(await impl.resources[method]({
          session,
          directory,
          number: requestIssueNumber(req.query?.number),
          project: owner ? { owner, name: repo } : undefined,
          context: trustedContext, remote: trustedContext.primaryRemote,
        }));
      }, {
        validate: (req) => (!requestIssueNumber(req.query?.number)
          || Boolean(requestText(req.query?.owner)) !== Boolean(requestText(req.query?.repo))
          ? 'valid number and complete project selector are required' : null),
      });
    }

    boundRead('projects', '/repo/upstream', async ({ res, impl, instance, directory, trustedContext }) => {
      const session = await sessionFor(impl, instance, trustedContext.accountId);
      return res.json(await impl.resources.projectUpstream({ session, directory, context: trustedContext, remote: trustedContext.primaryRemote }));
    });

    boundRead('projects', '/repo/branches', async ({ req, res, impl, instance, directory, trustedContext }) => {
      const session = await sessionFor(impl, instance, trustedContext.accountId);
      return res.json({
        branches: await impl.resources.projectBranches({
          session,
          directory,
          project: { owner: requestText(req.query?.owner), name: requestText(req.query?.repo) },
          context: trustedContext, remote: trustedContext.primaryRemote,
        }),
      });
    }, {
      validate: (req) => (!requestText(req.query?.owner) || !requestText(req.query?.repo) ? 'owner and repo are required' : null),
    });

    // The ambient account route is retired: account presentation comes from
    // auth status and account inventory, never from an implicit current user.
    target.get(authPaths('/me'), (_req, res) => res.status(410).json({
      error: `${label} account user route is retired`,
      code: 'SOURCE_CONTROL_ACCOUNT_CONTEXT_REQUIRED',
    }));
  }

  /**
   * A read for another module (the comparison view, walkthroughs, worktrees)
   * with the account of a context its caller has already validated. The
   * provider refusing the token writes the account off the same way a route
   * read does, and the upstream status travels with the error.
   */
  const readWithBoundAccount = async (context, method, input) => {
    const impl = await loadImplementation(context?.provider);
    const read = impl.resources?.[method];
    if (!(read instanceof Function)) {
      throw Object.assign(new Error('This source control provider does not support this operation'), {
        code: 'SOURCE_CONTROL_CAPABILITY_UNSUPPORTED', status: 501,
      });
    }
    const session = await impl.auth.resolveAccount({ instance: context.instance, accountId: context.accountId });
    try {
      return await read({ session, directory: context.directory, remote: context.primaryRemote, ...input });
    } catch (error) {
      const upstreamStatus = upstreamStatusOf(error);
      if (upstreamStatus === 401 && !error?.sourceControlAccountUnavailable && error?.sourceControlIdentity?.accountId) {
        const identity = error.sourceControlIdentity;
        statusCaches.get(identity.provider)?.invalidate({ instance: identity.instance, accountId: identity.accountId });
        await impl.auth.invalidateAccount({
          instance: identity.instance, accountId: identity.accountId, persisted: Boolean(error.sourceControlPersistedAccount),
        });
      }
      if (Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus < 600) error.statusCode = upstreamStatus;
      throw error;
    }
  };
  const invalidProvider = () => Object.assign(new Error('Change request source provider is invalid'), {
    code: 'INVALID_SOURCE_CONTROL_READ_CONTEXT', status: 400,
  });
  const requireProvider = (id) => {
    if (!providers.has(id)) throw invalidProvider();
    return id;
  };
  const trustedRead = async (input, method, extra) => {
    requireProvider(input?.context?.provider);
    const trusted = await validateReadContext(input.context);
    return readWithBoundAccount(trusted, method, { ...extra(trusted), context: trusted });
  };

  return Object.freeze({
    mountExtension,
    unmountExtension,
    extensionDispatcher,
    /**
     * Live state of known change requests and issues, read with the
     * instance's current or named account. A provider may answer with the
     * instance's current account when the named one no longer resolves
     * (`orCurrent`); GitHub does, GitLab does not.
     */
    readLiveSummaries: async ({ provider, instance, accountId = null, refs, issueRefs }) => {
      const impl = await loadImplementation(requireProvider(provider));
      if (!(impl.resources?.liveSummaries instanceof Function)) return { connected: false };
      let session;
      try {
        session = await impl.auth.resolveAccount({
          instance: providers.describe(provider).instance.normalize(instance), accountId: accountId ?? '', orCurrent: true,
        });
      } catch (error) {
        if (error?.sourceControlAccountUnavailable) return { connected: false };
        throw error;
      }
      return { connected: true, ...(await impl.resources.liveSummaries({ session, refs, issueRefs })) };
    },
    readChangeRequestPatch: ({ context, number, sourceRepo }) => readWithBoundAccount(context, 'readChangeRequestPatch', { number, sourceRepo }),
    readChangeRequestFile: ({ context, number, sourceRepo, path, previousPath, status }) => readWithBoundAccount(
      context, 'readChangeRequestFile', { number, sourceRepo, path, previousPath, status },
    ),
    /** A change request's head on the context's primary project network, for a worktree made from it. */
    readChangeRequestHead: (input) => trustedRead(input, 'readChangeRequestHead', () => ({ number: input.number })),
    resolveChangeRequestSource: (input) => trustedRead(input, 'resolveChangeRequestSource', () => ({
      project: input.project,
      number: input.number,
      expectedHeadSha: input.expectedHeadSha,
      requestedRemoteName: input.requestedRemoteName,
    })),
  });
}
