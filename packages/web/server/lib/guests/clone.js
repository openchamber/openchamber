import { spawn } from 'node:child_process';
import net from 'node:net';

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

export const isHttpsGitUrl = (value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && isPublicHostname(parsed.hostname);
  } catch {
    return false;
  }
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
 * fragment that is not a usable ref, or a URL that is not public https, is
 * `null` (the install route answers `invalid-url`).
 * @param {string} value
 */
export const parseGitInstallUrl = (value) => {
  const hashAt = value.indexOf('#');
  const url = hashAt === -1 ? value : value.slice(0, hashAt);
  const ref = hashAt === -1 ? '' : value.slice(hashAt + 1);
  if (!isHttpsGitUrl(url)) {
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
export const runGit = (args, { gitBinary = 'git', cwd, timeoutMs = CLONE_TIMEOUT_MS, capture = false } = {}) => (
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        gitBinary,
        args,
        {
          cwd,
          env: {
            ...process.env,
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
 * Clone `source` into `dest`. `source` is an https URL in production. Tests pass a local repo path.
 * `gitBinary` comes from the host's git resolver: on Windows and in the packaged desktop app a bare
 * `git` is often not on PATH. `ref` pins a branch or tag (`--branch`); a shallow clone of a tag
 * works the same way as of a branch.
 */
export const cloneGitRepository = async (source, dest, { gitBinary = 'git', timeoutMs = CLONE_TIMEOUT_MS, ref } = {}) => {
  if (ref !== undefined && !isGitRef(ref)) {
    return { ok: false, code: 'clone-failed' };
  }
  const args = ['clone', '--depth', '1'];
  if (ref) {
    args.push('--branch', ref);
  }
  args.push('--', source, dest);
  const result = await runGit(args, { gitBinary, timeoutMs });
  return result.ok ? { ok: true } : { ok: false, code: 'clone-failed' };
};
