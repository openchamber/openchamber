// A git remote names a host before the server ever mints a token, and the
// only credential the server holds for a non-github.com host is the gh CLI's
// host-pinned token (GH_ENTERPRISE_TOKEN / GITHUB_ENTERPRISE_TOKEN). Mailing
// that credential to an arbitrary host a local remote happens to name would
// leak it. This module decides which hosts are allowed to receive a token:
// github.com and the server's own GH_HOST are always trusted; any other host
// is trusted only when gh has a stored login for it (hosts.yml), so an
// unauthenticated gitlab.com (or any random) remote resolves to repo: null
// and never gets a token. Nothing here throws or talks to the network; an
// unreadable config simply means "not trusted", which fails closed.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import yaml from 'yaml';
import { z } from 'zod';

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
    // whichever case gh recorded still matches the lowercased query.
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
