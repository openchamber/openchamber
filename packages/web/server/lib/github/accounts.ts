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
import type { AuthJson, AuthUserInput } from '../source-control/auth-storage.js';
import type { Octokit } from './contracts.js';
import type { GitHubProviderOptions } from './provider.js';
import type { createOctokit as createGitHubOctokit } from './octokit.js';


const GITHUB_COM = 'github.com';
const CLI_ACCOUNT_RE = /^([^#]+)#cli:(\d+)$/;

const hasGhLoginWithoutRunningGh = () => hasStoredGhLogin(GITHUB_COM)
  || Boolean(process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim());

type AccountRow = Parameters<typeof mapAccount>[0];
type AuthUser = AuthUserInput;
type Instance = { instance: string };
type TargetAccount = Instance & { accountId: string };
interface AccountsOptions {
  createOctokit: () => Promise<typeof createGitHubOctokit>;
  events: GitHubProviderOptions['events'];
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}
interface CliStatus {
  available: boolean;
  disabled: boolean;
  active: boolean;
  user?: AuthUser | null;
}
export interface DeviceGrantResult {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
  scope: string;
  verificationUriComplete?: string;
}
interface AccountEmail { primary?: unknown; verified?: unknown; email?: string | null }
interface AccountStatusInput {
  user?: AuthUser | null;
  accounts: AccountRow[];
  scope?: string | undefined;
  cli?: CliStatus;
}
export interface GitHubAccountStatus {
  provider: string;
  instance: string;
  status: 'connected' | 'disconnected';
  connected: boolean;
  accounts: ReturnType<typeof mapAccount>[];
  user?: ReturnType<typeof mapUser>;
  scope?: string;
  cli?: Omit<CliStatus, 'user'> & { user?: ReturnType<typeof mapUser> };
}
interface FailureFields { code?: unknown; status?: unknown; message?: unknown }
interface DeviceReplyFields {
  error?: AuthJson;
  error_description?: AuthJson;
  access_token?: AuthJson;
  scope?: AuthJson;
  token_type?: AuthJson;
}
const hasDeviceReplyFields = (value: unknown): value is DeviceReplyFields => value != null;
const hasFailureFields = (value: unknown): value is FailureFields => value != null;
const statusOf = (cause: unknown) => hasFailureFields(cause) ? cause.status : undefined;
const hasHostCapture = (value: RegExpExecArray): value is RegExpExecArray & { 1: string } => value[1] !== undefined;
const requiredMatchHost = (value: RegExpExecArray) => {
  if (!hasHostCapture(value)) throw new TypeError('GitHub CLI account ID is missing a host');
  return value[1].toLowerCase();
};
const hasAuth = (value: Awaited<ReturnType<typeof getGitHubAuthForHost>>) => {
  if (!value) throw new TypeError('GitHub account is unavailable');
  return value;
};
const requiredEvents = (events: AccountsOptions['events']) => {
  if (!events) throw new TypeError('GitHub account events are unavailable');
  return events;
};

const hostCliAccount = (host: string, user: AuthUser, current: boolean, usable: boolean): AccountRow & { current: boolean } => ({
  id: `${host}#cli:${user.id}`,
  credentialId: `${host}#cli:${user.id}`,
  credentialRevision: 1,
  providerUserId: `${host}#${user.id}`,
  providerUserStatus: 'available',
  user,
  current,
  source: 'cli',
  status: 'valid',
  usable,
});

const guardStorage = <Args extends readonly unknown[], Result>(operation: (...args: Args) => Promise<Result>) => async (...args: Args) => {
  try {
    return await operation(...args);
  } catch (error) {
    if (hasFailureFields(error) && error.code === 'INVALID_GITHUB_AUTH') throw responseError(500, { error: error.message, code: error.code });
    throw error;
  }
};

export function createGitHubAccounts({ createOctokit, events, fetch: fetchImpl, timeoutMs }: AccountsOptions) {
  const identityOf = (instance: string) => ({ provider: 'github', instance });

  const userSummary = async (octokit: Octokit) => {
    const me = await octokit.rest.users.getAuthenticated();
    const primaryEmail = async (fallback: string | null) => {
      try {
        const emails = await octokit.rest.users.listEmailsForAuthenticatedUser({ per_page: 100 });
        const list: AccountEmail[] = Array.isArray(emails?.data) ? emails.data : [];
        return (list.find((entry) => entry?.primary && entry.verified && entry.email)
          ?? list.find((entry) => entry?.verified && entry.email))?.email ?? null;
      } catch { return fallback; }
    };
    const profileEmail = me.data.email ?? null;
    const email = profileEmail || await primaryEmail(profileEmail);
    return {
      login: me.data.login,
      id: me.data.id,
      avatarUrl: me.data.avatar_url,
      name: isProviderString(me.data.name) ? me.data.name : null,
      email,
    };
  };
  const clientFor = async (token: AuthJson, accountId: string, host: string) => (await createOctokit())(token, accountId, host);

  const statusBody = (instance: string, { user = null, scope, accounts, cli }: AccountStatusInput) => {
    const identity = identityOf(instance);
    const body: GitHubAccountStatus = {
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

  const invalidateStored = async (instance: string, accountId: string) => {
    await requiredEvents(events).invalidated({ provider: 'github', instance, accountId });
    await markGitHubAuthAccountInvalidForHost(instance, accountId, 'unauthorized');
  };

  const gitHubComStatus = async () => {
    const auth = await getGitHubAuthForHost(GITHUB_COM);
    let accounts: AccountRow[] = await getGitHubAuthAccountsForHost(GITHUB_COM);
    const cliDisabled = await isGhCliDisabledForHost(GITHUB_COM);
    const cliActive = await isGhCliActiveForHost(GITHUB_COM);
    const ghToken = cliDisabled ? null : await getGhCliToken(GITHUB_COM, await getGhCliLoginForHost(GITHUB_COM));
    const ownToken = Boolean(auth?.accessToken);
    const selectedPersisted = accounts.some((account) => account.current);
    let cliUser = null;
    let cliRejected = false;
    if (ghToken !== null && !cliDisabled) {
      try {
        cliUser = await userSummary(await clientFor(ghToken, '', GITHUB_COM));
      } catch (error) {
        cliRejected = statusOf(error) === 401;
      }
    }
    if (cliActive && (ghToken === null || cliDisabled || cliRejected)) await setGhCliActiveForHost(GITHUB_COM, false);
    const currentCliUser = ghToken !== null && !cliDisabled && cliActive ? cliUser : null;
    const cliCurrent = Boolean(currentCliUser);
    const gitHubComSwitchOn = cliActive && !cliDisabled;
    const logins = gitHubComSwitchOn ? await readGhCliLogins(GITHUB_COM, { createOctokit: clientFor }) : [];
    if (logins.length) {
      const currentLogin = currentCliUser ? currentCliUser.login.toLowerCase() : null;
      accounts = accounts.map((account) => ({ ...account, current: cliCurrent ? false : Boolean(account.current) }))
        .concat(logins.map((entry) => {
          const current = currentLogin !== null && entry.login.toLowerCase() === currentLogin;
          return hostCliAccount(GITHUB_COM, current && currentCliUser ? currentCliUser : entry.user, current, true);
        }));
    } else if (cliUser) {
      accounts = accounts.map((account) => ({ ...account, current: cliCurrent ? false : Boolean(account.current) }))
        .concat(hostCliAccount(GITHUB_COM, cliUser, cliCurrent, false));
    }
    const cli = (activeUser: AuthUser | null = null) => ({
      available: cliDisabled ? hasGhLoginWithoutRunningGh() : ghToken !== null,
      disabled: cliDisabled,
      active: cliCurrent,
      user: !cliDisabled ? activeUser || cliUser : null,
    });
    if (selectedPersisted && !ownToken && !cliCurrent) return statusBody(GITHUB_COM, { accounts, cli: cli() });
    const token = cliCurrent ? ghToken : auth?.accessToken;
    if (!token) return statusBody(GITHUB_COM, { accounts, cli: cli() });
    let user = null;
    try {
      user = await userSummary(await clientFor(token, cliCurrent ? '' : hasAuth(auth).accountId, GITHUB_COM));
    } catch (error) {
      if (statusOf(error) === 401) {
        if (!cliCurrent && ownToken) await invalidateStored(GITHUB_COM, hasAuth(auth).accountId);
        return statusBody(GITHUB_COM, { accounts: await getGitHubAuthAccountsForHost(GITHUB_COM), cli: cli() });
      }
    }
    const merged = user || (ownToken ? hasAuth(auth).user : null);
    return statusBody(GITHUB_COM, {
      user: merged,
      scope: cliCurrent ? undefined : auth?.scope,
      accounts,
      cli: cli(cliCurrent ? merged : null),
    });
  };

  const enterpriseStatus = async (host: string): Promise<GitHubAccountStatus> => {
    if (!(await isTrustedGitHubHostOrStored(host))) {
      return statusBody(host, { accounts: [], cli: { available: hasStoredGhLogin(host), disabled: false, active: false } });
    }
    const cliDisabled = await isGhCliDisabledForHost(host);
    const cliActive = await isGhCliActiveForHost(host);
    const available = cliDisabled ? false : hasStoredGhLogin(host);
    const cliLogin = await getGhCliLoginForHost(host);
    let cliUser: AuthUser | null = null;
    let logins: Awaited<ReturnType<typeof readGhCliLogins>> = [];
    if (cliActive && !cliDisabled) {
      const token = await getGhCliToken(host, cliLogin);
      let rejected = false;
      if (token !== null) {
        try {
          cliUser = await userSummary(await clientFor(token, '', host));
        } catch (error) {
          rejected = statusOf(error) === 401;
        }
      }
      if (!cliUser && (token === null || rejected)) {
        await setGhCliActiveForHost(host, false);
        return enterpriseStatus(host);
      }
      logins = await readGhCliLogins(host, { createOctokit: clientFor });
    }
    if (!cliActive && !cliUser && available) cliUser = storedGhLoginUser(host);
    const active = cliActive ? null : await getGitHubAuthForHost(host);
    const currentCliUser = cliActive ? cliUser : null;
    const cliCurrent = Boolean(currentCliUser);
    const currentLogin = currentCliUser ? currentCliUser.login.toLowerCase() : null;
    const loginRows = logins.length
      ? logins.map((entry) => {
        const current = currentLogin !== null && entry.login.toLowerCase() === currentLogin;
        return hostCliAccount(host, current && currentCliUser ? currentCliUser : entry.user, current, true);
      })
      : (cliUser ? [hostCliAccount(host, cliUser, cliCurrent, false)] : []);
    const accountsWith = async (current: (account: AccountRow) => boolean) => (await getGitHubAuthAccountsForHost(host))
      .map((account): AccountRow => ({ ...account, current: current(account) }))
      .concat(loginRows);
    const cli = { available: cliCurrent || available, disabled: cliDisabled, active: cliCurrent, user: cliUser };
    if (cliCurrent) return statusBody(host, { user: cliUser, accounts: await accountsWith(() => false), cli });
    if (!active) return statusBody(host, { accounts: await accountsWith(() => false), cli });
    let user = null;
    let rejected = false;
    try {
      user = await userSummary(await clientFor(active.accessToken, active.accountId, host));
    } catch (error) {
      rejected = statusOf(error) === 401;
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

  const status = ({ instance }: Instance) => (instance === GITHUB_COM ? gitHubComStatus() : enterpriseStatus(instance));

  const announceConnected = async (instance: string, credential: Awaited<ReturnType<typeof setGitHubAuthForHost>>, user: AuthUser) => {
    if (!credential?.credentialId) return;
    const account = { provider: 'github', instance, accountId: credential.credentialId };
    const superseded = (await getGitHubAuthAccountsForHost(instance)).filter((candidate) =>
      candidate.providerUserId === credential.providerUserId && candidate.id !== credential.credentialId);
    await requiredEvents(events).connected({
      account,
      user,
      credential: { credentialRevision: credential.credentialRevision, providerUserId: credential.providerUserId },
      renews: superseded.map((candidate) => ({ ...account, accountId: candidate.id })),
    });
  };

  return Object.freeze({
    capabilities: async ({ instance }: Instance) => {
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
    accounts: guardStorage(async ({ instance }: Instance) => (await getGitHubAuthAccountsForHost(instance))
      .map((account) => mapAccount(account, identityOf(instance)))),

    startDeviceFlow: async ({ instance }: Instance) => {
      if (instance !== GITHUB_COM) throw responseError(400, { error: 'GitHub device flow is only available for github.com', status: 'invalid-client' });
      const clientId = getGitHubClientId();
      if (!clientId) throw responseError(400, { error: 'GitHub OAuth client not configured. Set OPENCHAMBER_GITHUB_CLIENT_ID.' });
      const scope = getGitHubScopes();
      const payload = await startDeviceFlow({ clientId, scope, fetch: fetchImpl, timeoutMs });
      const result: DeviceGrantResult = {
        userCode: payload.user_code,
        verificationUri: payload.verification_uri,
        expiresIn: payload.expires_in,
        interval: payload.interval,
        scope,
      };
      if (isProviderString(payload.verification_uri_complete)) result.verificationUriComplete = payload.verification_uri_complete;
      return { flow: { deviceCode: payload.device_code, clientId, expiresIn: payload.expires_in }, result };
    },
    completeDeviceFlow: guardStorage(async ({ instance, deviceCode, clientId }: Instance & { deviceCode: string; clientId: string }, { consume }: { consume(): void }) => {
      const reply = await exchangeDeviceCode({ clientId, deviceCode, fetch: fetchImpl, timeoutMs });
      const payload = hasDeviceReplyFields(reply) ? reply : undefined;
      if (payload?.error) {
        const pending = payload.error === 'authorization_pending' || payload.error === 'slow_down';
        if (!pending) consume();
        return { pending, body: { connected: false, status: payload.error, error: payload.error_description || payload.error } };
      }
      consume();
      const accessToken = payload?.access_token;
      if (!accessToken) throw responseError(500, { error: 'Missing access_token from GitHub' });
      const user = await userSummary(await clientFor(accessToken, '', GITHUB_COM));
      const scope = isProviderString(payload?.scope) ? payload.scope : '';
      const credential = await setGitHubAuthForHost(instance, {
        accessToken,
        scope,
        tokenType: isProviderString(payload?.token_type) ? payload.token_type : 'bearer',
        user,
      });
      await announceConnected(instance, credential, user);
      return { pending: false, body: { connected: true, user: mapUser(user, identityOf(instance)), scope } };
    }),
    connectToken: guardStorage(async ({ instance, token }: Instance & { token: string }) => {
      if (instance === GITHUB_COM) {
        throw responseError(400, { error: 'Personal access tokens are only accepted for a GitHub Enterprise instance' });
      }
      let user;
      try {
        user = await userSummary(await clientFor(token, '', instance));
      } catch (error) {
        if (statusOf(error) === 401) throw Object.assign(new Error(gitHubRefusalMessage(error) || 'GitHub token is invalid'), { kind: 'invalid-token' });
        throw error;
      }
      const credential = await setGitHubAuthForHost(instance, { accessToken: token, user, source: 'pat' });
      await announceConnected(instance, credential, user);
      return { connected: true, user: mapUser(user, identityOf(instance)) };
    }),
    activate: guardStorage(async ({ instance, accountId }: TargetAccount) => {
      if (!accountId) throw responseError(400, { error: 'accountId is required' });
      const cli = CLI_ACCOUNT_RE.exec(accountId);
      if (accountId === GH_CLI_ACCOUNT_ID || cli) {
        const host = cli ? requiredMatchHost(cli) : GITHUB_COM;
        if (host !== GITHUB_COM && !(await isTrustedGitHubHostOrStored(host))) throw responseError(400, { error: 'Unsupported GitHub instance' });
        if (cli && Number(cli[2]) === 0) {
          await setGhCliActiveForHost(host, true);
          return status({ instance: host });
        }
        const login = cli ? await findGhCliLogin(host, accountId, { createOctokit: clientFor }) : null;
        if (cli && !login) throw responseError(404, { error: 'GitHub CLI account not found' });
        await setGhCliActiveForHost(host, true, login ? login.selector : undefined);
        return status({ instance: host });
      }
      if (!(await activateGitHubAuthForHost(instance, accountId))) throw responseError(404, { error: 'GitHub account not found' });
      return status({ instance });
    }),
    setCliDisabled: guardStorage(async ({ instance, disabled }: Instance & { disabled: boolean }) => {
      if (instance !== GITHUB_COM && !(await isTrustedGitHubHostOrStored(instance))) throw responseError(400, { error: 'Unsupported GitHub instance' });
      await setGhCliDisabledForHost(instance, disabled);
      const nextDisabled = await isGhCliDisabledForHost(instance);
      return { available: !nextDisabled && hasStoredGhLogin(instance), disabled: nextDisabled };
    }),
    remove: guardStorage(async ({ instance, accountId }: TargetAccount) => {
      const cli = CLI_ACCOUNT_RE.exec(accountId);
      if (cli) {
        const host = requiredMatchHost(cli);
        if (host !== GITHUB_COM && !(await isTrustedGitHubHostOrStored(host))) throw responseError(400, { error: 'Unsupported GitHub instance' });
        const login = Number(cli[2]) === 0 ? null : await findGhCliLogin(host, accountId, { createOctokit: clientFor });
        if (Number(cli[2]) !== 0 && !login) return { removed: false };
        if (!(await isGhCliActiveForHost(host))) return { removed: false };
        const pinned = await getGhCliLoginForHost(host);
        if (login && pinned && pinned.toLowerCase() !== (login.selector ?? login.login).toLowerCase()) return { removed: false };
        await requiredEvents(events).removed({ provider: 'github', instance: host, accountId });
        await setGhCliActiveForHost(host, false);
        return { removed: true };
      }
      const stored = await getGitHubAuthByAccountId(accountId);
      const host = stored?.host ?? instance;
      if (!stored && !(await getGitHubAuthAccountsForHost(instance)).some((account) => account.id === accountId)) return { removed: false };
      await requiredEvents(events).removed({ provider: 'github', instance: host, accountId });
      return { removed: await removeGitHubAuthAccountForHost(host, accountId) };
    }),
  });
}
