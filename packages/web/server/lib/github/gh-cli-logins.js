// A gh host can hold several logins (a personal account and a work account, for
// instance). hosts.yml names them; only GitHub says which account each one is,
// and the account id (`<host>#cli:<user id>`) every binding and exact lookup
// uses needs that answer. One token per login comes from gh (`--user`), and the
// answering account is read once and reused: the tokens are cached by
// `gh-cli-credential.js`, and this module caches the identity each login
// resolved to until hosts.yml changes (a login, logout or switch) or the reuse
// limit passes. A login gh has no token for, or that GitHub refuses, is left out
// of the list rather than failing the host's others; the list is then reused for
// the short limit only, so a keyring that just unlocked is seen soon.
//
// Nothing here decides whether an instance may use gh — that stays the
// instance's switch (`isGhCliActiveForHost`), checked by the caller before this
// module is asked.

import { ghConfigStamp, getGhCliToken } from './gh-cli-credential.js';
import { storedGhLogins } from './host-trust.js';

const IDENTITY_TTL_MS = 5 * 60_000;
// An incomplete list (a login gh could not answer for) is kept briefly, like
// "no token" in the credential cache: a locked keyring is the usual cause.
const INCOMPLETE_TTL_MS = 30_000;

const hostKeyFor = (host) => {
  const value = (host ?? '').trim().toLowerCase();
  return value && value !== 'github.com' ? value : 'github.com';
};

const text = (value) => (typeof value === 'string' && value.trim() ? value : null);

const toLogin = (data) => {
  if (!Number.isInteger(data?.id) || typeof data?.login !== 'string' || !data.login) return null;
  return Object.freeze({
    id: data.id,
    login: data.login,
    user: Object.freeze({
      id: data.id,
      login: data.login,
      avatarUrl: text(data.avatar_url),
      name: text(data.name),
    }),
    // GitHub's own answer, kept as it arrived: the transport credential has
    // always carried this shape, and callers compare it as GitHub sent it.
    profile: data,
  });
};

/** `createOctokit` is injected: the module never loads Octokit itself (accounts.js keeps it lazy). */
async function resolveLogins(hostKey, createOctokit) {
  const { active, logins } = storedGhLogins(hostKey);
  // gh can be signed in without a hosts.yml entry for the host: `GH_TOKEN` in
  // the server's environment answers for it. gh then names no login, so the
  // account its token belongs to is the host's only one — the same answer
  // earlier releases gave for every host.
  const names = logins.length ? logins : [null];
  let complete = true;
  const resolved = await Promise.all(names.map(async (login) => {
    // The active login is asked without `--user`: gh answers with the same
    // token, and the entry is the one every other caller asking for the host's
    // active account already shares.
    const token = await getGhCliToken(hostKey, login === null || login === active ? undefined : login);
    if (!token) {
      complete = false;
      return null;
    }
    try {
      const response = await (await createOctokit(token, '', hostKey)).rest.users.getAuthenticated();
      const entry = toLogin(response?.data);
      if (!entry) complete = false;
      return entry;
    } catch {
      // A refused or unreachable login is left out; the others still answer.
      complete = false;
      return null;
    }
  }));
  return { logins: resolved.filter(Boolean), complete };
}

const identities = new Map();

/**
 * Every gh login stored for `host` as `{ id, login, user }`, in gh's order
 * (the active login first), or an empty list when gh has none. Logins gh cannot
 * answer for are omitted. Concurrent callers share one resolution.
 */
export async function readGhCliLogins(host, { createOctokit }) {
  const hostKey = hostKeyFor(host);
  const stamp = await ghConfigStamp();
  const cached = identities.get(hostKey);
  const ttl = cached?.complete ? IDENTITY_TTL_MS : INCOMPLETE_TTL_MS;
  if (cached && cached.stamp === stamp && Date.now() - cached.at < ttl) return cached.promise;
  const record = { stamp, at: Date.now(), complete: false, promise: null };
  record.promise = resolveLogins(hostKey, createOctokit).then(({ logins, complete: done }) => {
    record.complete = done;
    return Object.freeze(logins);
  }).catch((error) => {
    if (identities.get(hostKey) === record) identities.delete(hostKey);
    throw error;
  });
  identities.set(hostKey, record);
  return record.promise;
}

/**
 * The gh login a `<host>#cli:<id>` account id names on `host`, or null when gh
 * is not signed in as that account (or cannot be asked). The id is GitHub's
 * numeric user id, the same one the account rows carry.
 */
export async function findGhCliLogin(host, accountId, { createOctokit }) {
  const match = /^([^#]+)#cli:(\d+)$/.exec(String(accountId ?? ''));
  if (!match || Number(match[2]) === 0) return null;
  const id = Number(match[2]);
  const logins = await readGhCliLogins(match[1].toLowerCase(), { createOctokit });
  return logins.find((entry) => entry.id === id) ?? null;
}
