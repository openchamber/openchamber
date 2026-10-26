// A git remote names a host before the server ever mints a token. A host
// becomes trusted by the server's own GH_HOST, a gh hosts.yml login, or the
// user's own act of registering a personal access token for it: registering
// the PAT is what trusts the host, and the gh CLI for an enterprise host is
// only considered on such a trusted host (or github.com). The trust gate runs
// before ANY token lookup, so an arbitrary host a local remote happens to
// name can never receive a credential unless the user already stored a PAT
// for it. This module decides which hosts are allowed to: github.com
// (always), the server's own GH_HOST, any host gh has a stored login for
// (hosts.yml), or any host with a server-stored per-host PAT. Nothing here
// talks to the network; an unreadable config simply means "not a known
// host", which fails closed.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import yaml from 'yaml';
import { z } from 'zod';

import { createSourceControlAuthStore } from '../source-control/auth-storage.js';

const dataDir = () => process.env.OPENCHAMBER_DATA_DIR
  ? resolve(process.env.OPENCHAMBER_DATA_DIR)
  : join(homedir(), '.config', 'openchamber');

const normalizeHost = (value) => String(value ?? '').trim().toLowerCase();

// hosts.yml lives in the gh config dir: $GH_CONFIG_DIR when set, otherwise
// ~/.config/gh — exactly the one directory gh itself reads (gh never falls
// back to the default when GH_CONFIG_DIR is set, so neither do we: an
// explicitly set config dir without a login is "not trusted", not a reason to
// consult the default).
const hostsYamlPath = () => {
  const configDir = process.env.GH_CONFIG_DIR?.trim() || join(homedir(), '.config', 'gh');
  return join(configDir, 'hosts.yml');
};

// The YAML arrives untyped, so it is validated at its I/O boundary. The
// document is a map of host -> entry; each entry is validated on its own so
// one malformed entry never turns a different, valid host untrusted. An entry
// is a stored login when it records an account: direct oauth_token (older gh),
// a `user` plus settings, or a `users` map. gh leaves oauth_token out of
// hosts.yml when the token lives in the OS keyring — the entry is then just
// `user`/`users` — so the presence of an account, not of a token, is what
// proves the host was authenticated with. Empty/null entries (`ghe.example.com:`
// is YAML null; `{}` records no account) fail closed.
const hostEntrySchema = z.object({
  oauth_token: z.string().optional(),
  user: z.string().optional(),
  users: z.record(z.string(), z.unknown()).optional(),
}).refine(
  (entry) => Boolean(entry.oauth_token) || Boolean(entry.user)
    || (entry.users !== undefined && Object.keys(entry.users).length > 0),
).nullable();
const hostsDocSchema = z.record(z.string(), z.unknown()).nullable();

const loadHostsYaml = () => {
  try {
    const parsed = yaml.parse(readFileSync(hostsYamlPath(), 'utf8'));
    const result = hostsDocSchema.safeParse(parsed);
    if (!result.success) {
      return null;
    }
    // Index host keys normalized (lowercased/trimmed) so a stored login under
    // whichever case gh recorded matches the lowercased query.
    const normalized = {};
    for (const [host, entry] of Object.entries(result.data)) {
      normalized[normalizeHost(host)] = entry;
    }
    return normalized;
  } catch {
    // An unreadable or malformed hosts.yml means "not trusted": no stored
    // logins are known, so no enterprise host may receive a token. Fails closed.
    return null;
  }
};

const hasStoredLogin = (entry) => {
  const parsed = hostEntrySchema.safeParse(entry);
  // A host line with an empty value (`ghe.example.com:`) parses as YAML null
  // and an empty object records no account; each fails the schema/refine and
  // stays untrusted instead of throwing — fail closed.
  return Boolean(parsed.success && parsed.data);
};

/**
 * True when the server may pair a token with `host`.
 *
 * github.com (and an omitted host) is always trusted; anything else is trusted
 * only when the server's own GH_HOST names it, or gh has a stored login for it.
 */
export function isTrustedGitHubHost(host) {
  const normalized = normalizeHost(host);
  if (!normalized || normalized === 'github.com') {
    return true;
  }
  const envHost = normalizeHost(process.env.GH_HOST);
  if (envHost && envHost === normalized) {
    return true;
  }
  return hasStoredLogin(loadHostsYaml()?.[normalized]);
}

/**
 * Trust for any credential use, not just the gh CLI: github.com (or nothing),
 * a host named by GH_HOST, a gh hosts.yml login, or a host the user already
 * stored a personal access token for. Registering the PAT against the host is
 * the act that trusts it, so a stored per-host credential is enough without
 * gh. The sync predicate (isTrustedGitHubHost) stays gh/env-only for its sync
 * consumers; this async form is the gate every async route uses.
 */
export async function isTrustedGitHubHostOrStored(host) {
  const normalized = normalizeHost(host);
  if (isTrustedGitHubHost(normalized)) return true;
  const authStore = createSourceControlAuthStore({ filePath: join(dataDir(), 'source-control-auth.json') });
  const instance = await authStore.github.readInstance(normalized);
  return (instance?.accounts?.length ?? 0) > 0;
}

/**
 * True when gh has a stored login for `host`, read from hosts.yml alone.
 * The auth-status route advertises the CLI as available for an inactive
 * instance from this file, so a gh login is offered without spawning gh:
 * the instance's switch is what consents to gh, not the login itself.
 * github.com is not special here; a hosts.yml entry for it counts.
 */
export function hasStoredGhLogin(host) {
  return hasStoredLogin(loadHostsYaml()?.[normalizeHost(host)]);
}

/**
 * The gh login's user record for `host`, read from hosts.yml alone: the entry's
 * `user` login (or the first `users` key when the token lives in the OS keyring).
 * The auth-status route builds a stored login's account row from it, so the row
 * can be offered without spawning gh or asking the host. Its id stays 0 — a
 * value GitHub never assigns — so the listing can never be mistaken for (or
 * collide with) a real stored account. Null when gh has no stored login for the
 * host.
 */
export function storedGhLoginUser(host) {
  const parsed = hostEntrySchema.safeParse(loadHostsYaml()?.[normalizeHost(host)]);
  if (!parsed.success || !parsed.data) return null;
  return { id: 0, login: parsed.data.user ?? Object.keys(parsed.data.users ?? {})[0] };
}

/**
 * The non-github.com hosts gh has a stored login for, plus the server's own
 * GH_HOST. Feeds the instance list so enterprise hosts the user is signed
 * into gh for become available in the UI. The trust decision itself is
 * isTrustedGitHubHost; this only enumerates candidates, and an unreadable
 * hosts.yml yields an empty list (fail closed).
 */
export function listTrustedGitHubHosts() {
  const hostsDoc = loadHostsYaml();
  const hosts = [];
  if (hostsDoc) {
    for (const [host, entry] of Object.entries(hostsDoc)) {
      if (host !== 'github.com' && hasStoredLogin(entry)) hosts.push(host);
    }
  }
  const envHost = normalizeHost(process.env.GH_HOST);
  if (envHost && envHost !== 'github.com' && !hosts.includes(envHost)) {
    hosts.push(envHost);
  }
  return hosts.sort();
}
