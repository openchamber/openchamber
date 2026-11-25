import { createPatAccountAuth } from '../source-control/pat-account-auth.js';
import { createStandardMutations } from '../source-control/standard-mutations.js';
import { classifyGiteaFailure, createGiteaClient } from './client.js';
import { giteaDescriptor } from './descriptor.js';
import { createGtCli } from './gt-cli.js';
import { createGiteaResourceService } from './resources.js';
import { normalizeSshUrl, parseSshUrl } from '../source-control/ssh-url.js';
import { isForgejoVersion, probeGiteaVersion, verifyGiteaToken } from './verify.js';
import type { PatAccountAuthOptions } from '../source-control/pat-account-auth.js';
import type { createSourceControlAuthStore } from '../source-control/auth-storage.js';
import type { ProviderDescriptor, ProviderMutationContext, ProviderReadContext, ProviderSession } from '../source-control/provider-contract.js';
import type { MutationRecord } from '../source-control/mutation-storage.js';
import type { StandardMutationInput } from '../source-control/standard-mutations.js';
import type { SourceControlMutationTarget } from '@openchamber/sdk';
import type { BindingMutationTarget } from '../source-control/binding-service-contracts.js';
import type { GiteaFetch } from './client.js';
import type { GiteaResourceOptions } from './resources.js';
import type { GtCliOptions } from './gt-cli.js';

type Service = ReturnType<typeof createGiteaResourceService>;
type AuthStore = ReturnType<typeof createSourceControlAuthStore>;
type Store = PatAccountAuthOptions['store'];
type FamilyServices = {
  events: PatAccountAuthOptions['events'];
  fetch?: GiteaFetch | undefined;
  timeoutMs?: number;
  createClient?: typeof createGiteaClient;
  createResourceService?: typeof createGiteaResourceService;
  resolveRepos?: GiteaResourceOptions['resolveRepos'];
} & ({ authStore: AuthStore; store?: undefined } | { authStore?: AuthStore; store: Store });
export type GiteaProviderOptions = FamilyServices & {
  descriptor?: ProviderDescriptor;
  execFile?: GtCliOptions['execFile'];
  readFile?: GtCliOptions['readFile'];
  cliTimeoutMs?: GtCliOptions['timeoutMs'];
};
export type GiteaFamilyProviderOptions = FamilyServices & {
  descriptor: ProviderDescriptor;
  edition: typeof GITEA_EDITIONS[keyof typeof GITEA_EDITIONS];
  cli?: PatAccountAuthOptions['cli'];
};

type Existing = Awaited<ReturnType<Service['resolveChangeRequestMutation']>>;
type Create = Awaited<ReturnType<Service['resolveCreateMutation']>>;
type NumberedTarget = SourceControlMutationTarget & { number: number };
type ResolveInput = { session: ProviderSession; input: StandardMutationInput } & (
  { context: ProviderMutationContext; kind: 'change-request-create'; replayOf?: MutationRecord }
  | { context: ProviderMutationContext & { target: BindingMutationTarget & { number: number } }; kind: string; replayOf?: Omit<MutationRecord, 'target'> & { target: NumberedTarget } }
);
const numberedContext = (input: ResolveInput): input is Extract<ResolveInput, { context: { target: { number: number } } }> => input.kind !== 'change-request-create';
type ReadInput = { session: ProviderSession; directory: string; remote?: Parameters<Service['changeRequestStatus']>[2] };
type NumberedRead = ReadInput & { number: number; project?: Parameters<Service['reviewState']>[2] };
type LinkedRead = { context?: Pick<ProviderReadContext, 'linked'> };
type PatchRead = ReadInput & { number: number; sourceRepo?: { owner: string; repo: string } | null | undefined; linked?: boolean };
type ExistingStep<Fields extends StandardMutationInput = StandardMutationInput> = { input: Fields; resolved: Existing };
type Body = StandardMutationInput & { body: string };
type Title = StandardMutationInput & { title: string };
type CommentId = StandardMutationInput & { commentId: string };
type Names = StandardMutationInput & { names: string[] };
type State = StandardMutationInput & { state: string };
type Steps = {
  '/pr/create': { input: Title & { draft: boolean }; resolved: Create & { target: SourceControlMutationTarget & { head: string; base: string } } };
  '/pr/update': ExistingStep<Title>;
  '/pr/merge': ExistingStep<StandardMutationInput & { method: string }>;
  '/pr/ready': ExistingStep;
  '/pr/draft': ExistingStep;
  '/pr/review': ExistingStep<StandardMutationInput & Pick<Parameters<Service['reviewChangeRequest']>[0], 'verdict'>>;
  '/pr/review/comment': ExistingStep<Body & Pick<Parameters<Service['addReviewComment']>[0], 'position'>>;
  '/pr/review/comment/update': ExistingStep<CommentId & Body>;
  '/pr/review/comment/delete': ExistingStep<CommentId>;
  '/pr/review/discard': ExistingStep;
  '/pr/comment': ExistingStep<Body>;
  '/issues/comment': ExistingStep<Body>;
  '/issues/update': ExistingStep<Title>;
  '/pr/comment/update': ExistingStep<CommentId & Body>;
  '/issues/comment/update': ExistingStep<CommentId & Body>;
  '/pr/comment/delete': ExistingStep<CommentId>;
  '/issues/comment/delete': ExistingStep<CommentId>;
  '/pr/state': ExistingStep<State>;
  '/issues/state': ExistingStep<State>;
  '/pr/labels': ExistingStep<Names>;
  '/issues/labels': ExistingStep<Names>;
  '/pr/reviewers': ExistingStep<Names>;
  '/issues/assignees': ExistingStep<Names>;
};
type Route = keyof Steps;
type MutationCall<K extends Route> = { session: ProviderSession; route: K; kind: string } & Steps[K];
type Operation<Step extends Steps[Route]> = {
  perform(service: Service, input: Step['input'], resolved: Step['resolved']): Promise<object>;
  reconcile(service: Service, resolved: Step['resolved'], input: Step['input']): { state: string; result?: object } | Promise<{ state: string; result?: object }>;
};
type Operations = { [K in Route]: Operation<Steps[K]> };

export const GITEA_EDITIONS = Object.freeze({
  gitea: Object.freeze({ id: 'gitea', label: 'Gitea', minimum: '1.21', serves: (version: Parameters<typeof isForgejoVersion>[0]) => !isForgejoVersion(version) }),
  forgejo: Object.freeze({ id: 'forgejo', label: 'Forgejo', minimum: '7.0', serves: isForgejoVersion }),
});

const unknownOutcome = () => ({ state: 'outcome-unknown' });

function giteaPrepare(standardMutations: ReturnType<typeof createStandardMutations>, label: string) {
  return (request: Parameters<typeof standardMutations.prepare>[0]) => {
    const prepared = standardMutations.prepare(request);
    if (prepared.kind === 'change-request-review' && prepared.input.verdict === 'request-changes' && prepared.input.body === undefined) {
      throw Object.assign(new Error(`body is required and must fit a ${label} comment`), {
        code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT',
        status: 400,
      });
    }
    return prepared;
  };
}

function mutationOperations(): Operations {
  function call<R extends Existing | Create>(resolved: R): { providerTarget: R['providerTarget']; expectedTarget: R['target'] };
  function call<R extends Existing | Create, Extra extends object>(resolved: R, extra: Extra): { providerTarget: R['providerTarget']; expectedTarget: R['target'] } & Extra;
  function call(resolved: Existing | Create, extra = {}) {
    return { providerTarget: resolved.providerTarget, expectedTarget: resolved.target, ...extra };
  }

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
    '/pr/draft': {
      perform: (service, _normalized, resolved) => service.draftChangeRequest(call(resolved)),
      reconcile: (service, resolved) => service.reconcileChangeRequestMutation(resolved.providerTarget, 'change-request-draft'),
    },
    '/pr/review': {
      perform: (service, normalized, resolved) => service.reviewChangeRequest(call(resolved, { verdict: normalized.verdict, body: normalized.body })),
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
  } satisfies Pick<Operations, '/pr/create' | '/pr/update' | '/pr/merge' | '/pr/ready' | '/pr/draft' | '/pr/review'
    | '/pr/review/comment' | '/pr/review/comment/update' | '/pr/review/comment/delete' | '/pr/review/discard'>;
  const comment = (): Operation<ExistingStep<Body>> => ({
    perform: (service, normalized, resolved) => service.comment(call(resolved, { body: normalized.body })),
    reconcile: unknownOutcome,
  });
  const update = (): Operation<ExistingStep<CommentId & Body>> => ({
      perform: (service, normalized, resolved) => service.updateIssueComment(call(resolved, { commentId: normalized.commentId, body: normalized.body })),
      reconcile: (service, resolved, normalized) => service.reconcileIssueCommentUpdate(resolved.providerTarget, normalized.commentId, normalized.body),
  });
  const remove = (): Operation<ExistingStep<CommentId>> => ({
      perform: (service, normalized, resolved) => service.deleteIssueComment(call(resolved, { commentId: normalized.commentId })),
      reconcile: (service, resolved, normalized) => service.reconcileIssueCommentDelete(resolved.providerTarget, normalized.commentId),
  });
  const setState = (kind: string): Operation<ExistingStep<State>> => ({
      perform: (service, normalized, resolved) => service.setState(call(resolved, { state: normalized.state, kind })),
      reconcile: (service, resolved, normalized) => service.reconcileStateMutation(resolved.providerTarget, kind, normalized.state),
  });
  const setLabels = (kind: string): Operation<ExistingStep<Names>> => ({
      perform: (service, normalized, resolved) => service.setLabels(call(resolved, { labels: normalized.names })),
      reconcile: (service, resolved, normalized) => service.reconcileSetMutation(resolved.providerTarget, kind, normalized.names),
  });
  return {
    ...operations,
    '/pr/comment': comment(),
    '/issues/comment': comment(),
    '/issues/update': {
      perform: (service, normalized, resolved) => service.updateIssue(call(resolved, { title: normalized.title, body: normalized.body })),
      reconcile: (service, resolved, normalized) => service.reconcileIssueUpdate(resolved.providerTarget, normalized.title, normalized.body),
    },
    '/pr/comment/update': update(),
    '/issues/comment/update': update(),
    '/pr/comment/delete': remove(),
    '/issues/comment/delete': remove(),
    '/pr/state': setState('change-request-state'),
    '/issues/state': setState('issue-state'),
    '/pr/labels': setLabels('change-request-labels'),
    '/issues/labels': setLabels('issue-labels'),
    '/pr/reviewers': {
      perform: (service, normalized, resolved) => service.setReviewers(call(resolved, { reviewers: normalized.names })),
      reconcile: (service, resolved, normalized) => service.reconcileSetMutation(resolved.providerTarget, 'change-request-reviewers', normalized.names),
    },
    '/issues/assignees': {
      perform: (service, normalized, resolved) => service.setIssueAssignees(call(resolved, { assignees: normalized.names })),
      reconcile: (service, resolved, normalized) => service.reconcileIssueAssignees(resolved.providerTarget, normalized.names),
    },
  };
}

const otherEditions = (edition: GiteaFamilyProviderOptions['edition']) => Object.values(GITEA_EDITIONS).filter((other) => other.id !== edition.id);

export function createGiteaFamilyProvider(build: GiteaFamilyProviderOptions) {
  const {
    edition,
    descriptor,
    authStore,
    events,
    cli = null,
    fetch: fetchImpl = (input, init) => fetch(input, init),
    timeoutMs = 15_000,
    createClient = createGiteaClient,
    createResourceService = createGiteaResourceService,
    resolveRepos,
  } = build;
  const store = build.store === undefined
    ? authStore?.section instanceof Function ? authStore.section(descriptor.id) : build.authStore
    : build.store;
  const { label } = descriptor;
  const verify: PatAccountAuthOptions['verify'] = (origin, token) => verifyGiteaToken({ origin, token, fetch: fetchImpl, timeoutMs, label });
  const probe = async (origin: string, token: string | null = null) => {
    const { version, supported, edition: probed } = await probeGiteaVersion({ origin, token, fetch: fetchImpl, timeoutMs, label });
    return supported
      ? { version, supported, edition: probed }
      : { version, supported, edition: probed, message: `${label} ${version} is older than OpenChamber supports (${edition.minimum})` };
  };
  type ProbeResult = Parameters<NonNullable<PatAccountAuthOptions['ownerElsewhere']>>[0];
  const servesEdition = (target: GiteaFamilyProviderOptions['edition'], { version, edition: probed }: ProbeResult) => (probed ? probed === target.id : target.serves(version));
  const ownerElsewhere = (probeResult: ProbeResult) => (servesEdition(edition, probeResult)
    ? null
    : otherEditions(edition).find((other) => servesEdition(other, probeResult)) ?? null);
  const identityFor = (origin: string, accountId: string) => ({ provider: descriptor.id, instance: origin, accountId });
  const accounts = createPatAccountAuth({
    descriptor, store, events, verify, probe, classifyFailure: classifyGiteaFailure, ownerElsewhere,
    normalizeSshUrl: (value) => normalizeSshUrl(value, { label }), parseSshUrl, cli,
  });

  const services = new WeakMap<ProviderSession, Service>();
  const serviceFor = (session: ProviderSession) => {
    const cached = services.get(session);
    if (cached) return cached;
    const options: GiteaResourceOptions = {
      origin: session.instance,
      client: createClient({ origin: session.instance, token: accounts.tokenFor(session), fetch: fetchImpl, timeoutMs, label }),
      provider: descriptor.id,
      providerLabel: label,
      sshUrl: accounts.sshUrlFor(session),
    };
    if (resolveRepos) options.resolveRepos = resolveRepos;
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
          if (target !== error) throw new TypeError('Cannot attach source control account to resource failure');
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

  const projectSelector = (sourceRepo: PatchRead['sourceRepo']) => (sourceRepo ? { owner: sourceRepo.owner, name: sourceRepo.repo } : undefined);

  return Object.freeze({
    descriptor,
    classifyFailure: classifyGiteaFailure,
    auth: accounts.auth,
    transport: Object.freeze({ readCredential: accounts.readCredential }),
    resources: Object.freeze({
      changeRequestStatus: ({ session, directory, branch, remote }: ReadInput & { branch: string }) => serviceFor(session).changeRequestStatus(directory, branch, remote),
      listChangeRequests: ({ session, directory, page, query, state, people, labels, remote }: ReadInput & NonNullable<Parameters<Service['listChangeRequests']>[1]>) => serviceFor(session)
        .listChangeRequests(directory, { page, query, state, people, labels, remote }),
      changeRequestContext: ({ session, context, directory, number, project, remote, includeDiff, includeCIDetails, includeTimeline, includeReferences }: NumberedRead & LinkedRead & NonNullable<Parameters<Service['changeRequestContext']>[2]> & { includeCIDetails?: boolean }) => {
        const options = { includeDiff, includeCIDetails, includeTimeline, includeReferences, project, remote, linked: context?.linked };
        return serviceFor(session).changeRequestContext(directory, number, options);
      },
      reviewState: ({ session, directory, project, number, remote }: NumberedRead) => serviceFor(session).reviewState(directory, number, project, remote),
      listIssues: ({ session, directory, page, query, state, people, labels, remote }: ReadInput & NonNullable<Parameters<Service['listIssues']>[1]>) => serviceFor(session)
        .listIssues(directory, { page, query, state, people, labels, remote }),
      getIssue: ({ session, context, directory, number, project, remote, includeReferences }: NumberedRead & LinkedRead & { includeReferences?: boolean }) => serviceFor(session).getIssue(directory, number, project, remote, { linked: context?.linked, includeReferences: Boolean(includeReferences) }),
      issueComments: ({ session, context, directory, number, project, remote }: NumberedRead & LinkedRead) => serviceFor(session).issueComments(directory, number, project, remote, { linked: context?.linked }),
      projectUpstream: ({ session, directory, remote }: ReadInput) => serviceFor(session).projectUpstream(directory, remote),
      projectBranches: ({ session, directory, project, remote }: ReadInput & Pick<NumberedRead, 'project'>) => serviceFor(session).projectBranches(directory, project, remote),
      listLabels: ({ session, directory, project, remote }: ReadInput & Pick<NumberedRead, 'project'>) => serviceFor(session).listLabels(directory, project, remote),
      listReviewerCandidates: ({ session, directory, project, remote, role }: ReadInput & Pick<NumberedRead, 'project'> & { role?: 'assignee' | 'reviewer' }) => serviceFor(session).listReviewerCandidates(directory, project, remote, role ? { role } : {}),
      readChangeRequestPatch: ({ session, directory, number, sourceRepo, remote, linked }: PatchRead) => serviceFor(session)
        .changeRequestPatch(directory, number, { project: projectSelector(sourceRepo), remote, linked }),
      readChangeRequestFile: ({ session, directory, number, sourceRepo, remote, path, previousPath, status, binary, linked }: PatchRead & Pick<Parameters<Service['changeRequestFileContents']>[2], 'path' | 'previousPath' | 'status' | 'binary'>) => serviceFor(session)
        .changeRequestFileContents(directory, number, { project: projectSelector(sourceRepo), remote, path, previousPath, status, binary, linked }),
      liveSummaries: ({ session, refs, issueRefs }: { session: ProviderSession } & Parameters<Service['liveSummaries']>[0]) => serviceFor(session).liveSummaries({ refs, issueRefs }),
      readChangeRequestHead: async ({ session, directory, remote, number }: NumberedRead) => {
        const { request, headProject } = await serviceFor(session).findChangeRequest(directory, number, null, remote);
        const headSha = String(request.headSha || '').toLowerCase();
        if (!/^[0-9a-f]{40}$/.test(headSha)) {
          throw Object.assign(new Error(`${label} returned an invalid pull request head`), { code: 'MALFORMED_PROVIDER_RESPONSE' });
        }
        return {
          project: { id: request.project.id, owner: request.project.owner, name: request.project.name },
          headSha,
          headBranch: request.head,
          headOwner: (headProject ?? request.project).owner,
        };
      },
      resolveChangeRequestSource: async ({ session, context, project, number, expectedHeadSha, requestedRemoteName }: NumberedRead & {
        context: ProviderReadContext;
        project: SourceControlMutationTarget['project'];
        expectedHeadSha: string;
        requestedRemoteName: string;
      }) => {
        const { request, headProject: fork } = await serviceFor(session)
          .findChangeRequest(context.directory, number, { owner: project.owner, name: project.name }, context.primaryRemote);
        if (request.project.id !== project.id || String(request.headSha || '').toLowerCase() !== expectedHeadSha.toLowerCase()) {
          throw Object.assign(new Error('Change request head changed'), { code: 'SOURCE_CONTROL_CHANGE_REQUEST_STALE', status: 409 });
        }
        const headProject = fork ?? request.project;
        const endpoint = headProject.cloneUrl;
        let parsed = null;
        try { parsed = new URL(String(endpoint)); } catch { parsed = null; }
        if (!parsed || endpoint === undefined || parsed.origin !== new URL(context.instance).origin
          || decodeURIComponent(parsed.pathname).replace(/^\//, '').replace(/\.git$/, '') !== `${headProject.owner}/${headProject.name}`) {
          throw Object.assign(new Error(`${label} returned an invalid head repository endpoint`), { code: 'MALFORMED_PROVIDER_RESPONSE' });
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
      prepare: giteaPrepare(standardMutations, label),
      resolveTarget: (step: ResolveInput) => {
        const service = serviceFor(step.session);
        if (!numberedContext(step)) return service.resolveCreateMutation(step.context, step.context.target, step.input);
        const { context, kind, replayOf } = step;
        if (replayOf) {
          const { project, number } = replayOf.target;
          return { providerTarget: { repoId: Number(project.id), owner: project.owner, name: project.name, number }, target: replayOf.target };
        }
        if (kind.startsWith('issue-')) return service.resolveIssueMutation(context, context.target);
        return service.resolveChangeRequestMutation(context, context.target);
      },
      perform: <K extends Route>({ session, route, input, resolved }: MutationCall<K>) => operations[route].perform(serviceFor(session), input, resolved),
      reconcile: <K extends Route>({ session, route, input, resolved }: MutationCall<K>) => operations[route].reconcile(serviceFor(session), resolved, input),
    }),
  });
}

export function createProvider({ descriptor = giteaDescriptor, execFile, readFile, cliTimeoutMs, ...services }: GiteaProviderOptions) {
  const cli = createGtCli({ execFile, readFile, timeoutMs: cliTimeoutMs });
  return createGiteaFamilyProvider({ ...services, descriptor, edition: GITEA_EDITIONS.gitea, cli });
}
