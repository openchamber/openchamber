import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

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
export const isPublicHostname = (hostname) => {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return false;
  }
  const version = net.isIP(host);
  if (version === 4) {
    return !PRIVATE_IPV4.some((pattern) => pattern.test(host));
  }
  if (version === 6) {
    return !(host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('::ffff:'));
  }
  return host.includes('.');
};

/**
 * A public-looking hostname can still resolve to a private address (a DNS
 * record the link's author controls). Every address it resolves to must be
 * public; a name that does not resolve is refused too.
 * @param {string} hostname
 * @param {(hostname: string, options: { all: true }) => Promise<Array<{ address: string }>>} [lookup]
 */
/**
 * The addresses a public hostname resolves to, or `null` when the name is
 * not public, does not resolve, or any answer is private. Callers connect to
 * exactly these addresses, so a second lookup by the HTTP client or by git
 * cannot answer differently.
 * @param {string} hostname
 * @param {(hostname: string, options: { all: true }) => Promise<Array<{ address: string, family?: number }>>} [lookup]
 * @returns {Promise<Array<{ address: string, family: 4 | 6 }> | null>}
 */
export const publicAddressesOf = async (hostname, lookup = (name, options) => dns.lookup(name, options)) => {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (!isPublicHostname(host)) {
    return null;
  }
  const literal = net.isIP(host);
  if (literal) {
    return [{ address: host, family: literal === 6 ? 6 : 4 }];
  }
  try {
    const addresses = await lookup(host, { all: true });
    if (addresses.length === 0 || !addresses.every((entry) => isPublicHostname(entry.address))) {
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
 * the redirect rule). `null` when the URL is https but not public.
 * @param {string} url
 * @param {Parameters<typeof publicAddressesOf>[1]} [lookup]
 * @returns {Promise<string[] | null>}
 */
export const gitNetworkArgs = async (url, lookup) => {
  const hostname = httpsHostname(url);
  if (hostname === null) {
    return [];
  }
  const addresses = await publicAddressesOf(hostname, lookup);
  if (!addresses) {
    return null;
  }
  const port = new URL(url).port || '443';
  return [
    '-c', 'http.followRedirects=false',
    '-c', `http.curloptResolve=${hostname}:${port}:${addresses.map((entry) => entry.address).join(',')}`,
  ];
};

const isHttpsGitUrl = (value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && isPublicHostname(parsed.hostname);
  } catch {
    return false;
  }
};

/** SSH URLs and scp-style addresses, with no shell syntax in their components. */
const parseSshGitUrl = (value) => {
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
  if (!isPublicHostname(hostname) || (username && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(username))) return null;
  if (!/^\/?[A-Za-z0-9_.~][A-Za-z0-9_./~-]*$/.test(repository) || repository.split('/').includes('..')) return null;
  return port ? { hostname, port } : { hostname };
};

export const isHttpsZipUrl = (value) => {
  if (!isHttpsGitUrl(value)) {
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
 * fragment that is not a usable ref, or a URL that is not public HTTPS/SSH, is
 * `null` (the install route answers `invalid-url`).
 * @param {string} value
 */
export const parseGitInstallUrl = (value) => {
  const hashAt = value.indexOf('#');
  const rawUrl = hashAt === -1 ? value : value.slice(0, hashAt);
  const url = rawUrl.replace(/^ssh:\/\//i, 'ssh://');
  const ref = hashAt === -1 ? '' : value.slice(hashAt + 1);
  if (!isHttpsGitUrl(url) && !parseSshGitUrl(url)) {
    return null;
  }
  if (hashAt !== -1 && !isGitRef(ref)) {
    return null;
  }
  return ref ? { url, ref } : { url };
};

/**
 * Run one git command without a terminal. Resolves `{ ok: true, stdout }` on
 * exit 0 and `{ ok: false }` on a non-zero exit, a spawn error, or the
 * timeout (the child is killed). Never rejects. `stdout` is captured only
 * when `capture` is set so a clone's progress is not buffered.
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
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false });
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      finish({ ok: false });
    });
    child.on('close', (exit) => {
      clearTimeout(timer);
      finish(exit === 0 ? { ok: true, stdout: Buffer.concat(chunks).toString('utf8') } : { ok: false });
    });
  })
);

/**
 * Clone `source` into `dest`. Production uses HTTPS/SSH; tests may use a local repo path.
 * `gitBinary` comes from the host's git resolver: on Windows and in the packaged desktop app a bare
 * `git` is often not on PATH. `ref` pins a branch or tag (`--branch`); a shallow clone of a tag
 * works the same way as of a branch.
 */
/** @returns {string | null} the hostname when `value` is an https URL */
const httpsHostname = (value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.hostname : null;
  } catch {
    return null;
  }
};

const quoteSshPath = (value) => {
  const expanded = value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  const normalized = process.platform === 'win32' ? expanded.replace(/\\/g, '/') : expanded;
  return `'${normalized.replace(/'/g, "'\\''")}'`;
};

/** Resolve identity on the server for every clone/fetch, so key rotation takes effect. */
export const prepareGuestGitNetwork = async (source, { gitIdentityId, lookup } = {}) => {
  let sshCommand = process.env.GIT_SSH_COMMAND?.trim() || '';
  if (gitIdentityId && gitIdentityId !== 'global') {
    const { getProfile } = await import('../git/identity-storage.js');
    const profile = getProfile(gitIdentityId);
    if (!profile) return null;
    if (profile.sshKey) sshCommand = `ssh -i ${quoteSshPath(profile.sshKey)} -o IdentitiesOnly=yes`;
  }
  const ssh = parseSshGitUrl(source);
  if (ssh) {
    const addresses = await publicAddressesOf(ssh.hostname, lookup);
    if (!addresses) return null;
    if (!sshCommand) {
      const { getGlobalIdentity } = await import('../git/index.js');
      const globalIdentity = await getGlobalIdentity();
      sshCommand = globalIdentity.sshCommand || (process.env.GIT_SSH ? quoteSshPath(process.env.GIT_SSH) : 'ssh');
    }
    sshCommand += ` -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o Hostname=${addresses[0].address} -o HostKeyAlias=${ssh.hostname.replace(/^\[|\]$/g, '')} -o ProxyCommand=none -o ProxyJump=none`;
    return { args: [], env: { GIT_SSH_COMMAND: sshCommand, GIT_SSH_VARIANT: 'ssh' } };
  }
  const args = await gitNetworkArgs(source, lookup);
  if (!args) return null;
  return sshCommand ? { args, env: { GIT_SSH_COMMAND: sshCommand } } : { args };
};

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
  const result = await runGit(args, { gitBinary, timeoutMs, env: network.env });
  return result.ok ? { ok: true } : { ok: false, code: 'clone-failed' };
};
