import { createPatAccountAuth } from '../source-control/pat-account-auth.js';
import { joinProjectPath } from '../source-control/project-path.js';
import { createStandardMutations } from '../source-control/standard-mutations.js';
import { classifyGerritFailure, createGerritClient } from './client.js';
import { gerritDescriptor } from './descriptor.js';
import { createGerritResourceService } from './resources.js';
import { probeGerritVersion, verifyGerritCredentials } from './verify.js';


const unknownOutcome = () => ({ state: 'outcome-unknown' });

const invalidMutationContext = (message) => Object.assign(new Error(message), {
  code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT',
  status: 400,
});

function mutationOperations() {
  const call = (resolved, extra = {}) => ({ providerTarget: resolved.providerTarget, expectedTarget: resolved.target, ...extra });
  return {
    '/pr/merge': {
      perform: (service, _normalized, resolved) => service.submit(call(resolved)),
      reconcile: (service, resolved) => service.reconcileChangeRequestMutation(resolved.providerTarget, 'change-request-merge'),
    },
    '/pr/ready': {
      perform: (service, _normalized, resolved) => service.ready(call(resolved)),
      reconcile: (service, resolved) => service.reconcileChangeRequestMutation(resolved.providerTarget, 'change-request-ready'),
    },
    '/pr/draft': {
      perform: (service, _normalized, resolved) => service.draft(call(resolved)),
      reconcile: (service, resolved) => service.reconcileChangeRequestMutation(resolved.providerTarget, 'change-request-draft'),
    },
    '/pr/review': {
      perform: (service, normalized, resolved) => service.vote(call(resolved, { votes: normalized.votes, body: normalized.body })),
      reconcile: unknownOutcome,
    },
    '/pr/review/comment': {
      perform: (service, normalized, resolved) => service.addReviewComment(call(resolved, { position: normalized.position, body: normalized.body })),
      reconcile: unknownOutcome,
    },
    '/pr/review/comment/update': {
      perform: (service, normalized, resolved) => service.updateReviewComment(call(resolved, { commentId: normalized.commentId, body: normalized.body })),
      reconcile: unknownOutcome,
    },
    '/pr/review/comment/delete': {
      perform: (service, normalized, resolved) => service.deleteReviewComment(call(resolved, { commentId: normalized.commentId })),
      reconcile: unknownOutcome,
    },
    '/pr/review/discard': {
      perform: (service, _normalized, resolved) => service.discardReview(call(resolved)),
      reconcile: unknownOutcome,
    },
    '/pr/comment': {
      perform: (service, normalized, resolved) => service.comment(call(resolved, { body: normalized.body })),
      reconcile: unknownOutcome,
    },
    '/pr/state': {
      perform: (service, normalized, resolved) => service.setState(call(resolved, { state: normalized.state })),
      reconcile: (service, resolved, normalized) => service.reconcileStateMutation(resolved.providerTarget, normalized.state),
    },
    '/pr/reviewers': {
      perform: (service, normalized, resolved) => service.setReviewers(call(resolved, { reviewers: normalized.names })),
      reconcile: (service, resolved, normalized) => service.reconcileReviewers(resolved.providerTarget, normalized.names),
    },
  };
}

export function createProvider({
  descriptor = gerritDescriptor,
  authStore,
  store = authStore?.section instanceof Function ? authStore.section(gerritDescriptor.id) : authStore,
  events,
  fetch: fetchImpl = (input, init) => fetch(input, init),
  timeoutMs = 15_000,
  createClient = createGerritClient,
  createResourceService = createGerritResourceService,
  resolveProjects,
  readLocalRevision,
  readUpstreamBranch,
}) {
  const verify = (origin, password, { username } = {}) => verifyGerritCredentials({ origin, login: username, password, fetch: fetchImpl, timeoutMs });
  const probe = async (origin, password, { username } = {}) => {
    const { version, supported } = await probeGerritVersion({ origin, login: username, password, fetch: fetchImpl, timeoutMs });
    return supported ? { version, supported } : { version, supported, message: `Gerrit ${version} is older than OpenChamber supports (3.8)` };
  };
  const identityFor = (origin, accountId) => ({ provider: descriptor.id, instance: origin, accountId });
  const accounts = createPatAccountAuth({ descriptor, store, events, verify, probe, classifyFailure: classifyGerritFailure });

  const services = new WeakMap();
  const serviceFor = (session) => {
    const cached = services.get(session);
    if (cached) return cached;
    const client = createClient({
      origin: session.instance, login: accounts.loginFor(session), password: accounts.tokenFor(session), fetch: fetchImpl, timeoutMs,
    });
    const options = { origin: session.instance, client };
    if (resolveProjects) options.resolveProjects = resolveProjects;
    if (readLocalRevision) options.readLocalRevision = readLocalRevision;
    if (readUpstreamBranch) options.readUpstreamBranch = readUpstreamBranch;
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
  const routes = Object.freeze(standardMutations.routes.filter((route) => Object.hasOwn(operations, route)));

  const projectSelector = (sourceRepo) => (sourceRepo ? { owner: sourceRepo.owner, name: sourceRepo.repo } : undefined);

  return Object.freeze({
    descriptor,
    classifyFailure: classifyGerritFailure,
    auth: accounts.auth,
    transport: Object.freeze({ readCredential: accounts.readCredential }),
    resources: Object.freeze({
      changeRequestStatus: ({ session, directory, branch, remote }) => serviceFor(session).changeRequestStatus(directory, branch, remote),
      listChangeRequests: ({ session, directory, page, query, state, people, remote }) => serviceFor(session)
        .listChangeRequests(directory, { page, query, state, people, remote }),
      reviewState: ({ session, directory, project, number, remote }) => serviceFor(session).reviewState(directory, number, project, remote),
      changeRequestContext: ({ session, context, directory, number, project, remote, includeDiff, includeTimeline, revision }) => serviceFor(session)
        .changeRequestContext(directory, number, { includeDiff, includeTimeline, project, remote, revision, linked: context?.linked }),
      projectUpstream: ({ session, directory, remote }) => serviceFor(session).projectUpstream(directory, remote),
      projectBranches: ({ session, directory, project, remote }) => serviceFor(session).projectBranches(directory, project, remote),
      listReviewerCandidates: ({ session, directory, project, remote }) => serviceFor(session).listReviewerCandidates(directory, project, remote),
      readChangeRequestPatch: ({ session, directory, number, sourceRepo, remote, revision, linked }) => serviceFor(session)
        .changeRequestPatch(directory, number, { project: projectSelector(sourceRepo), remote, revision, linked }),
      readChangeRequestFile: ({ session, directory, number, sourceRepo, remote, path, previousPath, status, revision, binary, linked }) => serviceFor(session)
        .changeRequestFileContents(directory, number, { project: projectSelector(sourceRepo), remote, path, previousPath, status, revision, binary, linked }),
      liveSummaries: ({ session, refs, issueRefs }) => serviceFor(session).liveSummaries({ refs, issueRefs }),
      readChangeRequestHead: async ({ session, directory, remote, number }) => {
        const { project, raw } = await serviceFor(session).findChangeRequest(directory, number, null, remote);
        const headSha = String(raw.current_revision || '').toLowerCase();
        if (!/^[0-9a-f]{40}$/.test(headSha)) {
          throw Object.assign(new Error('Gerrit returned an invalid current patchset'), { code: 'MALFORMED_PROVIDER_RESPONSE' });
        }
        return {
          project: { id: project.id, owner: project.owner, name: project.name },
          headSha,
          headBranch: `change-${number}`,
          headOwner: project.owner,
        };
      },
      resolveChangeRequestSource: async ({ session, context, project, number, expectedHeadSha, requestedRemoteName }) => {
        const { project: current, request } = await serviceFor(session)
          .findChangeRequest(context.directory, number, { owner: project.owner, name: project.name }, context.primaryRemote);
        if (current.id !== project.id || String(request.headSha || '').toLowerCase() !== expectedHeadSha.toLowerCase()) {
          throw Object.assign(new Error('Change request head changed'), { code: 'SOURCE_CONTROL_CHANGE_REQUEST_STALE', status: 409 });
        }
        const compact = { id: current.id, owner: current.owner, name: current.name };
        return Object.freeze({
          context,
          sourceProject: compact,
          targetProject: compact,
          classification: 'same-repository',
          headSha: expectedHeadSha.toLowerCase(),
          headRef: request.head,
          endpoint: current.cloneUrl,
          requestedRemoteName,
        });
      },
    }),
    mutations: Object.freeze({
      routes,
      prepare: (request) => {
        if (!routes.includes(request.route)) throw invalidMutationContext('Source control mutation is unsupported');
        return standardMutations.prepare(request);
      },
      resolveTarget: ({ session, context, replayOf }) => {
        if (replayOf) {
          const { project, number } = replayOf.target;
          return { providerTarget: { project: joinProjectPath(project.owner, project.name), number }, target: replayOf.target };
        }
        return serviceFor(session).resolveChangeRequestMutation(context, context.target);
      },
      perform: ({ session, route, input, resolved }) => operations[route].perform(serviceFor(session), input, resolved),
      reconcile: ({ session, route, input, resolved }) => operations[route].reconcile(serviceFor(session), resolved, input),
    }),
  });
}
