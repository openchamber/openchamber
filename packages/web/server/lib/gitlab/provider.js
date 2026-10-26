import { exchangeGitLabDeviceCode, refreshGitLabAccessToken, resolveGitLabClientId, probeGitLabAuth, startGitLabDeviceFlow } from './device-flow.js';
import { getGlabToken } from './glab-credential.js';
import { classifyGitLabFailure } from './network.js';
import { createGitLabClient, createGitLabDownloader } from './client.js';
import { createGitLabResourceService } from './resources.js';
import { verifyGitLabToken } from './verify.js';
import { isString } from './validation.js';
import { gitlabDescriptor } from './descriptor.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';
import { ownedOriginInstance } from '../source-control/origin-instance.js';

/**
 * GitLab as a source-control provider implementation: authentication,
 * resources and mutations behind the shared route shell
 * (`source-control/provider-routes.js`). Everything here takes and returns
 * plain JSON; the shell owns HTTP, read-context validation, the status cache
 * and the durable mutation executor.
 */

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

/** An error the shell answers with exactly this status and body. */
const responseError = (status, body) => Object.assign(new Error(body.error), { sourceControlResponse: { status, body } });

const invalidMutationContext = (message) => Object.assign(new Error(message), {
  code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT',
  status: 400,
});

const requestText = (value) => (isString(value) ? value.trim() : '');

// A comment or a review leaves nothing that tells a lost write from one never
// sent short of guessing from its text, so the outcome stays unknown.
const unknownOutcome = () => ({ state: 'outcome-unknown' });

// A discussion id (a SHA on GitLab); the request path keeps it on the target merge request.
const threadIdOf = (value) => {
  if (!isString(value) || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw invalidMutationContext('threadId is invalid');
  return value;
};

/**
 * Each mutation route's persisted kind, input normalization (with the fields
 * its digest covers), provider call and restart reconciliation. Kind names and
 * digest fields are persisted in `source-control-mutations.json` and must stay
 * byte-identical, or a retained `running` record would replay as a conflict.
 */
function mutationTable(descriptor) {
  const noteMaxLength = descriptor.limits.commentMaxLength;
  const noteText = (value, required) => {
    if (value === undefined && !required) return undefined;
    if (!isString(value) || !value.trim() || value.length > noteMaxLength) {
      throw invalidMutationContext('body is required and must fit a GitLab note');
    }
    return value;
  };
  // Labels and reviewers as one whole set, so a repeat asks for the same result.
  const nameList = (value, limit) => {
    if (!Array.isArray(value) || value.length > limit
      || value.some((entry) => !isString(entry) || !entry.trim() || entry.length > 256)) {
      throw invalidMutationContext('labels or reviewers are invalid');
    }
    return [...new Set(value)].sort();
  };
  const mergeMethods = descriptor.capabilities.merge ? descriptor.capabilities.merge.methods : [];
  const entries = {
    '/pr/create': {
      kind: 'change-request-create',
      normalize: (input, context) => {
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
      },
      perform: (service, normalized, resolved) => service.createChangeRequest({
        ...normalized,
        head: resolved.target.head,
        base: resolved.target.base,
        providerTarget: resolved.providerTarget,
        targetProject: resolved.target.project,
        expectedTarget: resolved.target,
      }),
      reconcile: (service, resolved) => service.reconcileCreateMutation(resolved.providerTarget, resolved.target),
    },
    '/pr/update': {
      kind: 'change-request-update',
      normalize: (input, context) => {
        const title = requestText(input.title);
        if (!title || !context.target.number) throw invalidMutationContext('title and target number are required');
        const normalized = { title };
        if (isString(input.body)) normalized.body = input.body;
        normalized.digest = { title, body: normalized.body ?? null };
        return normalized;
      },
      perform: (service, normalized, resolved) => service.updateChangeRequest({
        ...normalized,
        providerTarget: resolved.providerTarget,
        targetProject: resolved.target.project,
        expectedTarget: resolved.target,
      }),
      reconcile: (service, resolved) => service.reconcileChangeRequestMutation(resolved.providerTarget, 'change-request-update'),
    },
    '/pr/merge': {
      kind: 'change-request-merge',
      normalize: (input, context) => {
        if (!context.target.number || !mergeMethods.includes(input.method)) {
          throw invalidMutationContext('target number and merge method are required');
        }
        return { method: input.method, digest: { method: input.method } };
      },
      perform: async (service, normalized, resolved) => {
        const result = await service.mergeChangeRequest({
          method: normalized.method,
          providerTarget: resolved.providerTarget,
          targetProject: resolved.target.project,
          expectedTarget: resolved.target,
        });
        return { merged: result.merged };
      },
      reconcile: (service, resolved) => service.reconcileChangeRequestMutation(resolved.providerTarget, 'change-request-merge'),
    },
    '/pr/ready': {
      kind: 'change-request-ready',
      normalize: (_input, context) => {
        if (!context.target.number) throw invalidMutationContext('target number is required');
        return { digest: {} };
      },
      perform: (service, _normalized, resolved) => service.readyChangeRequest({
        providerTarget: resolved.providerTarget,
        targetProject: resolved.target.project,
        expectedTarget: resolved.target,
      }),
      reconcile: (service, resolved) => service.reconcileChangeRequestMutation(resolved.providerTarget, 'change-request-ready'),
    },
    '/pr/comment': {
      kind: 'change-request-comment',
      normalize: (input, context) => {
        if (!context.target.number) throw invalidMutationContext('target number is required');
        const text = noteText(input.body, true);
        return { body: text, digest: { body: text } };
      },
      perform: async (service, normalized, resolved) => {
        await service.commentChangeRequest({ providerTarget: resolved.providerTarget, body: normalized.body });
        return {};
      },
      reconcile: unknownOutcome,
    },
    '/pr/thread/start': {
      kind: 'change-request-thread-start',
      normalize: (input, context) => {
        if (!context.target.number) throw invalidMutationContext('target number is required');
        const text = noteText(input.body, true);
        return { body: text, digest: { body: text } };
      },
      perform: (service, normalized, resolved) => service.startThread({ providerTarget: resolved.providerTarget, body: normalized.body }),
      reconcile: unknownOutcome,
    },
    '/pr/thread/reply': {
      kind: 'change-request-thread-reply',
      normalize: (input, context) => {
        if (!context.target.number) throw invalidMutationContext('target number is required');
        const threadId = threadIdOf(input.threadId);
        const text = noteText(input.body, true);
        return { threadId, body: text, digest: { threadId, body: text } };
      },
      perform: (service, normalized, resolved) => service.replyToThread({
        providerTarget: resolved.providerTarget, threadId: normalized.threadId, body: normalized.body,
      }),
      reconcile: unknownOutcome,
    },
    '/pr/thread/resolve': {
      kind: 'change-request-thread-resolve',
      normalize: (input, context) => {
        if (!context.target.number || ![true, false].includes(input.resolved)) {
          throw invalidMutationContext('target number and resolved are required');
        }
        const threadId = threadIdOf(input.threadId);
        return { threadId, resolved: input.resolved, digest: { threadId, resolved: input.resolved } };
      },
      perform: (service, normalized, resolved) => service.resolveThread({
        providerTarget: resolved.providerTarget, threadId: normalized.threadId, resolved: normalized.resolved,
      }),
      reconcile: (service, resolved, normalized) => service.reconcileThreadResolve(resolved.providerTarget, normalized.threadId, normalized.resolved),
    },
    '/issues/comment': {
      kind: 'issue-comment',
      normalize: (input, context) => {
        if (!context.target.number) throw invalidMutationContext('target number is required');
        const text = noteText(input.body, true);
        return { body: text, digest: { body: text } };
      },
      perform: async (service, normalized, resolved) => {
        await service.commentIssue({ providerTarget: resolved.providerTarget, body: normalized.body });
        return {};
      },
      reconcile: unknownOutcome,
    },
    '/pr/review': {
      kind: 'change-request-review',
      normalize: (input, context) => {
        // A verdict names the commit it is for; without one it would land on whatever was pushed last.
        if (!context.target.number || !context.target.headSha || !['approve', 'request-changes'].includes(input.verdict)) {
          throw invalidMutationContext('target number, head SHA and review verdict are required');
        }
        const text = noteText(input.body, false);
        return { verdict: input.verdict, body: text, digest: { verdict: input.verdict, body: text ?? null } };
      },
      perform: (service, normalized, resolved) => service.reviewChangeRequest({
        verdict: normalized.verdict,
        body: normalized.body,
        providerTarget: resolved.providerTarget,
        targetProject: resolved.target.project,
        expectedTarget: resolved.target,
      }),
      reconcile: unknownOutcome,
    },
  };
  // Close or reopen: `state` is what the item should become.
  for (const [route, kind, method] of [
    ['/pr/state', 'change-request-state', 'setChangeRequestState'],
    ['/issues/state', 'issue-state', 'setIssueState'],
  ]) {
    entries[route] = {
      kind,
      normalize: (input, context) => {
        if (!context.target.number || !['open', 'closed'].includes(input.state)) {
          throw invalidMutationContext('target number and state are required');
        }
        return { state: input.state, digest: { state: input.state } };
      },
      perform: (service, normalized, resolved) => service[method]({
        state: normalized.state,
        providerTarget: resolved.providerTarget,
        targetProject: resolved.target.project,
        expectedTarget: resolved.target,
      }),
      reconcile: (service, resolved, normalized) => service.reconcileStateMutation(resolved.providerTarget, kind, normalized.state),
    };
  }
  for (const [route, kind, field, method] of [
    ['/pr/labels', 'change-request-labels', 'labels', 'setLabels'],
    ['/issues/labels', 'issue-labels', 'labels', 'setLabels'],
    ['/pr/reviewers', 'change-request-reviewers', 'reviewers', 'setReviewers'],
  ]) {
    entries[route] = {
      kind,
      normalize: (input, context) => {
        if (!context.target.number) throw invalidMutationContext('target number is required');
        const names = nameList(input[field], field === 'labels' ? descriptor.limits.labelsMax : descriptor.limits.reviewersMax);
        if (field === 'reviewers' && names.some((id) => !descriptor.limits.reviewerId.test(id))) {
          throw invalidMutationContext('reviewers are invalid');
        }
        return { names, digest: { [field]: names } };
      },
      perform: (service, normalized, resolved) => service[method]({
        kind,
        [field]: normalized.names,
        providerTarget: resolved.providerTarget,
        targetProject: resolved.target.project,
        expectedTarget: resolved.target,
      }),
      reconcile: (service, resolved, normalized) => service.reconcileSetMutation(resolved.providerTarget, kind, normalized.names),
    };
  }
  return entries;
}

/**
 * `store` is GitLab's section of the source-control auth store (origin-keyed
 * accounts, the glab switch, OAuth renewal). `events` receives account
 * lifecycle reports. The remaining options are test seams and timeouts.
 */
export function createProvider({
  descriptor = gitlabDescriptor,
  authStore,
  store = authStore?.section instanceof Function ? authStore.section('gitlab') : authStore,
  events,
  readSettings = async () => ({}),
  fetch: fetchImpl = fetch,
  timeoutMs = 10_000,
  execFile,
  cliTimeoutMs,
  createClient = createGitLabClient,
  createDownloader = createGitLabDownloader,
  createResourceService = createGitLabResourceService,
  resolveProjects,
}) {
  const getClientId = (origin) => resolveGitLabClientId(origin, readSettings);
  const glabToken = (origin) => getGlabToken(origin, { execFile, timeoutMs: cliTimeoutMs });
  const verify = (origin, token) => verifyGitLabToken({ origin, token, fetch: fetchImpl, timeoutMs });
  const identityFor = (origin, accountId) => ({ provider: descriptor.id, instance: origin, accountId });

  /**
   * A connected account is a complete identity waiting to be written: who it
   * is, what it authenticates with, and how it signs are all known here.
   */
  const announceConnectedAccount = async (origin, credential, user) => {
    if (!credential?.credentialId) return;
    const account = identityFor(origin, credential.credentialId);
    // Signing in again renews a credential rather than replacing it, so the
    // ones this supersedes are named too: whatever followed the old credential
    // is expected to keep working as the same account.
    const instance = await store.readInstance(origin).catch(() => null);
    const superseded = (instance?.accounts ?? []).filter((candidate) =>
      candidate.providerUserId === credential.providerUserId && candidate.id !== credential.credentialId);
    await events.connected({
      account,
      user,
      credential: { credentialRevision: credential.credentialRevision, providerUserId: credential.providerUserId },
      renews: superseded.map((candidate) => ({ ...account, accountId: candidate.id })),
    });
  };

  /**
   * Writes an account off after GitLab refused its token, unless renewing it
   * works. Bindings move first, then the stored account; a CLI login has no
   * stored record and only reports. Returns whether it was renewed.
   */
  const invalidateAccount = async ({ instance: origin, accountId, persisted = true, renew = true }) => {
    if (!persisted) {
      await events.invalidated(identityFor(origin, accountId));
      return false;
    }
    if (renew && await store.renewAccount?.(origin, accountId)) return true;
    await events.invalidated(identityFor(origin, accountId));
    await store.markAccountInvalid(origin, accountId, 'unauthorized');
    return false;
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

  const buildStatus = async (origin, renewed = false) => {
    const instance = await store.readInstance(origin);
    const activeRecord = instance.cliActive ? null : instance.accounts.find((account) => account.id === instance.activeAccountId) ?? null;
    const active = activeRecord?.status === 'invalid' ? null : activeRecord;
    const cli = await getUsableGlab(origin);
    if (instance.cliActive && !cli) {
      await store.setCliActive(origin, false);
      return buildStatus(origin);
    }
    // Like the gh rule: a glab login carries every scope glab was granted, so it
    // is used only after the user switched to it, never as a silent fallback.
    const cliCurrent = Boolean(cli && instance.cliActive);
    const accounts = instance.accounts.map((account) => accountView(
      origin, account, Boolean(active && account.id === active.id && !cliCurrent), instance.accounts,
    ));
    if (cli) accounts.push(cliAccountView(origin, cli.user, cliCurrent));

    if (!active) {
      if (cli && !cliCurrent) {
        return {
          provider: 'gitlab', instance: origin, status: 'disconnected', connected: false, accounts,
          cli: { available: true, disabled: instance.cliDisabled, active: false, user: { ...cli.user, provider: 'gitlab', instance: origin } },
        };
      }
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
        // A renewed token gets one more try; refused again, the account is written off.
        const renewedNow = await invalidateAccount({ instance: origin, accountId: active.id, renew: !renewed });
        return buildStatus(origin, renewedNow);
      }
      return { provider: 'gitlab', instance: origin, status: kind, connected: false, message: error?.message, accounts };
    }
  };

  // The token behind each session the shell holds stays in this module, never
  // in the session object, so serializing a session can never leak it.
  const tokens = new WeakMap();
  const sessionWith = (fields, token) => {
    const session = Object.freeze(fields);
    tokens.set(session, token);
    return session;
  };

  /**
   * The account a request acts as: the exact one asked for (persisted, or the
   * glab login while it is still that user), else the instance's current one.
   */
  const resolveAccount = async ({ instance: origin, accountId: requestedAccountId = '' }) => {
    const instance = await store.readInstance(origin);
    let active = null;
    let token = null;
    let accountId = requestedAccountId;
    let persisted = false;
    let credentialRevision = null;
    let providerUserId = '';
    let secretKind = 'oauth';
    if (requestedAccountId.startsWith(`${origin}#cli:`)) {
      if (!instance.cliDisabled) token = await glabToken(origin);
      if (token) {
        try {
          const user = await verify(origin, token);
          if (requestedAccountId !== `${origin}#cli:${user.id}`) {
            await events.invalidated(identityFor(origin, requestedAccountId));
            token = null;
          } else {
            credentialRevision = 1;
            providerUserId = `${origin}#${user.id}`;
            secretKind = 'cli';
          }
        } catch (error) {
          if (error?.kind === 'invalid-token') await events.invalidated(identityFor(origin, requestedAccountId));
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
      token = active?.token || (instance.cliActive && !instance.cliDisabled ? await glabToken(origin) : null);
      accountId = active?.id ?? '';
      persisted = Boolean(active);
      credentialRevision = active?.credentialRevision ?? null;
      providerUserId = active?.providerUserId ?? '';
      if (!active) secretKind = 'cli';
    }
    if (!token) {
      const error = new Error('GitLab is not connected');
      error.status = 401;
      error.sourceControlAccountUnavailable = true;
      if (requestedAccountId) error.sourceControlIdentity = identityFor(origin, requestedAccountId);
      throw error;
    }
    if (active) secretKind = active.source === 'pat' ? 'pat' : 'oauth';
    return sessionWith({ instance: origin, accountId, credentialRevision, providerUserId, secretKind, persisted }, token);
  };

  // One resource service per session, so a request's reads, mutation target
  // and provider call share one client.
  const services = new WeakMap();
  const serviceFor = (session, { canonicalReads = true } = {}) => {
    const cached = services.get(session);
    if (cached) return cached;
    // Only a stored personal access token goes as PRIVATE-TOKEN. OAuth
    // sign-ins, and the glab login (an OAuth token on gitlab.com, a personal
    // token elsewhere), go as a bearer token, which GitLab accepts for both.
    const tokenType = session.secretKind === 'pat' ? 'token' : 'oauth';
    const token = tokens.get(session);
    const resourceOptions = {
      origin: session.instance,
      client: createClient({ origin: session.instance, token, tokenType }),
      download: createDownloader({ origin: session.instance, token, tokenType }),
      canonicalReads,
    };
    if (resolveProjects) resourceOptions.resolveProjects = resolveProjects;
    const service = createResourceService(resourceOptions);
    const identity = identityFor(session.instance, session.accountId);
    for (const method of Object.keys(service)) {
      const operation = service[method];
      if (!(operation instanceof Function)) continue;
      service[method] = async (...args) => {
        try {
          return await operation(...args);
        } catch (error) {
          error.sourceControlIdentity = identity;
          error.sourceControlPersistedAccount = session.persisted;
          throw error;
        }
      };
    }
    services.set(session, service);
    return service;
  };

  const mutations = mutationTable(descriptor);
  const mutationFor = (route) => {
    const entry = mutations[route];
    if (!entry) throw invalidMutationContext('Source control mutation is unsupported');
    return entry;
  };
  const projectSelector = (sourceRepo) => (sourceRepo ? { owner: sourceRepo.owner, name: sourceRepo.repo } : undefined);

  return Object.freeze({
    descriptor,
    /** A failure kind: `unreachable`, `temporarily-unavailable`, `invalid-token`, `provider-error`, ... */
    classifyFailure: classifyGitLabFailure,
    auth: Object.freeze({
      capabilities: async ({ instance: origin }) => {
        const clientId = await getClientId(origin);
        const probe = await probeGitLabAuth({ origin, clientId, fetch: fetchImpl, timeoutMs, glabAvailable: false });
        const cliAvailable = probe.confirmed && Boolean(await getUsableGlab(origin));
        const cli = cliAvailable ? { available: true } : { available: false, reason: 'cli-unavailable' };
        return {
          authentication: probe.confirmed && (probe.device.available || probe.pat.available || cli.available),
          authenticationMethods: { device: probe.device, pat: probe.pat, cli },
        };
      },
      status: ({ instance }) => buildStatus(instance),
      accounts: async ({ instance: origin }) => {
        const instance = await store.readInstance(origin);
        return instance.accounts.map((account) => accountView(
          origin, account, account.id === instance.activeAccountId && !instance.cliActive, instance.accounts,
        ));
      },
      startDeviceFlow: async ({ instance: origin }) => {
        const clientId = await getClientId(origin);
        if (!clientId) throw responseError(400, { error: 'GitLab OAuth client is not configured', status: 'invalid-client' });
        const payload = await startGitLabDeviceFlow({ origin, clientId, fetch: fetchImpl, timeoutMs });
        const result = {
          userCode: payload.user_code,
          verificationUri: payload.verification_uri,
          expiresIn: payload.expires_in,
          interval: payload.interval,
        };
        if (isString(payload.verification_uri_complete)) result.verificationUriComplete = payload.verification_uri_complete;
        return { flow: { deviceCode: payload.device_code, clientId, expiresIn: payload.expires_in }, result };
      },
      /** `pending` keeps the flow pollable; anything else consumes it. */
      completeDeviceFlow: async ({ instance: origin, deviceCode, clientId }, { consume }) => {
        const result = await exchangeGitLabDeviceCode({ origin, clientId, deviceCode, fetch: fetchImpl, timeoutMs });
        if (result.status === 'authorization_pending' || result.status === 'slow_down') {
          return { pending: true, body: { connected: false, status: result.status } };
        }
        consume();
        if (result.status !== 'connected') return { pending: false, body: { connected: false, status: result.error, error: result.message } };
        const user = await verify(origin, result.accessToken);
        const credential = await store.setAccount(origin, {
          token: result.accessToken, user, source: 'oauth', scope: result.scope,
          refreshToken: result.refreshToken, expiresIn: result.expiresIn,
        });
        await announceConnectedAccount(origin, credential, user);
        return { pending: false, body: { connected: true, user, scope: result.scope } };
      },
      connectToken: async ({ instance: origin, token }) => {
        const user = await verify(origin, token);
        const credential = await store.setAccount(origin, { token, user, source: 'pat' });
        await announceConnectedAccount(origin, credential, user);
        return { connected: true, user };
      },
      activate: async ({ instance: origin, accountId }) => {
        if (accountId.startsWith(`${origin}#cli:`)) {
          const usable = await getUsableGlab(origin);
          if (!usable || accountId !== `${origin}#cli:${usable.user.id}`) throw responseError(404, { error: 'GitLab CLI account not found' });
          await store.setCliActive(origin, true);
          return buildStatus(origin);
        }
        if (!accountId || !(await store.activate(origin, accountId))) throw responseError(404, { error: 'GitLab account not found' });
        return buildStatus(origin);
      },
      setCliDisabled: async ({ instance: origin, disabled }) => {
        const nextDisabled = await store.setCliDisabled(origin, disabled);
        const usable = await getUsableGlab(origin);
        return { available: Boolean(usable), disabled: nextDisabled };
      },
      /** Bindings let go of the exact account before it leaves the store. */
      remove: async ({ instance: origin, accountId }) => {
        const instance = await store.readInstance(origin);
        if (accountId.startsWith(`${origin}#cli:`)) {
          const cli = await getUsableGlab(origin);
          if (!cli || `${origin}#cli:${cli.user.id}` !== accountId) return { removed: false };
          await events.removed(identityFor(origin, accountId));
          return { removed: await store.setCliActive(origin, false) };
        }
        if (!instance.accounts.some((account) => account.id === accountId)) return { removed: false };
        await events.removed(identityFor(origin, accountId));
        return { removed: await store.removeAccount(origin, accountId) };
      },
      resolveAccount,
      invalidateAccount,
      /** Trades a refresh token for a new pair; the auth store calls it before a token lapses. */
      refreshOAuthToken: async ({ instance: origin, refreshToken }) => refreshGitLabAccessToken({
        origin, refreshToken, clientId: await getClientId(origin), fetch: fetchImpl, timeoutMs,
      }),
      /**
       * The account GitLab reads on this instance use when none is named: the
       * glab login while the user has switched to it, else the active account.
       * Null when neither is there.
       */
      readCurrentAccountId: async ({ instance: origin }) => {
        const instance = await store.readInstance(origin);
        // A glab login that stopped working leaves the active account, as the status read does.
        const cli = instance.cliActive ? await getUsableGlab(origin) : null;
        if (cli) return `${origin}#cli:${cli.user.id}`;
        return instance.accounts.find((account) => account.id === instance.activeAccountId && account.status !== 'invalid')?.id ?? null;
      },
      listInstances: async () => (await store.listInstances?.()) ?? [],
      /** Every valid stored account, for identity backfill and binding repair at start. */
      listConnectedAccounts: async () => {
        const connected = [];
        for (const origin of (await store.listInstances?.()) ?? []) {
          for (const account of (await store.listAccounts?.(origin)) ?? []) {
            if (account?.status !== 'valid' || !account.credentialId) continue;
            connected.push({
              account: identityFor(origin, account.credentialId),
              user: account.user,
              credential: { credentialRevision: account.credentialRevision, providerUserId: account.providerUserId },
            });
          }
        }
        return connected;
      },
      /** The known instance a host belongs to; GitLab is never inferred from an unknown host. */
      ownsHost: ownedOriginInstance,
    }),
    transport: Object.freeze({
      readCredential: async ({ instance, credentialId, credentialRevision }) => {
        const account = await store.readAccount(instance, credentialId, credentialRevision);
        if (!account) return null;
        return {
          credentialId: account.credentialId,
          credentialRevision: account.credentialRevision,
          providerUserId: account.providerUserId,
          status: account.status,
          source: account.source,
          user: account.user,
          secret: account.token,
        };
      },
    }),
    resources: Object.freeze({
      changeRequestStatus: ({ session, directory, branch, remote }) => serviceFor(session)
        .changeRequestStatus(directory, branch, remote),
      listChangeRequests: ({ session, directory, page, query, state, people, remote }) => serviceFor(session)
        .listChangeRequests(directory, { page, query, state, people, remote }),
      changeRequestContext: ({ session, directory, number, project, remote, includeDiff, includeCIDetails, includeTimeline }) => serviceFor(session)
        .changeRequestContext(directory, number, {
          includeDiff, includeCIDetails, includeTimeline, project, remote, constrainToPrimary: true,
        }),
      listIssues: ({ session, directory, page, query, state, people, remote }) => serviceFor(session)
        .listIssues(directory, { page, query, state, people, remote }),
      getIssue: ({ session, directory, number, project, remote }) => serviceFor(session).getIssue(directory, number, project, remote),
      issueComments: ({ session, directory, number, project, remote }) => serviceFor(session).issueComments(directory, number, project, remote),
      projectUpstream: ({ session, directory, remote }) => serviceFor(session).projectUpstream(directory, remote),
      projectBranches: ({ session, directory, project, remote }) => serviceFor(session).projectBranches(directory, project, remote),
      listLabels: ({ session, directory, project, remote }) => serviceFor(session).listLabels(directory, project, remote),
      listReviewerCandidates: ({ session, directory, project, remote }) => serviceFor(session).listReviewerCandidates(directory, project, remote),
      /**
       * An attachment's bytes as the fetch Response GitLab answered; the shell
       * checks its type and streams it. The credential goes to the instance
       * only (`createGitLabDownloader`).
       */
      readUpload: ({ session, directory, project, remote, secret, filename, range, signal }) => serviceFor(session)
        .readUpload(directory, project, remote, { secret, filename, range, signal }),
      readChangeRequestPatch: ({ session, directory, number, sourceRepo, remote }) => serviceFor(session)
        .changeRequestPatch(directory, number, { project: projectSelector(sourceRepo), remote }),
      readChangeRequestFile: ({ session, directory, number, sourceRepo, remote, path, previousPath, status }) => serviceFor(session)
        .changeRequestFileContents(directory, number, { project: projectSelector(sourceRepo), remote, path, previousPath, status }),
      /** Live state of known merge requests and issues. */
      liveSummaries: ({ session, refs, issueRefs }) => serviceFor(session, { canonicalReads: false }).liveSummaries({ refs, issueRefs }),
      /** A merge request's head on the context's primary project network, by number, for a worktree made from it. */
      readChangeRequestHead: async ({ session, directory, remote, number }) => {
        const { changeRequest: request } = await serviceFor(session).changeRequestContext(directory, number, {
          remote,
          constrainToPrimary: true,
        });
        const headSha = String(request?.headSha || '').toLowerCase();
        if (!request?.project || !request.head || !/^[0-9a-f]{40}$/.test(headSha)) {
          throw Object.assign(new Error('GitLab returned an invalid merge request head'), { code: 'MALFORMED_PROVIDER_RESPONSE' });
        }
        return {
          project: { id: request.project.id, owner: request.project.owner, name: request.project.name },
          headSha,
          headBranch: request.head,
          headOwner: (request.headProject ?? request.project).owner,
        };
      },
      resolveChangeRequestSource: async ({ session, context, project, number, expectedHeadSha, requestedRemoteName }) => {
        const resolved = await serviceFor(session).changeRequestContext(context.directory, number, {
          project: { owner: project.owner, name: project.name },
          remote: context.primaryRemote,
          constrainToPrimary: true,
        });
        const request = resolved.changeRequest;
        if (!request || request.project?.id !== project.id
          || String(request.headSha || '').toLowerCase() !== expectedHeadSha.toLowerCase()) {
          throw Object.assign(new Error('Change request head changed'), { code: 'SOURCE_CONTROL_CHANGE_REQUEST_STALE', status: 409 });
        }
        const headProject = request.headProject ?? request.project;
        const endpoint = headProject.cloneUrl;
        const origin = new URL(context.instance);
        const parsed = new URL(endpoint);
        // The instance's own origin decides the scheme: HTTPS, or HTTP for an
        // instance on a loopback host, which Git transport also allows.
        if (parsed.origin !== origin.origin
          || decodeURIComponent(parsed.pathname).replace(/^\//, '').replace(/\.git$/, '') !== `${headProject.owner}/${headProject.name}`) {
          throw Object.assign(new Error('GitLab returned an invalid head project endpoint'), { code: 'MALFORMED_PROVIDER_RESPONSE' });
        }
        return Object.freeze({
          context,
          sourceProject: { id: headProject.id, owner: headProject.owner, name: headProject.name },
          targetProject: { id: request.project.id, owner: request.project.owner, name: request.project.name },
          classification: headProject.id === request.project.id ? 'same-repository' : 'contributor-fork',
          headSha: expectedHeadSha.toLowerCase(),
          headRef: `refs/heads/${request.head}`,
          endpoint,
          requestedRemoteName,
        });
      },
    }),
    mutations: Object.freeze({
      routes: Object.freeze(Object.keys(mutations)),
      /**
       * The persisted kind, normalized input and digest for one mutation
       * route. The digest covers the exact credential and resolved target,
       * computed exactly as the GitLab routes always have.
       */
      prepare: ({ route, input, context, actor, credential }) => {
        const entry = mutationFor(route);
        const normalized = entry.normalize(input, context);
        return {
          kind: entry.kind,
          input: normalized,
          digest: (target) => digestMutationInput({ kind: entry.kind, actor, credential, target, ...normalized.digest }),
        };
      },
      /**
       * The provider coordinates and the durable target of a mutation. A replay
       * of a stored record rebuilds them from its target, except create, whose
       * coordinates are resolved again.
       */
      resolveTarget: ({ session, context, kind, input, replayOf }) => {
        const service = serviceFor(session);
        if (kind === 'change-request-create') return service.resolveCreateMutation(context, context.target, input);
        if (replayOf) {
          return {
            providerTarget: { projectId: replayOf.target.project.id, number: replayOf.target.number },
            target: replayOf.target,
          };
        }
        if (kind.startsWith('issue-')) return service.resolveIssueMutation(context, context.target);
        return service.resolveChangeRequestMutation(context, context.target);
      },
      perform: ({ session, route, input, resolved }) => mutationFor(route).perform(serviceFor(session), input, resolved),
      reconcile: ({ session, route, input, resolved }) => mutationFor(route).reconcile(serviceFor(session), resolved, input),
    }),
  });
}
