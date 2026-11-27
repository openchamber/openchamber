import { createPatAccountAuth } from '../source-control/pat-account-auth.js';
import { joinProjectPath } from '../source-control/project-path.js';
import { createStandardMutations } from '../source-control/standard-mutations.js';
import { classifyGerritFailure, createGerritClient } from './client.js';
import { gerritDescriptor } from './descriptor.js';
import { createGerritResourceService } from './resources.js';
import { probeGerritVersion, verifyGerritCredentials } from './verify.js';
import type { PatAccountAuthOptions } from '../source-control/pat-account-auth.js';
import type { createSourceControlAuthStore } from '../source-control/auth-storage.js';
import type { ProviderDescriptor, ProviderMutationContext, ProviderReadContext, ProviderSession } from '../source-control/provider-contract.js';
import type { MutationRecord } from '../source-control/mutation-storage.js';
import type { StandardMutationInput } from '../source-control/standard-mutations.js';
import type { SourceControlMutationTarget } from '@openchamber/sdk';
import type { BindingMutationTarget } from '../source-control/binding-service-contracts.js';

type Service = ReturnType<typeof createGerritResourceService>;
type ResourceOptions = Parameters<typeof createGerritResourceService>[0];
type AuthStore = ReturnType<typeof createSourceControlAuthStore>;
export type GerritProviderOptions = {
  descriptor?: ProviderDescriptor;
  events: PatAccountAuthOptions['events'];
  fetch?: typeof fetch | undefined;
  timeoutMs?: number;
  createClient?: typeof createGerritClient;
  createResourceService?: typeof createGerritResourceService;
  resolveProjects?: ResourceOptions['resolveProjects'];
  readLocalRevision?: ResourceOptions['readLocalRevision'];
  readUpstreamBranch?: ResourceOptions['readUpstreamBranch'];
} & ({ authStore: AuthStore; store?: undefined } | { authStore?: AuthStore; store: PatAccountAuthOptions['store'] });

type ProviderTarget = Parameters<Service['submit']>[0]['providerTarget'];
type Resolved = { providerTarget: ProviderTarget; target: SourceControlMutationTarget };
type NumberedTarget = SourceControlMutationTarget & { number: number };
type ResolveInput = {
  session: ProviderSession;
  kind: string;
  input: StandardMutationInput;
  context: ProviderMutationContext & { target: BindingMutationTarget & { number: number } };
  replayOf?: Omit<MutationRecord, 'target'> & { target: NumberedTarget };
};
type ReadInput = { session: ProviderSession; directory: string; remote?: string | undefined };
type Project = { owner: string; name: string };
type NumberedRead = ReadInput & { project?: Project | undefined; number: number };
type FileRead = ReadInput & { number: number; sourceRepo?: { owner: string; repo: string } | null | undefined; revision?: string; linked?: boolean };

type ReviewInputs = {
  '/pr/merge': StandardMutationInput;
  '/pr/ready': StandardMutationInput;
  '/pr/draft': StandardMutationInput;
  '/pr/review': StandardMutationInput & Pick<Parameters<Service['vote']>[0], 'votes'>;
  '/pr/review/comment': StandardMutationInput & Pick<Parameters<Service['addReviewComment']>[0], 'position' | 'body'>;
  '/pr/review/comment/update': StandardMutationInput & { commentId: string; body: string };
  '/pr/review/comment/delete': StandardMutationInput & { commentId: string };
  '/pr/review/discard': StandardMutationInput;
  '/pr/comment': StandardMutationInput & { body: string };
  '/pr/thread/reply': StandardMutationInput & { threadId: string; body: string };
  '/pr/state': StandardMutationInput & { state: 'open' | 'closed' };
  '/pr/reviewers': StandardMutationInput & { names: string[] };
};
type Route = keyof ReviewInputs;
type MutationCall<K extends Route> = { session: ProviderSession; route: K; kind: string; input: ReviewInputs[K]; resolved: Resolved };
type Operations = {
  [K in Route]: {
    perform(service: Service, input: ReviewInputs[K], resolved: Resolved): Promise<object>;
    reconcile(service: Service, resolved: Resolved, input: ReviewInputs[K]): { state: string; result?: object } | Promise<{ state: string; result?: object }>;
  };
};

const unknownOutcome = () => ({ state: 'outcome-unknown' });

const invalidMutationContext = (message: string) => Object.assign(new Error(message), {
  code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT',
  status: 400,
});

function mutationOperations(): Operations {
  const call = (resolved: Resolved) => ({ providerTarget: resolved.providerTarget, expectedTarget: resolved.target });
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
      perform: (service, normalized, resolved) => service.vote({ ...call(resolved), votes: normalized.votes, body: normalized.body }),
      reconcile: unknownOutcome,
    },
    '/pr/review/comment': {
      perform: (service, normalized, resolved) => service.addReviewComment({ ...call(resolved), position: normalized.position, body: normalized.body }),
      reconcile: unknownOutcome,
    },
    '/pr/review/comment/update': {
      perform: (service, normalized, resolved) => service.updateReviewComment({ ...call(resolved), commentId: normalized.commentId, body: normalized.body }),
      reconcile: unknownOutcome,
    },
    '/pr/review/comment/delete': {
      perform: (service, normalized, resolved) => service.deleteReviewComment({ ...call(resolved), commentId: normalized.commentId }),
      reconcile: unknownOutcome,
    },
    '/pr/review/discard': {
      perform: (service, _normalized, resolved) => service.discardReview(call(resolved)),
      reconcile: unknownOutcome,
    },
    '/pr/comment': {
      perform: (service, normalized, resolved) => service.comment({ ...call(resolved), body: normalized.body }),
      reconcile: unknownOutcome,
    },
    '/pr/thread/reply': {
      perform: (service, normalized, resolved) => service.replyToThread({ ...call(resolved), threadId: normalized.threadId, body: normalized.body }),
      reconcile: unknownOutcome,
    },
    '/pr/state': {
      perform: (service, normalized, resolved) => service.setState({ ...call(resolved), state: normalized.state }),
      reconcile: (service, resolved, normalized) => service.reconcileStateMutation(resolved.providerTarget, normalized.state),
    },
    '/pr/reviewers': {
      perform: (service, normalized, resolved) => service.setReviewers({ ...call(resolved), reviewers: normalized.names }),
      reconcile: (service, resolved, normalized) => service.reconcileReviewers(resolved.providerTarget, normalized.names),
    },
  };
}

export function createProvider(options: GerritProviderOptions) {
  const {
    descriptor = gerritDescriptor,
    events,
    fetch: fetchImpl = (input, init) => fetch(input, init),
    timeoutMs = 15_000,
    createClient = createGerritClient,
    createResourceService = createGerritResourceService,
    resolveProjects,
    readLocalRevision,
    readUpstreamBranch,
  } = options;
  const { authStore } = options;
  const store = options.store === undefined
    ? authStore?.section instanceof Function ? authStore.section(gerritDescriptor.id) : options.authStore
    : options.store;
  const verify: PatAccountAuthOptions['verify'] = (origin, password, { username } = { username: undefined }) => verifyGerritCredentials({ origin, login: username, password, fetch: fetchImpl, timeoutMs });
  const probe: PatAccountAuthOptions['probe'] = async (origin, password, { username } = { username: undefined }) => {
    const { version, supported } = await probeGerritVersion({ origin, login: username, password, fetch: fetchImpl, timeoutMs });
    return supported ? { version, supported } : { version, supported, message: `Gerrit ${version} is older than OpenChamber supports (3.8)` };
  };
  const identityFor = (origin: string, accountId: string) => ({ provider: descriptor.id, instance: origin, accountId });
  const accounts = createPatAccountAuth({ descriptor, store, events, verify, probe, classifyFailure: classifyGerritFailure });

  const services = new WeakMap<ProviderSession, Service>();
  const serviceFor = (session: ProviderSession) => {
    const cached = services.get(session);
    if (cached) return cached;
    const client = createClient({
      origin: session.instance, login: accounts.loginFor(session), password: accounts.tokenFor(session), fetch: fetchImpl, timeoutMs,
    });
    const options: ResourceOptions = { origin: session.instance, client, reviewThreads: descriptor.capabilities.reviewThreads };
    if (resolveProjects) options.resolveProjects = resolveProjects;
    if (readLocalRevision) options.readLocalRevision = readLocalRevision;
    if (readUpstreamBranch) options.readUpstreamBranch = readUpstreamBranch;
    const service = createResourceService(options);
    const identity = identityFor(session.instance, session.accountId);
    const methods: Record<string, (...args: never[]) => Promise<object>> = service;
    for (const method of Object.keys(methods)) {
      const operation = methods[method];
      if (!(operation instanceof Function)) continue;
      methods[method] = async (...args: never[]) => {
        try {
          return await operation(...args);
        } catch (error) {
          const target: { sourceControlIdentity?: ReturnType<typeof identityFor>; sourceControlPersistedAccount?: boolean } = Object(error);
          if (target !== error) {
            throw new TypeError('Cannot attach source control account to resource failure');
          }
          target.sourceControlIdentity = identity;
          target.sourceControlPersistedAccount = session.persisted;
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

  const projectSelector = (sourceRepo: FileRead['sourceRepo']) => (sourceRepo ? { owner: sourceRepo.owner, name: sourceRepo.repo } : undefined);

  return Object.freeze({
    descriptor,
    classifyFailure: classifyGerritFailure,
    auth: accounts.auth,
    transport: Object.freeze({ readCredential: accounts.readCredential }),
    resources: Object.freeze({
      changeRequestStatus: ({ session, directory, branch, remote }: ReadInput & { branch: string }) => serviceFor(session).changeRequestStatus(directory, branch, remote),
      listChangeRequests: ({ session, directory, page, query, state, people, remote }: ReadInput & NonNullable<Parameters<Service['listChangeRequests']>[1]>) => serviceFor(session)
        .listChangeRequests(directory, { page, query, state, people, remote }),
      reviewState: ({ session, directory, project, number, remote }: NumberedRead) => serviceFor(session).reviewState(directory, number, project, remote),
      changeRequestContext: ({ session, context, directory, number, project, remote, includeDiff, includeTimeline, revision }: NumberedRead & NonNullable<Parameters<Service['changeRequestContext']>[2]> & { context?: Pick<ProviderReadContext, 'linked'> }) => serviceFor(session)
        .changeRequestContext(directory, number, { includeDiff, includeTimeline, project, remote, revision, linked: context?.linked }),
      projectUpstream: ({ session, directory, remote }: ReadInput) => serviceFor(session).projectUpstream(directory, remote),
      projectBranches: ({ session, directory, project, remote }: ReadInput & { project?: Project }) => serviceFor(session).projectBranches(directory, project, remote),
      listReviewerCandidates: ({ session, directory, project, remote }: ReadInput & { project?: Project }) => serviceFor(session).listReviewerCandidates(directory, project, remote),
      readChangeRequestPatch: ({ session, directory, number, sourceRepo, remote, revision, linked }: FileRead) => serviceFor(session)
        .changeRequestPatch(directory, number, { project: projectSelector(sourceRepo), remote, revision, linked }),
      readChangeRequestFile: ({ session, directory, number, sourceRepo, remote, path, previousPath, status, revision, binary, linked }: FileRead & { path: string; previousPath?: string | undefined; status?: string; binary?: boolean | undefined }) => serviceFor(session)
        .changeRequestFileContents(directory, number, { project: projectSelector(sourceRepo), remote, path, previousPath, status, revision, binary, linked }),
      liveSummaries: ({ session, refs, issueRefs }: { session: ProviderSession; refs?: Parameters<Service['liveSummaries']>[0]['refs']; issueRefs?: Array<{ owner: string; repo: string; number: number }> }) => {
        const options = { refs, issueRefs };
        return serviceFor(session).liveSummaries(options);
      },
      readChangeRequestHead: async ({ session, directory, remote, number }: NumberedRead) => {
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
      resolveChangeRequestSource: async ({ session, context, project, number, expectedHeadSha, requestedRemoteName }: NumberedRead & {
        context: ProviderReadContext;
        project: Project & { id: string };
        expectedHeadSha: string;
        requestedRemoteName: string;
      }) => {
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
      prepare: (request: Parameters<typeof standardMutations.prepare>[0]) => {
        if (!routes.includes(request.route)) throw invalidMutationContext('Source control mutation is unsupported');
        return standardMutations.prepare(request);
      },
      resolveTarget: ({ session, context, replayOf }: ResolveInput) => {
        if (replayOf) {
          const { project, number } = replayOf.target;
          return { providerTarget: { project: joinProjectPath(project.owner, project.name), number }, target: replayOf.target };
        }
        return serviceFor(session).resolveChangeRequestMutation(context, context.target);
      },
      perform: <K extends Route>({ session, route, input, resolved }: MutationCall<K>) => operations[route].perform(serviceFor(session), input, resolved),
      reconcile: <K extends Route>({ session, route, input, resolved }: MutationCall<K>) => operations[route].reconcile(serviceFor(session), resolved, input),
    }),
  });
}
