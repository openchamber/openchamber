import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { allowedInsecureGitOrigins } from '../enterprise-mode.js';
const CLONE_TIMEOUT_MS = 60_000;

const PRIVATE_IPV4 = [
  /^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/**
 * An install URL must name a public host. The server fetches it itself, so a
 * loopback or LAN address would turn "install from URL" into a request against
 * OpenChamber's own machine or network.
 */
/**
 * The eight 16-bit groups of an IPv6 address, or null when it is not spelled
 * as eight groups. Covers every expansion of `::`, so `::1` and
 * `0:0:0:0:0:0:0:1` compare equal.
 */
const ipv6Groups = (host) => {
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const [head, tail = ''] = halves;
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0) return null;
  const groups = [...headGroups, ...Array(missing).fill('0'), ...tailGroups];
  if (groups.length !== 8) return null;
  return groups.map((group) => (/^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : -1));
};

/**
 * The IPv6 addresses that are never an install target, in any spelling:
 * loopback (`::1`), the unspecified address (`::`), IPv4-mapped space
 * (`::ffff:…`), and link-local (`fe80::/10`). An address that does not parse
 * as eight groups is refused outright.
 */
const isReservedIPv6 = (host) => {
  if (host.startsWith('fe80:') || host.startsWith('::ffff:')) return true;
  const groups = ipv6Groups(host);
  if (!groups || groups.some((group) => group < 0)) return true;
  if (groups[4] === 0 && groups[5] === 0xffff) return true;
  return groups.slice(0, 7).every((group) => group === 0) && (groups[7] === 0 || groups[7] === 1);
};

const isPublicHostname = (hostname) => {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return false;
  }
  const version = net.isIP(host);
  if (version === 4) {
    return !PRIVATE_IPV4.some((pattern) => pattern.test(host));
  }
  if (version === 6) {
    return !(host.startsWith('fc') || host.startsWith('fd')) && !isReservedIPv6(host);
  }
  return host.includes('.');
};

/**
 * What the administrator trusts for installs: the hosts of
 * `allowedInsecureGitOrigins` (one list for every place the server reaches a
 * self-hosted Git host) and those exact origins. A trusted host may be a
 * private or internal-domain one, over https, ssh or its listed http origin.
 * Nothing is trusted unless that list names it, so an unconfigured server
 * behaves exactly as before.
 * @param {Parameters<typeof allowedInsecureGitOrigins>[0]} [policyOptions]
 * @returns {{ origins: Set<string>, hosts: Set<string> }}
 */
export const installTrust = (policyOptions) => {
  const origins = allowedInsecureGitOrigins(policyOptions);
  const hosts = new Set();
  for (const origin of origins) {
    hosts.add(new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase());
  }
  return { origins, hosts };
};

/**
 * An address that stays refused even for a trusted host: this machine itself
 * and link-local space (cloud metadata lives at 169.254.169.254). A trusted
 * host buys reach into the LAN, never into the server's own loopback.
 */
const isLocalOnlyHost = (hostname) => {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  const version = net.isIP(host);
  if (version === 4) return /^127\./.test(host) || /^0\./.test(host) || /^169\.254\./.test(host);
  if (version === 6) return isReservedIPv6(host);
  return false;
};

const isTrustedHost = (hostname, trust) => {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return trust.hosts.has(host) && !isLocalOnlyHost(host);
};

/** A public host, or one the administrator trusts. */
const isInstallHostname = (hostname, trust = installTrust()) => (
  isPublicHostname(hostname) || isTrustedHost(hostname, trust)
);

/**
 * A URL an install may fetch: https on an install host, or http on an exact
 * origin the administrator listed; never with credentials in the URL.
 * @param {string} value
 * @param {{ origins: Set<string>, hosts: Set<string> }} [trust]
 */
export const isInstallableUrl = (value, trust = installTrust()) => {
  try {
    const parsed = new URL(value);
    if (parsed.username !== '' || parsed.password !== '') return false;
    if (parsed.protocol === 'https:') return isInstallHostname(parsed.hostname, trust);
    if (parsed.protocol === 'http:') return trust.origins.has(parsed.origin) && !isLocalOnlyHost(parsed.hostname);
    return false;
  } catch {
    return false;
  }
};

/**
 * The addresses a hostname resolves to, or `null` when the name is not an
 * install host (public, or trusted by the policy list), does not resolve, or
 * any answer is out of bounds. For a public name every answer must be public;
 * for a trusted one it may be private but never loopback or link-local, so a
 * trusted name cannot be re-pointed at this machine. Callers connect to
 * exactly these addresses, so a second lookup by the HTTP client or by git
 * cannot answer differently.
 * @param {string} hostname
 * @param {(hostname: string, options: { all: true }) => Promise<Array<{ address: string, family?: number }>>} [lookup]
 * @param {{ origins: Set<string>, hosts: Set<string> }} [trust]
 * @returns {Promise<Array<{ address: string, family: 4 | 6 }> | null>}
 */
export const publicAddressesOf = async (hostname, lookup = (name, options) => dns.lookup(name, options), trust = installTrust()) => {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (!isInstallHostname(host, trust)) {
    return null;
  }
  const trusted = !isPublicHostname(host);
  const acceptable = (address) => (trusted ? !isLocalOnlyHost(address) : isPublicHostname(address));
  const literal = net.isIP(host);
  if (literal) {
    return [{ address: host, family: literal === 6 ? 6 : 4 }];
  }
  try {
    const addresses = await lookup(host, { all: true });
    if (addresses.length === 0 || !addresses.every((entry) => acceptable(entry.address))) {
      return null;
    }
    return addresses.map((entry) => ({ address: entry.address, family: net.isIP(entry.address) === 6 ? 6 : 4 }));
  } catch {
    return null;
  }
};

/**
 * `-c` options that keep a git network operation on the checked host: no
 * redirects, and the connection pinned to the addresses just resolved
 * (`http.curloptResolve`, git 2.30+; older builds ignore the key and keep
 * the redirect rule). `null` when the URL is http(s) but not an install host.
 * @param {string} url
 * @param {Parameters<typeof publicAddressesOf>[1]} [lookup]
 * @param {{ origins: Set<string>, hosts: Set<string> }} [trust]
 * @returns {Promise<string[] | null>}
 */
export const gitNetworkArgs = async (url, lookup, trust = installTrust()) => {
  const target = httpTarget(url);
  if (target === null) {
    return [];
  }
  if (!isInstallableUrl(url, trust)) {
    return null;
  }
  const addresses = await publicAddressesOf(target.hostname, lookup, trust);
  if (!addresses) {
    return null;
  }
  return [
    '-c', 'http.followRedirects=false',
    '-c', `http.curloptResolve=${target.hostname}:${target.port}:${addresses.map((entry) => entry.address).join(',')}`,
  ];
};

/**
 * Hostname and port when `value` is an http(s) URL, else null. The port is
 * the one the connection will use, which is what `curloptResolve` keys on.
 * @returns {{ hostname: string, port: string } | null}
 */
const httpTarget = (value) => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return { hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80') };
  } catch {
    return null;
  }
};

/** SSH URLs and scp-style addresses, with no shell syntax in their components. */
const parseSshGitUrl = (value, trust = installTrust()) => {
  if (/[\s\\\0]/.test(value)) return null;
  let hostname;
  let username;
  let repository;
  let port;
  if (value.slice(0, 6).toLowerCase() === 'ssh://') {
    try {
      const url = new URL(value);
      if (url.password || url.search || url.hash) return null;
      hostname = url.hostname;
      username = url.username;
      repository = url.pathname;
      port = url.port;
      if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return null;
    } catch { return null; }
  } else {
    const match = /^(?:([A-Za-z0-9_][A-Za-z0-9_.-]*)@)?([A-Za-z0-9][A-Za-z0-9.-]*):(.+)$/.exec(value);
    if (!match) return null;
    [, username = '', hostname, repository] = match;
  }
  if (!/^[A-Za-z0-9.-]+$/.test(hostname) && !net.isIP(hostname.replace(/^\[|\]$/g, ''))) return null;
  if (!isInstallHostname(hostname, trust) || (username && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(username))) return null;
  if (!/^\/?[A-Za-z0-9_.~][A-Za-z0-9_./~-]*$/.test(repository) || repository.split('/').includes('..')) return null;
  return port ? { hostname, port } : { hostname };
};

/** An archive URL an install may download: an installable URL ending in `.zip`. */
export const isInstallableZipUrl = (value, trust = installTrust()) => {
  if (!isInstallableUrl(value, trust)) {
    return false;
  }
  try {
    return new URL(value).pathname.toLowerCase().endsWith('.zip');
  } catch {
    return false;
  }
};

// A branch or tag name git will take after `--branch`. No option-looking
// names, no `..`, and nothing git refuses in a ref.
const GIT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

/** @param {string} value */
export const isGitRef = (value) => (
  GIT_REF_PATTERN.test(value)
  && !value.includes('..')
  && !value.endsWith('/')
  && !value.endsWith('.lock')
  && !value.includes('//')
);

/**
 * `https://host/org/panel.git#v1.2.0` → `{ url, ref }`. The fragment pins a
 * branch or tag; without it the clone follows the remote default branch. A
 * fragment that is not a usable ref, or a URL that is not an install URL
 * (public or policy-trusted https/ssh, or a listed http origin), is
 * `null` (the install route answers `invalid-url`).
 * @param {string} value
 * @param {{ origins: Set<string>, hosts: Set<string> }} [trust]
 */
export const parseGitInstallUrl = (value, trust = installTrust()) => {
  const hashAt = value.indexOf('#');
  const rawUrl = hashAt === -1 ? value : value.slice(0, hashAt);
  const url = rawUrl.replace(/^ssh:\/\//i, 'ssh://');
  const ref = hashAt === -1 ? '' : value.slice(hashAt + 1);
  if (!isInstallableUrl(url, trust) && !parseSshGitUrl(url, trust)) {
    return null;
  }
  if (hashAt !== -1 && !isGitRef(ref)) {
    return null;
  }
  return ref ? { url, ref } : { url };
};

const STDERR_TAIL_BYTES = 4096;
const KILL_GRACE_MS = 3_000;

/**
 * Run one git command without a terminal. Resolves `{ ok: true, stdout }` on
 * exit 0 and `{ ok: false, stderr }` on a non-zero exit, a spawn error, or the
 * timeout (the child gets SIGTERM, then SIGKILL after a grace period). Never
 * rejects. `stdout` is captured only
 * when `capture` is set so a clone's progress is not buffered; `stderr` keeps
 * only its tail, for diagnosis.
 */
export const runGit = (args, { gitBinary = 'git', cwd, timeoutMs = CLONE_TIMEOUT_MS, capture = false, env = {} } = {}) => (
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        gitBinary,
        args,
        {
          cwd,
          windowsHide: true,
          env: {
            ...process.env,
            ...env,
            GIT_TERMINAL_PROMPT: '0',
            GIT_ASKPASS: 'echo',
          },
          stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'],
        },
      );
    } catch {
      resolve({ ok: false });
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    if (capture && child.stdout) {
      child.stdout.on('data', (chunk) => chunks.push(chunk));
    }
    let stderrTail = Buffer.alloc(0);
    child.stderr?.on('data', (chunk) => {
      const joined = Buffer.concat([stderrTail, chunk]);
      stderrTail = joined.subarray(Math.max(0, joined.length - STDERR_TAIL_BYTES));
    });
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    // SIGTERM first so git can remove the lock files it holds (a SIGKILL
    // leaves `.git/shallow.lock` behind and every later fetch fails on it).
    // SIGKILL only if it has not exited after the grace period.
    let killTimer;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ ok: false });
      }, KILL_GRACE_MS);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      finish({ ok: false });
    });
    child.on('close', (exit) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      finish(exit === 0 ? { ok: true, stdout: Buffer.concat(chunks).toString('utf8') } : { ok: false, stderr: stderrTail.toString('utf8') });
    });
  })
);

/**
 * Clone `source` into `dest`. Production uses HTTPS/SSH; tests may use a local repo path.
 * `gitBinary` comes from the host's git resolver: on Windows and in the packaged desktop app a bare
 * `git` is often not on PATH. `ref` pins a branch or tag (`--branch`); a shallow clone of a tag
 * works the same way as of a branch.
 */
const quoteSshPath = (value) => {
  const expanded = value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  const normalized = process.platform === 'win32' ? expanded.replace(/\\/g, '/') : expanded;
  return `'${normalized.replace(/'/g, "'\\''")}'`;
};

/** Resolve identity on the server for every clone/fetch, so key rotation takes effect. */
export const prepareGuestGitNetwork = async (source, { gitIdentityId, lookup, trust = installTrust() } = {}) => {
  let sshCommand = process.env.GIT_SSH_COMMAND?.trim() || '';
  if (gitIdentityId && gitIdentityId !== 'global') {
    const { getProfile } = await import('../git/identity-storage.js');
    const profile = getProfile(gitIdentityId);
    if (!profile) return null;
    if (profile.sshKey) sshCommand = `ssh -i ${quoteSshPath(profile.sshKey)} -o IdentitiesOnly=yes`;
  }
  const ssh = parseSshGitUrl(source, trust);
  if (ssh) {
    const addresses = await publicAddressesOf(ssh.hostname, lookup, trust);
    if (!addresses) return null;
    if (!sshCommand) {
      const { getGlobalIdentity } = await import('../git/index.js');
      const globalIdentity = await getGlobalIdentity();
      sshCommand = globalIdentity.sshCommand || (process.env.GIT_SSH ? quoteSshPath(process.env.GIT_SSH) : 'ssh');
    }
    sshCommand += ` -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o Hostname=${addresses[0].address} -o HostKeyAlias=${ssh.hostname.replace(/^\[|\]$/g, '')} -o ProxyCommand=none -o ProxyJump=none`;
    return { args: [], env: { GIT_SSH_COMMAND: sshCommand, GIT_SSH_VARIANT: 'ssh' } };
  }
  const args = await gitNetworkArgs(source, lookup, trust);
  if (!args) return null;
  return sshCommand ? { args, env: { GIT_SSH_COMMAND: sshCommand } } : { args };
};

/**
 * Run a network git command (clone, fetch). The pinned connection options make
 * git honour `http.sslBackend` from the user's config; a Git build that lacks
 * that backend refuses with "Unsupported SSL backend" and names the ones it
 * has, so the command is retried once on the first of those. A failure's
 * stderr is logged: the UI only shows a generic "could not clone".
 */
export const runGitNetwork = async (args, options) => {
  const result = await runGit(args, options);
  if (result.ok) return result;
  const supported = /Unsupported SSL backend[\s\S]*?Supported SSL backends:\s*([\w-]+)/i.exec(result.stderr ?? '')?.[1];
  const retried = supported ? await runGit(['-c', `http.sslBackend=${supported}`, ...args], options) : result;
  if (!retried.ok) {
    console.warn('[guests] git network command failed:', (retried.stderr ?? '').trim() || 'no output');
  }
  return retried;
};

// What git and the common hosts print when a clone is refused for lack of
// access: no stored HTTPS login (prompts are off), a rejected login, or an
// SSH key the host does not accept.
const AUTH_FAILURE_PATTERN = /Authentication failed|could not read (?:Username|Password)|Invalid username or (?:password|token)|HTTP Basic: Access denied|Permission denied \(publickey/i;

/** @param {string | undefined} stderr */
export const isGitAuthFailure = (stderr) => AUTH_FAILURE_PATTERN.test(stderr ?? '');

export const cloneGitRepository = async (source, dest, { gitBinary = 'git', timeoutMs = CLONE_TIMEOUT_MS, ref, lookup, gitIdentityId } = {}) => {
  if (ref !== undefined && !isGitRef(ref)) {
    return { ok: false, code: 'clone-failed' };
  }
  const network = await prepareGuestGitNetwork(source, { lookup, gitIdentityId }).catch(() => null);
  if (!network) {
    return { ok: false, code: 'clone-failed' };
  }
  const args = [...network.args, 'clone', '--depth', '1'];
  if (ref) {
    args.push('--branch', ref);
  }
  args.push('--', source, dest);
  const result = await runGitNetwork(args, { gitBinary, timeoutMs, env: network.env });
  if (result.ok) {
    return { ok: true };
  }
  return { ok: false, code: isGitAuthFailure(result.stderr) ? 'clone-auth-failed' : 'clone-failed' };
};
