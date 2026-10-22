import { createPatAccountAuth } from '../source-control/pat-account-auth.js';
import { createStandardMutations } from '../source-control/standard-mutations.js';
import { classifyGiteaFailure, createGiteaClient } from './client.js';
import { giteaDescriptor } from './descriptor.js';
import { createGiteaResourceService } from './resources.js';
import { probeGiteaVersion, verifyGiteaToken } from './verify.js';

/**
 * Gitea as a source-control provider implementation behind the shared route
 * shell (`source-control/provider-routes.js`): personal access tokens only,
 * one account store section (`section('gitea')`) keyed by instance origin
 * (`source-control/pat-account-auth.js`), REST v1 through `client.js`, the
 * standard mutation kinds and digests (`source-control/standard-mutations.js`).
 * Everything here takes and returns plain JSON.
 */

// A comment or a review leaves nothing that tells a lost write from one never
// sent short of guessing from its text, so the outcome stays unknown.
const unknownOutcome = () => ({ state: 'outcome-unknown' });

/**
 * The standard table on top, plus what Gitea refuses that the standard table
 * accepts: a request for changes without a body (422 on 1.21 and 1.27). The
 * standard normalization already refused a blank or oversized body, so a
 * missing one is all that is left; the digest is unchanged.
 */
function giteaPrepare(standardMutations) {
  return (request) => {
    const prepared = standardMutations.prepare(request);
    if (prepared.kind === 'change-request-review' && prepared.input.verdict === 'request-changes' && prepared.input.body === undefined) {
      throw Object.assign(new Error('body is required and must fit a Gitea comment'), {
        code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT',
        status: 400,
      });
    }
    return prepared;
  };
}

/**
 * Each standard mutation route's Gitea call and restart reconciliation. The
 * kind, normalization and digest come from the standard table; `normalized`
 * is its output.
 */
function mutationOperations() {
  const call = (resolved, extra = {}) => ({
    providerTarget: resolved.providerTarget, expectedTarget: resolved.target, ...extra,
  });

  const operations = {
    '/pr/create': {
      perform: (service, normalized, resolved) => service.createChangeRequest(call(resolved, {
        title: normalized.title, body: normalized.body, draft: normalized.draft,
        head: resolved.target.head, base: resolved.target.base,
      })),
      reconcile: (service, resolved) => service.reconcileCreateMutation(resolved.providerTarget, resolved.target),
    },
    '/pr/update': {
      perform: (service, normalized, resolved) => service.updateChangeRequest(call(resolved, { title: normalized.title, body: normalized.body })),
      reconcile: (service, resolved) => service.reconcileChangeRequestMutation(resolved.providerTarget, 'change-request-update'),
    },
    '/pr/merge': {
      perform: (service, normalized, resolved) => service.mergeChangeRequest(call(resolved, { method: normalized.method })),
      reconcile: (service, resolved) => service.reconcileChangeRequestMutation(resolved.providerTarget, 'change-request-merge'),
    },
    '/pr/ready': {
      perform: (service, _normalized, resolved) => service.readyChangeRequest(call(resolved)),
      reconcile: (service, resolved) => service.reconcileChangeRequestMutation(resolved.providerTarget, 'change-request-ready'),
    },
    '/pr/review': {
      perform: (service, normalized, resolved) => service.reviewChangeRequest(call(resolved, { verdict: normalized.verdict, body: normalized.body })),
      reconcile: unknownOutcome,
    },
  };
  for (const route of ['/pr/comment', '/issues/comment']) {
    operations[route] = {
      perform: (service, normalized, resolved) => service.comment(call(resolved, { body: normalized.body })),
      reconcile: unknownOutcome,
    };
  }
  for (const [route, kind] of [['/pr/state', 'change-request-state'], ['/issues/state', 'issue-state']]) {
    operations[route] = {
      perform: (service, normalized, resolved) => service.setState(call(resolved, { state: normalized.state, kind })),
      reconcile: (service, resolved, normalized) => service.reconcileStateMutation(resolved.providerTarget, kind, normalized.state),
    };
  }
  for (const [route, kind, field, method] of [
    ['/pr/labels', 'change-request-labels', 'labels', 'setLabels'],
    ['/issues/labels', 'issue-labels', 'labels', 'setLabels'],
    ['/pr/reviewers', 'change-request-reviewers', 'reviewers', 'setReviewers'],
  ]) {
    operations[route] = {
      perform: (service, normalized, resolved) => service[method](call(resolved, { [field]: normalized.names })),
      reconcile: (service, resolved, normalized) => service.reconcileSetMutation(resolved.providerTarget, kind, normalized.names),
    };
  }
  return operations;
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
  const probe = async (origin) => {
    const { version, supported } = await probeGiteaVersion({ origin, fetch: fetchImpl, timeoutMs });
    return supported ? { version, supported } : { version, supported, message: `Gitea ${version} is older than OpenChamber supports (1.21)` };
  };
  const identityFor = (origin, accountId) => ({ provider: descriptor.id, instance: origin, accountId });
  const accounts = createPatAccountAuth({ descriptor, store, events, verify, probe, classifyFailure: classifyGiteaFailure });

  // One resource service per session, so a request's reads, mutation target
  // and provider call share one client. Errors carry the acting account for
  // the shell's 401 handling.
  const services = new WeakMap();
  const serviceFor = (session) => {
    const cached = services.get(session);
    if (cached) return cached;
    const options = { origin: session.instance, client: createClient({ origin: session.instance, token: accounts.tokenFor(session), fetch: fetchImpl, timeoutMs }) };
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

  const standardMutations = createStandardMutations(descriptor);
  const operations = mutationOperations();

  const projectSelector = (sourceRepo) => (sourceRepo ? { owner: sourceRepo.owner, name: sourceRepo.repo } : undefined);

  return Object.freeze({
    descriptor,
    classifyFailure: classifyGiteaFailure,
    auth: accounts.auth,
    transport: Object.freeze({ readCredential: accounts.readCredential }),
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
      routes: standardMutations.routes,
      prepare: giteaPrepare(standardMutations),
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
      perform: ({ session, route, input, resolved }) => operations[route].perform(serviceFor(session), input, resolved),
      reconcile: ({ session, route, input, resolved }) => operations[route].reconcile(serviceFor(session), resolved, input),
    }),
  });
}
