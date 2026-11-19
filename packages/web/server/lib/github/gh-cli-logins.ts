
import { z } from 'zod';

import { ghConfigStamp, getGhCliToken } from './gh-cli-credential.js';
import { storedGhLogins } from './host-trust.js';
import { hasProperty } from './contracts.js';
import type { Octokit } from '@octokit/rest';

type CreateOctokit = (token: string, accountId: string, host: string) => Octokit | Promise<Octokit>;
type Login = NonNullable<ReturnType<typeof toLogin>>;

interface LoginCache {
  stamp: string;
  at: number;
  complete: boolean;
  promise: Promise<{ readonly logins: readonly Login[]; readonly error: unknown }>;
}

interface LoginResolution {
  error: unknown;
}

const IDENTITY_TTL_MS = 5 * 60_000;
const INCOMPLETE_TTL_MS = 30_000;

const hostKeyFor = (host: string | null | undefined) => {
  const value = (host ?? '').trim().toLowerCase();
  return value && value !== 'github.com' ? value : 'github.com';
};

const authenticatedUserSchema = z.object({
  id: z.number().int(),
  login: z.string().min(1),
  avatar_url: z.string().nullish(),
  name: z.string().nullish(),
});

const text = (value: string | null | undefined) => (value?.trim() ? value : null);

const toLogin = <Data>(data: Data, selector: string | null) => {
  const parsed = authenticatedUserSchema.safeParse(data);
  if (!parsed.success) return null;
  const { id, login, avatar_url: avatarUrl, name } = parsed.data;
  return Object.freeze({
    id,
    login,
    selector,
    user: Object.freeze({
      id,
      login,
      avatarUrl: text(avatarUrl),
      name: text(name),
    }),
    profile: data,
  });
};

async function resolveLogins(hostKey: string, createOctokit: CreateOctokit) {
  const { logins } = storedGhLogins(hostKey);
  let complete = true;
  const resolution: LoginResolution = { error: null };
  const ask = async (selector: string | null) => {
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
      complete = false;
      if (!(hasProperty(failure, 'status') && failure.status === 401)) resolution.error ??= failure;
      return null;
    }
  };
  const unnamed = await ask(null);
  const named = await Promise.all(logins
    .filter((login) => login.toLowerCase() !== unnamed?.login.toLowerCase())
    .map((login) => ask(login)));
  const resolved: Login[] = [];
  for (const entry of [unnamed, ...named]) {
    if (entry && !resolved.some((existing) => existing.id === entry.id)) resolved.push(entry);
  }
  return { logins: resolved, complete, error: resolution.error };
}

const identities = new Map<string, LoginCache>();

async function loadGhCliLogins(host: string | null | undefined, createOctokit: CreateOctokit) {
  const hostKey = hostKeyFor(host);
  const stamp = await ghConfigStamp();
  const cached = identities.get(hostKey);
  const ttl = cached?.complete ? IDENTITY_TTL_MS : INCOMPLETE_TTL_MS;
  if (cached && cached.stamp === stamp && Date.now() - cached.at < ttl) return cached.promise;
  const record: LoginCache = { stamp, at: Date.now(), complete: false, promise: resolveLogins(hostKey, createOctokit).then(({ logins, complete: done, error }) => {
    record.complete = done;
    if (error && identities.get(hostKey) === record) identities.delete(hostKey);
    return Object.freeze({ logins: Object.freeze(logins), error });
  }).catch((error) => {
    if (identities.get(hostKey) === record) identities.delete(hostKey);
    throw error;
  }) };
  identities.set(hostKey, record);
  return record.promise;
}

export async function readGhCliLogins(host: string | null | undefined, { createOctokit }: { createOctokit: CreateOctokit }) {
  return (await loadGhCliLogins(host, createOctokit)).logins;
}

export async function findGhCliLogin(host: string | null | undefined, accountId: string | null | undefined, { createOctokit }: { createOctokit: CreateOctokit }) {
  const match = /^([^#]+)#cli:(\d+)$/.exec(String(accountId ?? ''));
  if (!match || Number(match[2]) === 0) return null;
  const id = Number(match[2]);
  const { logins, error } = await loadGhCliLogins(match[1]?.toLowerCase(), createOctokit);
  const login = logins.find((entry) => entry.id === id);
  if (login) return login;
  if (error) throw error;
  return null;
}

export const getGhCliLoginToken = (host: string | null | undefined, entry: Pick<Login, 'selector'>) => getGhCliToken(host, entry.selector);
