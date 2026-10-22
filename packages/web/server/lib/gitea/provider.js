import { isString } from '../shared/guards.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';
import { ownedOriginInstance } from '../source-control/origin-instance.js';
import { classifyGiteaFailure, createGiteaClient } from './client.js';
import { giteaDescriptor } from './descriptor.js';
import { createGiteaResourceService } from './resources.js';
import { probeGiteaVersion, verifyGiteaToken } from './verify.js';

/**
 * Gitea as a source-control provider implementation behind the shared route
 * shell (`source-control/provider-routes.js`): personal access tokens only,
 * one account store section (`section('gitea')`) keyed by instance origin,
 * REST v1 through `client.js`. Everything here takes and returns plain JSON.
 */

const UNSUPPORTED_METHOD = Object.freeze({ available: false, reason: 'unsupported' });

const accountView = (origin, account, current, accounts) => ({
  id: account.id,
  credentialId: account.id,
  credentialRevision: account.credentialRevision,
  providerUserId: account.providerUserId,
  providerUserStatus: accounts.some((candidate) => (
    candidate.providerUserId === account.providerUserId && candidate.status === 'valid'
  )) ? 'available' : 'unavailable',
  user: { ...account.user, provider: 'gitea', instance: origin },
  scope: account.scope,
  current,
  source: account.source,
  status: account.status === 'invalid' ? 'invalid' : 'valid',
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

/**
 * Each mutation route's persisted kind (GitLab's names), input normalization
 * with the fields its digest covers, provider call and restart
 * reconciliation. Kinds and digest fields are persisted in
 * `source-control-mutations.json`; changing either turns a retained record's
 * replay into a conflict.
 */
function mutationTable(descriptor) {
  const commentText = (value, required) => {
    if (value === undefined && !required) return undefined;
    if (!isString(value) || !value.trim() || value.length > descriptor.limits.commentMaxLength) {
      throw invalidMutationContext('body is required and must fit a Gitea comment');
    }
    return value;
  };
  const nameList = (value, limit) => {
    if (!Array.isArray(value) || value.length > limit
      || value.some((entry) => !isString(entry) || !entry.trim() || entry.length > 256)) {
      throw invalidMutationContext('labels or reviewers are invalid');
    }
    return [...new Set(value)].sort();
  };
  const mergeMethods = descriptor.capabilities.merge ? descriptor.capabilities.merge.methods : [];
  const requireNumber = (context) => {
    if (!context.target.number) throw invalidMutationContext('target number is required');
  };
  const call = (resolved, extra = {}) => ({
    providerTarget: resolved.providerTarget, expectedTarget: resolved.target, ...extra,
  });

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
      perform: (service, normalized, resolved) => service.createChangeRequest(call(resolved, {
        title: normalized.title, body: normalized.body, draft: normalized.draft,
        head: resolved.target.head, base: resolved.target.base,
      })),
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
      perform: (service, normalized, resolved) => service.updateChangeRequest(call(resolved, { title: normalized.title, body: normalized.body })),
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
      perform: (service, normalized, resolved) => service.mergeChangeRequest(call(resolved, { method: normalized.method })),
      reconcile: (service, resolved) => service.reconcileChangeRequestMutation(resolved.providerTarget, 'change-request-merge'),
    },
    '/pr/ready': {
      kind: 'change-request-ready',
      normalize: (_input, context) => {
        requireNumber(context);
        return { digest: {} };
      },
      perform: (service, _normalized, resolved) => service.readyChangeRequest(call(resolved)),
      reconcile: (service, resolved) => service.reconcileChangeRequestMutation(resolved.providerTarget, 'change-request-ready'),
    },
    '/pr/review': {
      kind: 'change-request-review',
      normalize: (input, context) => {
        // A verdict names the commit it is for; without one it would land on whatever was pushed last.
        if (!context.target.number || !context.target.headSha || !['approve', 'request-changes'].includes(input.verdict)) {
          throw invalidMutationContext('target number, head SHA and review verdict are required');
        }
        const text = commentText(input.body, false);
        return { verdict: input.verdict, body: text, digest: { verdict: input.verdict, body: text ?? null } };
      },
      perform: (service, normalized, resolved) => service.reviewChangeRequest(call(resolved, { verdict: normalized.verdict, body: normalized.body })),
      reconcile: unknownOutcome,
    },
  };
  for (const [route, kind] of [['/pr/comment', 'change-request-comment'], ['/issues/comment', 'issue-comment']]) {
    entries[route] = {
      kind,
      normalize: (input, context) => {
        requireNumber(context);
        const text = commentText(input.body, true);
        return { body: text, digest: { body: text } };
      },
      perform: (service, normalized, resolved) => service.comment(call(resolved, { body: normalized.body })),
      reconcile: unknownOutcome,
    };
  }
  // Close or reopen: `state` is what the item should become.
  for (const [route, kind] of [['/pr/state', 'change-request-state'], ['/issues/state', 'issue-state']]) {
    entries[route] = {
      kind,
      normalize: (input, context) => {
        if (!context.target.number || !['open', 'closed'].includes(input.state)) {
          throw invalidMutationContext('target number and state are required');
        }
        return { state: input.state, digest: { state: input.state } };
      },
      perform: (service, normalized, resolved) => service.setState(call(resolved, { state: normalized.state, kind })),
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
        requireNumber(context);
        const names = nameList(input[field], field === 'labels' ? descriptor.limits.labelsMax : descriptor.limits.reviewersMax);
        if (field === 'reviewers' && names.some((id) => !descriptor.limits.reviewerId.test(id))) {
          throw invalidMutationContext('reviewers are invalid');
        }
        return { names, digest: { [field]: names } };
      },
      perform: (service, normalized, resolved) => service[method](call(resolved, { [field]: normalized.names })),
      reconcile: (service, resolved, normalized) => service.reconcileSetMutation(resolved.providerTarget, kind, normalized.names),
    };
  }
  return entries;
}

/**
 * `store` is Gitea's origin-keyed section of the source-control auth store;
 * `events` receives account lifecycle reports. The rest are test seams.
 */
export function createProvider({
  descriptor = giteaDescriptor,
  authStore,
  store = authStore?.section instanceof Function ? authStore.section(giteaDescriptor.id) : authStore,
  events,
  fetch: fetchImpl = (input, init) => fetch(input, init),
  timeoutMs = 15_000,
  createClient = createGiteaClient,
  createResourceService = createGiteaResourceService,
  resolveRepos,
}) {
  const verify = (origin, token) => verifyGiteaToken({ origin, token, fetch: fetchImpl, timeoutMs });
  const probe = (origin) => probeGiteaVersion({ origin, fetch: fetchImpl, timeoutMs });
  const identityFor = (origin, accountId) => ({ provider: descriptor.id, instance: origin, accountId });

  const announceConnectedAccount = async (origin, credential, user) => {
    const account = identityFor(origin, credential.credentialId);
    // Connecting the same user again supersedes the earlier credential;
    // whatever followed it keeps working as the same account.
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

  /** A personal access token cannot be renewed: a refused one is written off. Bindings move first. */
  const invalidateAccount = async ({ instance: origin, accountId }) => {
    await events.invalidated(identityFor(origin, accountId));
    await store.markAccountInvalid(origin, accountId, 'unauthorized');
    return false;
  };

  const buildStatus = async (origin) => {
    const instance = await store.readInstance(origin);
    const active = instance.accounts.find((account) => account.id === instance.activeAccountId && account.status !== 'invalid') ?? null;
    const accounts = instance.accounts.map((account) => accountView(origin, account, Boolean(active && account.id === active.id), instance.accounts));
    if (!active) return { provider: descriptor.id, instance: origin, status: 'disconnected', connected: false, accounts };
    try {
      const user = await verify(origin, active.token);
      return {
        provider: descriptor.id, instance: origin, status: 'connected', connected: true,
        user: { ...user, provider: descriptor.id, instance: origin }, scope: active.scope, accounts,
      };
    } catch (error) {
      if (error?.kind === 'invalid-token') {
        await invalidateAccount({ instance: origin, accountId: active.id });
        return buildStatus(origin);
      }
      return { provider: descriptor.id, instance: origin, status: classifyGiteaFailure(error), connected: false, message: error?.message, accounts };
    }
  };

  // The token behind each session the shell holds stays in this module, never
  // in the session object, so serializing a session can never leak it.
  const tokens = new WeakMap();

  /** The exact account asked for, else the instance's current one. */
  const resolveAccount = async ({ instance: origin, accountId: requestedAccountId = '' }) => {
    let account;
    if (requestedAccountId) {
      account = await store.readAccount(origin, requestedAccountId);
    } else {
      const instance = await store.readInstance(origin);
      account = instance.accounts.find((candidate) => candidate.id === instance.activeAccountId && candidate.status !== 'invalid') ?? null;
    }
    if (!account?.token) {
      const error = new Error('Gitea is not connected');
      error.status = 401;
      error.sourceControlAccountUnavailable = true;
      if (requestedAccountId) error.sourceControlIdentity = identityFor(origin, requestedAccountId);
      throw error;
    }
    const session = Object.freeze({
      instance: origin,
      accountId: account.id,
      credentialRevision: account.credentialRevision,
      providerUserId: account.providerUserId,
      secretKind: 'pat',
      persisted: true,
    });
    tokens.set(session, account.token);
    return session;
  };

  // One resource service per session, so a request's reads, mutation target
  // and provider call share one client. Errors carry the acting account for
  // the shell's 401 handling.
  const services = new WeakMap();
  const serviceFor = (session) => {
    const cached = services.get(session);
    if (cached) return cached;
    const options = { origin: session.instance, client: createClient({ origin: session.instance, token: tokens.get(session), fetch: fetchImpl, timeoutMs }) };
    if (resolveRepos) options.resolveRepos = resolveRepos;
    const service = createResourceService(options);
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
    classifyFailure: classifyGiteaFailure,
    auth: Object.freeze({
      /** Whether the instance answers as a supported Gitea; tokens are the only way in. */
      capabilities: async ({ instance: origin }) => {
        const { supported } = await probe(origin);
        return {
          authentication: supported,
          authenticationMethods: {
            device: UNSUPPORTED_METHOD,
            pat: supported ? { available: true } : UNSUPPORTED_METHOD,
            cli: UNSUPPORTED_METHOD,
          },
        };
      },
      status: ({ instance }) => buildStatus(instance),
      accounts: async ({ instance: origin }) => {
        const instance = await store.readInstance(origin);
        return instance.accounts.map((account) => accountView(origin, account, account.id === instance.activeAccountId, instance.accounts));
      },
      connectToken: async ({ instance: origin, token }) => {
        const user = await verify(origin, token);
        const { version, supported } = await probe(origin);
        if (!supported) {
          throw responseError(400, { error: `Gitea ${version} is older than OpenChamber supports (1.21)`, code: 'UNSUPPORTED_PROVIDER_VERSION' });
        }
        const credential = await store.setAccount(origin, { token, user, source: 'pat' });
        await announceConnectedAccount(origin, credential, user);
        return { connected: true, user };
      },
      activate: async ({ instance: origin, accountId }) => {
        if (!accountId || !(await store.activate(origin, accountId))) throw responseError(404, { error: 'Gitea account not found' });
        return buildStatus(origin);
      },
      /** Bindings let go of the exact account before it leaves the store. */
      remove: async ({ instance: origin, accountId }) => {
        const instance = await store.readInstance(origin);
        if (!instance.accounts.some((account) => account.id === accountId)) return { removed: false };
        await events.removed(identityFor(origin, accountId));
        return { removed: await store.removeAccount(origin, accountId) };
      },
      resolveAccount,
      invalidateAccount,
      readCurrentAccountId: async ({ instance: origin }) => {
        const instance = await store.readInstance(origin);
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
      /** The known instance a host belongs to; Gitea is never inferred from an unknown host. */
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
      changeRequestStatus: ({ session, directory, branch, remote }) => serviceFor(session).changeRequestStatus(directory, branch, remote),
      listChangeRequests: ({ session, directory, page, query, state, people, remote }) => serviceFor(session)
        .listChangeRequests(directory, { page, query, state, people, remote }),
      changeRequestContext: ({ session, directory, number, project, remote, includeDiff, includeCIDetails, includeTimeline }) => serviceFor(session)
        .changeRequestContext(directory, number, { includeDiff, includeCIDetails, includeTimeline, project, remote }),
      listIssues: ({ session, directory, page, query, state, people, remote }) => serviceFor(session)
        .listIssues(directory, { page, query, state, people, remote }),
      getIssue: ({ session, directory, number, project, remote }) => serviceFor(session).getIssue(directory, number, project, remote),
      issueComments: ({ session, directory, number, project, remote }) => serviceFor(session).issueComments(directory, number, project, remote),
      projectUpstream: ({ session, directory, remote }) => serviceFor(session).projectUpstream(directory, remote),
      projectBranches: ({ session, directory, project, remote }) => serviceFor(session).projectBranches(directory, project, remote),
      listLabels: ({ session, directory, project, remote }) => serviceFor(session).listLabels(directory, project, remote),
      listReviewerCandidates: ({ session, directory, project, remote }) => serviceFor(session).listReviewerCandidates(directory, project, remote),
      readChangeRequestPatch: ({ session, directory, number, sourceRepo, remote }) => serviceFor(session)
        .changeRequestPatch(directory, number, { project: projectSelector(sourceRepo), remote }),
      readChangeRequestFile: ({ session, directory, number, sourceRepo, remote, path, previousPath, status }) => serviceFor(session)
        .changeRequestFileContents(directory, number, { project: projectSelector(sourceRepo), remote, path, previousPath, status }),
      liveSummaries: ({ session, refs, issueRefs }) => serviceFor(session).liveSummaries({ refs, issueRefs }),
      /** A pull request's head on the context's primary repository network, for a worktree made from it. */
      readChangeRequestHead: async ({ session, directory, remote, number }) => {
        const { request, headProject } = await serviceFor(session).findChangeRequest(directory, number, null, remote);
        const headSha = String(request.headSha || '').toLowerCase();
        if (!/^[0-9a-f]{40}$/.test(headSha)) {
          throw Object.assign(new Error('Gitea returned an invalid pull request head'), { code: 'MALFORMED_PROVIDER_RESPONSE' });
        }
        return {
          project: { id: request.project.id, owner: request.project.owner, name: request.project.name },
          headSha,
          headBranch: request.head,
          headOwner: (headProject ?? request.project).owner,
        };
      },
      resolveChangeRequestSource: async ({ session, context, project, number, expectedHeadSha, requestedRemoteName }) => {
        const { request, headProject: fork } = await serviceFor(session)
          .findChangeRequest(context.directory, number, { owner: project.owner, name: project.name }, context.primaryRemote);
        if (request.project.id !== project.id || String(request.headSha || '').toLowerCase() !== expectedHeadSha.toLowerCase()) {
          throw Object.assign(new Error('Change request head changed'), { code: 'SOURCE_CONTROL_CHANGE_REQUEST_STALE', status: 409 });
        }
        const headProject = fork ?? request.project;
        const endpoint = headProject.cloneUrl;
        let parsed = null;
        try { parsed = new URL(endpoint); } catch { parsed = null; }
        if (!parsed || parsed.protocol !== 'https:' || parsed.origin !== new URL(context.instance).origin
          || decodeURIComponent(parsed.pathname).replace(/^\//, '').replace(/\.git$/, '') !== `${headProject.owner}/${headProject.name}`) {
          throw Object.assign(new Error('Gitea returned an invalid head repository endpoint'), { code: 'MALFORMED_PROVIDER_RESPONSE' });
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
      /** The persisted kind, normalized input and digest; the digest covers the exact credential and resolved target. */
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
       * The provider coordinates and durable target. A replay rebuilds them
       * from the stored target, except create, which is resolved again.
       */
      resolveTarget: ({ session, context, kind, input, replayOf }) => {
        const service = serviceFor(session);
        if (kind === 'change-request-create') return service.resolveCreateMutation(context, context.target, input);
        if (replayOf) {
          const { project, number } = replayOf.target;
          return { providerTarget: { repoId: Number(project.id), owner: project.owner, name: project.name, number }, target: replayOf.target };
        }
        if (kind.startsWith('issue-')) return service.resolveIssueMutation(context, context.target);
        return service.resolveChangeRequestMutation(context, context.target);
      },
      perform: ({ session, route, input, resolved }) => mutationFor(route).perform(serviceFor(session), input, resolved),
      reconcile: ({ session, route, input, resolved }) => mutationFor(route).reconcile(serviceFor(session), resolved, input),
    }),
  });
}
