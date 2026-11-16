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

import { z } from 'zod';

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

// GitHub's `GET /user` answer, parsed for the fields a login row needs; the
// rest of the answer is kept as it arrived (`profile`).
const authenticatedUserSchema = z.object({
  id: z.number().int(),
  login: z.string().min(1),
  avatar_url: z.string().nullish(),
  name: z.string().nullish(),
});

const text = (value) => (value?.trim() ? value : null);

const toLogin = (data, selector) => {
  const parsed = authenticatedUserSchema.safeParse(data);
  if (!parsed.success) return null;
  const { id, login, avatar_url: avatarUrl, name } = parsed.data;
  return Object.freeze({
    id,
    login,
    // The `--user` argument this login's token was read with, or null when it
    // was read without one (gh's active login, or a host gh answers only through
    // `GH_TOKEN`). Every later lookup asks gh the same way: a named lookup reads
    // only gh's per-user storage, so it cannot answer for `GH_TOKEN`, and gh
    // releases before `--user` reject the flag outright.
    selector,
    user: Object.freeze({
      id,
      login,
      avatarUrl: text(avatarUrl),
      name: text(name),
    }),
    // GitHub's own answer, kept as it arrived: the transport credential has
    // always carried this shape, and callers compare it as GitHub sent it.
    profile: data,
  });
};

/** `createOctokit` is injected: the module never loads Octokit itself (accounts.js keeps it lazy). */
async function resolveLogins(hostKey, createOctokit) {
  const { logins } = storedGhLogins(hostKey);
  let complete = true;
  // A failure GitHub did not decide (a network error, a rate limit, a 5xx)
  // says nothing about the account, so it is reported instead of read as one.
  let error = null;
  const ask = async (selector) => {
    const token = await getGhCliToken(hostKey, selector);
    if (!token) {
      complete = false;
      return null;
    }
    try {
      const response = await (await createOctokit(token, '', hostKey)).rest.users.getAuthenticated();
      const entry = toLogin(response?.data, selector);
      if (!entry) complete = false;
      return entry;
    } catch (failure) {
      // A refused login is left out; the others still answer.
      complete = false;
      if (failure?.status !== 401) error ??= failure;
      return null;
    }
  };
  // gh's own answer without `--user` comes first: it is gh's active login, or
  // the account `GH_TOKEN` in the server's environment names, which overrides
  // the active login and may not be stored at all. Every stored login it did
  // not already answer for is then asked by name, so a `GH_TOKEN` account does
  // not hide the stored login gh calls active.
  const unnamed = await ask(null);
  const named = await Promise.all(logins
    .filter((login) => login.toLowerCase() !== unnamed?.login.toLowerCase())
    .map((login) => ask(login)));
  const resolved = [];
  for (const entry of [unnamed, ...named]) {
    if (entry && !resolved.some((existing) => existing.id === entry.id)) resolved.push(entry);
  }
  return { logins: resolved, complete, error };
}

const identities = new Map();

async function loadGhCliLogins(host, createOctokit) {
  const hostKey = hostKeyFor(host);
  const stamp = await ghConfigStamp();
  const cached = identities.get(hostKey);
  const ttl = cached?.complete ? IDENTITY_TTL_MS : INCOMPLETE_TTL_MS;
  if (cached && cached.stamp === stamp && Date.now() - cached.at < ttl) return cached.promise;
  const record = { stamp, at: Date.now(), complete: false, promise: null };
  record.promise = resolveLogins(hostKey, createOctokit).then(({ logins, complete: done, error }) => {
    record.complete = done;
    // An answer GitHub did not give is not kept: the next read asks again.
    if (error && identities.get(hostKey) === record) identities.delete(hostKey);
    return Object.freeze({ logins: Object.freeze(logins), error });
  }).catch((error) => {
    if (identities.get(hostKey) === record) identities.delete(hostKey);
    throw error;
  });
  identities.set(hostKey, record);
  return record.promise;
}

/**
 * Every gh login stored for `host` as `{ id, login, selector, user }`, gh's
 * active (or `GH_TOKEN`) account first, or an empty list when gh has none.
 * Logins gh or GitHub cannot answer for are omitted. Concurrent callers share
 * one resolution.
 */
export async function readGhCliLogins(host, { createOctokit }) {
  return (await loadGhCliLogins(host, createOctokit)).logins;
}

/**
 * The gh login a `<host>#cli:<id>` account id names on `host`, or null when gh
 * is not signed in as that account (or cannot be asked). Throws GitHub's error
 * when it failed to identify a login (other than refusing its token). The id is GitHub's
 * numeric user id, the same one the account rows carry.
 */
export async function findGhCliLogin(host, accountId, { createOctokit }) {
  const match = /^([^#]+)#cli:(\d+)$/.exec(String(accountId ?? ''));
  if (!match || Number(match[2]) === 0) return null;
  const id = Number(match[2]);
  const { logins, error } = await loadGhCliLogins(match[1].toLowerCase(), createOctokit);
  const login = logins.find((entry) => entry.id === id);
  if (login) return login;
  // GitHub failed to say who a login is, so this account may be the one it
  // could not answer for: its failure is reported, not read as "gone".
  if (error) throw error;
  return null;
}

/**
 * The token of a login `readGhCliLogins` listed, asked of gh the same way the
 * listing verified it (`selector`), or null when gh no longer answers.
 */
export const getGhCliLoginToken = (host, entry) => getGhCliToken(host, entry.selector);
