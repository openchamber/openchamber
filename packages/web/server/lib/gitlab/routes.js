import path from 'node:path';
import os from 'node:os';

import { createSourceControlAuthStore } from './auth-storage.js';
import { defaultGitLabClientId, exchangeGitLabDeviceCode, probeGitLabAuth, startGitLabDeviceFlow } from './device-flow.js';
import { getGlabToken } from './glab-credential.js';
import { normalizeGitLabInstance } from './instance.js';
import { classifyGitLabFailure } from './network.js';
import { createGitLabClient } from './client.js';
import { createGitLabResourceService } from './resources.js';
import { verifyGitLabToken } from './verify.js';
import { isString } from './validation.js';
import { createOAuthFlowRegistry } from '../source-control/oauth-flow-registry.js';
import { digestMutationInput, mutationReceipt } from '../source-control/mutation-executor.js';

const accountView = (origin, account, current, accounts) => ({
  id: account.id,
  credentialId: account.id,
  credentialRevision: account.credentialRevision,
  providerUserId: account.providerUserId,
  providerUserStatus: accounts.some((candidate) => (
    candidate.providerUserId === account.providerUserId && candidate.status === 'valid'
  )) ? 'available' : 'unavailable',
  user: { ...account.user, provider: 'gitlab', instance: origin },
  scope: account.scope,
  current,
  source: account.source,
  status: account.status === 'invalid' ? 'invalid' : 'valid',
});

const cliAccountView = (origin, user, current) => ({
  id: `${origin}#cli:${user.id}`,
  credentialId: `${origin}#cli:${user.id}`,
  credentialRevision: 1,
  providerUserId: `${origin}#${user.id}`,
  providerUserStatus: 'available',
  user: { ...user, provider: 'gitlab', instance: origin },
  current,
  source: 'cli',
  status: 'valid',
});

function requestOrigin(req) {
  return normalizeGitLabInstance(isString(req.query?.instance) ? req.query.instance : '');
}

function errorStatus(kind) {
  return kind === 'temporarily-unavailable' ? 503 : kind === 'unreachable' ? 502 : 500;
}

function sendAuthStorageError(res, error) {
  if (error?.code?.startsWith('SOURCE_CONTROL_LOCK_')) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  if (error?.code === 'INVALID_SOURCE_CONTROL_AUTH') {
    return res.status(500).json({ error: error.message, code: error.code });
  }
  return null;
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

export function registerGitLabRoutes(app, options = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const authFile = options.authFile ?? path.join(options.configRoot ?? process.env.OPENCHAMBER_DATA_DIR ?? path.join(os.homedir(), '.config', 'openchamber'), 'source-control-auth.json');
  const store = options.store ?? createSourceControlAuthStore({ filePath: authFile });
  const oauthFlowRegistry = options.oauthFlowRegistry ?? createOAuthFlowRegistry();
  const readSettings = options.readSettings ?? (async () => ({}));
  const getClientId = async (origin) => {
    const envValue = isString(process.env.OPENCHAMBER_GITLAB_CLIENT_ID) ? process.env.OPENCHAMBER_GITLAB_CLIENT_ID.trim() : '';
    if (envValue) return envValue;
    const settings = await readSettings();
    const stored = isString(settings?.gitlabClientId) ? settings.gitlabClientId.trim() : '';
    return stored || defaultGitLabClientId(origin);
  };
  const glabToken = (origin) => getGlabToken(origin, { execFile: options.execFile, timeoutMs: options.cliTimeoutMs });
  const verify = (origin, token) => verifyGitLabToken({ origin, token, fetch: fetchImpl, timeoutMs });
  const createClient = options.createClient ?? createGitLabClient;
  const identityFor = (origin, accountId) => ({ provider: 'gitlab', instance: origin, accountId });
  /**
   * A connected account is a complete identity waiting to be written: who it
   * is, what it authenticates with, and how it signs are all known here.
   */
  const announceConnectedAccount = async (origin, credential, user) => {
    if (!credential?.credentialId) return;
    const account = { provider: 'gitlab', instance: origin, accountId: credential.credentialId };
    // Signing in again renews a credential rather than replacing it, so the
    // ones this supersedes are named too: whatever followed the old credential
    // is expected to keep working as the same account.
    const instance = await store.readInstance(origin).catch(() => null);
    const superseded = (instance?.accounts ?? []).filter((candidate) =>
      candidate.providerUserId === credential.providerUserId && candidate.id !== credential.credentialId);
    options.onAccountConnected?.({
      account,
      user,
      renews: superseded.map((candidate) => ({ ...account, accountId: candidate.id })),
    });
  };
  const invalidateAccount = async (origin, accountId) => {
    await options.onAccountInvalidated?.(identityFor(origin, accountId));
    await store.markAccountInvalid(origin, accountId, 'unauthorized');
  };

  const getUsableGlab = async (origin) => {
    const instance = await store.readInstance(origin);
    if (instance.cliDisabled) return null;
    const token = await glabToken(origin);
    if (!token) return null;
    try {
      return { token, user: await verify(origin, token) };
    } catch {
      return null;
    }
  };

  const buildStatus = async (origin) => {
    const instance = await store.readInstance(origin);
    const activeRecord = instance.cliActive ? null : instance.accounts.find((account) => account.id === instance.activeAccountId) ?? null;
    const active = activeRecord?.status === 'invalid' ? null : activeRecord;
    const cli = await getUsableGlab(origin);
    if (instance.cliActive && !cli) {
      await store.setCliActive(origin, false);
      return buildStatus(origin);
    }
    const cliCurrent = Boolean(cli && (instance.cliActive || !activeRecord));
    const accounts = instance.accounts.map((account) => accountView(
      origin, account, Boolean(active && account.id === active.id && !cliCurrent), instance.accounts,
    ));
    if (cli) accounts.push(cliAccountView(origin, cli.user, cliCurrent));

    if (!active) {
      if (!cli) {
        if (instance.cliDisabled) {
          return {
            provider: 'gitlab', instance: origin, status: 'disconnected', connected: false,
            accounts, cli: { available: false, disabled: true, active: false },
          };
        }
        const clientId = await getClientId(origin);
        const capability = await probeGitLabAuth({ origin, clientId, fetch: fetchImpl, timeoutMs, glabAvailable: false });
        if (!capability.confirmed) return { provider: 'gitlab', instance: origin, status: 'unsupported', connected: false, reason: 'no-supported-auth-method', accounts };
        return {
          provider: 'gitlab', instance: origin, status: 'disconnected', connected: false,
          accounts, cli: { available: false, disabled: instance.cliDisabled, active: false },
        };
      }
      return {
        provider: 'gitlab', instance: origin, status: 'connected', connected: true,
        user: { ...cli.user, provider: 'gitlab', instance: origin }, accounts,
        cli: { available: true, disabled: instance.cliDisabled, active: cliCurrent, user: { ...cli.user, provider: 'gitlab', instance: origin } },
      };
    }

    try {
      const user = await verify(origin, active.token);
      const status = {
        provider: 'gitlab', instance: origin, status: 'connected', connected: true,
        user: { ...user, provider: 'gitlab', instance: origin }, scope: active.scope, accounts,
        cli: { available: Boolean(cli), disabled: instance.cliDisabled, active: false },
      };
      if (cli) status.cli.user = { ...cli.user, provider: 'gitlab', instance: origin };
      return status;
    } catch (error) {
      const kind = classifyGitLabFailure(error);
      if (error?.kind === 'invalid-token') {
        await invalidateAccount(origin, active.id);
        return buildStatus(origin);
      }
      return { provider: 'gitlab', instance: origin, status: kind, connected: false, message: error?.message, accounts };
    }
  };

  const getResourceContext = async (origin, requestedAccountId = '', canonicalReads = false) => {
    const instance = await store.readInstance(origin);
    let active = null;
    let token = null;
    let accountId = requestedAccountId;
    let persisted = false;
    let credentialRevision = null;
    let providerUserId = '';
    if (requestedAccountId.startsWith(`${origin}#cli:`)) {
      if (!instance.cliDisabled) token = await glabToken(origin);
      if (token) {
        try {
          const user = await verify(origin, token);
          if (requestedAccountId !== `${origin}#cli:${user.id}`) {
            await options.onAccountInvalidated?.(identityFor(origin, requestedAccountId));
            token = null;
          } else {
            credentialRevision = 1;
            providerUserId = `${origin}#${user.id}`;
          }
        } catch (error) {
          if (error?.kind === 'invalid-token') await options.onAccountInvalidated?.(identityFor(origin, requestedAccountId));
          throw error;
        }
      }
    } else if (requestedAccountId) {
      active = await store.readAccount(origin, requestedAccountId);
      token = active?.token ?? null;
      persisted = Boolean(active);
      credentialRevision = active?.credentialRevision ?? null;
      providerUserId = active?.providerUserId ?? '';
    } else {
      active = instance.cliActive ? null : instance.accounts.find((account) => account.id === instance.activeAccountId && account.status !== 'invalid') ?? null;
      token = active?.token || (!instance.cliDisabled ? await glabToken(origin) : null);
      accountId = active?.id ?? '';
      persisted = Boolean(active);
      credentialRevision = active?.credentialRevision ?? null;
      providerUserId = active?.providerUserId ?? '';
    }
    if (!token) {
      const error = new Error('GitLab is not connected');
      error.status = 401;
      error.sourceControlAccountUnavailable = true;
      if (requestedAccountId) error.sourceControlIdentity = identityFor(origin, requestedAccountId);
      throw error;
    }
    const identity = identityFor(origin, accountId);
    const resourceOptions = {
      origin,
      client: createClient({ origin, token, tokenType: active?.source === 'oauth' ? 'oauth' : 'token' }),
      canonicalReads,
    };
    if (options.resolveProjects) resourceOptions.resolveProjects = options.resolveProjects;
    const service = (options.createResourceService ?? createGitLabResourceService)(resourceOptions);
    for (const method of Object.keys(service)) {
      const operation = service[method];
      if (!(operation instanceof Function)) continue;
      service[method] = async (...args) => {
        try {
          return await operation(...args);
        } catch (error) {
          error.sourceControlIdentity = identity;
          error.sourceControlPersistedAccount = persisted;
          throw error;
        }
      };
    }
    return { service, accountId, credentialRevision, providerUserId };
  };
  const getResourceService = async (...args) => (await getResourceContext(...args)).service;

  const sendResourceError = async (res, error) => {
    const upstreamStatus = error?.cause?.response?.status ?? error?.response?.status ?? error?.status;
    if (upstreamStatus === 401 && !error?.sourceControlAccountUnavailable && error?.sourceControlIdentity?.accountId) {
      const identity = error.sourceControlIdentity;
      try {
        if (error.sourceControlPersistedAccount) await invalidateAccount(identity.instance, identity.accountId);
        else await options.onAccountInvalidated?.(identity);
      } catch (failure) {
        if (failure?.code?.startsWith('SOURCE_CONTROL_LOCK_')) {
          return res.status(failure.status).json({ error: failure.message, code: failure.code });
        }
        throw failure;
      }
    }
    const status = Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus < 600
      ? upstreamStatus
      : errorStatus(classifyGitLabFailure(error));
    return res.status(status).json({ error: error?.message || 'GitLab resource request failed' });
  };
  const validateReadContext = (req, origin, directory) => options.validateReadContext?.({
    directory,
    repositoryId: req.query?.repositoryId,
    provider: 'gitlab',
    instance: origin,
    accountId: req.query?.accountId,
    bindingRevision: Number(req.query?.bindingRevision),
    primaryRemote: req.query?.primaryRemote,
  });
  const isReadContextError = (error) => error?.code?.startsWith('SOURCE_CONTROL_BINDING_')
    || error?.code?.startsWith('SOURCE_CONTROL_LOCK_')
    || error?.code === 'INVALID_SOURCE_CONTROL_READ_CONTEXT'
    || error?.code === 'INVALID_SOURCE_CONTROL_BINDING';
  const sourceControlErrorBody = (error) => {
    const body = { error: error.message, code: error.code };
    if (Object.hasOwn(error, 'current')) body.current = error.current;
    return body;
  };
  const sendMutationError = (res, error) => {
    if (error?.code?.startsWith('SOURCE_CONTROL_') || error?.code?.startsWith('INVALID_SOURCE_CONTROL_')) {
      return res.status(error.status ?? 409).json(sourceControlErrorBody(error));
    }
    return sendResourceError(res, error);
  };
  const mutationAvailable = () => options.validateMutationContext instanceof Function
    && options.mutationExecutor?.read instanceof Function
    && options.mutationExecutor?.execute instanceof Function;
  const classifyMutationError = (error) => {
    const status = error?.cause?.response?.status ?? error?.response?.status ?? error?.status;
    const localSourceControlError = error?.code?.startsWith('SOURCE_CONTROL_')
      || error?.code?.startsWith('INVALID_SOURCE_CONTROL_');
    if (!localSourceControlError && Number.isInteger(status) && status >= 400 && status < 500) {
      if (!Number.isInteger(error.status)) error.status = status;
      return 'failed';
    }
    return 'outcome-unknown';
  };
  const mutationRecord = (context, kind, actor, credential, target, fields) => ({
    key: context.idempotencyKey,
    inputDigest: digestMutationInput({ kind, actor, credential, target, ...fields }),
    kind,
    actor,
    target,
  });
  const mutationConflict = () => Object.assign(
    new Error('Source control mutation idempotency key was already used with different input'),
    { code: 'SOURCE_CONTROL_MUTATION_CONFLICT', status: 409 },
  );
  const invalidMutationContext = (message) => Object.assign(new Error(message), {
    code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT',
    status: 400,
  });
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
  const executeMutation = async (body, kind, normalize, perform, reconcile) => {
    if (!mutationAvailable()) {
      throw Object.assign(new Error('Canonical source control mutations are unavailable'), {
        code: 'SOURCE_CONTROL_MUTATIONS_UNAVAILABLE', status: 501,
      });
    }
    const context = await options.validateMutationContext(body);
    const actor = { provider: 'gitlab', instance: context.instance, accountId: context.accountId };
    const resource = await getResourceContext(context.instance, context.accountId, true);
    if (resource.accountId !== context.accountId
      || !Number.isSafeInteger(resource.credentialRevision) || resource.credentialRevision < 1
      || !isString(resource.providerUserId) || !resource.providerUserId.startsWith(`${context.instance}#`)
      || !/^\d+$/.test(resource.providerUserId.slice(context.instance.length + 1))) {
      throw Object.assign(new Error('GitLab account is unavailable'), {
        code: 'SOURCE_CONTROL_ACCOUNT_UNAVAILABLE', status: 401,
      });
    }
    const { service } = resource;
    const credential = { accountId: resource.accountId, credentialRevision: resource.credentialRevision };
    const existing = await options.mutationExecutor.read(context.idempotencyKey);
    const normalized = normalize(body, context);
    if (existing) {
      requireReplayMatch(existing, kind, actor, context);
      let replayResolution;
      const resolveReplay = async () => {
        if (!replayResolution) {
          replayResolution = kind === 'change-request-create'
            ? await service.resolveCreateMutation(context, context.target, normalized)
            : {
                providerTarget: { projectId: existing.target.project.id, number: existing.target.number },
                target: existing.target,
              };
        }
        return replayResolution;
      };
      const execution = await options.mutationExecutor.execute({
        record: mutationRecord(context, kind, actor, credential, existing.target, normalized.digest),
        providerAccountId: resource.providerUserId,
        perform: () => { throw mutationConflict(); },
        reconcile: async () => reconcile(service, await resolveReplay()),
        classifyError: classifyMutationError,
      });
      return mutationReceipt(execution.record, execution.replayed, resource.providerUserId);
    }
    const resolved = kind === 'change-request-create'
      ? await service.resolveCreateMutation(context, context.target, normalized)
      : await service.resolveChangeRequestMutation(context, context.target);
    const execution = await options.mutationExecutor.execute({
      record: mutationRecord(context, kind, actor, credential, resolved.target, normalized.digest),
      providerAccountId: resource.providerUserId,
      perform: () => perform(service, normalized, resolved),
      reconcile: () => reconcile(service, resolved),
      classifyError: classifyMutationError,
    });
    return mutationReceipt(execution.record, execution.replayed, resource.providerUserId);
  };

  app.get('/api/source-control/gitlab/capabilities', async (req, res) => {
    try {
      const origin = requestOrigin(req);
      const clientId = await getClientId(origin);
      const probe = await probeGitLabAuth({ origin, clientId, fetch: fetchImpl, timeoutMs, glabAvailable: false });
      const cliAvailable = probe.confirmed && Boolean(await getUsableGlab(origin));
      const cli = cliAvailable ? { available: true } : { available: false, reason: 'cli-unavailable' };
      return res.json({
        identity: { provider: 'gitlab', instance: origin }, authentication: probe.confirmed && (probe.device.available || probe.pat.available || cli.available),
        authenticationMethods: { device: probe.device, pat: probe.pat, cli }, multipleAccounts: true,
        projects: true, issues: true, changeRequests: true, draftChangeRequests: true,
        mergeChangeRequests: true, mergeMethods: ['merge', 'squash'], ci: true,
      });
    } catch (error) {
      const kind = classifyGitLabFailure(error);
      return res.status(errorStatus(kind)).json({ error: error?.message || 'Failed to probe GitLab', status: kind });
    }
  });

  app.get('/api/source-control/gitlab/auth/status', async (req, res) => {
    try {
      return res.json(await buildStatus(requestOrigin(req)));
    } catch (error) {
      const lockResponse = sendAuthStorageError(res, error);
      if (lockResponse) return lockResponse;
      if (error?.kind === 'unreachable' || error?.kind === 'temporarily-unavailable') {
        let origin;
        try {
          origin = requestOrigin(req);
        } catch {
          return res.status(400).json({ error: 'Invalid GitLab instance URL' });
        }
        return res.json({ provider: 'gitlab', instance: origin, status: error.kind, connected: false, message: error.message });
      }
      return res.status(400).json({ error: error?.message || 'Failed to get GitLab auth status' });
    }
  });

  app.get('/api/source-control/gitlab/auth/accounts', async (req, res) => {
    try {
      const origin = requestOrigin(req);
      const instance = await store.readInstance(origin);
      const accounts = instance.accounts.map((account) => accountView(
        origin, account, account.id === instance.activeAccountId && !instance.cliActive, instance.accounts,
      ));
      return res.json({ provider: 'gitlab', instance: origin, accounts });
    } catch (error) {
      const lockResponse = sendAuthStorageError(res, error);
      if (lockResponse) return lockResponse;
      return res.status(400).json({ error: error?.message || 'Failed to list GitLab accounts' });
    }
  });

  app.post('/api/source-control/gitlab/auth/start', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const origin = requestOrigin(req);
      const clientId = await getClientId(origin);
      if (!clientId) return res.status(400).json({ error: 'GitLab OAuth client is not configured', status: 'invalid-client' });
      const payload = await startGitLabDeviceFlow({ origin, clientId, fetch: fetchImpl, timeoutMs });
      const { flowId } = oauthFlowRegistry.register({
        provider: 'gitlab', instance: origin, deviceCode: payload.device_code, clientId, expiresIn: payload.expires_in,
      });
      const result = {
        flowId,
        userCode: payload.user_code,
        verificationUri: payload.verification_uri,
        expiresIn: payload.expires_in,
        interval: payload.interval,
      };
      if (isString(payload.verification_uri_complete)) result.verificationUriComplete = payload.verification_uri_complete;
      return res.json(result);
    } catch (error) {
      const kind = classifyGitLabFailure(error);
      return res.status(errorStatus(kind)).json({ error: error?.message || 'Failed to start GitLab device flow', status: kind });
    }
  });

  app.post('/api/source-control/gitlab/auth/complete', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    let flowId = '';
    let acquired = false;
    try {
      const origin = requestOrigin(req);
      flowId = isString(req.body?.flowId) ? req.body.flowId.trim() : '';
      if (!flowId) return res.status(400).json({ error: 'flowId is required' });
      let flow;
      try {
        flow = oauthFlowRegistry.acquire({ flowId, provider: 'gitlab', instance: origin });
        acquired = true;
      } catch (error) {
        if (error?.code === 'SOURCE_CONTROL_OAUTH_FLOW_BUSY') return res.status(409).json({ error: 'OAuth flow is busy', code: error.code });
        if (error?.code === 'SOURCE_CONTROL_OAUTH_FLOW_UNAVAILABLE') return res.status(410).json({ error: 'OAuth flow is unavailable', code: error.code });
        throw error;
      }
      const { clientId, deviceCode } = flow;
      const result = await exchangeGitLabDeviceCode({ origin, clientId, deviceCode, fetch: fetchImpl, timeoutMs });
      if (result.status === 'authorization_pending' || result.status === 'slow_down') {
        oauthFlowRegistry.release(flowId);
        acquired = false;
        return res.json({ connected: false, status: result.status });
      }
      oauthFlowRegistry.consume(flowId);
      acquired = false;
      if (result.status !== 'connected') return res.json({ connected: false, status: result.error, error: result.message });
      const user = await verify(origin, result.accessToken);
      const credential = await store.setAccount(origin, { token: result.accessToken, user, source: 'oauth', scope: result.scope });
      await announceConnectedAccount(origin, credential, user);
      return res.json({ connected: true, user, scope: result.scope });
    } catch (error) {
      if (acquired) oauthFlowRegistry.release(flowId);
      const lockResponse = sendAuthStorageError(res, error);
      if (lockResponse) return lockResponse;
      const kind = classifyGitLabFailure(error);
      return res.status(errorStatus(kind)).json({ error: error?.message || 'Failed to complete GitLab device flow', status: kind });
    }
  });

  app.post('/api/source-control/gitlab/auth/token', async (req, res) => {
    try {
      const origin = requestOrigin(req);
      const token = isString(req.body?.token) ? req.body.token.trim() : '';
      if (!token) return res.status(400).json({ error: 'token is required' });
      const user = await verify(origin, token);
      const credential = await store.setAccount(origin, { token, user, source: 'pat' });
      await announceConnectedAccount(origin, credential, user);
      return res.json({ connected: true, user });
    } catch (error) {
      const lockResponse = sendAuthStorageError(res, error);
      if (lockResponse) return lockResponse;
      // The reason a token was refused is the person's to act on, so it is
      // named by a code the interface can translate rather than folded into a
      // generic failure.
      if (error?.kind === 'invalid-token') {
        return res.status(401).json({ error: error?.message || 'GitLab token is invalid', code: 'INVALID_TOKEN' });
      }
      return res.status(errorStatus(classifyGitLabFailure(error))).json({ error: error?.message || 'Failed to verify GitLab token' });
    }
  });

  app.post('/api/source-control/gitlab/auth/activate', async (req, res) => {
    try {
      const origin = requestOrigin(req);
      const accountId = isString(req.body?.accountId) ? req.body.accountId : '';
      if (accountId.startsWith(`${origin}#cli:`)) {
        const usable = await getUsableGlab(origin);
        if (!usable || accountId !== `${origin}#cli:${usable.user.id}`) return res.status(404).json({ error: 'GitLab CLI account not found' });
        await store.setCliActive(origin, true);
        return res.json(await buildStatus(origin));
      }
      if (!accountId || !(await store.activate(origin, accountId))) return res.status(404).json({ error: 'GitLab account not found' });
      return res.json(await buildStatus(origin));
    } catch (error) {
      const lockResponse = sendAuthStorageError(res, error);
      if (lockResponse) return lockResponse;
      return res.status(400).json({ error: error?.message || 'Failed to activate GitLab account' });
    }
  });

  app.post('/api/source-control/gitlab/auth/cli', async (req, res) => {
    try {
      const origin = requestOrigin(req);
      const disabled = await store.setCliDisabled(origin, Boolean(req.body?.disabled));
      const usable = await getUsableGlab(origin);
      return res.json({ available: Boolean(usable), disabled });
    } catch (error) {
      const lockResponse = sendAuthStorageError(res, error);
      if (lockResponse) return lockResponse;
      return res.status(400).json({ error: error?.message || 'Failed to inspect glab authentication' });
    }
  });

  app.delete('/api/source-control/gitlab/auth', async (req, res) => {
    try {
      const origin = requestOrigin(req);
      const requested = req.query?.accountId ?? req.body?.accountId;
      const requestedAccountId = requestText(requested);
      if (!requestedAccountId || requested !== requestedAccountId) {
        return res.status(400).json({ error: 'accountId is required' });
      }
      const instance = await store.readInstance(origin);
      if (requestedAccountId.startsWith(`${origin}#cli:`)) {
        const cli = await getUsableGlab(origin);
        if (!cli || `${origin}#cli:${cli.user.id}` !== requestedAccountId) {
          return res.json({ removed: false });
        }
        await options.onAccountRemoved?.(identityFor(origin, requestedAccountId));
        return res.json({ removed: await store.setCliActive(origin, false) });
      }
      if (!instance.accounts.some((account) => account.id === requestedAccountId)) return res.json({ removed: false });
      await options.onAccountRemoved?.(identityFor(origin, requestedAccountId));
      return res.json({ removed: await store.removeAccount(origin, requestedAccountId) });
    } catch (error) {
      const lockResponse = sendAuthStorageError(res, error);
      if (lockResponse) return lockResponse;
      return res.status(400).json({ error: error?.message || 'Failed to disconnect GitLab' });
    }
  });

  app.get('/api/source-control/gitlab/pr/status', async (req, res) => {
    try {
      const origin = requestOrigin(req);
      const directory = requestText(req.query?.directory);
      const branch = requestText(req.query?.branch);
      if (!directory || !branch) return res.status(400).json({ error: 'directory and branch are required' });
      const trustedContext = await validateReadContext(req, origin, directory);
      if (!trustedContext) return res.status(501).json({ error: 'Bound source control status is unavailable' });
      const service = await getResourceService(origin, trustedContext.accountId, true);
      return res.json(await service.changeRequestStatus(directory, branch, trustedContext.primaryRemote));
    } catch (error) {
      if (isReadContextError(error)) {
        return res.status(error.status ?? 400).json(sourceControlErrorBody(error));
      }
      return sendResourceError(res, error);
    }
  });

  app.post('/api/source-control/gitlab/pr/create', async (req, res) => {
    try {
      const body = req.body ?? {};
      return res.json(await executeMutation(body, 'change-request-create', (input, context) => {
        const title = requestText(input.title);
        if (!title || !context.target.head || !context.target.base) {
          throw invalidMutationContext('title, target head, and target base are required');
        }
        const normalized = { title, draft: input.draft === true };
        if (isString(input.body)) normalized.body = input.body;
        const remote = requestText(input.remote);
        const headRemote = requestText(input.headRemote);
        if (remote) normalized.remote = remote;
        if (headRemote) normalized.headRemote = headRemote;
        normalized.digest = {
          title, body: normalized.body ?? null, draft: normalized.draft,
          remote: normalized.remote ?? context.primaryRemote, headRemote: normalized.headRemote ?? context.primaryRemote,
        };
        return normalized;
      }, (service, normalized, resolved) => service.createChangeRequest({
        ...normalized,
        head: resolved.target.head,
        base: resolved.target.base,
        providerTarget: resolved.providerTarget,
        targetProject: resolved.target.project,
        expectedTarget: resolved.target,
      }), (service, resolved) => service.reconcileCreateMutation(resolved.providerTarget, resolved.target)));
    } catch (error) {
      return sendMutationError(res, error);
    }
  });

  app.post('/api/source-control/gitlab/pr/update', async (req, res) => {
    try {
      const body = req.body ?? {};
      return res.json(await executeMutation(body, 'change-request-update', (input, context) => {
        const title = requestText(input.title);
        if (!title || !context.target.number) {
          throw invalidMutationContext('title and target number are required');
        }
        const normalized = { title };
        if (isString(input.body)) normalized.body = input.body;
        normalized.digest = { title, body: normalized.body ?? null };
        return normalized;
      }, (service, normalized, resolved) => service.updateChangeRequest({
        ...normalized,
        providerTarget: resolved.providerTarget,
        targetProject: resolved.target.project,
        expectedTarget: resolved.target,
      }), (service, resolved) => service.reconcileChangeRequestMutation(resolved.providerTarget, 'change-request-update')));
    } catch (error) {
      return sendMutationError(res, error);
    }
  });

  app.post('/api/source-control/gitlab/pr/merge', async (req, res) => {
    try {
      const body = req.body ?? {};
      return res.json(await executeMutation(body, 'change-request-merge', (input, context) => {
        if (!context.target.number || !['merge', 'squash'].includes(input.method)) {
          throw invalidMutationContext('target number and merge method are required');
        }
        return { method: input.method, digest: { method: input.method } };
      }, async (service, normalized, resolved) => {
        const result = await service.mergeChangeRequest({
          method: normalized.method,
          providerTarget: resolved.providerTarget,
          targetProject: resolved.target.project,
          expectedTarget: resolved.target,
        });
        return { merged: result.merged };
      }, (service, resolved) => service.reconcileChangeRequestMutation(resolved.providerTarget, 'change-request-merge')));
    } catch (error) {
      return sendMutationError(res, error);
    }
  });

  app.post('/api/source-control/gitlab/pr/ready', async (req, res) => {
    try {
      const body = req.body ?? {};
      return res.json(await executeMutation(body, 'change-request-ready', (_input, context) => {
        if (!context.target.number) {
          throw invalidMutationContext('target number is required');
        }
        return { digest: {} };
      }, (service, _normalized, resolved) => service.readyChangeRequest({
        providerTarget: resolved.providerTarget,
        targetProject: resolved.target.project,
        expectedTarget: resolved.target,
      }), (service, resolved) => service.reconcileChangeRequestMutation(resolved.providerTarget, 'change-request-ready')));
    } catch (error) {
      return sendMutationError(res, error);
    }
  });

  app.get('/api/source-control/gitlab/pulls/list', async (req, res) => {
    try {
      const origin = requestOrigin(req);
      const directory = requestText(req.query?.directory);
      const trustedContext = await validateReadContext(req, origin, directory);
      if (!trustedContext) return res.status(501).json({ error: 'Bound source control status is unavailable' });
      const service = await getResourceService(origin, trustedContext.accountId, true);
      return res.json(await service.listChangeRequests(directory, {
        page: requestNumber(req.query?.page) ?? 1,
        query: requestText(req.query?.query) || undefined,
        remote: trustedContext.primaryRemote,
      }));
    } catch (error) {
      if (isReadContextError(error)) {
        return res.status(error.status ?? 400).json(sourceControlErrorBody(error));
      }
      return sendResourceError(res, error);
    }
  });

  app.get('/api/source-control/gitlab/pulls/context', async (req, res) => {
    try {
      const number = requestNumber(req.query?.number);
      const owner = requestText(req.query?.owner);
      const repo = requestText(req.query?.repo);
      if (Boolean(owner) !== Boolean(repo)) return res.status(400).json({ error: 'complete project selector is required' });
      const origin = requestOrigin(req);
      const directory = requestText(req.query?.directory);
      const trustedContext = await validateReadContext(req, origin, directory);
      if (!trustedContext) return res.status(501).json({ error: 'Bound source control status is unavailable' });
      if (!number) return res.status(400).json({ error: 'number is required' });
      const service = await getResourceService(origin, trustedContext.accountId, true);
      return res.json(await service.changeRequestContext(directory, number, {
        includeDiff: req.query?.diff === '1', includeCIDetails: req.query?.checkDetails === '1',
        project: owner ? { owner, name: repo } : undefined,
        remote: trustedContext.primaryRemote,
        constrainToPrimary: true,
      }));
    } catch (error) {
      if (isReadContextError(error)) {
        return res.status(error.status ?? 400).json(sourceControlErrorBody(error));
      }
      return sendResourceError(res, error);
    }
  });

  app.get('/api/source-control/gitlab/issues/list', async (req, res) => {
    try {
      const origin = requestOrigin(req);
      const directory = requestText(req.query?.directory);
      const trustedContext = await validateReadContext(req, origin, directory);
      if (!trustedContext) return res.status(501).json({ error: 'Bound source control status is unavailable' });
      const service = await getResourceService(origin, trustedContext.accountId, true);
      return res.json(await service.listIssues(directory, {
        page: requestNumber(req.query?.page) ?? 1, query: requestText(req.query?.query) || undefined,
        remote: trustedContext.primaryRemote,
      }));
    } catch (error) {
      if (isReadContextError(error)) {
        return res.status(error.status ?? 400).json(sourceControlErrorBody(error));
      }
      return sendResourceError(res, error);
    }
  });

  app.get('/api/source-control/gitlab/issues/get', async (req, res) => {
    try {
      const number = requestIssueNumber(req.query?.number);
      const owner = requestText(req.query?.owner);
      const repo = requestText(req.query?.repo);
      if (!number || Boolean(owner) !== Boolean(repo)) return res.status(400).json({ error: 'valid number and complete project selector are required' });
      const origin = requestOrigin(req);
      const directory = requestText(req.query?.directory);
      const trustedContext = await validateReadContext(req, origin, directory);
      if (!trustedContext) return res.status(501).json({ error: 'Bound source control status is unavailable' });
      const service = await getResourceService(origin, trustedContext.accountId, true);
      return res.json(await service.getIssue(directory, number, owner ? { owner, name: repo } : undefined, trustedContext.primaryRemote));
    } catch (error) {
      if (isReadContextError(error)) {
        return res.status(error.status ?? 400).json(sourceControlErrorBody(error));
      }
      return sendResourceError(res, error);
    }
  });

  app.get('/api/source-control/gitlab/issues/comments', async (req, res) => {
    try {
      const number = requestIssueNumber(req.query?.number);
      const owner = requestText(req.query?.owner);
      const repo = requestText(req.query?.repo);
      if (!number || Boolean(owner) !== Boolean(repo)) return res.status(400).json({ error: 'valid number and complete project selector are required' });
      const origin = requestOrigin(req);
      const directory = requestText(req.query?.directory);
      const trustedContext = await validateReadContext(req, origin, directory);
      if (!trustedContext) return res.status(501).json({ error: 'Bound source control status is unavailable' });
      const service = await getResourceService(origin, trustedContext.accountId, true);
      return res.json(await service.issueComments(directory, number, owner ? { owner, name: repo } : undefined, trustedContext.primaryRemote));
    } catch (error) {
      if (isReadContextError(error)) {
        return res.status(error.status ?? 400).json(sourceControlErrorBody(error));
      }
      return sendResourceError(res, error);
    }
  });

  app.get('/api/source-control/gitlab/repo/upstream', async (req, res) => {
    try {
      const origin = requestOrigin(req);
      const directory = requestText(req.query?.directory);
      const trustedContext = await validateReadContext(req, origin, directory);
      if (!trustedContext) return res.status(501).json({ error: 'Bound source control status is unavailable' });
      const service = await getResourceService(origin, trustedContext.accountId, true);
      return res.json(await service.projectUpstream(directory, trustedContext.primaryRemote));
    } catch (error) {
      if (isReadContextError(error)) {
        return res.status(error.status ?? 400).json(sourceControlErrorBody(error));
      }
      return sendResourceError(res, error);
    }
  });

  app.get('/api/source-control/gitlab/repo/branches', async (req, res) => {
    try {
      const owner = requestText(req.query?.owner);
      const repo = requestText(req.query?.repo);
      if (!owner || !repo) return res.status(400).json({ error: 'owner and repo are required' });
      const origin = requestOrigin(req);
      const directory = requestText(req.query?.directory);
      const trustedContext = await validateReadContext(req, origin, directory);
      if (!trustedContext) return res.status(501).json({ error: 'Bound source control status is unavailable' });
      const service = await getResourceService(origin, trustedContext.accountId, true);
      return res.json({ branches: await service.projectBranches(directory, { owner, name: repo }, trustedContext.primaryRemote) });
    } catch (error) {
      if (isReadContextError(error)) {
        return res.status(error.status ?? 400).json(sourceControlErrorBody(error));
      }
      return sendResourceError(res, error);
    }
  });

  return {
    listInstances: async () => store.listInstances?.() ?? [],
    resolveChangeRequestSource: async ({ context, project, number, expectedHeadSha, requestedRemoteName }) => {
      const trusted = await options.validateReadContext(context);
      const service = await getResourceService(trusted.instance, trusted.accountId, true);
      const resolved = await service.changeRequestContext(trusted.directory, number, {
        project: { owner: project.owner, name: project.name },
        remote: trusted.primaryRemote,
        constrainToPrimary: true,
      });
      const request = resolved.changeRequest;
      if (!request || request.project?.id !== project.id
        || String(request.headSha || '').toLowerCase() !== expectedHeadSha.toLowerCase()) {
        throw Object.assign(new Error('Change request head changed'), { code: 'SOURCE_CONTROL_CHANGE_REQUEST_STALE', status: 409 });
      }
      const headProject = request.headProject ?? request.project;
      const endpoint = headProject.cloneUrl;
      const origin = new URL(trusted.instance);
      const parsed = new URL(endpoint);
      if (parsed.protocol !== 'https:' || parsed.origin !== origin.origin
        || decodeURIComponent(parsed.pathname).replace(/^\//, '').replace(/\.git$/, '') !== `${headProject.owner}/${headProject.name}`) {
        throw Object.assign(new Error('GitLab returned an invalid head project endpoint'), { code: 'MALFORMED_PROVIDER_RESPONSE' });
      }
      return Object.freeze({
        context: trusted,
        sourceProject: { id: headProject.id, owner: headProject.owner, name: headProject.name },
        targetProject: { id: request.project.id, owner: request.project.owner, name: request.project.name },
        classification: headProject.id === request.project.id ? 'same-repository' : 'contributor-fork',
        headSha: expectedHeadSha.toLowerCase(),
        headRef: `refs/heads/${request.head}`,
        endpoint,
        requestedRemoteName,
      });
    },
  };
}
