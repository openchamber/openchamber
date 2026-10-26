import { githubDescriptor } from './descriptor.js';
import {
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

/**
 * GitHub as a source-control provider implementation behind the shared route
 * shell (`source-control/provider-routes.js`): accounts per instance
 * (`accounts.js`), bound reads answering neutral DTOs (`resources.js`), and
 * durable mutations with GitHub's own kinds and digests (`mutations.js`).
 *
 * A session is the exact account a request acts as. Its Octokit stays in this
 * module (`accountOf`), never in the JSON the shell sees. Octokit and the
 * libraries that use it load on first use (`modules`); tests pass fakes, and
 * the repository lookups the routes always let tests replace.
 */
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

/** A failure kind for the shell: a timeout is transient, a refused token is the account's, anything else GitHub's. */
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

  // The Octokit and stored user behind each session the shell holds.
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

  /**
   * The exact account a read or write acts as: a stored credential (on any
   * instance), or the gh login while the user switched to it on its host.
   * Without an account, or with `orCurrent` when the named one no longer
   * resolves, the instance's current credential. A gh login GitHub refuses or
   * that turned into another user is reported invalidated here; a stored
   * account's refusal is the caller's to report.
   */
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

  /** Bindings let go first; a stored account is then marked invalid, a gh login only reported. */
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

  /**
   * The account GitHub reads on an instance use when none is named: its gh
   * login while the user switched to it, else its active stored credential.
   * Only a refused gh token means "no account"; a network failure must not
   * read as one, or another account answers.
   */
  const readCurrentAccountId = async ({ instance }) => {
    const host = String(instance ?? '').trim().toLowerCase().replace(/\.$/, '') || GITHUB_COM;
    if (await isGhCliActiveForHost(host) && !(await isGhCliDisabledForHost(host))) {
      const token = await getGhCliToken(host);
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
      /** GitHub Enterprise hosts the user can work with: gh is signed in to one, or a per-host PAT is stored. */
      listInstances: async () => [...new Set([...listTrustedGitHubHosts(), ...await enterpriseHosts()])],
      /** Every valid stored account: github.com's device-flow accounts and each enterprise host's. */
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
      /** github.com, or an enterprise host the user already works with. */
      ownsHost: ({ host, knownInstances }) => {
        const name = String(host ?? '').toLowerCase();
        return name === GITHUB_COM || knownInstances.includes(name) ? name : null;
      },
    }),
    transport: Object.freeze({
      /**
       * The exact stored credential (github.com or an enterprise host), else
       * the gh login the user switched to, as a neutral transport credential.
       * Credential ids are looked up across every host, so the answer must
       * belong to the asked instance: an enterprise token is never handed out
       * for github.com, nor the other way round.
       */
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
      referenceStatuses: resources.referenceStatuses,
      readChangeRequestHead: resources.readChangeRequestHead,
      resolveChangeRequestSource: resources.resolveChangeRequestSource,

      /**
       * Live state of known pull requests, issues and discussions for tracked
       * items, read with the session's Octokit. Rate limits and a refused
       * token are this host's alone and come back as `{ status }`: the
       * per-host cooldown answers `unavailable`, a 401 answers `disconnected`.
       */
      liveSummaries: async ({ session, refs = [], issueRefs = [], discussionRefs = [] }) => {
        const { summaries: { fetchPrSummaries, isGraphqlRateLimitError }, rateLimit } = await modules();
        const host = session.instance;
        if (rateLimit.isGitHubRateLimited(host)) return { status: 'unavailable' };
        try {
          return await fetchPrSummaries({ octokit: accountOf(session).octokit, refs, issueRefs, discussionRefs });
        } catch (error) {
          if ((error?.status ?? error?.response?.status) === 401) return { status: 'disconnected' };
          if (isGraphqlRateLimitError(error) || rateLimit.isGitHubRateLimitError(error)) {
            rateLimit.noteGitHubRateLimit(error, host);
            return { status: 'unavailable' };
          }
          throw error;
        }
      },

      // A pull request's diff and one file's two sides for the comparison
      // view and walkthroughs. An exact-account 401 tells the registry, which
      // lets bindings go of the account.
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
