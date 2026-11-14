import {
  GH_CLI_ACCOUNT_ID,
  activateGitHubAuthForHost,
  getGhCliLoginForHost,
  getGitHubAuthAccountsForHost,
  getGitHubAuthByAccountId,
  getGitHubAuthForHost,
  getGitHubClientId,
  getGitHubScopes,
  isGhCliActiveForHost,
  isGhCliDisabledForHost,
  markGitHubAuthAccountInvalidForHost,
  removeGitHubAuthAccountForHost,
  setGhCliActiveForHost,
  setGhCliDisabledForHost,
  setGitHubAuthForHost,
} from './auth.js';
import { exchangeDeviceCode, startDeviceFlow } from './device-flow.js';
import { getGhCliToken } from './gh-cli-credential.js';
import { findGhCliLogin, readGhCliLogins } from './gh-cli-logins.js';
import { hasStoredGhLogin, isTrustedGitHubHostOrStored, storedGhLoginUser } from './host-trust.js';
import { isProviderString, mapAccount, mapUser } from './mappers.js';
import { gitHubRefusalMessage, responseError } from './resources.js';

/**
 * GitHub's accounts behind the shared route shell, per instance: github.com
 * with OpenChamber's device flow and the Settings gh switch, and each GitHub
 * Enterprise host with its personal access tokens and its own gh switch.
 * Every answer is the neutral auth shape (`SourceControlAuthStatus`).
 *
 * `createOctokit` builds a host-pinned client for a token (`octokit.js`,
 * loaded lazily); `events` receives account lifecycle reports.
 */

const GITHUB_COM = 'github.com';
const CLI_ACCOUNT_RE = /^([^#]+)#cli:(\d+)$/;

const hostCliAccount = (host, user, current, usable) => ({
  id: `${host}#cli:${user.id}`,
  credentialId: `${host}#cli:${user.id}`,
  credentialRevision: 1,
  providerUserId: `${host}#${user.id}`,
  providerUserStatus: 'available',
  user,
  current,
  source: 'cli',
  status: 'valid',
  // `usable` says the server would answer with this login now: its host's switch
  // is on and gh holds it, which is the consent every exact lookup re-checks. It
  // is a separate flag from `current` because a host can have several gh logins
  // while only one of them is the one an unbound use falls back to.
  usable,
});

/** A storage file the server cannot read is an answer of its own, never an empty inventory. */
const guardStorage = (operation) => async (...args) => {
  try {
    return await operation(...args);
  } catch (error) {
    if (error?.code === 'INVALID_GITHUB_AUTH') throw responseError(500, { error: error.message, code: error.code });
    throw error;
  }
};

export function createGitHubAccounts({ createOctokit, events, fetch: fetchImpl, timeoutMs }) {
  const identityOf = (instance) => ({ provider: 'github', instance });

  const userSummary = async (octokit) => {
    const me = await octokit.rest.users.getAuthenticated();
    let email = me.data.email ?? null;
    if (!email) {
      try {
        const emails = await octokit.rest.users.listEmailsForAuthenticatedUser({ per_page: 100 });
        const list = Array.isArray(emails?.data) ? emails.data : [];
        email = (list.find((entry) => entry?.primary && entry.verified && entry.email)
          ?? list.find((entry) => entry?.verified && entry.email))?.email ?? null;
      } catch {
        // The scope may be missing.
      }
    }
    return {
      login: me.data.login,
      id: me.data.id,
      avatarUrl: me.data.avatar_url,
      name: isProviderString(me.data.name) ? me.data.name : null,
      email,
    };
  };
  const clientFor = async (token, accountId, host) => (await createOctokit())(token, accountId, host);

  /** The neutral auth answer for one instance. Connected means a user answered for the current credential. */
  const statusBody = (instance, { user = null, scope, accounts, cli }) => {
    const identity = identityOf(instance);
    const body = {
      provider: 'github',
      instance,
      status: user ? 'connected' : 'disconnected',
      connected: Boolean(user),
      accounts: accounts.map((account) => mapAccount(account, identity)),
    };
    if (user) body.user = mapUser(user, identity);
    if (user && scope) body.scope = scope;
    if (cli) {
      body.cli = { available: cli.available, disabled: cli.disabled, active: cli.active };
      if (cli.user) body.cli.user = mapUser(cli.user, identity);
    }
    return body;
  };

  /** Writes a stored account off after GitHub refused its token; bindings move first. */
  const invalidateStored = async (instance, accountId) => {
    await events.invalidated({ provider: 'github', instance, accountId });
    await markGitHubAuthAccountInvalidForHost(instance, accountId, 'unauthorized');
  };

  /**
   * github.com: the active device-flow account, or the gh login while the user
   * switched to it in Settings. The gh login is listed whenever gh answers.
   */
  const gitHubComStatus = async () => {
    const auth = await getGitHubAuthForHost(GITHUB_COM);
    let accounts = await getGitHubAuthAccountsForHost(GITHUB_COM);
    const cliDisabled = await isGhCliDisabledForHost(GITHUB_COM);
    const cliActive = await isGhCliActiveForHost(GITHUB_COM);
    const cliLogin = await getGhCliLoginForHost(GITHUB_COM);
    const ghToken = await getGhCliToken(GITHUB_COM, cliLogin);
    const ownToken = Boolean(auth?.accessToken);
    const selectedPersisted = accounts.some((account) => account.current);
    let cliUser = null;
    let cliRejected = false;
    if (ghToken !== null && !cliDisabled) {
      try {
        cliUser = await userSummary(await clientFor(ghToken, '', GITHUB_COM));
      } catch (error) {
        cliRejected = error?.status === 401;
      }
    }
    // The user's switch to the gh account is undone only when that account is
    // really gone: gh logged out, disabled here, or its token rejected. A
    // network blip leaves this read without a user but keeps the choice.
    if (cliActive && (ghToken === null || cliDisabled || cliRejected)) await setGhCliActiveForHost(GITHUB_COM, false);
    const cliCurrent = ghToken !== null && !cliDisabled && Boolean(cliUser) && cliActive;
    // Every login gh holds for the host, not only the active one, so a repository
    // can bind any of them without changing gh's own active account. The login
    // this instance is on answers with its (fully read) user; the others answer
    // with the identity the login resolved to. Only the switch makes them usable:
    // with it off the single row below is the offer that turns it on, and gh is
    // not asked about the other logins at all.
    const gitHubComSwitchOn = cliActive && !cliDisabled;
    const logins = gitHubComSwitchOn ? await readGhCliLogins(GITHUB_COM, { createOctokit: clientFor }) : [];
    if (logins.length) {
      const currentLogin = cliCurrent ? cliUser.login.toLowerCase() : null;
      accounts = accounts.map((account) => ({ ...account, current: cliCurrent ? false : Boolean(account.current) }))
        .concat(logins.map((entry) => {
          const current = currentLogin !== null && entry.login.toLowerCase() === currentLogin;
          return hostCliAccount(GITHUB_COM, current ? cliUser : entry.user, current, true);
        }));
    } else if (cliUser) {
      accounts = accounts.map((account) => ({ ...account, current: cliCurrent ? false : Boolean(account.current) }))
        .concat(hostCliAccount(GITHUB_COM, cliUser, cliCurrent, false));
    }
    const cli = (activeUser = null) => ({
      // gh holding a login is what makes the switch offerable, also while the
      // kill switch is on: that is the row that turns it back on.
      available: ghToken !== null,
      disabled: cliDisabled,
      active: cliCurrent,
      user: !cliDisabled ? activeUser || cliUser : null,
    });
    // A current-but-invalid saved account means disconnected only while it,
    // not the gh login, is the selected source.
    if (selectedPersisted && !ownToken && !cliCurrent) return statusBody(GITHUB_COM, { accounts, cli: cli() });
    const token = cliCurrent ? ghToken : auth?.accessToken;
    if (!token) return statusBody(GITHUB_COM, { accounts, cli: cli() });
    let user = null;
    try {
      user = await userSummary(await clientFor(token, cliCurrent ? '' : auth.accountId, GITHUB_COM));
    } catch (error) {
      if (error?.status === 401) {
        if (!cliCurrent && ownToken) await invalidateStored(GITHUB_COM, auth.accountId);
        return statusBody(GITHUB_COM, { accounts: await getGitHubAuthAccountsForHost(GITHUB_COM), cli: cli() });
      }
    }
    const merged = user || (ownToken ? auth.user : null);
    return statusBody(GITHUB_COM, {
      user: merged,
      scope: cliCurrent ? undefined : auth?.scope,
      accounts,
      cli: cli(cliCurrent ? merged : null),
    });
  };

  /**
   * A GitHub Enterprise host: its stored personal access token, or its gh
   * logins once the user activated that instance. While the instance's switch
   * is off the gh login is still listed, from hosts.yml alone, so the account
   * row can offer it without running gh or asking the host who it is; its id
   * is 0, which GitHub never assigns. Only an activated instance asks gh for
   * every login it holds, so each can be bound by a repository.
   */
  const enterpriseStatus = async (host) => {
    if (!(await isTrustedGitHubHostOrStored(host))) {
      return statusBody(host, { accounts: [], cli: { available: hasStoredGhLogin(host), disabled: false, active: false } });
    }
    const cliDisabled = await isGhCliDisabledForHost(host);
    const cliActive = await isGhCliActiveForHost(host);
    const available = cliDisabled ? false : hasStoredGhLogin(host);
    const cliLogin = await getGhCliLoginForHost(host);
    let cliUser = null;
    let logins = [];
    if (cliActive && !cliDisabled) {
      const token = await getGhCliToken(host, cliLogin);
      let rejected = false;
      if (token !== null) {
        try {
          cliUser = await userSummary(await clientFor(token, '', host));
        } catch (error) {
          rejected = error?.status === 401;
        }
      }
      // The activation is undone only when that account is really gone: gh
      // logged out or its token rejected. A network blip keeps the choice.
      if (!cliUser && (token === null || rejected)) {
        await setGhCliActiveForHost(host, false);
        return enterpriseStatus(host);
      }
      logins = await readGhCliLogins(host, { createOctokit: clientFor });
    }
    if (!cliActive && !cliUser && available) cliUser = storedGhLoginUser(host);
    const active = cliActive ? null : await getGitHubAuthForHost(host);
    const cliCurrent = Boolean(cliUser && cliActive);
    const currentLogin = cliCurrent ? cliUser.login.toLowerCase() : null;
    // Every login is a row of its own; the one the instance is on answers with
    // its fully read user and carries `current`. An instance whose switch is off
    // has no login rows from gh, only the hosts.yml placeholder below, and no row
    // is usable while the switch is off — that is the server's consent.
    const loginRows = logins.length
      ? logins.map((entry) => {
        const current = currentLogin !== null && entry.login.toLowerCase() === currentLogin;
        return hostCliAccount(host, current ? cliUser : entry.user, current, true);
      })
      : (cliUser ? [hostCliAccount(host, cliUser, cliCurrent, false)] : []);
    const accountsWith = async (current) => (await getGitHubAuthAccountsForHost(host))
      .map((account) => ({ ...account, current: current(account) }))
      .concat(loginRows);
    const cli = { available: cliCurrent || available, disabled: cliDisabled, active: cliCurrent, user: cliUser };
    if (cliCurrent) return statusBody(host, { user: cliUser, accounts: await accountsWith(() => false), cli });
    if (!active) return statusBody(host, { accounts: await accountsWith(() => false), cli });
    let user = null;
    let rejected = false;
    try {
      user = await userSummary(await clientFor(active.accessToken, active.accountId, host));
    } catch (error) {
      rejected = error?.status === 401;
    }
    if (!user) {
      if (rejected) await invalidateStored(host, active.accountId);
      return statusBody(host, { accounts: await accountsWith(() => false), cli: { ...cli, active: false } });
    }
    return statusBody(host, {
      user,
      scope: active.scope,
      accounts: await accountsWith((account) => account.id === active.accountId),
      cli,
    });
  };

  const status = ({ instance }) => (instance === GITHUB_COM ? gitHubComStatus() : enterpriseStatus(instance));

  const announceConnected = async (instance, credential, user) => {
    if (!credential?.credentialId) return;
    // Signing in again renews a credential rather than replacing it, so the
    // ones this supersedes are named too: whatever followed the old credential
    // is expected to keep working as the same account.
    const account = { provider: 'github', instance, accountId: credential.credentialId };
    const superseded = (await getGitHubAuthAccountsForHost(instance)).filter((candidate) =>
      candidate.providerUserId === credential.providerUserId && candidate.id !== credential.credentialId);
    await events.connected({
      account,
      user,
      credential: { credentialRevision: credential.credentialRevision, providerUserId: credential.providerUserId },
      renews: superseded.map((candidate) => ({ ...account, accountId: candidate.id })),
    });
  };

  return Object.freeze({
    /**
     * The device flow is github.com's: its URLs are github.com's, and a GHE
     * device flow would need a host-pinned operator OAuth app this server does
     * not implement. Any named host is a PAT candidate; naming it is the act
     * that makes it one. Its gh login is offered only where gh has one.
     */
    capabilities: async ({ instance }) => {
      const enterprise = instance !== GITHUB_COM;
      return {
        authentication: true,
        authenticationMethods: {
          device: enterprise ? { available: false, reason: 'invalid-client' } : { available: true },
          pat: enterprise ? { available: true } : { available: false, reason: 'unsupported' },
          cli: { available: enterprise ? hasStoredGhLogin(instance) : true },
        },
      };
    },
    status: guardStorage(status),
    accounts: guardStorage(async ({ instance }) => (await getGitHubAuthAccountsForHost(instance))
      .map((account) => mapAccount(account, identityOf(instance)))),

    startDeviceFlow: async ({ instance }) => {
      if (instance !== GITHUB_COM) throw responseError(400, { error: 'GitHub device flow is only available for github.com', status: 'invalid-client' });
      const clientId = getGitHubClientId();
      if (!clientId) throw responseError(400, { error: 'GitHub OAuth client not configured. Set OPENCHAMBER_GITHUB_CLIENT_ID.' });
      const scope = getGitHubScopes();
      const payload = await startDeviceFlow({ clientId, scope, fetch: fetchImpl, timeoutMs });
      const result = {
        userCode: payload.user_code,
        verificationUri: payload.verification_uri,
        expiresIn: payload.expires_in,
        interval: payload.interval,
        scope,
      };
      if (isProviderString(payload.verification_uri_complete)) result.verificationUriComplete = payload.verification_uri_complete;
      return { flow: { deviceCode: payload.device_code, clientId, expiresIn: payload.expires_in }, result };
    },
    /** `pending` keeps the flow pollable; anything else consumes it. */
    completeDeviceFlow: guardStorage(async ({ instance, deviceCode, clientId }, { consume }) => {
      const payload = await exchangeDeviceCode({ clientId, deviceCode, fetch: fetchImpl, timeoutMs });
      if (payload?.error) {
        const pending = payload.error === 'authorization_pending' || payload.error === 'slow_down';
        if (!pending) consume();
        return { pending, body: { connected: false, status: payload.error, error: payload.error_description || payload.error } };
      }
      consume();
      const accessToken = payload?.access_token;
      if (!accessToken) throw responseError(500, { error: 'Missing access_token from GitHub' });
      const user = await userSummary(await clientFor(accessToken, '', GITHUB_COM));
      const scope = isProviderString(payload.scope) ? payload.scope : '';
      const credential = await setGitHubAuthForHost(instance, {
        accessToken,
        scope,
        tokenType: isProviderString(payload.token_type) ? payload.token_type : 'bearer',
        user,
      });
      await announceConnected(instance, credential, user);
      return { pending: false, body: { connected: true, user: mapUser(user, identityOf(instance)), scope } };
    }),
    /**
     * A GitHub Enterprise personal access token, verified against that host
     * before it is stored. Registering it is what trusts the host; the trust
     * gate applies when the token is used. github.com's own token entry is
     * its device flow.
     */
    connectToken: guardStorage(async ({ instance, token }) => {
      if (instance === GITHUB_COM) {
        throw responseError(400, { error: 'Personal access tokens are only accepted for a GitHub Enterprise instance' });
      }
      let user;
      try {
        user = await userSummary(await clientFor(token, '', instance));
      } catch (error) {
        if (error?.status === 401) throw Object.assign(new Error(gitHubRefusalMessage(error) || 'GitHub token is invalid'), { kind: 'invalid-token' });
        throw error;
      }
      const credential = await setGitHubAuthForHost(instance, { accessToken: token, user, source: 'pat' });
      await announceConnected(instance, credential, user);
      return { connected: true, user: mapUser(user, identityOf(instance)) };
    }),
    /**
     * Switches the instance's current account: a stored one, or one of its gh
     * logins (`<host>#cli:<id>`; an enterprise row not yet active lists the
     * placeholder id 0, and github.com's legacy `gh-cli` id still works). The
     * named login is remembered as the instance's own, so an unbound use keeps
     * resolving to it instead of gh's active account.
     */
    activate: guardStorage(async ({ instance, accountId }) => {
      if (!accountId) throw responseError(400, { error: 'accountId is required' });
      const cli = CLI_ACCOUNT_RE.exec(accountId);
      if (accountId === GH_CLI_ACCOUNT_ID || cli) {
        const host = cli ? cli[1].toLowerCase() : GITHUB_COM;
        if (host !== GITHUB_COM && !(await isTrustedGitHubHostOrStored(host))) throw responseError(400, { error: 'Unsupported GitHub instance' });
        // The hosts.yml placeholder names no account: it only turns the
        // instance's gh switch on, which lists the real logins for binding.
        if (cli && Number(cli[2]) === 0) {
          await setGhCliActiveForHost(host, true);
          return status({ instance: host });
        }
        const login = cli ? await findGhCliLogin(host, accountId, { createOctokit: clientFor }) : null;
        if (cli && !login) throw responseError(404, { error: 'GitHub CLI account not found' });
        await setGhCliActiveForHost(host, true, login?.login ?? null);
        return status({ instance: host });
      }
      if (!(await activateGitHubAuthForHost(instance, accountId))) throw responseError(404, { error: 'GitHub account not found' });
      return status({ instance });
    }),
    /** github.com's switch lives in Settings; each enterprise host keeps its own. */
    setCliDisabled: guardStorage(async ({ instance, disabled }) => {
      if (instance !== GITHUB_COM && !(await isTrustedGitHubHostOrStored(instance))) throw responseError(400, { error: 'Unsupported GitHub instance' });
      await setGhCliDisabledForHost(instance, disabled);
      const nextDisabled = await isGhCliDisabledForHost(instance);
      return { available: !nextDisabled && hasStoredGhLogin(instance), disabled: nextDisabled };
    }),
    /** Bindings let go of the exact account before it leaves the store; a gh login is only switched off. */
    remove: guardStorage(async ({ instance, accountId }) => {
      const cli = CLI_ACCOUNT_RE.exec(accountId);
      if (cli) {
        const host = cli[1].toLowerCase();
        if (host !== GITHUB_COM && !(await isTrustedGitHubHostOrStored(host))) throw responseError(400, { error: 'Unsupported GitHub instance' });
        // The named login is resolved first: gh keeps every account it is signed
        // in to, and this only ends the instance's use of the one its row names.
        // A login that is gone or refused is answered as a plain no-op, not as
        // the other logins' failure.
        const login = Number(cli[2]) === 0 ? null : await findGhCliLogin(host, accountId, { createOctokit: clientFor });
        if (Number(cli[2]) !== 0 && !login) return { removed: false };
        // Nothing of the instance's is in use while its switch is off, so there
        // is nothing to disconnect — also for another login's row.
        if (!(await isGhCliActiveForHost(host))) return { removed: false };
        const pinned = await getGhCliLoginForHost(host);
        if (login && pinned && pinned.toLowerCase() !== login.login.toLowerCase()) return { removed: false };
        await events.removed({ provider: 'github', instance: host, accountId });
        await setGhCliActiveForHost(host, false);
        return { removed: true };
      }
      // A stored credential is removed by its exact id on whichever instance holds it.
      const stored = await getGitHubAuthByAccountId(accountId);
      const host = stored?.host ?? instance;
      if (!stored && !(await getGitHubAuthAccountsForHost(instance)).some((account) => account.id === accountId)) return { removed: false };
      await events.removed({ provider: 'github', instance: host, accountId });
      return { removed: await removeGitHubAuthAccountForHost(host, accountId) };
    }),
  });
}
