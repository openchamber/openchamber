import { execFile } from 'child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'util';
import { createGitCredentialBroker, GIT_CREDENTIAL_NONCE_ENV } from '../git/credential-broker.js';
import { normalizeGitRemoteEndpoint } from '../git/credential-resolver.js';
import { managedSshCommand } from '../git/network-operations.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

const isolatedGitEnvironment = (allowedProtocol) => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^GIT_CONFIG(?:_|$)/i.test(name)
      || /^GIT_TRACE(?:2)?(?:_|$)/i.test(name)
      || /^(?:GIT_ASKPASS|SSH_ASKPASS|SSH_ASKPASS_REQUIRE|GIT_SSH|GIT_SSH_COMMAND|GIT_SSH_VARIANT|GIT_PROXY_COMMAND|SSH_AUTH_SOCK|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|NETRC|CURL_CA_BUNDLE|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(name)) {
      delete env[name];
    }
    if (/^(?:GIT_CURL_VERBOSE|GIT_REDIRECT_STDERR|GIT_SSL_CERT|GIT_SSL_KEY|GIT_SSL_CAINFO|GIT_SSL_CAPATH|GIT_SSL_CIPHER_LIST|GIT_SSL_VERSION|GIT_SSL_NO_VERIFY|GIT_SSL_CERT_PASSWORD_PROTECTED|SSLKEYLOGFILE)$/i.test(name)
      || /^CURL_/i.test(name)) {
      delete env[name];
    }
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_ALLOW_PROTOCOL = allowedProtocol;
  if (allowedProtocol === 'https') {
    // Git's Curl transport also consults netrc outside Git configuration; an
    // ambient ~/.netrc entry must not authenticate as another account than
    // the selected one. SSH keeps HOME for known_hosts.
    for (const name of Object.keys(env)) {
      if (['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'HOMEDRIVE', 'HOMEPATH'].includes(name.toUpperCase())) delete env[name];
    }
    env.HOME = env.USERPROFILE = env.XDG_CONFIG_HOME = process.platform === 'win32' ? 'NUL' : '/dev/null';
  }
  return env;
};

export function looksLikeAuthError(message) {
  const text = String(message || '');
  return (
    /permission denied/i.test(text) ||
    /publickey/i.test(text) ||
    /could not read from remote repository/i.test(text) ||
    /authentication failed/i.test(text) ||
    /selected git identity/i.test(text) ||
    /fatal: could not/i.test(text)
  );
}

export async function runGit(args, options = {}) {
  const cwd = options.cwd;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxBuffer = Number.isFinite(options.maxBuffer) ? options.maxBuffer : DEFAULT_MAX_BUFFER;

  const identity = options.identity || null;
  const normalizedArgs = Array.isArray(args) ? args.slice() : [];

  let env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  let credential;
  let broker;
  let lease;

  try {
    if (identity?.credentialId) {
      if (!options.credentialResolver || !identity.endpoint) {
        return { ok: false, stdout: '', stderr: '', message: 'Selected Git identity is unavailable' };
      }

      const operationId = randomUUID();
      try {
        credential = await options.credentialResolver.resolve({
          mode: 'managed',
          credentialId: identity.credentialId,
          endpoint: normalizeGitRemoteEndpoint(identity.endpoint),
          operationId,
          deadline: Date.now() + timeoutMs,
        });
      } catch {
        return { ok: false, stdout: '', stderr: '', message: 'Authentication failed for the selected Git identity' };
      }

      if (credential.transport === 'https') {
        broker = createGitCredentialBroker({ capacity: 1, ttlMs: timeoutMs });
        await broker.start();
        lease = broker.issue({ operationId, credential });
        env = isolatedGitEnvironment('https');
        env[GIT_CREDENTIAL_NONCE_ENV] = lease.env[GIT_CREDENTIAL_NONCE_ENV];
        normalizedArgs.unshift(
          '-c', 'credential.helper=',
          '-c', 'credential.useHttpPath=true',
          '-c', 'http.proxy=',
          '-c', 'http.sslVerify=true',
          '-c', 'http.followRedirects=false',
          '-c', 'http.extraHeader=',
          '-c', 'http.cookieFile=',
          '-c', 'credential.interactive=false',
          '-c', 'submodule.recurse=false',
          '-c', 'fetch.recurseSubmodules=false',
          ...lease.gitConfigArgs,
        );
      } else if (credential.transport === 'ssh') {
        env = isolatedGitEnvironment('ssh');
        normalizedArgs.unshift('-c', `core.sshCommand=${managedSshCommand(credential.key.privateKeyPath)}`);
      } else {
        return { ok: false, stdout: '', stderr: '', message: 'Selected Git identity cannot authenticate this repository' };
      }
    } else if (identity?.anonymous) {
      env = isolatedGitEnvironment('https');
      normalizedArgs.unshift(
        '-c', 'credential.helper=',
        '-c', 'http.proxy=',
        '-c', 'http.followRedirects=false',
        '-c', 'http.extraHeader=',
        '-c', 'http.cookieFile=',
        '-c', 'credential.interactive=false',
        '-c', 'submodule.recurse=false',
        '-c', 'fetch.recurseSubmodules=false',
      );
    } else if (identity) {
      // A selected identity that names no credential never falls back to System Git.
      return { ok: false, stdout: '', stderr: '', message: 'Selected Git identity is unavailable' };
    }

    const { stdout, stderr } = await execFileAsync('git', normalizedArgs, {
      cwd,
      env,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer,
    });

    return { ok: true, stdout: stdout || '', stderr: stderr || '' };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const stdout = String(err.stdout ?? '');
    const stderr = String(err.stderr ?? '');
    const message = err.message;

    return {
      ok: false,
      stdout,
      stderr,
      message,
      code: Number.isInteger(err.code) ? err.code : null,
      signal: err.signal == null ? null : String(err.signal),
    };
  } finally {
    lease?.revoke();
    if (credential?.transport === 'ssh') await credential.key.cleanup();
    if (broker) await broker.close();
  }
}

export async function assertGitAvailable() {
  const result = await runGit(['--version'], { timeoutMs: 5_000 });
  if (!result.ok) {
    return { ok: false, error: { kind: 'gitUnavailable', message: 'Git is not available in PATH' } };
  }
  return { ok: true };
}
