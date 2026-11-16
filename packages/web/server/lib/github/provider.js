import { githubDescriptor } from './descriptor.js';
import {
  getGhCliLoginForHost,
  getGitHubAuthAccounts,
  getGitHubAuthByAccountId,
  getGitHubAuthForHost,
  githubCliAccountId,
  isGhCliActiveForHost,
  isGhCliDisabledForHost,
  markGitHubAuthAccountInvalidForHost,
} from './auth.js';
import { getGhCliToken } from './gh-cli-credential.js';
import { listTrustedGitHubHosts } from './host-trust.js';
import { createGitHubAccounts } from './accounts.js';
import { createGitHubMutations } from './mutations.js';
import { createGitHubResources } from './resources.js';

const GITHUB_COM = 'github.com';

const loadModules = async () => {
  const [octokit, summaries, rateLimit, patch, prStatus, checks, repo, forks, git] = await Promise.all([
    import('./octokit.js'),
    import('./pr-summaries.js'),
    import('./rate-limit.js'),
    import('./change-request-patch.js'),
    import('./pr-status.js'),
    import('./checks-summary.js'),
    import('./repo/index.js'),
    import('./repo/fork-detection.js'),
    import('../git/index.js'),
  ]);
  return { octokit, summaries, rateLimit, patch, prStatus, checks, repo, forks, git };
};

const accountUnavailable = (instance, accountId) => {
  const error = Object.assign(new Error('GitHub account is unavailable'), {
    status: 401,
    sourceControlAccountUnavailable: true,
  });
  if (accountId) error.sourceControlIdentity = { provider: 'github', instance, accountId };
  return error;
};

const classifyFailure = (error) => {
  if (error?.code === 'ETIMEDOUT' || error?.name === 'TimeoutError') return 'temporarily-unavailable';
  if (error?.kind === 'invalid-token' || (error?.status ?? error?.response?.status) === 401) return 'invalid-token';
  return 'provider-error';
};

export function createProvider({
  descriptor = githubDescriptor,
  authStore,
  events,
  fetch: fetchImpl,
  timeoutMs,
  modules = loadModules,
  resolveGitHubRepoFromDirectory,
  resolveRepoNetwork,
  resolveGitHubPrStatus,
  readContributorProvenance,
}) {
  const enterprise = authStore?.github ?? null;
  const enterpriseHosts = async () => (await enterprise?.listInstances?.()) ?? [];
  const identityFor = (instance, accountId) => ({ provider: descriptor.id, instance, accountId });

  const sessions = new WeakMap();
  const accountOf = (session) => {
    const account = sessions.get(session);
    if (!account) throw accountUnavailable(session?.instance, session?.accountId);
    return account;
  };
  const sessionFor = (fields, account) => {
    const session = Object.freeze(fields);
    sessions.set(session, account);
    return session;
  };

  const resolveAccount = async ({ instance, accountId = '', orCurrent = false }) => {
    const host = String(instance ?? '').trim().toLowerCase() || GITHUB_COM;
    const { octokit: github } = await modules();
    if (accountId) {
      const account = await github.getOctokitForAccountId(accountId, {
        onUnauthorized: async (identity, persisted) => {
          if (!persisted) await events?.invalidated(identity);
        },
      });
      const accountHost = account?.octokit?.openChamberHost;
      if (account && (!accountHost || accountHost === host)) {
        return sessionFor({
          instance: host,
          accountId,
          credentialRevision: account.credentialRevision,
          providerUserId: account.providerUserId,
          secretKind: account.source === 'cli' ? 'cli' : account.source === 'pat' ? 'pat' : 'oauth',
          persisted: account.source !== 'cli',
        }, { octokit: account.octokit, user: account.user ?? null });
      }
      if (!orCurrent) throw accountUnavailable(host, accountId);
    }
    const octokit = await github.getOctokitOrNull(host === GITHUB_COM ? '' : host);
    if (!octokit) throw accountUnavailable(host, accountId);
    const current = await getGitHubAuthForHost(host);
    return sessionFor({
      instance: host, accountId: '', credentialRevision: null, providerUserId: '', secretKind: 'oauth', persisted: false,
    }, { octokit, user: current?.user ?? null });
  };

  const invalidateAccount = async ({ instance, accountId, persisted = true }) => {
    await events?.invalidated(identityFor(instance, accountId));
    if (persisted) await markGitHubAuthAccountInvalidForHost(instance, accountId, 'unauthorized');
    return false;
  };

  const resolveRepo = async (directory, remote) => (resolveGitHubRepoFromDirectory
    ?? (await modules()).repo.resolveGitHubRepoFromDirectory)(directory, remote);
  const resolveNetwork = async (octokit, directory, remote, options) => (resolveRepoNetwork
    ?? (await modules()).forks.resolveRepoNetwork)(octokit, directory, remote, options);

  const resources = createGitHubResources({
    load: modules,
    accountOf,
    resolveRepo,
    resolveNetwork,
    resolvePrStatus: async (input) => (resolveGitHubPrStatus ?? (await modules()).prStatus.resolveGitHubPrStatus)(input),
    readContributorProvenance,
    invalidateAccount: (identity, persisted) => invalidateAccount({ ...identity, persisted }),
  });
  const mutations = createGitHubMutations({
    descriptor,
    octokitOf: (session) => accountOf(session).octokit,
    resolveRepo,
    resolveNetwork,
    invalidatePulls: async (owner, repo, octokit) => (await modules()).prStatus.invalidateRepoPullsCache(owner, repo, octokit),
    onSucceeded: ({ session, target }) => resources.invalidateContexts({
      accountId: session.accountId,
      credentialRevision: session.credentialRevision,
      repositoryId: target.repositoryId,
      bindingRevision: target.bindingRevision,
      primaryRemote: target.primaryRemote,
      number: target.number,
    }),
  });
  const accounts = createGitHubAccounts({
    createOctokit: async () => (await modules()).octokit.createOctokit,
    events,
    fetch: fetchImpl,
    timeoutMs,
  });

  const readCurrentAccountId = async ({ instance }) => {
    const host = String(instance ?? '').trim().toLowerCase().replace(/\.$/, '') || GITHUB_COM;
    if (await isGhCliActiveForHost(host) && !(await isGhCliDisabledForHost(host))) {
      const token = await getGhCliToken(host, await getGhCliLoginForHost(host));
      if (token) {
        const { octokit: github } = await modules();
        try {
          const { data } = await github.createOctokit(token, '', host).rest.users.getAuthenticated();
          return host === GITHUB_COM ? githubCliAccountId(data.id) : `${host}#cli:${data.id}`;
        } catch (error) {
          if (error?.status === 401) return null;
          throw error;
        }
      }
    }
    return (await getGitHubAuthForHost(host))?.accountId ?? null;
  };

  return Object.freeze({
    descriptor,
    classifyFailure,
    auth: Object.freeze({
      capabilities: accounts.capabilities,
      status: accounts.status,
      accounts: accounts.accounts,
      startDeviceFlow: accounts.startDeviceFlow,
      completeDeviceFlow: accounts.completeDeviceFlow,
      connectToken: accounts.connectToken,
      activate: accounts.activate,
      setCliDisabled: accounts.setCliDisabled,
      remove: accounts.remove,
      resolveAccount,
      invalidateAccount,
      readCurrentAccountId,
      listInstances: async () => [...new Set([...listTrustedGitHubHosts(), ...await enterpriseHosts()])],
      listConnectedAccounts: async () => {
        const connected = [];
        const add = (instance, account) => {
          if (account?.status !== 'valid' || !account.credentialId) return;
          connected.push({
            account: identityFor(instance, account.credentialId),
            user: account.user,
            credential: { credentialRevision: account.credentialRevision, providerUserId: account.providerUserId },
          });
        };
        for (const account of await getGitHubAuthAccounts()) add(GITHUB_COM, account);
        for (const host of await enterpriseHosts()) {
          for (const account of (await enterprise.readInstance(host))?.accounts ?? []) add(host, account);
        }
        return connected;
      },
      ownsHost: ({ host, knownInstances }) => {
        const name = String(host ?? '').toLowerCase();
        return name === GITHUB_COM || knownInstances.includes(name) ? name : null;
      },
    }),
    transport: Object.freeze({
      readCredential: async ({ instance, credentialId, credentialRevision }) => {
        const host = String(instance ?? '').toLowerCase();
        const cliHost = /^([^#]+)#cli:/.exec(credentialId ?? '')?.[1]?.toLowerCase();
        if (!host || (cliHost !== undefined && cliHost !== host)) return null;
        const account = await getGitHubAuthByAccountId(credentialId, credentialRevision)
          ?? await (await modules()).octokit.getGitHubCliCredential(credentialId, credentialRevision);
        if (!account || !String(account.providerUserId ?? '').startsWith(`${host}#`)) return null;
        return {
          credentialId: account.credentialId,
          credentialRevision: account.credentialRevision,
          providerUserId: account.providerUserId,
          status: account.status,
          source: account.source,
          user: account.user,
          secret: account.accessToken,
        };
      },
    }),
    resources: Object.freeze({
      changeRequestStatus: resources.changeRequestStatus,
      listChangeRequests: resources.listChangeRequests,
      changeRequestContext: resources.changeRequestContext,
      listIssues: resources.listIssues,
      getIssue: resources.getIssue,
      issueComments: resources.issueComments,
      projectUpstream: resources.projectUpstream,
      projectBranches: resources.projectBranches,
      listLabels: resources.listLabels,
      listReviewerCandidates: resources.listReviewerCandidates,
      references: resources.references,
      referencesAcross: ({ body, validateReadContext }) => resources.referencesAcross({
        body,
        validateReadContext,
        resolveSession: (context) => resolveAccount({ instance: context.instance, accountId: context.accountId }),
      }),
      referenceDetail: resources.referenceDetail,
      reviewState: resources.reviewState,
      referenceStatuses: resources.referenceStatuses,
      readChangeRequestHead: resources.readChangeRequestHead,
      resolveChangeRequestSource: resources.resolveChangeRequestSource,

      liveSummaries: async ({ session, refs = [], issueRefs = [], discussionRefs = [], details = false }) => {
        const { summaries: { fetchPrSummaries, isGraphqlRateLimitError }, rateLimit } = await modules();
        const host = session.instance;
        if (rateLimit.isGitHubRateLimited(host)) return { status: 'unavailable' };
        try {
          return await fetchPrSummaries({ octokit: accountOf(session).octokit, refs, issueRefs, discussionRefs, details });
        } catch (error) {
          if ((error?.status ?? error?.response?.status) === 401) return { status: 'disconnected' };
          if (isGraphqlRateLimitError(error) || rateLimit.isGitHubRateLimitError(error)) {
            rateLimit.noteGitHubRateLimit(error, host);
            return { status: 'unavailable' };
          }
          throw error;
        }
      },

      readChangeRequestPatch: async (input) => (await modules()).patch.readGitHubChangeRequestPatch(input, {
        onAccountUnavailable: events?.invalidated,
      }),
      readChangeRequestFile: async (input) => (await modules()).patch.readGitHubChangeRequestFile(input, {
        onAccountUnavailable: events?.invalidated,
      }),
    }),
    mutations: Object.freeze({
      routes: mutations.routes,
      prepare: mutations.prepare,
      resolveTarget: mutations.resolveTarget,
      perform: mutations.perform,
      reconcile: mutations.reconcile,
      afterSuccess: mutations.afterSuccess,
      classifyError: mutations.classifyError,
      presentError: mutations.presentError,
    }),
  });
}
