import { execFile as nodeExecFile } from 'node:child_process';

/**
 * Vault references in environment variables: a value such as
 * `op://Vertex SRE/github_token/credential` stands for a secret kept in
 * 1Password and is read with the `op` CLI (`op read`) when a process needs
 * it. The resolved value lives in memory only: it is never written, logged or
 * returned, and the variable's stored value stays the reference.
 *
 * A reference that cannot be read leaves its variable out, so a process
 * never receives the literal `op://` text as if it were the token, and the
 * failure is recorded per variable for Settings and the agent tool (the
 * reason, never `op`'s output, which can name vault items). Each recorded
 * outcome is tied to the reference it came from, so a variable whose
 * reference is replaced never shows the old reference's outcome.
 */

// `op://<vault>/<item>/<field>` and the optional `<section>` level; names may contain spaces.
const OP_REFERENCE = /^op:\/\/[^/\s][^/]*\/[^/]+\/[^/]+(\/[^/]+)?$/;

export const isVaultReference = (value) => OP_REFERENCE.test(String(value ?? '').trim());

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TTL_MS = 5 * 60_000;

const readFailureReason = (error) => {
  if (error?.code === 'ENOENT') return 'op-not-installed';
  if (error?.killed || error?.signal === 'SIGTERM') return 'timeout';
  return 'op-read-failed';
};

/**
 * `resolve(variables, { refresh })` answers the variables with each vault
 * reference replaced by its secret, or left out when it cannot be read.
 * `refresh: true` re-reads every reference, even one read moments ago:
 * a caller that launches a process with the secret (Restart OpenCode after
 * a rotation) must not be handed the pre-rotation value from the cache.
 * `refresh: false` uses only what an earlier read left, fresh or stale, so
 * a caller on a hot path (Git status polling) never starts `op`. Either
 * way a failed re-read keeps the last good value.
 */
export const createVaultResolver = ({
  execFile = nodeExecFile,
  env = () => process.env,
  now = Date.now,
  logger = console,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ttlMs = DEFAULT_TTL_MS,
} = {}) => {
  // reference -> { at, value }
  const values = new Map();
  const reads = new Map();
  // variable name -> { state: 'resolved' | 'failed', reason?, at, reference }
  // The reference is kept with the outcome: a status answers for the
  // reference it was recorded under, never for a replacement.
  const statuses = new Map();
  const reported = new Set();

  const readReference = (reference) => {
    const pending = reads.get(reference);
    if (pending) return pending;
    const read = new Promise((resolve) => {
      execFile('op', ['read', '--no-newline', reference], { env: env(), timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) {
          resolve({ ok: false, reason: readFailureReason(error) });
          return;
        }
        const value = String(stdout ?? '');
        resolve(value ? { ok: true, value } : { ok: false, reason: 'empty' });
      });
    }).then((outcome) => {
      if (outcome.ok) values.set(reference, { at: now(), value: outcome.value });
      return outcome;
    }).finally(() => {
      reads.delete(reference);
    });
    reads.set(reference, read);
    return read;
  };

  const record = (name, reference, outcome) => {
    statuses.set(name, outcome.ok ? { state: 'resolved', at: now(), reference } : { state: 'failed', reason: outcome.reason, at: now(), reference });
    if (!outcome.ok) {
      const message = `[environment] ${name} is a vault reference that could not be read (${outcome.reason}); it is left out`;
      if (!reported.has(message)) {
        reported.add(message);
        logger.warn(message);
      }
    }
  };

  const resolve = async (variables, { refresh = true } = {}) => {
    const entries = Object.entries(variables ?? {});
    if (!entries.some(([, value]) => isVaultReference(value))) return variables;
    const resolved = {};
    await Promise.all(entries.map(async ([name, value]) => {
      if (!isVaultReference(value)) {
        resolved[name] = value;
        return;
      }
      const reference = String(value).trim();
      // A status recorded under a different reference answers for that
      // reference, so it is dropped before this one is served or read.
      if (statuses.get(name)?.reference !== reference) statuses.delete(name);
      const cached = values.get(reference);
      if (cached && !refresh) {
        resolved[name] = cached.value;
        record(name, reference, { ok: true });
        return;
      }
      if (!refresh) return;
      const outcome = await readReference(reference);
      record(name, reference, outcome);
      if (outcome.ok) resolved[name] = outcome.value;
      else if (cached) resolved[name] = cached.value;
    }));
    return resolved;
  };

  /**
   * Per variable: the last read's outcome, or absent before any read.
   * With `variables`, only outcomes recorded under the reference each
   * variable currently holds are answered, so a replaced reference never
   * inherits the previous one's outcome.
   */
  const status = (variables) => Object.fromEntries([...statuses].filter(([name, entry]) => {
    if (!variables) return true;
    const value = variables[name];
    return isVaultReference(value) && String(value).trim() === entry.reference;
  }).map(([name, { reference: _reference, ...entry }]) => [name, entry]));

  /**
   * One reference's secret, for a caller that holds a reference itself (an
   * integration account): `{ ok: true, value }` or `{ ok: false, reason }`.
   * Shares the cache and the five-minute refresh with `resolve`; a failed
   * re-read keeps the last good value.
   */
  const readSecret = async (reference) => {
    const trimmed = String(reference ?? '').trim();
    if (!isVaultReference(trimmed)) return { ok: false, reason: 'not-a-reference' };
    const cached = values.get(trimmed);
    if (cached && now() - cached.at < ttlMs) return { ok: true, value: cached.value };
    const outcome = await readReference(trimmed);
    if (outcome.ok) return outcome;
    return cached ? { ok: true, value: cached.value } : outcome;
  };

  return { resolve, status, readSecret };
};
