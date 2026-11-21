import { exchangeGitLabDeviceCode, refreshGitLabAccessToken, resolveGitLabClientId, probeGitLabAuth, startGitLabDeviceFlow } from './device-flow.js';
import { getGlabToken, getGlabTokenResult } from './glab-credential.js';
import { classifyGitLabFailure } from './network.js';
import { createGitLabClient, createGitLabDownloader } from './client.js';
import { createGitLabResourceService } from './resources.js';
import { reviewDraftEntries } from '../source-control/review-position.js';
import { verifyGitLabToken } from './verify.js';
import { isString } from './validation.js';
import { gitlabDescriptor } from './descriptor.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';
import { ownedOriginInstance } from '../source-control/origin-instance.js';
import type { SourceControlJson, SourceControlJsonObject, SourceControlMutationTarget } from '@openchamber/sdk';
import type { AccountEvents, AccountIdentity, ProviderDescriptor, ProviderMutationContext, ProviderReadContext, ProviderSession } from '../source-control/provider-contract.js';
import type { AuthCredential, createSourceControlAuthStore } from '../source-control/auth-storage.js';
import type { MutationContextInput } from '../source-control/binding-service-contracts.js';
import type { MutationRecord } from '../source-control/mutation-storage.js';
import type { GitLabResourceOptions } from './resources.js';
import type { GlabLookupOptions } from './glab-credential.js';
import type { GitLabUser } from './user.js';

type AuthStore = ReturnType<typeof createSourceControlAuthStore>;
type Store = ReturnType<AuthStore['section']>;
export type GitLabProviderOptions = {
  descriptor?: ProviderDescriptor;
  events: Pick<AccountEvents, 'connected' | 'invalidated' | 'removed'>;
  readSettings?: Parameters<typeof resolveGitLabClientId>[1];
  fetch?: typeof fetch | undefined;
  timeoutMs?: number;
  execFile?: GlabLookupOptions['execFile'];
  cliTimeoutMs?: GlabLookupOptions['timeoutMs'];
  createClient?: typeof createGitLabClient;
  createDownloader?: typeof createGitLabDownloader;
  createResourceService?: typeof createGitLabResourceService;
  resolveProjects?: GitLabResourceOptions['resolveProjects'];
} & ({ authStore: AuthStore; store?: undefined } | { authStore?: AuthStore; store: Store });
type Service = ReturnType<typeof createGitLabResourceService>;
type Digest = Record<string, SourceControlJson | undefined>;
type Normalized = { digest: Digest };
type WithBody = Normalized & { body: string };
type WithTitle = Normalized & { title: string; body?: string };
type WithNote = Normalized & { commentId: string };
type WithThread = Normalized & { threadId: string };
type WithState = Normalized & { state: 'open' | 'closed' };
type WithNames = Normalized & { names: string[] };
type CreateInput = WithTitle & { draft: boolean; remote?: string; headRemote?: string };
type ExistingResolution = Pick<Awaited<ReturnType<Service['resolveChangeRequestMutation']>>, 'providerTarget' | 'target'>;
type CreateResolution = Awaited<ReturnType<Service['resolveCreateMutation']>> & { target: SourceControlMutationTarget & { head: string; base: string } };
type Position = Parameters<Service['addReviewComment']>[0]['position'];
type Inputs = {
  '/pr/create': CreateInput;
  '/pr/update': WithTitle;
  '/pr/merge': Normalized & { method: string };
  '/pr/ready': Normalized;
  '/pr/draft': Normalized;
  '/pr/comment': WithBody;
  '/pr/thread/start': WithBody;
  '/pr/thread/reply': WithThread & WithBody;
  '/pr/thread/resolve': WithThread & { resolved: boolean };
  '/issues/comment': WithBody;
  '/issues/update': WithTitle;
  '/pr/comment/update': WithNote & WithBody;
  '/pr/comment/delete': WithNote;
  '/issues/comment/update': WithNote & WithBody;
  '/issues/comment/delete': WithNote;
  '/pr/review': Normalized & { verdict: string; body: string | undefined };
  '/pr/review/comment': WithBody & { position: Position };
  '/pr/review/comment/update': WithNote & WithBody;
  '/pr/review/comment/delete': WithNote;
  '/pr/review/discard': Normalized;
  '/pr/state': WithState;
  '/issues/state': WithState;
  '/pr/labels': WithNames;
  '/issues/labels': WithNames;
  '/pr/reviewers': WithNames;
};
type Route = keyof Inputs;
type Resolutions = { [K in Route]: K extends '/pr/create' ? CreateResolution : ExistingResolution };
type Outcome = { state: string; result?: object };
type MutationEntry<I extends Normalized, R> = {
  kind: string;
  normalize(input: SourceControlJsonObject, context: MutationContextInput): I;
  perform(service: Service, input: I, resolved: R): Promise<object>;
  reconcile(service: Service, resolved: R, input: I): Outcome | Promise<Outcome>;
};
type Mutations = { [K in Route]: MutationEntry<Inputs[K], Resolutions[K]> };
type DraftRoute = keyof ReturnType<typeof reviewDraftEntries>;
type ExtraRoute = DraftRoute | '/pr/state' | '/issues/state' | '/pr/labels' | '/issues/labels' | '/pr/reviewers';
type NumberedTarget = SourceControlMutationTarget & { number: number };
type NumberedContext = Omit<ProviderMutationContext, 'target'> & { target: ProviderMutationContext['target'] & { number: number } };
type ResolveInput = { session: ProviderSession } & (
  { context: ProviderMutationContext; kind: 'change-request-create'; input: CreateInput; replayOf?: MutationRecord }
  | { context: NumberedContext; kind: string; input: Inputs[Route]; replayOf?: Omit<MutationRecord, 'target'> & { target: NumberedTarget } }
);
type MutationStep<K extends Route> = { route: K; kind: string; session: ProviderSession; input: Inputs[K]; resolved: Resolutions[K] };
type PrepareInput<K extends Route> = { route: K; input: SourceControlJsonObject; context: MutationContextInput; actor: AccountIdentity;
  credential: { accountId: string; credentialRevision: number } };
type Instance = { instance: string };
type Account = Instance & { accountId: string };
type ReadInput = { session: ProviderSession; directory: string; remote?: string | undefined };
type LinkedRead = { context?: Pick<ProviderReadContext, 'linked'> };
type ProjectRead = ReadInput & { project?: Parameters<Service['reviewState']>[2] };
type NumberedRead = ProjectRead & { number: number };
type PatchRead = ReadInput & { number: number; sourceRepo?: { owner: string; repo: string } | null | undefined; linked?: boolean };
type Failure = { status?: number; kind?: string; message?: unknown };

const hasFailureFields = (value: unknown): value is Failure => value != null;
const isCreate = (step: ResolveInput): step is Extract<ResolveInput, { kind: 'change-request-create' }> => step.kind === 'change-request-create';
const includes = <T extends SourceControlJson>(items: readonly T[], value: SourceControlJson | undefined): value is T => {
  const candidates: readonly (SourceControlJson | undefined)[] = items;
  return candidates.includes(value);
};
const validNames = (value: SourceControlJson | undefined, limit: number): value is string[] =>
  !(!Array.isArray(value) || value.length > limit || value.some((entry) => !isString(entry) || !entry.trim() || entry.length > 256));

const accountView = (origin: string, account: AuthCredential, current: boolean, accounts: AuthCredential[]) => ({
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

const cliAccountView = (origin: string, user: GitLabUser, current: boolean) => ({
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

const responseError = (status: number, body: { error: string; status?: string }) => Object.assign(new Error(body.error), { sourceControlResponse: { status, body } });

const invalidMutationContext = (message: string) => Object.assign(new Error(message), {
  code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT',
  status: 400,
});

const requestText = (value: SourceControlJson | undefined) => (isString(value) ? value.trim() : '');

const unknownOutcome = () => ({ state: 'outcome-unknown' });

const threadIdOf = (value: SourceControlJson | undefined) => {
  if (!isString(value) || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw invalidMutationContext('threadId is invalid');
  return value;
};

const noteIdOf = (value: SourceControlJson | undefined) => {
  const id = isString(value) || Number.isSafeInteger(value) ? String(value) : '';
  if (!/^[1-9]\d{0,19}$/.test(id)) throw invalidMutationContext('commentId is invalid');
  return id;
};

function mutationTable(descriptor: ProviderDescriptor): Mutations {
  const noteMaxLength = descriptor.limits.commentMaxLength;
  function noteText(value: SourceControlJson | undefined, required: true): string;
  function noteText(value: SourceControlJson | undefined, required: boolean): string | undefined;
  function noteText(value: SourceControlJson | undefined, required: boolean) {
    if (value === undefined && !required) return undefined;
    if (!isString(value) || !value.trim() || value.length > noteMaxLength) {
      throw invalidMutationContext('body is required and must fit a GitLab note');
    }
    return value;
  }
  const nameList = (value: SourceControlJson | undefined, limit: number) => {
    if (!validNames(value, limit)) {
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
        const normalized: Omit<CreateInput, 'digest'> & { digest?: Digest } = { title, draft: input.draft === true };
        if (isString(input.body)) normalized.body = input.body;
        const remote = requestText(input.remote);
        const headRemote = requestText(input.headRemote);
        if (remote) normalized.remote = remote;
        if (headRemote) normalized.headRemote = headRemote;
        normalized.digest = {
          title, body: normalized.body ?? null, draft: normalized.draft,
          remote: normalized.remote ?? context.primaryRemote, headRemote: normalized.headRemote ?? context.primaryRemote,
        };
        return { ...normalized, digest: normalized.digest };
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
        const normalized: Omit<WithTitle, 'digest'> & { digest?: Digest } = { title };
        if (isString(input.body)) normalized.body = input.body;
        normalized.digest = { title, body: normalized.body ?? null };
        return { ...normalized, digest: normalized.digest };
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
        if (!context.target.number || !includes(mergeMethods, input.method)) {
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
    '/pr/draft': {
      kind: 'change-request-draft',
      normalize: (_input, context) => {
        if (!context.target.number) throw invalidMutationContext('target number is required');
        return { digest: {} };
      },
      perform: (service, _normalized, resolved) => service.draftChangeRequest({
        providerTarget: resolved.providerTarget,
        targetProject: resolved.target.project,
        expectedTarget: resolved.target,
      }),
      reconcile: (service, resolved) => service.reconcileChangeRequestMutation(resolved.providerTarget, 'change-request-draft'),
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
        if (!context.target.number || (input.resolved !== true && input.resolved !== false)) {
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
    '/issues/update': {
      kind: 'issue-update',
      normalize: (input, context) => {
        const title = requestText(input.title);
        if (!title || !context.target.number) throw invalidMutationContext('title and target number are required');
        const normalized: Omit<WithTitle, 'digest'> & { digest?: Digest } = { title };
        if (isString(input.body)) normalized.body = input.body;
        normalized.digest = { title, body: normalized.body ?? null };
        return { ...normalized, digest: normalized.digest };
      },
      perform: (service, normalized, resolved) => service.updateIssue({
        title: normalized.title,
        body: normalized.body,
        providerTarget: resolved.providerTarget,
        targetProject: resolved.target.project,
        expectedTarget: resolved.target,
      }),
      reconcile: (service, resolved, normalized) => service.reconcileIssueUpdate(resolved.providerTarget, normalized),
    },
    '/pr/comment/update': {
      kind: 'change-request-comment-update',
      normalize: (input, context) => {
        if (!context.target.number) throw invalidMutationContext('target number is required');
        const commentId = noteIdOf(input.commentId);
        const text = noteText(input.body, true);
        return { commentId, body: text, digest: { commentId, body: text } };
      },
      perform: async (service, normalized, resolved) => {
        await service.updateChangeRequestComment({
          providerTarget: resolved.providerTarget, commentId: normalized.commentId, body: normalized.body,
        });
        return {};
      },
      reconcile: (service, resolved, normalized) => service.reconcileChangeRequestComment(resolved.providerTarget, 'update', normalized),
    },
    '/pr/comment/delete': {
      kind: 'change-request-comment-delete',
      normalize: (input, context) => {
        if (!context.target.number) throw invalidMutationContext('target number is required');
        const commentId = noteIdOf(input.commentId);
        return { commentId, digest: { commentId } };
      },
      perform: async (service, normalized, resolved) => {
        await service.deleteChangeRequestComment({ providerTarget: resolved.providerTarget, commentId: normalized.commentId });
        return {};
      },
      reconcile: (service, resolved, normalized) => service.reconcileChangeRequestComment(resolved.providerTarget, 'delete', normalized),
    },
    '/issues/comment/update': {
      kind: 'issue-comment-update',
      normalize: (input, context) => {
        if (!context.target.number) throw invalidMutationContext('target number is required');
        const commentId = noteIdOf(input.commentId);
        const text = noteText(input.body, true);
        return { commentId, body: text, digest: { commentId, body: text } };
      },
      perform: async (service, normalized, resolved) => {
        await service.updateIssueComment({
          providerTarget: resolved.providerTarget, commentId: normalized.commentId, body: normalized.body,
        });
        return {};
      },
      reconcile: (service, resolved, normalized) => service.reconcileIssueComment(resolved.providerTarget, 'update', normalized),
    },
    '/issues/comment/delete': {
      kind: 'issue-comment-delete',
      normalize: (input, context) => {
        if (!context.target.number) throw invalidMutationContext('target number is required');
        const commentId = noteIdOf(input.commentId);
        return { commentId, digest: { commentId } };
      },
      perform: async (service, normalized, resolved) => {
        await service.deleteIssueComment({ providerTarget: resolved.providerTarget, commentId: normalized.commentId });
        return {};
      },
      reconcile: (service, resolved, normalized) => service.reconcileIssueComment(resolved.providerTarget, 'delete', normalized),
    },
    '/pr/review': {
      kind: 'change-request-review',
      normalize: (input, context) => {
        if (!context.target.number || !context.target.headSha || !includes(['approve', 'request-changes', 'comment'], input.verdict)) {
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
  } satisfies Omit<Mutations, ExtraRoute>;
  const reviewDrafts = reviewDraftEntries<string>({ commentText: noteText, fail: (message) => { throw invalidMutationContext(message); } });
  const setState = (kind: string, method: 'setChangeRequestState' | 'setIssueState'): MutationEntry<WithState, ExistingResolution> => ({
    kind,
    normalize: (input, context) => {
      if (!context.target.number || (input.state !== 'open' && input.state !== 'closed')) {
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
  });
  const setNames = (kind: string, field: 'labels' | 'reviewers'): MutationEntry<WithNames, ExistingResolution> => ({
    kind,
    normalize: (input, context) => {
      if (!context.target.number) throw invalidMutationContext('target number is required');
      const names = nameList(input[field], field === 'labels' ? descriptor.limits.labelsMax : descriptor.limits.reviewersMax);
      if (field === 'reviewers' && names.some((id) => !descriptor.limits.reviewerId.test(id))) {
        throw invalidMutationContext('reviewers are invalid');
      }
      return { names, digest: { [field]: names } };
    },
    perform: (service, normalized, resolved) => {
      const target = { providerTarget: resolved.providerTarget, targetProject: resolved.target.project, expectedTarget: resolved.target };
      if (field === 'reviewers') {
        const options = { kind, reviewers: normalized.names, ...target };
        return service.setReviewers(options);
      }
      const options = { kind, labels: normalized.names, ...target };
      return service.setLabels(options);
    },
    reconcile: (service, resolved, normalized) => service.reconcileSetMutation(resolved.providerTarget, kind, normalized.names),
  });
  return {
    ...entries,
    '/pr/review/comment': {
      ...reviewDrafts['/pr/review/comment'],
      perform: (service, normalized, resolved) => service.addReviewComment({ providerTarget: resolved.providerTarget, ...normalized }),
      reconcile: unknownOutcome,
    },
    '/pr/review/comment/update': {
      ...reviewDrafts['/pr/review/comment/update'],
      perform: (service, normalized, resolved) => service.updateReviewComment({ providerTarget: resolved.providerTarget, ...normalized }),
      reconcile: unknownOutcome,
    },
    '/pr/review/comment/delete': {
      ...reviewDrafts['/pr/review/comment/delete'],
      perform: (service, normalized, resolved) => service.deleteReviewComment({ providerTarget: resolved.providerTarget, ...normalized }),
      reconcile: unknownOutcome,
    },
    '/pr/review/discard': {
      ...reviewDrafts['/pr/review/discard'],
      perform: (service, _normalized, resolved) => service.discardReview({ providerTarget: resolved.providerTarget }),
      reconcile: unknownOutcome,
    },
    '/pr/state': setState('change-request-state', 'setChangeRequestState'),
    '/issues/state': setState('issue-state', 'setIssueState'),
    '/pr/labels': setNames('change-request-labels', 'labels'),
    '/issues/labels': setNames('issue-labels', 'labels'),
    '/pr/reviewers': setNames('change-request-reviewers', 'reviewers'),
  };
}

type PresentedUser = GitLabUser & { provider: string; instance: string };
type StatusCli = { available: boolean; disabled: boolean; active: boolean; user?: PresentedUser };
type StatusAccount = ReturnType<typeof accountView> | ReturnType<typeof cliAccountView>;
type AccountStatus = {
  provider: string; instance: string; status: string; connected: boolean;
  accounts: StatusAccount[]; cli?: StatusCli; user?: PresentedUser; scope?: string; reason?: string; message?: unknown;
};
type CliState = { status: 'disabled' | 'gone' | 'unknown' } | { status: 'usable'; token: string; user: GitLabUser };

export function createProvider(options: GitLabProviderOptions) {
  const {
    descriptor = gitlabDescriptor,
    authStore,
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
  } = options;
  const store = options.store === undefined
    ? authStore?.section instanceof Function ? authStore.section('gitlab') : options.authStore
    : options.store;
  const getClientId = (origin: string) => resolveGitLabClientId(origin, readSettings);
  const glabToken = (origin: string) => getGlabToken(origin, { execFile, timeoutMs: cliTimeoutMs });
  const verify = (origin: string, token: string | undefined) => verifyGitLabToken({ origin, token, fetch: fetchImpl, timeoutMs });
  const identityFor = (origin: string, accountId: string) => ({ provider: descriptor.id, instance: origin, accountId });

  const announceConnectedAccount = async (origin: string, credential: Pick<AuthCredential, 'credentialId' | 'credentialRevision' | 'providerUserId'> | null | undefined, user: GitLabUser) => {
    if (!credential?.credentialId) return;
    const account = identityFor(origin, credential.credentialId);
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

  const invalidateAccount = async ({ instance: origin, accountId, persisted = true, renew = true }: Account & { persisted?: boolean; renew?: boolean }) => {
    if (!persisted) {
      await events.invalidated(identityFor(origin, accountId));
      return false;
    }
    if (renew && await store.renewAccount?.(origin, accountId)) return true;
    await events.invalidated(identityFor(origin, accountId));
    await store.markAccountInvalid(origin, accountId, 'unauthorized');
    return false;
  };

  const getGlabCliState = async (origin: string): Promise<CliState> => {
    const instance = await store.readInstance(origin);
    if (instance.cliDisabled) return { status: 'disabled' };
    const lookup = await getGlabTokenResult(origin, { execFile, timeoutMs: cliTimeoutMs });
    if (lookup.gone) return { status: 'gone' };
    if (lookup.unknown) return { status: 'unknown' };
    try {
      return { status: 'usable', token: lookup.token, user: await verify(origin, lookup.token) };
    } catch (error) {
      return hasFailureFields(error) && error.status === 401 ? { status: 'gone' } : { status: 'unknown' };
    }
  };

  const getUsableGlab = async (origin: string) => {
    const state = await getGlabCliState(origin);
    return state.status === 'usable' ? { token: state.token, user: state.user } : null;
  };

  const buildStatus = async (origin: string, renewed = false): Promise<AccountStatus> => {
    const instance = await store.readInstance(origin);
    const activeRecord = instance.cliActive ? null : instance.accounts.find((account) => account.id === instance.activeAccountId) ?? null;
    const active = activeRecord?.status === 'invalid' ? null : activeRecord;
    const cliState = await getGlabCliState(origin);
    if (instance.cliActive && cliState.status === 'gone') {
      await store.setCliActive(origin, false);
      return buildStatus(origin);
    }
    const cli = cliState.status === 'usable' ? { token: cliState.token, user: cliState.user } : null;
    const cliCurrent = Boolean(cli && instance.cliActive);
    const accounts: StatusAccount[] = instance.accounts.map((account) => accountView(
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
        if (instance.cliDisabled || instance.cliActive) {
          return {
            provider: 'gitlab', instance: origin, status: 'disconnected', connected: false,
            accounts, cli: { available: false, disabled: instance.cliDisabled, active: instance.cliActive },
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
      const cliStatus: StatusCli = { available: Boolean(cli), disabled: instance.cliDisabled, active: false };
      const status = {
        provider: 'gitlab', instance: origin, status: 'connected', connected: true,
        user: { ...user, provider: 'gitlab', instance: origin }, scope: active.scope, accounts,
        cli: cliStatus,
      };
      if (cli) status.cli.user = { ...cli.user, provider: 'gitlab', instance: origin };
      return status;
    } catch (error) {
      const kind = classifyGitLabFailure(error);
      if (hasFailureFields(error) && error.kind === 'invalid-token') {
        const renewedNow = await invalidateAccount({ instance: origin, accountId: active.id, renew: !renewed });
        return buildStatus(origin, renewedNow);
      }
      return { provider: 'gitlab', instance: origin, status: kind, connected: false, message: hasFailureFields(error) ? error.message : undefined, accounts };
    }
  };

  const tokens = new WeakMap<ProviderSession, string>();
  const sessionWith = (fields: ProviderSession, token: string) => {
    const session = Object.freeze(fields);
    tokens.set(session, token);
    return session;
  };

  const resolveAccount = async ({ instance: origin, accountId: requestedAccountId = '' }: Instance & { accountId?: string }) => {
    const instance = await store.readInstance(origin);
    let active = null;
    let token = null;
    let accountId = requestedAccountId;
    let persisted = false;
    let credentialRevision = null;
    let providerUserId = '';
    let secretKind: ProviderSession['secretKind'] = 'oauth';
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
          if (hasFailureFields(error) && error.kind === 'invalid-token') await events.invalidated(identityFor(origin, requestedAccountId));
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
      type Unavailable = Error & { status: number; sourceControlAccountUnavailable: boolean; sourceControlIdentity?: AccountIdentity };
      const error: Unavailable = Object.assign(new Error('GitLab is not connected'), { status: 401, sourceControlAccountUnavailable: true });
      if (requestedAccountId) error.sourceControlIdentity = identityFor(origin, requestedAccountId);
      throw error;
    }
    if (active) secretKind = active.source === 'pat' ? 'pat' : 'oauth';
    return sessionWith({ instance: origin, accountId, credentialRevision, providerUserId, secretKind, persisted }, token);
  };

  const services = new WeakMap<ProviderSession, Service>();
  const serviceFor = (session: ProviderSession, { canonicalReads = true } = {}) => {
    const cached = services.get(session);
    if (cached) return cached;
    const tokenType = session.secretKind === 'pat' ? 'token' : 'oauth';
    const token = tokens.get(session);
    const resourceOptions: GitLabResourceOptions = {
      origin: session.instance,
      client: createClient({ origin: session.instance, token, tokenType }),
      download: createDownloader({ origin: session.instance, token, tokenType }),
      canonicalReads,
      providerUserId: session.providerUserId,
    };
    if (resolveProjects) resourceOptions.resolveProjects = resolveProjects;
    const service = createResourceService(resourceOptions);
    const identity = identityFor(session.instance, session.accountId);
    const methods: Record<string, (...args: never[]) => Promise<object | void>> = service;
    for (const method of Object.keys(methods)) {
      const operation = methods[method];
      if (!(operation instanceof Function)) continue;
      methods[method] = async (...args: never[]) => {
        try {
          return await operation(...args);
        } catch (error) {
          const target: { sourceControlIdentity?: AccountIdentity; sourceControlPersistedAccount?: boolean } = Object(error);
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

  const mutations = mutationTable(descriptor);
  const mutationFor = <K extends Route>(route: K) => {
    const entry = mutations[route];
    if (!entry) throw invalidMutationContext('Source control mutation is unsupported');
    return entry;
  };
  const projectSelector = (sourceRepo: PatchRead['sourceRepo']) => (sourceRepo ? { owner: sourceRepo.owner, name: sourceRepo.repo } : undefined);

  return Object.freeze({
    descriptor,
    classifyFailure: classifyGitLabFailure,
    auth: Object.freeze({
      capabilities: async ({ instance: origin }: Instance) => {
        const clientId = await getClientId(origin);
        const probe = await probeGitLabAuth({ origin, clientId, fetch: fetchImpl, timeoutMs, glabAvailable: false });
        const cliAvailable = probe.confirmed && Boolean(await getUsableGlab(origin));
        const cli = cliAvailable ? { available: true } : { available: false, reason: 'cli-unavailable' };
        return {
          authentication: probe.confirmed && (probe.device.available || probe.pat.available || cli.available),
          authenticationMethods: { device: probe.device, pat: probe.pat, cli },
        };
      },
      status: ({ instance }: Instance) => buildStatus(instance),
      accounts: async ({ instance: origin }: Instance) => {
        const instance = await store.readInstance(origin);
        return instance.accounts.map((account) => accountView(
          origin, account, account.id === instance.activeAccountId && !instance.cliActive, instance.accounts,
        ));
      },
      startDeviceFlow: async ({ instance: origin }: Instance) => {
        const clientId = await getClientId(origin);
        if (!clientId) throw responseError(400, { error: 'GitLab OAuth client is not configured', status: 'invalid-client' });
        const payload = await startGitLabDeviceFlow({ origin, clientId, fetch: fetchImpl, timeoutMs });
        type PublicFlow = { userCode: string; verificationUri: string; expiresIn: number; interval: number; verificationUriComplete?: string };
        const result: PublicFlow = {
          userCode: payload.user_code,
          verificationUri: payload.verification_uri,
          expiresIn: payload.expires_in,
          interval: payload.interval,
        };
        if (isString(payload.verification_uri_complete)) result.verificationUriComplete = payload.verification_uri_complete;
        return { flow: { deviceCode: payload.device_code, clientId, expiresIn: payload.expires_in }, result };
      },
      completeDeviceFlow: async ({ instance: origin, deviceCode, clientId }: Instance & { deviceCode: string; clientId: string }, { consume }: { consume(): void }) => {
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
      connectToken: async ({ instance: origin, token }: Instance & { token: string }) => {
        const user = await verify(origin, token);
        const credential = await store.setAccount(origin, { token, user, source: 'pat' });
        await announceConnectedAccount(origin, credential, user);
        return { connected: true, user };
      },
      activate: async ({ instance: origin, accountId }: Account) => {
        if (accountId.startsWith(`${origin}#cli:`)) {
          const usable = await getUsableGlab(origin);
          if (!usable || accountId !== `${origin}#cli:${usable.user.id}`) throw responseError(404, { error: 'GitLab CLI account not found' });
          await store.setCliActive(origin, true);
          return buildStatus(origin);
        }
        if (!accountId || !(await store.activate(origin, accountId))) throw responseError(404, { error: 'GitLab account not found' });
        return buildStatus(origin);
      },
      setCliDisabled: async ({ instance: origin, disabled }: Instance & { disabled: boolean }) => {
        const nextDisabled = await store.setCliDisabled(origin, disabled);
        const usable = await getUsableGlab(origin);
        return { available: Boolean(usable), disabled: nextDisabled };
      },
      remove: async ({ instance: origin, accountId }: Account) => {
        const instance = await store.readInstance(origin);
        if (accountId.startsWith(`${origin}#cli:`)) {
          const cli = await getUsableGlab(origin);
          if (!cli || `${origin}#cli:${cli.user.id}` !== accountId) return { removed: false };
          await events.removed(identityFor(origin, accountId));
          await store.setCliActive(origin, false);
          return { removed: true };
        }
        if (!instance.accounts.some((account) => account.id === accountId)) return { removed: false };
        await events.removed(identityFor(origin, accountId));
        return { removed: await store.removeAccount(origin, accountId) };
      },
      resolveAccount,
      invalidateAccount,
      refreshOAuthToken: async ({ instance: origin, refreshToken }: Instance & { refreshToken: string }) => refreshGitLabAccessToken({
        origin, refreshToken, clientId: await getClientId(origin), fetch: fetchImpl, timeoutMs,
      }),
      readCurrentAccountId: async ({ instance: origin }: Instance) => {
        const instance = await store.readInstance(origin);
        const cli = instance.cliActive ? await getUsableGlab(origin) : null;
        if (cli) return `${origin}#cli:${cli.user.id}`;
        return instance.accounts.find((account) => account.id === instance.activeAccountId && account.status !== 'invalid')?.id ?? null;
      },
      listInstances: async () => (await store.listInstances?.()) ?? [],
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
      ownsHost: ownedOriginInstance,
    }),
    transport: Object.freeze({
      readCredential: async ({ instance, credentialId, credentialRevision }: Instance & { credentialId: string; credentialRevision?: number }) => {
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
      changeRequestStatus: ({ session, directory, branch, remote }: ReadInput & { branch: string }) => serviceFor(session)
        .changeRequestStatus(directory, branch, remote),
      listChangeRequests: ({ session, directory, page, query, state, people, labels, remote }: ReadInput & NonNullable<Parameters<Service['listChangeRequests']>[1]>) => serviceFor(session)
        .listChangeRequests(directory, { page, query, state, people, labels, remote }),
      reviewState: ({ session, directory, project, number, remote }: NumberedRead) => serviceFor(session).reviewState(directory, number, project, remote),
      changeRequestContext: ({ session, context, directory, number, project, remote, includeDiff, includeCIDetails, includeTimeline }: NumberedRead & LinkedRead & NonNullable<Parameters<Service['changeRequestContext']>[2]>) => serviceFor(session)
        .changeRequestContext(directory, number, {
          includeDiff, includeCIDetails, includeTimeline, project, remote, constrainToPrimary: true, linked: context?.linked,
        }),
      listIssues: ({ session, directory, page, query, state, people, labels, remote }: ReadInput & NonNullable<Parameters<Service['listIssues']>[1]>) => serviceFor(session)
        .listIssues(directory, { page, query, state, people, labels, remote }),
      getIssue: ({ session, context, directory, number, project, remote }: NumberedRead & LinkedRead) => serviceFor(session).getIssue(directory, number, project, remote, { linked: context?.linked }),
      issueComments: ({ session, context, directory, number, project, remote }: NumberedRead & LinkedRead) => serviceFor(session).issueComments(directory, number, project, remote, { linked: context?.linked }),
      projectUpstream: ({ session, directory, remote }: ReadInput) => serviceFor(session).projectUpstream(directory, remote),
      projectBranches: ({ session, directory, project, remote }: ProjectRead) => serviceFor(session).projectBranches(directory, project, remote),
      listLabels: ({ session, directory, project, remote }: ProjectRead) => serviceFor(session).listLabels(directory, project, remote),
      listReviewerCandidates: ({ session, directory, project, remote }: ProjectRead) => serviceFor(session).listReviewerCandidates(directory, project, remote),
      readUpload: ({ session, context, directory, project, remote, secret, filename, range, signal }: ProjectRead & LinkedRead & Parameters<Service['readUpload']>[3]) => serviceFor(session)
        .readUpload(directory, project, remote, { secret, filename, range, signal, linked: context?.linked }),
      readChangeRequestPatch: ({ session, directory, number, sourceRepo, remote, linked }: PatchRead) => serviceFor(session)
        .changeRequestPatch(directory, number, { project: projectSelector(sourceRepo), remote, linked }),
      readChangeRequestFile: ({ session, directory, number, sourceRepo, remote, path, previousPath, status, binary, linked }: PatchRead & Pick<Parameters<Service['changeRequestFileContents']>[2], 'path' | 'previousPath' | 'status' | 'binary'>) => serviceFor(session)
        .changeRequestFileContents(directory, number, { project: projectSelector(sourceRepo), remote, path, previousPath, status, binary, linked }),
      liveSummaries: ({ session, refs, issueRefs, details }: { session: ProviderSession } & Parameters<Service['liveSummaries']>[0]) => serviceFor(session, { canonicalReads: false }).liveSummaries({ refs, issueRefs, details }),
      readChangeRequestHead: async ({ session, directory, remote, number }: NumberedRead) => {
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
      resolveChangeRequestSource: async ({ session, context, project, number, expectedHeadSha, requestedRemoteName }: NumberedRead & {
        context: ProviderReadContext;
        project: SourceControlMutationTarget['project'];
        expectedHeadSha: string;
        requestedRemoteName: string;
      }) => {
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
        const parsed = new URL(String(endpoint));
        if (endpoint === undefined || parsed.origin !== origin.origin
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
      prepare: <K extends Route>({ route, input, context, actor, credential }: PrepareInput<K>) => {
        const entry = mutationFor(route);
        const normalized = entry.normalize(input, context);
        return {
          kind: entry.kind,
          input: normalized,
          digest: (target: SourceControlMutationTarget) => digestMutationInput({ kind: entry.kind, actor, credential, target, ...normalized.digest }),
        };
      },
      resolveTarget: (step: ResolveInput) => {
        const service = serviceFor(step.session);
        if (isCreate(step)) return service.resolveCreateMutation(step.context, step.context.target, step.input);
        const { context, kind, replayOf } = step;
        if (replayOf) {
          return {
            providerTarget: { projectId: replayOf.target.project.id, number: replayOf.target.number },
            target: replayOf.target,
          };
        }
        if (kind.startsWith('issue-')) return service.resolveIssueMutation(context, context.target);
        return service.resolveChangeRequestMutation(context, context.target);
      },
      perform: <K extends Route>({ session, route, input, resolved }: MutationStep<K>) => mutationFor(route).perform(serviceFor(session), input, resolved),
      reconcile: <K extends Route>({ session, route, input, resolved }: MutationStep<K>) => mutationFor(route).reconcile(serviceFor(session), resolved, input),
    }),
  });
}
