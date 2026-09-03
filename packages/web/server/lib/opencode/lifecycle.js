import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { stripAppImageArgv0Leak } from '../inherited-env.js';
import os from 'node:os';
import path from 'node:path';
import { registerManagedProcess, unregisterManagedProcess, reapOrphanedProcesses } from './managed-process-registry.js';
import { applyProviderEnvAliases } from './provider-env-aliases.js';
import { recordStartupPerformance } from './startup-performance.js';
import { detectAndAdoptGuardianChild, getGuardianSocketPath, isGuardianRunning } from '../guardian/detection.js';
import {
  GuardianClient,
  GUARDIAN_AMBIGUOUS_REQUEST_CODE,
  isAmbiguousGuardianRequestError,
} from '../guardian/guardian-client.js';
import {
  buildManagedOpenCodeOrigin,
  resolveManagedOpenCodeConnectHostname,
} from '../guardian/host.js';
import { resolveGuardianPaths } from '../guardian/paths.js';
import {
  createLaunchFingerprint,
  createRuntimeIdentity,
  normalizeOwnerInstanceId,
} from '../guardian/owner-identity.js';
import { waitForGuardianManagedOpenCodeReady } from '../guardian/lifecycle-health.js';

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const HEALTH_CHECK_TIMEOUT_MS = parsePositiveInt(process.env.OPENCHAMBER_OPENCODE_HEALTH_TIMEOUT_MS, 5000);
const HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES = parsePositiveInt(
  process.env.OPENCHAMBER_OPENCODE_HEALTH_CONSECUTIVE_FAILURES,
  20
);
const HEALTH_CHECK_INTERVAL_OVERRIDE_MS = parsePositiveInt(process.env.OPENCHAMBER_OPENCODE_HEALTH_INTERVAL_MS, 0);
const HEALTH_CHECK_RESULT_CACHE_MS = parsePositiveInt(process.env.OPENCHAMBER_OPENCODE_HEALTH_CACHE_MS, 750);
const OPENCODE_HEALTH_PATH = '/global/health';
// Last-used directory plus the three most recently opened projects — deeper
// tails are unlikely to be the user's first click and just add background work.
const WARMUP_DIRECTORY_LIMIT = 4;
const WARMUP_REQUEST_TIMEOUT_MS = 30000;
const MANAGED_STDERR_TAIL_MAX_BYTES = 32 * 1024;
const HEALTH_FAILURE_DETAIL_MAX_LENGTH = 256;

const getBoundedTextTail = (value, maxBytes) => {
  const buffer = Buffer.from(String(value ?? ''));
  if (buffer.byteLength <= maxBytes) return buffer.toString();
  return buffer.subarray(buffer.byteLength - maxBytes).toString();
};

const sanitizeDiagnosticText = (value) => String(value ?? '')
  .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[redacted]@')
  .replace(/\b(Bearer)\s+[^\s,;]+/gi, '$1 [redacted]')
  // Unquoted `Authorization: <scheme> <credential>` values must be handled
  // before the generic key/value rule below: that rule stops at whitespace, so
  // it would redact only the scheme word and leave the credential intact.
  // Scoped to authorization-style keys so ordinary prose using "basic" or
  // "token" is not mangled.
  .replace(
    /(^|[\s,{\[])((?:"|')?[a-z0-9_.-]{0,80}authorization[a-z0-9_.-]{0,80}(?:"|')?\s*[:=]\s*(?:"|')?(?:basic|bearer|token)\s+)[^\s,;"']+/gim,
    '$1$2[redacted]',
  )
  .replace(/([?&][^=&#\s]*(?:token|api[_-]?key|password|secret|authorization|credential|private[_-]?key)[^=&#\s]*=)[^&#\s]+/gi, '$1[redacted]')
  .replace(
    /(^|[\s,{\[])((?:"|')?[a-z0-9_.-]{0,80}(?:token|api[_-]?key|password|secret|authorization|credential|private[_-]?key)[a-z0-9_.-]{0,80}(?:"|')?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gim,
    '$1$2[redacted]',
  );

const getHealthFailureDetail = (error) => {
  const name = String(error?.name || 'Error');
  const message = String(error?.message || error || 'Unknown error');
  return sanitizeDiagnosticText(`${name}: ${message}`).slice(0, HEALTH_FAILURE_DETAIL_MAX_LENGTH);
};

const classifyHealthProbeError = (error) => {
  const name = String(error?.name || '');
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || error || '');
  const normalizedMessage = message.toLowerCase();

  if (
    name === 'AbortError'
    || name === 'TimeoutError'
    || normalizedMessage.includes('the operation was aborted')
    || normalizedMessage.includes('abortsignal.timeout')
  ) {
    return { class: 'timeout', detail: getHealthFailureDetail(error) };
  }
  if (code === 'ECONNREFUSED' || normalizedMessage.includes('econnrefused')) {
    return { class: 'connection_refused', detail: getHealthFailureDetail(error) };
  }
  if (
    code === 'ECONNRESET'
    || normalizedMessage.includes('econnreset')
    || normalizedMessage.includes('socket hang up')
  ) {
    return { class: 'connection_reset', detail: getHealthFailureDetail(error) };
  }
  return { class: 'error', detail: getHealthFailureDetail(error) };
};
const GUARDIAN_BLOCKED_ENV_KEY = /^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|COMSPEC|ComSpec)$/i;
const MANAGED_STARTUP_CAPTURE_LIMIT = 16 * 1024;
const MANAGED_STARTUP_DIAGNOSTIC_LIMIT = 32 * 1024;
const STARTUP_REDACTION = '[REDACTED]';
const MANAGED_CREDENTIAL_ENV_KEY = /(?:PASSWORD|TOKEN|SECRET|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)/i;
const createGuardianOperationId = () => randomBytes(32).toString('base64url');

const appendBoundedStartupOutput = (current, text) => {
  const value = String(text ?? '');
  const remaining = MANAGED_STARTUP_CAPTURE_LIMIT - current.value.length;
  if (remaining <= 0) return { value: current.value, truncated: true };
  if (value.length <= remaining) {
    return { value: current.value + value, truncated: current.truncated };
  }
  return {
    value: current.value + value.slice(0, remaining),
    truncated: true,
  };
};

const createManagedStartupOutputFormatter = (env = {}, additionalSecrets = []) => {
  const secrets = new Set();
  for (const value of additionalSecrets) {
    if (typeof value === 'string' && value.length > 0) secrets.add(value);
  }

  if (env && typeof env === 'object') {
    for (const [key, value] of Object.entries(env)) {
      if (MANAGED_CREDENTIAL_ENV_KEY.test(key) && typeof value === 'string' && value.length > 0) {
        secrets.add(value);
        const trimmed = value.trim();
        if (trimmed.length > 0) secrets.add(trimmed);
      }
    }

    const password = typeof env.OPENCODE_SERVER_PASSWORD === 'string'
      ? env.OPENCODE_SERVER_PASSWORD
      : '';
    if (password.length > 0) {
      const username = typeof env.OPENCODE_SERVER_USERNAME === 'string'
        && env.OPENCODE_SERVER_USERNAME.trim().length > 0
        ? env.OPENCODE_SERVER_USERNAME.trim()
        : 'opencode';
      const basicValue = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
      secrets.add(basicValue);
      secrets.add(`Basic ${basicValue}`);
    }
  }

  const orderedSecrets = () => Array.from(secrets)
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);

  const redact = (value) => {
    let text = String(value ?? '');
    for (const secret of orderedSecrets()) {
      text = text.split(secret).join(STARTUP_REDACTION);
    }
    return text;
  };

  const bound = (value) => {
    const text = redact(value);
    if (text.length <= MANAGED_STARTUP_DIAGNOSTIC_LIMIT) return text;
    return `${text.slice(0, MANAGED_STARTUP_DIAGNOSTIC_LIMIT)}\n...[startup diagnostic truncated]`;
  };

  // Hold only a bounded, match-aware overlap before emitting capture text. A
  // fixed suffix is not sufficient here: if the last emitted byte is the
  // first byte of a candidate, the rest of that candidate can be emitted by
  // a later chunk and reconstruct the secret across output boundaries.
  // Secrets larger than the capture bound disable raw capture entirely rather
  // than allowing an unbounded overlap to grow with an environment value.
  const createStreamingRedactor = ({ outputLimit = MANAGED_STARTUP_CAPTURE_LIMIT } = {}) => {
    const candidates = orderedSecrets();
    const maxSecretLength = candidates[0]?.length || 0;
    const canBoundOverlap = maxSecretLength <= MANAGED_STARTUP_CAPTURE_LIMIT;
    let pending = '';
    let sawInput = false;
    let emittedLength = 0;

    const emitBounded = (value) => {
      const text = String(value ?? '');
      const remaining = outputLimit - emittedLength;
      if (remaining <= 0 || text.length === 0) return '';
      const output = text.length <= remaining ? text : text.slice(0, remaining);
      emittedLength += output.length;
      return output;
    };

    const processPending = () => {
      let cursor = 0;
      const output = [];
      // Never emit the trailing overlap merely because no candidate is
      // currently a prefix at its first code unit. A future candidate may
      // begin anywhere in that suffix (for example the first chunk of
      // `xpasswordx` must not emit `xpass` before the next chunk arrives).
      // Keeping the full max-length overlap is conservative, bounded, and
      // prevents raw spans from being reassembled into a secret by callers.
      const safeEnd = Math.max(0, pending.length - (maxSecretLength - 1));

      while (cursor < pending.length) {
        let completeMatch = null;
        let hasIncompleteMatch = false;

        for (const candidate of candidates) {
          if (pending.startsWith(candidate, cursor)) {
            completeMatch = candidate;
            break;
          }

          const remainingLength = pending.length - cursor;
          if (
            remainingLength < candidate.length
            && candidate.startsWith(pending.slice(cursor))
          ) {
            hasIncompleteMatch = true;
          }
        }

        if (completeMatch) {
          output.push(STARTUP_REDACTION);
          cursor += completeMatch.length;
          continue;
        }

        if (cursor >= safeEnd) break;

        // This position is a possible beginning of a candidate, but the
        // stream has not supplied enough bytes to decide whether it is a
        // match. Keep it and everything after it until the next chunk.
        if (hasIncompleteMatch) break;

        // No candidate can begin here. It is now safe to release this one
        // raw code unit and inspect the next position independently.
        output.push(pending[cursor]);
        cursor += 1;
      }

      pending = pending.slice(cursor);
      return emitBounded(output.join(''));
    };

    return {
      push(chunk) {
        const text = chunk?.toString?.() ?? String(chunk ?? '');
        if (text.length === 0) return '';
        sawInput = true;
        if (!canBoundOverlap) return '';
        if (maxSecretLength === 0) return emitBounded(text);

        pending += text;
        return processPending();
      },
      flush() {
        const output = !canBoundOverlap
          ? (sawInput ? emitBounded(STARTUP_REDACTION) : '')
          : emitBounded(redact(pending));
        pending = '';
        return output;
      },
    };
  };

  const formatCapturedOutput = ({
    stdout = '',
    stderr = '',
    stdoutTruncated = false,
    stderrTruncated = false,
  } = {}) => {
    const parts = [];
    const formatStream = (label, value, truncated) => {
      const trimmed = String(value ?? '').trim();
      if (!trimmed) return;
      const suffix = truncated ? '\n...[startup output truncated]' : '';
      parts.push(`${label}:\n${bound(trimmed)}${suffix}`);
    };
    formatStream('stdout', stdout, stdoutTruncated);
    formatStream('stderr', stderr, stderrTruncated);
    return parts.length > 0 ? parts.join('\n\n') : 'No stdout/stderr captured';
  };

  return { bound, createStreamingRedactor, formatCapturedOutput, secrets };
};

const createManagedStartupCapture = (formatter, sharedRedactor = formatter.createStreamingRedactor()) => {
  const redactor = sharedRedactor;
  let value = '';
  let truncated = false;
  let inputLength = 0;
  let finished = false;

  const appendSafe = (text) => {
    const captured = appendBoundedStartupOutput({ value, truncated }, text);
    value = captured.value;
    truncated = captured.truncated;
  };

  return {
    append(chunk) {
      if (finished) return;
      const text = chunk?.toString?.() ?? String(chunk ?? '');
      inputLength += text.length;
      if (inputLength > MANAGED_STARTUP_CAPTURE_LIMIT) truncated = true;
      // Keep advancing the shared redactor after this label reaches its
      // capture bound. A later stdout/stderr chunk may complete a candidate;
      // dropping the input here would flush that candidate prefix as raw text.
      const redacted = redactor.push(text);
      if (value.length < MANAGED_STARTUP_CAPTURE_LIMIT) appendSafe(redacted);
    },
    finish({ flush = true } = {}) {
      if (!finished) {
        finished = true;
        if (flush) appendSafe(redactor.flush());
      }
      return { value, truncated };
    },
  };
};

const copyStructuredStartupErrorMetadata = (target, source) => {
  if (!source || typeof source !== 'object') return target;
  if (isAmbiguousGuardianRequestError(source)) {
    // An outer cleanup wrapper may preserve the ambiguity marker in
    // originalCode while replacing code with its own failure code. Normalize
    // it back to the stable fail-closed contract and retain the underlying
    // transport code for diagnosis.
    target.code = GUARDIAN_AMBIGUOUS_REQUEST_CODE;
    target.ambiguous = true;
    target.retryable = false;
    const originalCode = typeof source.code === 'string'
      && source.code !== GUARDIAN_AMBIGUOUS_REQUEST_CODE
      ? source.code
      : source.originalCode;
    if (typeof originalCode === 'string' && originalCode !== GUARDIAN_AMBIGUOUS_REQUEST_CODE) {
      target.originalCode = originalCode;
    }
    if (typeof source.name === 'string' && source.name !== 'Error') target.name = source.name;
    return target;
  }
  if (typeof source.code === 'string') target.code = source.code;
  if (typeof source.name === 'string' && source.name !== 'Error') target.name = source.name;
  if (typeof source.retryable === 'boolean') target.retryable = source.retryable;
  if (typeof source.originalCode === 'string') target.originalCode = source.originalCode;
  if (source.ambiguous === true) target.ambiguous = true;
  return target;
};

const createRedactedStartupError = (error, formatter) => {
  const rawMessage = error instanceof Error ? error.message : String(error ?? '');
  const message = formatter.bound(rawMessage);
  const safeError = new Error(message);
  if (error && typeof error === 'object' && typeof error.code === 'string') {
    safeError.code = error.code;
  }
  if (error && typeof error === 'object' && typeof error.name === 'string' && error.name !== 'Error') {
    safeError.name = error.name;
  }
  copyStructuredStartupErrorMetadata(safeError, error);
  return safeError;
};

const buildGuardianSpawnEnv = (env) => Object.fromEntries(
  Object.entries(env || {}).filter(([key]) => !GUARDIAN_BLOCKED_ENV_KEY.test(key)),
);

const getGuardianPaths = () => resolveGuardianPaths();
const getGuardianSocket = () => getGuardianSocketPath(getGuardianPaths().rootDir);
const getWindowsPortPath = () => getGuardianPaths().portPath;

export const createOpenCodeLifecycleRuntime = (deps) => {
  const {
    state,
    env,
    syncToHmrState,
    syncFromHmrState,
    getOpenCodeAuthHeaders,
    buildOpenCodeUrl,
    waitForReady,
    normalizeApiPrefix,
    applyOpencodeBinaryFromSettings,
    ensureOpencodeCliEnv,
    ensureLocalOpenCodeServerPassword,
    captureOpenCodeAuthState,
    restoreManagedOpenCodeCredential,
    resolveManagedOpenCodeLaunchSpec,
    setOpenCodePort,
    setDetectedOpenCodeApiPrefix,
    setupProxy,
    ensureOpenCodeApiPrefix,
    clearResolvedOpenCodeBinary,
    buildAugmentedPath,
    buildManagedOpenCodePath,
    getManagedOpenCodeShellEnvSnapshot,
    getManagedOpenCodeEnv = async () => ({}),
    getActiveSessionCount = () => 0,
    reapManagedOrphanedProcesses = reapOrphanedProcesses,
    getWarmupDirectories = async () => [],
    onOpenCodeRestarted = null,
    now = Date.now,
    resetSessionRuntimeForOpenCodeReplacement = () => {},
    waitForPortRelease: injectedWaitForPortRelease,
  } = deps;

  const killProcessOnPortWin32 = (port) => {
    try {
      // Get-NetTCPConnection reads the same locale-independent WinNT API
      // netstat's display layer translates (e.g. "LISTENING" renders as
      // "ABHÖREN"/"ÉCOUTE"/"ESCUTANDO" on non-English Windows), so this
      // works regardless of the OS display language.
      const result = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-NetTCPConnection -State Listen -LocalPort ${Number.parseInt(port, 10)} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`,
        ],
        { encoding: 'utf8', timeout: 5000, windowsHide: true }
      );
      const output = result.stdout || '';
      const myPid = process.pid;
      const pids = new Set();
      for (const line of output.split(/\r?\n/)) {
        const pid = Number.parseInt(line.trim(), 10);
        if (pid && pid !== myPid) pids.add(pid);
      }
      for (const pid of pids) {
        try {
          spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', timeout: 3000, windowsHide: true });
        } catch {
        }
      }
    } catch {
    }
  };

  // The CLI allocates and persists this identity in the per-port instance
  // metadata, then passes it through OPENCHAMBER_GUARDIAN_OWNER_ID. Do not
  // generate a process-local replacement here: a new random value would make
  // a restarted web server unable to distinguish its own child from another
  // OpenChamber instance using the same guardian.
  const guardianOwnerInstanceId = normalizeOwnerInstanceId(
    deps.guardianOwnerInstanceId || process.env.OPENCHAMBER_GUARDIAN_OWNER_ID,
  ) || null;
  let guardianDataDirectory;
  try {
    guardianDataDirectory = getGuardianPaths().rootDir;
  } catch {
    guardianDataDirectory = process.env.OPENCHAMBER_DATA_DIR || 'default';
  }
  const guardianRuntimeIdentity = deps.guardianRuntimeIdentity || createRuntimeIdentity({
    dataDir: guardianDataDirectory,
    runtime: process.env.OPENCHAMBER_RUNTIME || 'web',
  });

  const createGuardianLaunch = ({ binary, args = [], hostname, port, cwd }) => {
    const launchSpec = {
      binary,
      args: Array.isArray(args) ? [...args] : [],
      hostname,
      port,
      cwd,
    };
    return {
      launchSpec,
      owner: guardianOwnerInstanceId
        ? {
          ownerInstanceId: guardianOwnerInstanceId,
          runtimeIdentity: guardianRuntimeIdentity,
          launchFingerprint: createLaunchFingerprint(launchSpec),
        }
        : null,
    };
  };

  const canUseGuardian = Boolean(guardianOwnerInstanceId && guardianRuntimeIdentity);
  const expectedGuardianOwner = canUseGuardian
    ? {
      ownerInstanceId: guardianOwnerInstanceId,
      runtimeIdentity: guardianRuntimeIdentity,
    }
    : null;

  // Normalized ownership decision: does this OpenChamber instance own a
  // managed local OpenCode? `OPENCODE_SKIP_START` / `OPENCHAMBER_SKIP_START`
  // (or auto-detected external OpenCode) mean the operator told OpenChamber
  // NOT to own/manage a local OpenCode process. Guardian autostart, guardian
  // adoption, guardian-managed spawn, restart handoff, and legacy managed
  // spawn all route through this single decision instead of re-reading the
  // raw env flag at every call site.
  //
  // `ENV_SKIP_OPENCODE_START` is the explicit operator opt-out; the
  // auto-detected external branch is reflected at runtime via
  // `state.isExternalOpenCode`, which the bootstrap/restart paths set after
  // probing. The bootstrap reordering below ensures adoption is skipped
  // before `state.isExternalOpenCode` is ever set, so this predicate is
  // authoritative at every guardian entry point.
  const ownsManagedLocalOpenCode = () => !env.ENV_SKIP_OPENCODE_START;
  // Keep credential values in explicit launch leases rather than one runtime-
  // lifetime Set. A lease remains active while its child or cleanup path can
  // still produce the associated startup output; confirmed child/pipe cleanup
  // retires it so repeated password/token rotation cannot grow this context
  // without bound. The values are never logged or persisted.
  const managedStartupSecretLeases = new Set();
  const guardianStartupSecretLeases = new Map();

  const createManagedStartupSecretLease = (processEnv) => {
    const formatter = createManagedStartupOutputFormatter(processEnv || process.env);
    const lease = {
      secrets: new Set(formatter.secrets),
      released: false,
    };
    managedStartupSecretLeases.add(lease);
    return lease;
  };

  const releaseManagedStartupSecretLease = (lease) => {
    if (!lease) return;
    lease.released = true;
    managedStartupSecretLeases.delete(lease);
    for (const [incarnation, retainedLease] of guardianStartupSecretLeases) {
      if (retainedLease === lease) guardianStartupSecretLeases.delete(incarnation);
    }
  };

  const getManagedStartupFormatter = (processEnv) => {
    const activeSecrets = new Set();
    for (const lease of managedStartupSecretLeases) {
      for (const secret of lease.secrets) activeSecrets.add(secret);
    }
    return createManagedStartupOutputFormatter(processEnv || process.env, activeSecrets);
  };

  const getManagedStartupSecretState = () => {
    const activeSecrets = new Set();
    for (const lease of managedStartupSecretLeases) {
      for (const secret of lease.secrets) activeSecrets.add(secret);
    }
    return {
      leaseCount: managedStartupSecretLeases.size,
      secretCount: activeSecrets.size,
    };
  };

  const getGuardianStartupSecretLeaseCount = () => guardianStartupSecretLeases.size;

  const retainGuardianStartupSecretLease = (incarnation, lease) => {
    if (!incarnation || !lease) return;
    guardianStartupSecretLeases.set(incarnation, lease);
  };

  const releaseGuardianStartupSecretLease = (incarnation) => {
    if (!incarnation) return;
    const lease = guardianStartupSecretLeases.get(incarnation);
    if (!lease) return;
    releaseManagedStartupSecretLease(lease);
  };
  const redactManagedStartupDiagnostic = (value, processEnv) => (
    getManagedStartupFormatter(processEnv).bound(value)
  );
  const sanitizeManagedStartupError = (error, processEnv) => (
    createRedactedStartupError(error, getManagedStartupFormatter(processEnv))
  );

  const getGuardianAdoptionOptions = () => {
    const options = { expectedOwner: expectedGuardianOwner };
    if (typeof restoreManagedOpenCodeCredential === 'function') {
      options.restoreCredential = restoreManagedOpenCodeCredential;
    }
    return options;
  };

  // Guardian health is checked against the child's launch hostname, not the
  // current configured hostname. Keep that verified origin authoritative for
  // proxy/API/SSE URL construction after adoption or handoff, including when
  // the configured host changed while the web process was down or is IPv6.
  const getAuthoritativeGuardianOrigin = ({ child, launchSpec, port } = {}) => {
    const candidate = typeof child?.url === 'string'
      ? child.url
      : (launchSpec
        ? buildManagedOpenCodeOrigin({ hostname: launchSpec.hostname, port })
        : null);
    if (!candidate) {
      throw new Error('Guardian child launch origin is unavailable');
    }
    try {
      return new URL(candidate).origin;
    } catch (error) {
      throw new Error(`Guardian child launch origin is invalid: ${error?.message || String(error)}`);
    }
  };

  const hasCompleteOwnerIdentity = (owner) => Boolean(
    owner
    && typeof owner.ownerInstanceId === 'string'
    && owner.ownerInstanceId.length > 0
    && typeof owner.runtimeIdentity === 'string'
    && owner.runtimeIdentity.length > 0
    && typeof owner.launchFingerprint === 'string'
    && owner.launchFingerprint.length > 0
  );
  const hasOwnerScopeIdentity = (owner) => Boolean(
    owner
    && typeof owner.ownerInstanceId === 'string'
    && owner.ownerInstanceId.length > 0
    && typeof owner.runtimeIdentity === 'string'
    && owner.runtimeIdentity.length > 0
  );

  const withOwner = (params, owner) => owner ? { ...params, owner } : params;

  // A lost response from a side-effecting handoff RPC is an ownership fence,
  // not a normal restart failure. Keep only the authenticated identity and
  // public handoff fields here; the guardian remains authoritative for the
  // record MAC and lease checks.
  let guardianOutcomeUnknownLease = state.guardianOutcomeUnknownLease || null;
  const getGuardianOutcomeUnknownFences = () => {
    const fences = Array.isArray(state.guardianOutcomeUnknownFences)
      ? state.guardianOutcomeUnknownFences
      : (state.guardianOutcomeUnknownFence ? [state.guardianOutcomeUnknownFence] : []);
    return fences.filter((fence) => fence && typeof fence === 'object');
  };
  const getGuardianOutcomeUnknownFence = () => getGuardianOutcomeUnknownFences()[0] || null;
  // A fence is keyed by its durable operation ID when present, falling back to
  // a synthetic kind/incarnation/owner key for legacy injected clients. The
  // replacement operation must remove the previous fence's key and add the
  // next fence's key in a single state transition even when the operation ID
  // changes between prepareHandoff and abortHandoff.
  const guardianFenceKey = (fence) => fence?.operationId
    || `${fence?.kind}:${fence?.incarnation || ''}:${fence?.owner?.ownerInstanceId || ''}`;
  const setGuardianOutcomeUnknownFence = (fence) => {
    const fences = getGuardianOutcomeUnknownFences();
    if (!fence) {
      state.guardianOutcomeUnknownFences = fences;
      state.guardianOutcomeUnknownFence = fences[0] || null;
      state.guardianOutcomeUnknownLease = guardianOutcomeUnknownLease || null;
      syncToHmrState();
      return;
    }
    const key = guardianFenceKey(fence);
    const next = [...fences];
    const index = next.findIndex((candidate) => guardianFenceKey(candidate) === key);
    if (index >= 0) next[index] = fence;
    else next.push(fence);
    state.guardianOutcomeUnknownFences = next;
    state.guardianOutcomeUnknownFence = next[0] || null;
    state.guardianOutcomeUnknownLease = guardianOutcomeUnknownLease || null;
    syncToHmrState();
  };
  const clearGuardianOutcomeUnknownFence = (fence) => {
    const fences = getGuardianOutcomeUnknownFences();
    const key = guardianFenceKey(fence);
    const next = fences.filter((candidate) => guardianFenceKey(candidate) !== key);
    state.guardianOutcomeUnknownFences = next;
    state.guardianOutcomeUnknownFence = next[0] || null;
    syncToHmrState();
  };
  // Replace a previous fence with a built replacement fence in a single state
  // transition and a single HMR sync, even when the operation ID changes. The
  // replacement must be built and validated BEFORE this call so a build failure
  // leaves the old fence untouched. This is the atomic supersession primitive:
  // it never reduces fence state to an intermediate "no fence" window between
  // clearing the old key and adding the new key.
  const replaceGuardianOutcomeUnknownFence = (previousFence, nextFence) => {
    if (!nextFence || typeof nextFence !== 'object' || Array.isArray(nextFence)) {
      throw new Error('Guardian outcome-unknown fence replacement requires a built fence object');
    }
    const previousKey = guardianFenceKey(previousFence);
    const nextKey = guardianFenceKey(nextFence);
    const fences = getGuardianOutcomeUnknownFences();
    // One state transition: drop the previous-key entry, then upsert the
    // replacement by its (possibly different) key. The old fence is removed and
    // the new fence is added in the same `state.guardianOutcomeUnknownFences`
    // assignment, so there is no intermediate window with no fail-closed fence.
    const withoutPrevious = previousKey === nextKey
      ? fences
      : fences.filter((candidate) => guardianFenceKey(candidate) !== previousKey);
    const next = [];
    let upserted = false;
    for (const candidate of withoutPrevious) {
      if (guardianFenceKey(candidate) === nextKey) {
        next.push(nextFence);
        upserted = true;
      } else {
        next.push(candidate);
      }
    }
    if (!upserted) next.push(nextFence);
    state.guardianOutcomeUnknownFences = next;
    state.guardianOutcomeUnknownFence = next[0] || null;
    state.guardianOutcomeUnknownLease = guardianOutcomeUnknownLease || null;
    syncToHmrState();
  };
  const releaseGuardianOutcomeUnknownLease = () => {
    // One startup-secret lease may cover several overlapping lifecycle
    // operations. Releasing it while another fence remains would expose later
    // diagnostics and violate the retention contract.
    if (getGuardianOutcomeUnknownFences().length > 1) return;
    const lease = guardianOutcomeUnknownLease || state.guardianOutcomeUnknownLease || null;
    guardianOutcomeUnknownLease = null;
    releaseManagedStartupSecretLease(lease);
    state.guardianOutcomeUnknownLease = null;
  };
  const createGuardianOutcomeUnknownError = (fence, reason = 'guardian handoff outcome remains unknown') => {
    const error = new Error(reason);
    error.code = GUARDIAN_AMBIGUOUS_REQUEST_CODE;
    error.ambiguous = true;
    error.retryable = false;
    if (typeof fence?.originalCode === 'string' && fence.originalCode !== GUARDIAN_AMBIGUOUS_REQUEST_CODE) {
      error.originalCode = fence.originalCode;
    }
    return error;
  };
  const assertGuardianStopIsUnfenced = () => {
    const fence = getGuardianOutcomeUnknownFence();
    if (fence) {
      throw createGuardianOutcomeUnknownError(
        fence,
        'Guardian stop is blocked by an unresolved owner-scoped ambiguity fence',
      );
    }
  };
  // Build and validate a fence object from a lost-response description WITHOUT
  // mutating fence state, the lease closure variable, or HMR state. This is a
  // pure builder: throwing here (e.g. missing owner identity) must leave the
  // existing fence state untouched so callers can perform atomic supersession
  // as build-then-replace rather than clear-then-persist.
  const buildGuardianOutcomeUnknownFence = ({
    kind,
    incarnation,
    owner,
    preparedRecord,
    successorOwner,
    cleanupTarget,
    rollbackIncarnation,
    rollbackOwner,
    launchSpec,
    oldStopped,
    source,
    operationId,
  }) => {
    const initialSpawn = kind === 'initial-spawn';
    const fenceOwner = initialSpawn ? (successorOwner || owner) : owner;
    if ((!initialSpawn && (!incarnation || !hasCompleteOwnerIdentity(fenceOwner)))
      || (initialSpawn && !hasCompleteOwnerIdentity(fenceOwner))) {
      throw Object.assign(
        new Error('Guardian ambiguous handoff outcome has no complete owner identity'),
        { code: 'GUARDIAN_OUTCOME_UNKNOWN_OWNER' },
      );
    }
    const durableOperationId = operationId || source?.operationId;
    // Legacy injected clients do not expose a durable operation ID. Do not
    // copy a transition record into their fence as if it were a durable
    // operation binding; terminalStatus/confirmTerminal remains the complete
    // authoritative check for that compatibility path.
    const boundRecord = durableOperationId ? preparedRecord : null;
    const originalCode = typeof source?.code === 'string'
      && source.code !== GUARDIAN_AMBIGUOUS_REQUEST_CODE
      ? source.code
      : source?.originalCode;
    return {
      version: 1,
      kind,
      ...(typeof durableOperationId === 'string' && durableOperationId.length > 0 ? { operationId: durableOperationId } : {}),
      ...(incarnation ? { incarnation } : {}),
      owner: { ...fenceOwner },
      ...(Number.isSafeInteger(boundRecord?.revision) ? { revision: boundRecord.revision } : {}),
      ...(Number.isSafeInteger(boundRecord?.leaseExpiresAt)
        ? { leaseExpiresAt: boundRecord.leaseExpiresAt }
        : {}),
      ...(typeof boundRecord?.mac === 'string' ? { mac: boundRecord.mac } : {}),
      ...(successorOwner ? { successorOwner: { ...successorOwner } } : {}),
      ...(cleanupTarget ? { cleanupTarget } : {}),
      ...(rollbackIncarnation ? { rollbackIncarnation } : {}),
      ...(rollbackOwner ? { rollbackOwner: { ...rollbackOwner } } : {}),
      ...(launchSpec ? { launchSpec: { ...launchSpec, args: [...launchSpec.args] } } : {}),
      oldStopped: oldStopped === true,
      ambiguous: isAmbiguousGuardianRequestError(source),
      ...(typeof originalCode === 'string' && originalCode !== GUARDIAN_AMBIGUOUS_REQUEST_CODE
        ? { originalCode }
        : {}),
    };
  };
  const persistGuardianOutcomeUnknownFence = (params) => {
    const fence = buildGuardianOutcomeUnknownFence(params);
    // Retain the startup-secret lease for this fence. This assignment happens
    // only after the pure builder has succeeded, so a validation failure does
    // not silently retain a lease for a fence that was never constructed.
    guardianOutcomeUnknownLease = params.lease || guardianOutcomeUnknownLease;
    setGuardianOutcomeUnknownFence(fence);
  };

  // Reset the OpenCode API prefix detection state. Mirrors the legacy
  // restart fallback (previously inlined): mark the prefix as detected,
  // clear any cached value, and cancel any pending detection timer.
  const resetOpenCodeApiPrefixState = () => {
    state.openCodeApiPrefixDetected = true;
    state.openCodeApiPrefix = '';
    if (state.openCodeApiDetectionTimer) {
      clearTimeout(state.openCodeApiDetectionTimer);
      state.openCodeApiDetectionTimer = null;
    }
  };

  // Build a proxy for a guardian-managed child. Stopping the owned child and
  // detaching this web process are intentionally separate operations:
  // restart shutdown detaches, while explicit stop/ordinary full shutdown
  // uses the owner-scoped stop operation.
  const createGuardianChildProxy = ({ pid, incarnation, client, owner, startupSecretLease = null }) => {
    const stopOwnedOpenCode = async () => {
      if (!client || !incarnation) return false;
      if (!hasCompleteOwnerIdentity(owner)) {
        throw new Error('Guardian child owner identity is required for an owner-scoped stop');
      }
      const retainedFence = getGuardianOutcomeUnknownFences().find((fence) => (
        fence.kind === 'stop' && fence.incarnation === incarnation
      ));
      if (retainedFence
        && retainedFence.ambiguous !== true
        && (!retainedFence.operationId
          || (typeof client.operationStatus !== 'function' && typeof client.terminalStatus !== 'function'))) {
        // Older/injected clients may not expose the durable terminal RPCs. A
        // fresh authenticated empty child list is still authoritative
        // quiescence; it resolves the fence without replaying stop.
        try {
          if (await verifyGuardianChildGone(client, { incarnation })) {
            const lease = startupSecretLease || guardianStartupSecretLeases.get(incarnation);
            releaseManagedStartupSecretLease(lease);
            releaseGuardianStartupSecretLease(incarnation);
            clearGuardianOutcomeUnknownFence(retainedFence);
            return true;
          }
        } catch {
          // Keep the fence blocked when verification is unavailable or stale.
        }
      }
      // A lost stop response may already have terminated this child. The
      // persisted fence must be reconciled before any caller can issue the
      // non-idempotent stop again, including repeated shutdown/close calls.
      assertGuardianStopIsUnfenced();
      const lease = startupSecretLease || guardianStartupSecretLeases.get(incarnation);
      await stopGuardianChildAndVerify({
        client,
        incarnation,
        owner,
        lease,
      });
      if (lease) {
        releaseManagedStartupSecretLease(lease);
      }
      return true;
    };
    const detach = () => {
      if (!client) return;
      if (typeof client.detach === 'function') {
        client.detach();
      } else {
        client.disconnect();
      }
    };
    return {
      pid,
      incarnation,
      isGuardianManaged: true,
      owner: owner || null,
      async health() {
        if (!client || !incarnation || !hasCompleteOwnerIdentity(owner)) {
          throw new Error('Guardian child owner-scoped health identity is unavailable');
        }
        return client.health(withOwner({ incarnation }, owner));
      },
      detach,
      stopOwnedOpenCode,
      async close() {
        try {
          await stopOwnedOpenCode();
        } catch {
          // The shutdown path must not kill an arbitrary listener when the
          // guardian is unreachable or rejects an owner-scoped stop.
        }
      },
      async kill() {
        try {
          await stopOwnedOpenCode();
        } catch {
          // See close().
        }
      },
    };
  };

  const disconnectGuardianClient = async (client) => {
    if (!client) return true;
    try {
      const result = typeof client.detach === 'function'
        ? client.detach()
        : client.disconnect?.();
      if (result && typeof result.then === 'function') {
        await result;
      }
      return true;
    } catch {
      return false;
    }
  };

  const createGuardianClient = ({ connectTimeoutMs = 5000, requestTimeoutMs } = {}) => {
    const paths = getGuardianPaths();
    return new GuardianClient({
      socketPath: getGuardianSocket(),
      portPath: getWindowsPortPath(),
      authSecretPath: paths.authSecretPath,
      connectTimeoutMs,
      ...(Number.isFinite(requestTimeoutMs) ? { requestTimeoutMs } : {}),
    });
  };

  const waitForGuardianReady = async ({ client, incarnation, owner, timeoutMs = 10_000, intervalMs = 100 }) => {
    if (!client || typeof client.health !== 'function') {
      throw new Error('Guardian-managed OpenCode readiness requires owner-scoped Guardian health');
    }
    if (!incarnation || !hasCompleteOwnerIdentity(owner)) {
      throw new Error('Guardian-managed OpenCode readiness requires the exact owner and incarnation identity');
    }
    return waitForGuardianManagedOpenCodeReady({
      timeoutMs,
      intervalMs,
      check: () => client.health(withOwner({ incarnation }, owner)),
    });
  };

  // A completed probe that returns false means the guardian transport is
  // unavailable. A rejected probe means its state is unknown, so treating it
  // as false could start a legacy child beside a live guardian child.
  const probeGuardianRunning = async () => {
    try {
      return await isGuardianRunning(getGuardianSocket(), getWindowsPortPath());
    } catch (error) {
      const probeError = new Error(
        `Guardian status probe failed; refusing legacy lifecycle fallback: ${error?.message || String(error)}`,
      );
      probeError.code = 'GUARDIAN_STATUS_UNKNOWN';
      probeError.cause = error;
      throw probeError;
    }
  };

  const readGuardianChildList = async (client) => {
    if (!client || typeof client.list !== 'function') return null;
    const children = await client.list();
    if (!Array.isArray(children) || children.some((child) => (
      !child
      || typeof child !== 'object'
      || Array.isArray(child)
      || typeof child.incarnation !== 'string'
      || child.incarnation.length === 0
      || typeof child.state !== 'string'
      || child.state.length === 0
    ))) {
      const error = new Error(
        'Guardian child list response is malformed; refusing cleanup or lifecycle fallback',
      );
      error.code = 'GUARDIAN_CHILD_LIST_INVALID';
      throw error;
    }
    return children;
  };

  const assertGuardianGlobalAdmission = async (client) => {
    if (!client) throw new Error('Guardian global admission requires a client');
    if (typeof client.admissionStatus === 'function') {
      const status = await client.admissionStatus();
      if (status?.admitted !== true) {
        const error = new Error(
          `Guardian global admission is blocked (${status?.attentionCount ?? 'unknown'} attention, ${status?.operationCount ?? 'unknown'} unresolved operation(s))`,
        );
        error.code = 'GUARDIAN_ADMISSION_BLOCKED';
        throw error;
      }
      return status;
    }

    if (typeof client.list !== 'function') {
      // The production client always exposes admissionStatus(). Older test or
      // injected clients have no guardian observation surface at all; keep
      // their established compatibility path rather than dereferencing a
      // synthetic null list.
      return { admitted: true, attentionCount: 0, operationCount: 0 };
    }

    // Compatibility for injected/older clients. Production GuardianClient has
    // admissionStatus(); a list-only client can prove attention records but
    // cannot expose durable operations, so this fallback is intentionally
    // narrow and still fails closed on malformed/unavailable lists.
    const children = await readGuardianChildList(client);
    const unresolved = children.find((child) => (
      child.attention === true
      || child.state === 'attention'
      || ['unknown', 'stopping', 'handoff-prepared'].includes(child.state)
    ));
    if (unresolved) {
      const error = new Error(`Guardian global admission is blocked by ${unresolved.incarnation}`);
      error.code = 'GUARDIAN_ADMISSION_BLOCKED';
      throw error;
    }
    return { admitted: true, attentionCount: 0, operationCount: 0 };
  };

  const assertLegacyLaunchAdmission = async ({ guardianRunning } = {}) => {
    const running = guardianRunning === undefined ? await probeGuardianRunning() : guardianRunning;
    if (!running) return;
    const admissionClient = createGuardianClient({ connectTimeoutMs: 5000 });
    let admissionConnected = false;
    try {
      await admissionClient.connect();
      admissionConnected = true;
      await assertGuardianGlobalAdmission(admissionClient);
    } finally {
      if (admissionConnected) await disconnectGuardianClient(admissionClient);
    }
  };

  // A successful owner-scoped stop is authoritative for the real
  // GuardianClient. When a test/injected client exposes list(), additionally
  // verify that no live record for the incarnation remains before allowing a
  // legacy fallback. A present but malformed list is unknown, never empty.
  const verifyGuardianChildGone = async (client, { incarnation } = {}) => {
    const children = await readGuardianChildList(client);
    if (children === null) return true;
    return !children.some((child) => {
      if (!child || child.incarnation !== incarnation) return false;
      return child.state !== 'retired' && child.state !== 'interrupted';
    });
  };

  // A successful stop response is not enough when the follow-up list is
  // stale or unreadable. The guardian has already durably recorded the stop;
  // retain that operation as an HMR fence and never replay the non-idempotent
  // RPC just because verification failed.
  const stopGuardianChildAndVerify = async ({
    client,
    incarnation,
    owner,
    lease = null,
    successorOwner,
    cleanupTarget = 'old',
    rollbackIncarnation,
    rollbackOwner,
    oldStopped = false,
  }) => {
    const operationId = createGuardianOperationId();
    const durableOperationId = typeof client?.operationStatus === 'function' ? operationId : null;
    let stopped;
    try {
      stopped = await client.stop(withOwner({
        incarnation,
        ...(durableOperationId ? { operationId: durableOperationId } : {}),
      }, owner));
    } catch (error) {
      if (isAmbiguousGuardianRequestError(error)) {
        persistGuardianOutcomeUnknownFence({
          kind: 'stop',
          incarnation,
          owner,
          preparedRecord: null,
          successorOwner,
          cleanupTarget,
          rollbackIncarnation,
          rollbackOwner,
          oldStopped,
          source: error,
          lease,
          operationId: error.operationId || durableOperationId,
        });
      }
      throw error;
    }
    try {
      if (!(await verifyGuardianChildGone(client, { incarnation }))) {
        throw Object.assign(
          new Error(`Guardian child ${incarnation} cleanup was not confirmed`),
          { code: 'GUARDIAN_CLEANUP_UNCERTAIN' },
        );
      }
    } catch (error) {
      persistGuardianOutcomeUnknownFence({
        kind: 'stop',
        incarnation,
        owner,
        preparedRecord: stopped,
        successorOwner,
        cleanupTarget,
        rollbackIncarnation,
        rollbackOwner,
        oldStopped,
        source: error,
        lease,
        operationId: durableOperationId,
      });
      throw error;
    }
    return { stopped, operationId };
  };

  const findLiveGuardianSuccessor = async (client, owner) => {
    if (!client || typeof client.list !== 'function') return null;
    const children = await readGuardianChildList(client);
    if (!owner) return null;
    return children.find((child) => (
      child?.state !== 'retired'
      && child?.state !== 'interrupted'
      && child?.ownerInstanceId === owner.ownerInstanceId
      && child?.runtimeIdentity === owner.runtimeIdentity
      && child?.launchFingerprint === owner.launchFingerprint
    )) || null;
  };

  const confirmGuardianNoSuccessor = async (client, owner) => {
    const children = await readGuardianChildList(client);
    if (children.some((child) => (
      child?.state !== 'retired'
      && child?.state !== 'interrupted'
      && guardianChildMatchesOwner(child, owner)
    ))) {
      throw new Error('Guardian successor remains discoverable');
    }
    if (typeof client.operationList === 'function') {
      const operations = await client.operationList({ owner });
      if (!Array.isArray(operations)) throw new Error('Guardian operation list is malformed');
      if (operations.some((operation) => ['pending', 'expired'].includes(operation?.state))) {
        throw new Error('Guardian successor operation remains unresolved');
      }
    }
    if (getGuardianOutcomeUnknownFences().length > 0) {
      throw new Error('Guardian successor cleanup remains fenced');
    }
    return true;
  };

  const getGuardianChildOwner = (child) => child?.owner || (
    child?.ownerInstanceId && child?.runtimeIdentity && child?.launchFingerprint
      ? {
        ownerInstanceId: child.ownerInstanceId,
        runtimeIdentity: child.runtimeIdentity,
        launchFingerprint: child.launchFingerprint,
      }
      : null
  );

  const guardianChildMatchesOwner = (child, owner) => {
    const childOwner = getGuardianChildOwner(child);
    return hasCompleteOwnerIdentity(owner)
      && hasCompleteOwnerIdentity(childOwner)
      && childOwner.ownerInstanceId === owner.ownerInstanceId
      && childOwner.runtimeIdentity === owner.runtimeIdentity
      && childOwner.launchFingerprint === owner.launchFingerprint;
  };

  const hasCompleteGuardianRecordBinding = (record) => Boolean(
    record
    && Number.isSafeInteger(record.revision)
    && Number.isSafeInteger(record.leaseExpiresAt)
    && record.leaseExpiresAt > 0
    && typeof record.mac === 'string'
    && record.mac.length > 0
  );

  const guardianFenceRecordMatches = (child, fence) => {
    if (!hasCompleteGuardianRecordBinding(fence)
      || !hasCompleteGuardianRecordBinding(child)
      || !child
      || child.incarnation !== fence?.incarnation
      || !guardianChildMatchesOwner(child, fence.owner)) {
      return false;
    }
    return child.revision === fence.revision
      && child.leaseExpiresAt === fence.leaseExpiresAt
      && child.mac === fence.mac;
  };

  const guardianFenceHasRecordBinding = (fence) => Boolean(
    fence && ['revision', 'leaseExpiresAt', 'mac'].some((key) => Object.hasOwn(fence, key)),
  );

  const guardianFenceMatchesOperation = (fence, operation) => {
    if (!fence || !operation
      || (fence.incarnation && operation.incarnation !== fence.incarnation)
      || operation.ownerInstanceId !== fence.owner?.ownerInstanceId
      || operation.runtimeIdentity !== fence.owner?.runtimeIdentity
      || operation.launchFingerprint !== fence.owner?.launchFingerprint) {
      return false;
    }
    if (!guardianFenceHasRecordBinding(fence)) return true;
    const targetMatches = operation.targetRevision === fence.revision
      && operation.targetLeaseExpiresAt === fence.leaseExpiresAt
      && operation.targetMac === fence.mac;
    const resolutionMatches = Number.isSafeInteger(operation.resolutionRevision)
      && Number.isSafeInteger(operation.resolutionLeaseExpiresAt)
      && typeof operation.resolutionMac === 'string'
      && operation.resolutionMac.length > 0
      && operation.resolutionRevision === fence.revision
      && operation.resolutionLeaseExpiresAt === fence.leaseExpiresAt
      && operation.resolutionMac === fence.mac;
    return targetMatches || resolutionMatches;
  };

  const guardianFenceCandidateMatchesIdentity = (child, fence) => {
    if (!child || !fence) return false;
    if (fence.kind === 'initial-spawn') {
      return guardianChildMatchesOwner(child, fence.successorOwner)
        && child.incarnation !== fence.incarnation;
    }
    return child.incarnation === fence.incarnation
      && guardianChildMatchesOwner(child, fence.owner);
  };

  const bindGuardianFenceToAuthoritativeRecord = (fence, child) => {
    if (!hasCompleteGuardianRecordBinding(child)) {
      throw createGuardianOutcomeUnknownError(
        fence,
        'Guardian outcome-unknown fence requires complete revision, lease, and MAC binding',
      );
    }
    if (hasCompleteGuardianRecordBinding(fence)) {
      if (!guardianFenceRecordMatches(child, fence)) {
        // abort-handoff itself advances the v2 revision/lease/MAC when it
        // applies. A lost response is therefore reconciled by accepting only
        // the exact owner/incarnation in the authoritative Active record, then
        // pinning the fence to that complete post-abort binding.
        if ((fence.kind === 'abort-handoff'
          && child.incarnation === fence.incarnation
          && guardianChildMatchesOwner(child, fence.owner)
          && child.state === 'active')
          || (fence.kind === 'stop'
            && child.incarnation === fence.incarnation
            && guardianChildMatchesOwner(child, fence.owner)
            && ['interrupted', 'retired'].includes(child.state))
          || (fence.kind === 'prepare'
            && child.incarnation === fence.incarnation
            && guardianChildMatchesOwner(child, fence.owner)
            && child.state === 'handoff-prepared')) {
          const transitionedFence = {
            ...fence,
            revision: child.revision,
            leaseExpiresAt: child.leaseExpiresAt,
            mac: child.mac,
          };
          setGuardianOutcomeUnknownFence(transitionedFence);
          return transitionedFence;
        }
        throw createGuardianOutcomeUnknownError(
          fence,
          'Guardian outcome-unknown fence does not match the authoritative revision, lease, or MAC',
        );
      }
      return fence;
    }
    const boundFence = {
      ...fence,
      revision: child.revision,
      leaseExpiresAt: child.leaseExpiresAt,
      mac: child.mac,
    };
    setGuardianOutcomeUnknownFence(boundFence);
    return boundFence;
  };

  const bindGuardianFenceSuccessor = (fence, child) => {
    if (!hasCompleteGuardianRecordBinding(child)
      || typeof child?.incarnation !== 'string'
      || !guardianChildMatchesOwner(child, fence?.successorOwner)) {
      throw createGuardianOutcomeUnknownError(
        fence,
        'Guardian outcome-unknown fence successor lacks complete owner or record binding',
      );
    }
    const successorBinding = {
      incarnation: child.incarnation,
      revision: child.revision,
      leaseExpiresAt: child.leaseExpiresAt,
      mac: child.mac,
    };
    if (fence.successorBinding && (
      fence.successorBinding.incarnation !== successorBinding.incarnation
      || fence.successorBinding.revision !== successorBinding.revision
      || fence.successorBinding.leaseExpiresAt !== successorBinding.leaseExpiresAt
      || fence.successorBinding.mac !== successorBinding.mac
    )) {
      throw createGuardianOutcomeUnknownError(
        fence,
        'Guardian outcome-unknown fence successor binding changed during reconciliation',
      );
    }
    if (fence.successorBinding) return fence;
    const boundFence = { ...fence, successorBinding };
    setGuardianOutcomeUnknownFence(boundFence);
    return boundFence;
  };

  const reconcileDurableGuardianOperation = async (client, fence) => {
    if (!fence?.operationId) return null;
    if (typeof client?.operationStatus !== 'function') {
      throw createGuardianOutcomeUnknownError(fence, 'Guardian ambiguity has no durable operation status endpoint');
    }
    let status;
    try {
      status = await client.operationStatus({ operationId: fence.operationId, owner: fence.owner });
    } catch (error) {
      throw createGuardianOutcomeUnknownError(
        fence,
        `Guardian durable operation status is unavailable: ${error?.message || String(error)}`,
      );
    }
    let operation = status?.operation;
    if (!operation || operation.incarnation !== fence.incarnation && fence.kind !== 'initial-spawn') {
      throw createGuardianOutcomeUnknownError(fence, 'Guardian durable operation binding does not match the fence');
    }
    if (!operation
      || operation.ownerInstanceId !== fence.owner?.ownerInstanceId
      || operation.runtimeIdentity !== fence.owner?.runtimeIdentity
      || operation.launchFingerprint !== fence.owner?.launchFingerprint) {
      throw createGuardianOutcomeUnknownError(fence, 'Guardian durable operation owner binding does not match the fence');
    }
    if (operation.state === 'pending' && status?.expired && typeof client.expireOperation === 'function') {
      const expired = await client.expireOperation({
        operationId: fence.operationId,
        owner: fence.owner,
        expected: {
          revision: operation.revision,
          confirmationExpiresAt: operation.confirmationExpiresAt,
          mac: operation.mac,
        },
      });
      operation = expired?.operation;
    }
    if (['pending', 'expired'].includes(operation?.state) && status.record
      && ['active', 'handoff-prepared', 'interrupted', 'retired'].includes(status.record.state)) {
      if (status.record.incarnation === operation.incarnation
        && guardianChildMatchesOwner(status.record, fence.owner)) {
        const resolved = await client.resolveOperation({
          operationId: fence.operationId,
          owner: fence.owner,
          expected: {
            revision: operation.revision,
            confirmationExpiresAt: operation.confirmationExpiresAt,
            mac: operation.mac,
          },
          resolution: {
            state: status.record.state,
            revision: status.record.revision,
            leaseExpiresAt: status.record.leaseExpiresAt,
            mac: status.record.mac,
          },
        });
        operation = resolved?.operation;
      }
    }
    if (!operation || operation.state !== 'resolved') {
      throw createGuardianOutcomeUnknownError(
        fence,
        operation?.state === 'expired'
          ? 'Guardian durable operation expired but remains unresolved pending authoritative quiescence'
          : 'Guardian durable operation remains unresolved',
      );
    }
    if (operation.state === 'resolved' && operation.incarnation !== fence.incarnation
      && fence.kind !== 'initial-spawn') {
      throw createGuardianOutcomeUnknownError(fence, 'Guardian durable operation incarnation changed');
    }
    if (!guardianFenceMatchesOperation(fence, operation)) {
      throw createGuardianOutcomeUnknownError(
        fence,
        'Guardian durable operation resolution does not match the persisted fence binding',
      );
    }
    return { operation, record: status?.record || null };
  };

  // HMR state is only an optimization. After a real web-process restart the
  // guardian's signed operation table is the authority for an outcome that
  // may have crossed a side-effect boundary. Discover pending operations
  // before any adoption, start, or legacy fallback decision and reconstruct a
  // local fence from their owner/target binding.
  const discoverGuardianOutcomeUnknownFence = async () => {
    if (!canUseGuardian || !hasOwnerScopeIdentity(expectedGuardianOwner)) {
      return;
    }
    if (!(await probeGuardianRunning())) return;
    const client = createGuardianClient({ connectTimeoutMs: 5000 });
    let connected = false;
    try {
      if (typeof client.operationList !== 'function') {
        // Compatibility for injected/older clients. The production
        // GuardianClient exposes operationList; an unavailable discovery
        // method cannot prove a pending operation, so no synthetic fence is
        // created from an incomplete client contract.
        return;
      }
      await client.connect();
      connected = true;
      const operations = await client.operationList({ owner: expectedGuardianOwner });
      if (!Array.isArray(operations)) {
        throw createGuardianOutcomeUnknownError(
          { owner: expectedGuardianOwner },
          'Guardian durable operation discovery returned an invalid list',
        );
      }
      const pending = operations.filter((operation) => (
        operation?.state === 'pending' || operation?.state === 'expired'
      ));
      if (pending.length === 0) return;
      for (const operation of pending) {
        const kind = operation.kind === 'spawn'
          ? 'initial-spawn'
          : operation.kind === 'prepare-handoff'
            ? 'prepare'
            : operation.kind;
        const operationOwner = {
          ownerInstanceId: operation.ownerInstanceId,
          runtimeIdentity: operation.runtimeIdentity,
          launchFingerprint: operation.launchFingerprint,
        };
        persistGuardianOutcomeUnknownFence({
          kind,
          // Initial spawn fences intentionally leave incarnation unset: the
          // operation's incarnation is the candidate successor, not an old
          // child that must match the pre-spawn fence.
          incarnation: kind === 'initial-spawn' ? null : operation.incarnation,
          owner: operationOwner,
          successorOwner: kind === 'initial-spawn' ? operationOwner : undefined,
          preparedRecord: kind === 'initial-spawn' ? null : {
            incarnation: operation.incarnation,
            ownerInstanceId: operation.ownerInstanceId,
            runtimeIdentity: operation.runtimeIdentity,
            launchFingerprint: operation.launchFingerprint,
            revision: operation.targetRevision,
            leaseExpiresAt: operation.targetLeaseExpiresAt,
            mac: operation.targetMac,
          },
          operationId: operation.operationId,
          oldStopped: kind === 'initial-spawn',
        });
      }
    } finally {
      if (connected) await disconnectGuardianClient(client);
    }
  };

  const findFenceChild = (children, fence, { successor = false } = {}) => children.find((child) => {
    if (successor) {
      return child?.state !== 'retired'
        && child?.state !== 'interrupted'
        && guardianChildMatchesOwner(child, fence?.successorOwner)
        && (!fence.successorBinding || child.incarnation === fence.successorBinding.incarnation);
    }
    return child?.incarnation === fence?.incarnation
      && guardianChildMatchesOwner(child, fence?.owner);
  }) || null;

  const guardianFenceSuccessorMatches = (child, fence) => {
    const binding = fence?.successorBinding;
    return Boolean(binding
      && child?.incarnation === binding.incarnation
      && child.revision === binding.revision
      && child.leaseExpiresAt === binding.leaseExpiresAt
      && child.mac === binding.mac
      && guardianChildMatchesOwner(child, fence.successorOwner));
  };

  // A list only identifies a candidate. The guardian owns the adoption
  // authority: it revalidates the record, credential, and health and closes
  // with the v2 same-record CAS before lifecycle state may be published or a
  // fence may be cleared.
  const confirmGuardianFenceAdoption = async (client, fence, { successor = false } = {}) => {
    if (typeof client?.confirmAdoption !== 'function') {
      throw createGuardianOutcomeUnknownError(
        fence,
        'Guardian outcome-unknown fence cannot be adopted without authoritative confirmation',
      );
    }
    const firstChildren = await readGuardianChildList(client);
    const first = findFenceChild(firstChildren, fence, { successor });
    if (!first) throw createGuardianOutcomeUnknownError(fence);
    const boundFence = successor
      ? bindGuardianFenceSuccessor(fence, first)
      : bindGuardianFenceToAuthoritativeRecord(fence, first);
    const expectedBinding = successor ? boundFence.successorBinding : boundFence;
    if (successor ? !guardianFenceSuccessorMatches(first, boundFence) : !guardianFenceRecordMatches(first, expectedBinding)) {
      throw createGuardianOutcomeUnknownError(
        boundFence,
        'Guardian outcome-unknown fence candidate binding is not authoritative',
      );
    }
    const owner = successor ? getGuardianChildOwner(first) : boundFence.owner;
    let confirmation;
    try {
      confirmation = await client.confirmAdoption({
        incarnation: first.incarnation,
        owner,
        expected: {
          revision: first.revision,
          leaseExpiresAt: first.leaseExpiresAt,
          mac: first.mac,
        },
      });
    } catch (error) {
      throw createGuardianOutcomeUnknownError(
        boundFence,
        `Guardian outcome-unknown adoption confirmation failed: ${error?.message || String(error)}`,
      );
    }
    const final = confirmation?.record;
    if (!final
      || final.state !== 'active'
      || final.incarnation !== first.incarnation
      || !guardianChildMatchesOwner(final, owner)
      || (successor
        ? !guardianFenceSuccessorMatches(final, boundFence)
        : !guardianFenceRecordMatches(final, expectedBinding))
      || confirmation?.health?.healthy !== true) {
      throw createGuardianOutcomeUnknownError(
        boundFence,
        'Guardian outcome-unknown fence was not authoritatively adopted',
      );
    }
    let credential = confirmation?.credential;
    try {
      if (typeof restoreManagedOpenCodeCredential === 'function') {
        if (!credential || typeof credential !== 'object') {
          throw createGuardianOutcomeUnknownError(
            boundFence,
            'Guardian outcome-unknown fence credential state is unavailable',
          );
        }
        await restoreManagedOpenCodeCredential(credential);
      }
    } finally {
      if (credential && typeof credential === 'object') {
        try {
          credential.username = '';
          credential.password = '';
        } catch {
          // Best-effort secret scrubbing must not mask the authoritative result.
        }
      }
    }
    return { fence: boundFence, child: final, owner };
  };

  const confirmGuardianTerminal = async (client, fence) => {
    if (typeof client?.terminalStatus !== 'function'
      || typeof client?.confirmTerminal !== 'function') {
      throw createGuardianOutcomeUnknownError(
        fence,
        'Guardian stop fence cannot be reconciled without authoritative terminal confirmation',
      );
    }
    const owner = fence.owner;
    const durable = await reconcileDurableGuardianOperation(client, fence);
    if (durable?.operation?.state === 'resolved'
      && ['interrupted', 'retired'].includes(durable.operation.resolutionState)) {
      if (typeof client.confirmOperation !== 'function') {
        throw createGuardianOutcomeUnknownError(
          fence,
          'Guardian stop fence cannot be cleared without durable operation CAS confirmation',
        );
      }
      const confirmedOperation = await client.confirmOperation({
        operationId: fence.operationId,
        owner,
        expected: {
          revision: durable.operation.revision,
          confirmationExpiresAt: durable.operation.confirmationExpiresAt,
          mac: durable.operation.mac,
        },
      });
      if (!confirmedOperation?.operation
        || confirmedOperation.operation.state !== 'resolved'
        || confirmedOperation.operation.resolutionState !== durable.operation.resolutionState
        || !guardianFenceMatchesOperation(fence, confirmedOperation.operation)) {
        throw createGuardianOutcomeUnknownError(fence, 'Guardian terminal operation CAS confirmation failed');
      }
      if (!durable.record) {
        // The signed durable operation is the only surviving terminal handle
        // after child-row pruning. Its exact owner/incarnation/resolution
        // binding was verified by Guardian and confirmed above.
        return {
          fence: {
            ...fence,
            revision: durable.operation.resolutionRevision,
            leaseExpiresAt: durable.operation.resolutionLeaseExpiresAt,
            mac: durable.operation.resolutionMac,
          },
          record: {
            incarnation: durable.operation.incarnation,
            ownerInstanceId: durable.operation.ownerInstanceId,
            runtimeIdentity: durable.operation.runtimeIdentity,
            launchFingerprint: durable.operation.launchFingerprint,
            state: durable.operation.resolutionState,
            revision: durable.operation.resolutionRevision,
            leaseExpiresAt: durable.operation.resolutionLeaseExpiresAt,
            mac: durable.operation.resolutionMac,
          },
        };
      }
      return {
        fence: {
          ...fence,
          revision: durable.operation.resolutionRevision,
          leaseExpiresAt: durable.operation.resolutionLeaseExpiresAt,
          mac: durable.operation.resolutionMac,
        },
        record: {
          incarnation: durable.operation.incarnation,
          ownerInstanceId: durable.operation.ownerInstanceId,
          runtimeIdentity: durable.operation.runtimeIdentity,
          launchFingerprint: durable.operation.launchFingerprint,
          state: durable.operation.resolutionState,
          revision: durable.operation.resolutionRevision,
          leaseExpiresAt: durable.operation.resolutionLeaseExpiresAt,
          mac: durable.operation.resolutionMac,
        },
      };
    }
    if (durable?.operation?.state === 'resolved') {
      throw createGuardianOutcomeUnknownError(
        fence,
        'Guardian stop fence durable operation resolved without terminal confirmation',
      );
    }
    const status = await client.terminalStatus({
      incarnation: fence.incarnation,
      owner,
    });
    const terminal = status?.record;
    if (!terminal
      || terminal.incarnation !== fence.incarnation
      || !guardianChildMatchesOwner(terminal, owner)
      || !hasCompleteGuardianRecordBinding(terminal)
      || (guardianFenceHasRecordBinding(fence) && !guardianFenceRecordMatches(terminal, fence))
      || !['retired', 'interrupted'].includes(terminal.state)) {
      throw createGuardianOutcomeUnknownError(
        fence,
        'Guardian stop fence has no exact signed terminal record',
      );
    }
    const confirmed = await client.confirmTerminal({
      incarnation: terminal.incarnation,
      owner,
      expected: {
        revision: terminal.revision,
        leaseExpiresAt: terminal.leaseExpiresAt,
        mac: terminal.mac,
      },
    });
    const committed = confirmed?.record;
    if (!committed
      || committed.incarnation !== terminal.incarnation
      || !guardianChildMatchesOwner(committed, owner)
      || committed.state !== terminal.state
      || committed.revision !== terminal.revision
      || committed.leaseExpiresAt !== terminal.leaseExpiresAt
      || committed.mac !== terminal.mac
      || (guardianFenceHasRecordBinding(fence) && !guardianFenceRecordMatches(committed, fence))) {
      throw createGuardianOutcomeUnknownError(
        fence,
        'Guardian stop fence terminal binding changed during confirmation',
      );
    }
    const terminalFence = {
      ...fence,
      revision: committed.revision,
      leaseExpiresAt: committed.leaseExpiresAt,
      mac: committed.mac,
    };
    setGuardianOutcomeUnknownFence(terminalFence);
    return { fence: terminalFence, record: committed };
  };

  // Reconcile an ambiguity before any new prepare/stop/spawn or legacy port
  // cleanup. A missing successor is deliberately not treated as proof that
  // the ambiguous spawn did not happen: the guardian list may lag the lost
  // response. The fence therefore remains until an exact owner-scoped child is
  // adopted, or a prepared old record is explicitly returned to active.
  const reconcileGuardianOutcomeUnknownFence = async ({ client, fence }) => {
    if (!client || typeof client.list !== 'function') {
      throw createGuardianOutcomeUnknownError(fence, 'Guardian outcome-unknown fence cannot be reconciled without an authenticated child list');
    }
    const durableOperation = await reconcileDurableGuardianOperation(client, fence);
    let boundFence = fence;
    if (durableOperation?.operation?.state === 'resolved'
      && fence.kind === 'initial-spawn'
      && ['interrupted', 'retired'].includes(durableOperation.operation.resolutionState)) {
      if (typeof client.confirmOperation !== 'function') {
        throw createGuardianOutcomeUnknownError(
          boundFence,
          'Guardian initial-spawn fence cannot clear without durable operation confirmation',
        );
      }
      const confirmedOperation = await client.confirmOperation({
        operationId: boundFence.operationId,
        owner: boundFence.owner,
        expected: {
          revision: durableOperation.operation.revision,
          confirmationExpiresAt: durableOperation.operation.confirmationExpiresAt,
          mac: durableOperation.operation.mac,
        },
      });
      if (!confirmedOperation?.operation
        || confirmedOperation.operation.state !== 'resolved'
        || !['interrupted', 'retired'].includes(confirmedOperation.operation.resolutionState)
        || !guardianFenceMatchesOperation(boundFence, confirmedOperation.operation)) {
        throw createGuardianOutcomeUnknownError(
          boundFence,
          'Guardian initial-spawn terminal operation confirmation does not match the fence',
        );
      }
      releaseGuardianOutcomeUnknownLease();
      clearGuardianOutcomeUnknownFence(boundFence);
      state.openCodeProcess = null;
      state.currentIncarnation = null;
      state.currentOwner = null;
      syncToHmrState();
      return { adopted: false, resolved: true };
    }
    const children = await readGuardianChildList(client);
    const candidate = children.find((child) => guardianFenceCandidateMatchesIdentity(child, fence)) || null;
    boundFence = candidate ? bindGuardianFenceToAuthoritativeRecord(fence, candidate) : fence;
    const oldChild = boundFence.kind === 'initial-spawn'
      ? null
      : (candidate && guardianFenceRecordMatches(candidate, boundFence) ? candidate : null);

    if (boundFence.kind === 'prepare' || boundFence.kind === 'abort-handoff') {
      if (!oldChild || !['active', 'handoff-prepared'].includes(oldChild.state)) {
        throw createGuardianOutcomeUnknownError(boundFence);
      }
      let checked = null;
      let authoritativeOld = null;
      if (oldChild.state === 'handoff-prepared') {
        if (boundFence.kind === 'abort-handoff') {
          // This fence records an abortHandoff whose response was ambiguous.
          // Seeing the record still prepared is not proof that the abort did
          // not apply; retrying abort would duplicate a non-idempotent RPC.
          throw createGuardianOutcomeUnknownError(
            boundFence,
            'Guardian abort outcome remains unknown while the old record is still handoff-prepared',
          );
        }
        if (typeof client.abortHandoff !== 'function') {
          throw createGuardianOutcomeUnknownError(boundFence, 'Guardian outcome-unknown fence cannot safely resolve the prepared handoff');
        }
        let active;
        try {
          active = await client.abortHandoff(withOwner({ incarnation: boundFence.incarnation }, boundFence.owner));
        } catch (error) {
          if (isAmbiguousGuardianRequestError(error)) {
            // `checked` is still null here; it is only assigned after this
            // try/catch via confirmGuardianFenceAdoption. The authoritative
            // prepared record in scope at this catch point is `oldChild`
            // (the authenticated handoff-prepared candidate matched to the
            // fence). The abort-handoff ambiguity fence supersedes the
            // prepare-kind fence being reconciled as a single atomic
            // replacement: build the replacement first, then replace the old
            // fence in one state transition + one HMR sync. If the build throws
            // (e.g. missing owner identity) the old prepare fence stays in
            // place. The replacement is keyed by the abort operation ID (which
            // differs from the prepare operation ID), so a later
            // reconciliation does not replay the non-idempotent abortHandoff RPC
            // against the still-prepared child.
            const replacementFence = buildGuardianOutcomeUnknownFence({
              kind: 'abort-handoff',
              incarnation: boundFence.incarnation,
              owner: boundFence.owner,
              preparedRecord: oldChild,
              source: error,
              lease: guardianOutcomeUnknownLease,
            });
            replaceGuardianOutcomeUnknownFence(boundFence, replacementFence);
          }
          throw error;
        }
        if (active?.state !== 'active' || active?.incarnation !== boundFence.incarnation
          || !hasCompleteGuardianRecordBinding(active)) {
          throw createGuardianOutcomeUnknownError(boundFence, 'Guardian outcome-unknown fence did not return the old child to active with complete binding');
        }
        // abort-handoff legitimately advances revision/lease/MAC. Carry that
        // authoritative transition into the final adoption fence rather than
        // comparing the active record to the older handoff-prepared binding.
        const activeFence = { ...boundFence,
          revision: active.revision,
          leaseExpiresAt: active.leaseExpiresAt,
          mac: active.mac,
        };
        setGuardianOutcomeUnknownFence(activeFence);
        checked = await confirmGuardianFenceAdoption(client, activeFence);
        authoritativeOld = checked.child;
      } else {
        checked = await confirmGuardianFenceAdoption(client, boundFence);
        authoritativeOld = checked.child;
      }
      state.openCodeProcess = createGuardianChildProxy({
        pid: authoritativeOld.pid,
        incarnation: authoritativeOld.incarnation,
        client,
        owner: boundFence.owner,
      });
      state.openCodeBaseUrl = getAuthoritativeGuardianOrigin({
        child: authoritativeOld,
        launchSpec: authoritativeOld.launchSpec,
        port: authoritativeOld.port,
      });
      setOpenCodePort(authoritativeOld.port);
      resetOpenCodeApiPrefixState();
      state.currentIncarnation = authoritativeOld.incarnation;
      state.currentOwner = boundFence.owner;
      state.isExternalOpenCode = false;
      state.isOpenCodeReady = true;
      state.lastOpenCodeError = null;
      state.openCodeNotReadySince = 0;
      releaseGuardianOutcomeUnknownLease();
      clearGuardianOutcomeUnknownFence(boundFence);
      syncToHmrState();
      return { adopted: true };
    }

    if (boundFence.kind === 'stop') {
      // A stop response can be lost after the guardian has durably entered a
      // terminal state. Never issue a second stop: first require an exact
      // owner/incarnation/revision/lease/MAC record proving the target is
      // terminal, then do the final owner-scoped successor reconciliation.
      let terminalConfirmation;
      try {
        terminalConfirmation = await confirmGuardianTerminal(client, boundFence);
      } catch (error) {
        throw createGuardianOutcomeUnknownError(
          boundFence,
          `Guardian stop fence terminal confirmation remains unresolved: ${error?.message || String(error)}`,
        );
      }
      const terminalFence = terminalConfirmation.fence;
      const finalChildren = await readGuardianChildList(client);

      if (terminalFence.cleanupTarget === 'old') {
        const successor = finalChildren.find((child) => (
          child?.state === 'active'
          && guardianChildMatchesOwner(child, terminalFence.successorOwner)
          && child?.incarnation !== terminalFence.incarnation
        )) || null;
        if (!successor) {
          if (!terminalFence.successorOwner) {
            state.openCodeProcess = null;
            state.currentIncarnation = null;
            state.currentOwner = null;
            releaseGuardianOutcomeUnknownLease();
            clearGuardianOutcomeUnknownFence(terminalFence);
            syncToHmrState();
            return { adopted: false };
          }
          throw createGuardianOutcomeUnknownError(boundFence);
        }
        const successorFence = bindGuardianFenceSuccessor(terminalFence, successor);
        const checkedSuccessor = await confirmGuardianFenceAdoption(client, successorFence, { successor: true });
        const successorOwner = checkedSuccessor.owner;
        retainGuardianStartupSecretLease(checkedSuccessor.child.incarnation, guardianOutcomeUnknownLease);
        state.openCodeProcess = createGuardianChildProxy({
          pid: checkedSuccessor.child.pid,
          incarnation: checkedSuccessor.child.incarnation,
          client,
          owner: successorOwner,
          startupSecretLease: guardianOutcomeUnknownLease,
        });
        state.openCodeBaseUrl = getAuthoritativeGuardianOrigin({
          child: checkedSuccessor.child,
          launchSpec: checkedSuccessor.child.launchSpec,
          port: checkedSuccessor.child.port,
        });
        setOpenCodePort(checkedSuccessor.child.port);
        resetOpenCodeApiPrefixState();
        state.currentIncarnation = checkedSuccessor.child.incarnation;
        state.currentOwner = successorOwner;
        state.isExternalOpenCode = false;
        state.isOpenCodeReady = true;
        state.lastOpenCodeError = null;
        state.openCodeNotReadySince = 0;
        guardianOutcomeUnknownLease = null;
        clearGuardianOutcomeUnknownFence(terminalFence);
        syncToHmrState();
        return { adopted: true };
      }

      if (terminalFence.cleanupTarget === 'successor') {
        if (terminalFence.oldStopped === true) {
          state.openCodeProcess = null;
          state.currentIncarnation = null;
          state.currentOwner = null;
          releaseGuardianOutcomeUnknownLease();
          clearGuardianOutcomeUnknownFence(terminalFence);
          syncToHmrState();
          return { adopted: false };
        }
        const rollbackChild = finalChildren.find((child) => (
          child?.incarnation === terminalFence.rollbackIncarnation
          && guardianChildMatchesOwner(child, terminalFence.rollbackOwner)
          && ['active', 'handoff-prepared'].includes(child.state)
        )) || null;
        if (!rollbackChild || !hasCompleteGuardianRecordBinding(rollbackChild)) {
          throw createGuardianOutcomeUnknownError(boundFence);
        }
        const rollbackFence = {
          version: 1,
          kind: 'prepare',
          incarnation: rollbackChild.incarnation,
          owner: { ...terminalFence.rollbackOwner },
          revision: rollbackChild.revision,
          leaseExpiresAt: rollbackChild.leaseExpiresAt,
          mac: rollbackChild.mac,
          oldStopped: false,
        };
        setGuardianOutcomeUnknownFence(rollbackFence);
        return reconcileGuardianOutcomeUnknownFence({ client, fence: rollbackFence });
      }
    }

    const successor = children.find((child) => (
      child?.state === 'active'
      && guardianChildMatchesOwner(child, boundFence.successorOwner)
      && child?.incarnation !== boundFence.incarnation
    )) || null;
    if (!successor || !Number.isSafeInteger(successor.pid) || successor.pid <= 0
      || !Number.isSafeInteger(successor.port) || successor.port <= 0
      || !successor.launchSpec) {
      throw createGuardianOutcomeUnknownError(boundFence);
    }
    if (!hasCompleteGuardianRecordBinding(successor)) {
      throw createGuardianOutcomeUnknownError(
        boundFence,
        'Guardian outcome-unknown fence successor lacks complete revision, lease, or MAC binding',
      );
    }
    const successorFence = bindGuardianFenceSuccessor(boundFence, successor);
    const checkedSuccessor = await confirmGuardianFenceAdoption(client, successorFence, { successor: true });
    const authoritativeSuccessor = checkedSuccessor.child;
    const successorOwner = checkedSuccessor.owner;

    if (boundFence.kind !== 'initial-spawn' && !boundFence.oldStopped) {
      if (!oldChild || ['retired', 'interrupted'].includes(oldChild.state)) {
        throw createGuardianOutcomeUnknownError(boundFence, 'Guardian outcome-unknown fence cannot prove the old child was stopped');
      }
      try {
        await stopGuardianChildAndVerify({
          client,
          incarnation: boundFence.incarnation,
          owner: boundFence.owner,
          lease: guardianOutcomeUnknownLease,
          successorOwner,
          cleanupTarget: 'old',
          oldStopped: false,
        });
      } catch (error) {
        if (isAmbiguousGuardianRequestError(error)) {
          persistGuardianOutcomeUnknownFence({
            kind: 'stop',
            incarnation: boundFence.incarnation,
            owner: boundFence.owner,
            preparedRecord: oldChild,
            successorOwner,
            cleanupTarget: 'old',
            oldStopped: false,
            source: error,
            lease: guardianOutcomeUnknownLease,
          });
        }
        throw error;
      }
    }

    retainGuardianStartupSecretLease(authoritativeSuccessor.incarnation, guardianOutcomeUnknownLease);
    state.openCodeProcess = createGuardianChildProxy({
      pid: authoritativeSuccessor.pid,
      incarnation: authoritativeSuccessor.incarnation,
      client,
      owner: successorOwner,
      startupSecretLease: guardianOutcomeUnknownLease,
    });
    state.openCodeBaseUrl = getAuthoritativeGuardianOrigin({
      child: authoritativeSuccessor,
      launchSpec: authoritativeSuccessor.launchSpec,
      port: authoritativeSuccessor.port,
    });
    setOpenCodePort(authoritativeSuccessor.port);
    resetOpenCodeApiPrefixState();
    state.currentIncarnation = authoritativeSuccessor.incarnation;
    state.currentOwner = successorOwner;
    state.isExternalOpenCode = false;
    state.isOpenCodeReady = true;
    state.lastOpenCodeError = null;
    state.openCodeNotReadySince = 0;
    guardianOutcomeUnknownLease = null;
    clearGuardianOutcomeUnknownFence(boundFence);
    syncToHmrState();
    return { adopted: true };
  };

  const reconcileGuardianOutcomeUnknownFenceForLifecycle = async () => {
    await discoverGuardianOutcomeUnknownFence();
    const fences = getGuardianOutcomeUnknownFences();
    const fence = fences[0];
    if (!fence) return { resolved: false, adopted: false };
    if (!canUseGuardian) {
      throw createGuardianOutcomeUnknownError(
        fence,
        'Guardian outcome-unknown fence blocks lifecycle startup while owner-scoped guardian use is unavailable',
      );
    }
    if (!(await probeGuardianRunning())) {
      throw createGuardianOutcomeUnknownError(
        fence,
        'Guardian outcome-unknown fence cannot be reconciled while the guardian is unavailable',
      );
    }
    const client = createGuardianClient({ connectTimeoutMs: 5000 });
    let keepClient = false;
    let adopted = false;
    try {
      await client.connect();
      for (const candidate of getGuardianOutcomeUnknownFences()) {
        const result = await reconcileGuardianOutcomeUnknownFence({ client, fence: candidate });
        adopted ||= result.adopted === true;
        if (result.adopted === true) keepClient = true;
      }
      if (getGuardianOutcomeUnknownFences().length > 0) {
        throw createGuardianOutcomeUnknownError(
          getGuardianOutcomeUnknownFence(),
          'Guardian durable operations remain unresolved after reconciliation',
        );
      }
      return { resolved: true, adopted };
    } finally {
      if (!keepClient) await disconnectGuardianClient(client);
    }
  };

  const adoptGuardianChildForRestart = async ({ socketPath, portPath }) => {
    const guardianChild = await detectAndAdoptGuardianChild(socketPath, portPath, {
      ...getGuardianAdoptionOptions(),
    });
    if (!guardianChild) return null;

    if (!hasCompleteOwnerIdentity(guardianChild.owner)) {
      const error = new Error('Guardian adoption returned an incomplete owner identity');
      error.code = 'GUARDIAN_ADOPTION_OWNER_INVALID';
      throw error;
    }

    const client = createGuardianClient();
    const owner = guardianChild.owner;
    state.openCodeProcess = createGuardianChildProxy({
      pid: guardianChild.pid,
      incarnation: guardianChild.incarnation,
      client,
      owner,
    });
    state.openCodeBaseUrl = getAuthoritativeGuardianOrigin({ child: guardianChild });
    setOpenCodePort(guardianChild.port);
    resetOpenCodeApiPrefixState();
    state.currentIncarnation = guardianChild.incarnation;
    state.currentOwner = owner;
    state.isExternalOpenCode = false;
    state.isOpenCodeReady = true;
    state.lastOpenCodeError = null;
    state.openCodeNotReadySince = 0;
    syncToHmrState();

    console.log(
      `[lifecycle] Adopted guardian child ${guardianChild.incarnation} for owner-scoped restart`,
    );
    return { child: guardianChild, client };
  };

  // Shared env-construction for any managed OpenCode spawn path (legacy
  // startOpenCodeOnce, guardian handoff restart, ...). Centralising this here
  // is the right-level fix for F-2: the guardian handoff path used to bypass
  // the managed-launch semantics (binary resolution, password rotation, PATH
  // augmentation, shell env, agent-tool env), which left a guardian-spawned
  // successor without OPENCODE_SERVER_PASSWORD and without the agent-tool
  // runtime env — so the web server's proxied requests (carrying
  // getOpenCodeAuthHeaders()) would fail to authenticate against it.
  const buildManagedOpenCodeSpawnEnv = async ({
    rotatePassword,
    onBinaryReady,
    onEnvironmentReady,
  } = {}) => {
    await applyOpencodeBinaryFromSettings({ strict: true });
    ensureOpencodeCliEnv();
    onBinaryReady?.();
    const openCodePassword = await ensureLocalOpenCodeServerPassword({ rotateManaged: rotatePassword === true });

    let envPath = process.env.PATH;
    if (typeof buildManagedOpenCodePath === 'function') {
      envPath = buildManagedOpenCodePath();
    } else if (typeof buildAugmentedPath === 'function') {
      envPath = buildAugmentedPath();
    }

    const shellEnv = typeof getManagedOpenCodeShellEnvSnapshot === 'function'
      ? getManagedOpenCodeShellEnvSnapshot() || {}
      : {};

    const managedOpenCodeEnv = await getManagedOpenCodeEnv();
    onEnvironmentReady?.();

    // Use the same managed-launch spec the legacy spawn path uses, so the
    // binary we hand to client.spawn matches what the locally-spawned
    // managed server would have used (Windows shim unwrap, etc.).
    const resolvedRaw = (process.env.OPENCODE_BINARY || 'opencode').trim() || 'opencode';
    const launchSpec = typeof resolveManagedOpenCodeLaunchSpec === 'function'
      ? resolveManagedOpenCodeLaunchSpec(resolvedRaw)
      : null;
    const binary = launchSpec?.binary || resolvedRaw;

    const managedEnv = {
      ...shellEnv,
      ...process.env,
      ...managedOpenCodeEnv,
      PATH: envPath,
      OPENCODE_SERVER_PASSWORD: openCodePassword,
    };
    const startupSecretLease = createManagedStartupSecretLease(managedEnv);

    return {
      binary,
      args: Array.isArray(launchSpec?.args) ? [...launchSpec.args] : [],
      shellEnvKeysCount: Object.keys(shellEnv).length,
      env: stripAppImageArgv0Leak(applyProviderEnvAliases(managedEnv)),
      startupSecretLease,
    };
  };

  const killProcessOnPort = (port) => {
    if (!port) return;
    if (process.platform === 'win32') {
      killProcessOnPortWin32(port);
      return;
    }
    try {
      const result = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const output = result.stdout || '';
      const myPid = process.pid;
      for (const pidStr of output.split(/\s+/)) {
        const pid = parseInt(pidStr.trim(), 10);
        if (pid && pid !== myPid) {
          try {
            spawnSync('kill', ['-9', String(pid)], { stdio: 'ignore', timeout: 2000 });
          } catch {
          }
        }
      }
    } catch {
    }
  };

  const hasChildProcessExited = (child) => !child
    || (child.exitCode !== null && child.exitCode !== undefined)
    || (child.signalCode !== null && child.signalCode !== undefined);

  const isManagedOpenCodeProcessAlive = () => {
    const child = state.openCodeProcess;
    if (!child || hasChildProcessExited(child)) return false;
    if (!child.pid) return true;
    try {
      process.kill(child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const snapshotManagedOpenCodeProcess = (child = state.openCodeProcess) => {
    if (!child) return null;
    const snapshot = {
      pid: child.pid || null,
      exitCode: child.exitCode ?? null,
      signalCode: child.signalCode ?? null,
      stderrTail: getBoundedTextTail(
        sanitizeDiagnosticText(child.stderrTail ?? ''),
        MANAGED_STDERR_TAIL_MAX_BYTES,
      ),
    };
    state.lastManagedOpenCodeProcess = snapshot;
    return snapshot;
  };

  const captureRestartDiagnostics = (reason) => {
    const processSnapshot = snapshotManagedOpenCodeProcess();
    const diagnostics = {
      reason: sanitizeDiagnosticText(String(reason || 'managed-restart')).slice(0, HEALTH_FAILURE_DETAIL_MAX_LENGTH),
      healthFailure: state.lastOpenCodeHealthFailure ? { ...state.lastOpenCodeHealthFailure } : null,
      process: processSnapshot
        ? { ...processSnapshot, alive: isManagedOpenCodeProcessAlive() }
        : null,
      busySessionCount: getActiveSessionCount(),
      at: new Date(now()).toISOString(),
    };
    state.lastOpenCodeRestartDiagnostics = diagnostics;
    console.warn('[lifecycle] managed OpenCode restart diagnostics', diagnostics);
  };

  const waitForChildProcessClose = (child, timeoutMs) => new Promise((resolve) => {
    if (!child || hasChildProcessExited(child)) {
      resolve(true);
      return;
    }

    let done = false;
    const finish = (closed) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off('close', onClose);
      child.off('error', onError);
      resolve(closed);
    };

    const onClose = () => finish(true);
    const onError = () => finish(hasChildProcessExited(child));
    const timer = setTimeout(() => finish(hasChildProcessExited(child)), timeoutMs);

    child.once('close', onClose);
    child.once('error', onError);
  });

  const childStillRunningError = (child) => Object.assign(
    new Error('OpenCode child process is still running after termination escalation'),
    {
      code: 'OPENCODE_CHILD_STILL_RUNNING',
      ...(Number.isInteger(child?.pid) ? { pid: child.pid } : {}),
    },
  );

  const waitForPortRelease = injectedWaitForPortRelease || ((port, timeoutMs, hostname = env.ENV_CONFIGURED_OPENCODE_HOSTNAME) => {
    if (!port) {
      return Promise.resolve(true);
    }

    const probeHost = resolveManagedOpenCodeConnectHostname(hostname);
    const deadline = Date.now() + timeoutMs;

    return new Promise((resolve) => {
      const attempt = () => {
        const socket = net.connect({ port, host: probeHost });
        let settled = false;

        const finish = (released) => {
          if (settled) return;
          settled = true;
          socket.removeAllListeners();
          socket.destroy();
          if (released || Date.now() >= deadline) {
            resolve(released);
            return;
          }
          setTimeout(attempt, 150);
        };

        socket.once('connect', () => finish(false));
        socket.once('timeout', () => finish(true));
        socket.once('error', (error) => {
          if (error && typeof error === 'object' && (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH')) {
            finish(true);
            return;
          }
          finish(false);
        });
        socket.setTimeout(500);
      };

      attempt();
    });
  });

  const terminateChildProcess = async (child) => {
    if (!child) {
      return;
    }

    const pid = child.pid;
    if (hasChildProcessExited(child)) {
      await waitForChildProcessClose(child, 250);
      return;
    }
    if (!pid) {
      if (await waitForChildProcessClose(child, 250)) return;
      throw childStillRunningError(child);
    }

    const signalProcessTree = (signal) => {
      if (process.platform !== 'win32') {
        try {
          process.kill(-pid, signal);
        } catch {
        }
      }

      try {
        child.kill(signal);
      } catch {
      }
    };

    if (process.platform === 'win32') {
      try {
        child.kill();
      } catch {
      }

      if (await waitForChildProcessClose(child, 800)) {
        return;
      }

      try {
        spawnSync('taskkill', ['/pid', String(pid), '/t'], {
          stdio: 'ignore',
          timeout: 3000,
          windowsHide: true,
        });
      } catch {
      }

      if (await waitForChildProcessClose(child, 1500)) {
        return;
      }

      try {
        spawnSync('taskkill', ['/pid', String(pid), '/f', '/t'], {
          stdio: 'ignore',
          timeout: 5000,
          windowsHide: true,
        });
      } catch {
      }

       if (await waitForChildProcessClose(child, 3000)) {
         return;
       }
       throw childStillRunningError(child);
    }

    signalProcessTree('SIGTERM');

    if (await waitForChildProcessClose(child, 2500)) {
      return;
    }

    signalProcessTree('SIGKILL');

    if (await waitForChildProcessClose(child, 1000)) {
      return;
    }
    throw childStillRunningError(child);
  };

  const destroyChildPipes = (child) => {
    for (const stream of [child?.stdout, child?.stderr]) {
      try { stream?.destroy?.(); } catch { /* The child may already be gone. */ }
    }
  };

  const closeManagedOpenCodeChild = async (child) => {
    const pid = child?.pid;
    try {
      await terminateChildProcess(child);
    } finally {
      destroyChildPipes(child);
      // Drop it from the registry only once it has actually exited, so a child
      // that survived teardown stays eligible for the next run's reaper.
      if (Number.isInteger(pid) && hasChildProcessExited(child)) {
        await unregisterManagedProcess(pid);
      }
    }
  };

  const createManagedOpenCodeServerProcess = async ({
    hostname,
    port,
    timeout,
    cwd,
    env: processEnv,
    shellEnvKeysCount = 0,
    startupSecretLease = null,
  }) => {
    let binary = (process.env.OPENCODE_BINARY || 'opencode').trim() || 'opencode';
    const sourceBinary = binary;
    let args = ['serve', '--hostname', hostname, '--port', String(port)];
    let launchWrapperType = null;

    if (process.platform === 'win32' && state.useWslForOpencode) {
      throw new Error('Launching OpenCode through WSL is no longer supported. Install OpenCode natively on Windows and configure opencode.cmd or opencode.exe.');
    }

    if (process.platform === 'win32' && !state.useWslForOpencode) {
      const launchSpec = resolveManagedOpenCodeLaunchSpec(binary);
      if (launchSpec?.binary) {
        if (launchSpec.wrapperType) {
          console.log(`Launching OpenCode via ${launchSpec.wrapperType}: ${launchSpec.binary}`);
        }
        launchWrapperType = launchSpec.wrapperType || null;
        binary = launchSpec.binary;
        args = [...(Array.isArray(launchSpec.args) ? launchSpec.args : []), ...args];
      }
    }

    const pathValue = typeof processEnv?.PATH === 'string' ? processEnv.PATH : '';
    const pathEntryCount = pathValue ? pathValue.split(process.platform === 'win32' ? ';' : ':').filter(Boolean).length : 0;
    state.lastOpenCodeLaunchDiagnostics = {
      launchedAt: new Date().toISOString(),
      sourceBinary,
      binary,
      args,
      cwd,
      hostname,
      port,
      wrapperType: launchWrapperType,
      pathEntryCount,
      hasShellEnv: shellEnvKeysCount > 0,
      shellEnvKeysCount,
    };
    console.log('[OpenCode] Launching managed server', state.lastOpenCodeLaunchDiagnostics);

    const launchSecretLease = startupSecretLease || createManagedStartupSecretLease(processEnv);
    let child = null;
    let registered = false;
    let registrationPromise = null;
    let runtimeStderrTail = '';
    let runtimeStderrAttached = false;
    let observedExitCode = null;
    let observedSignalCode = null;

    const getManagedProcessSnapshot = () => ({
      pid: child.pid || null,
      exitCode: observedExitCode ?? child.exitCode ?? null,
      signalCode: observedSignalCode ?? child.signalCode ?? null,
      stderrTail: getBoundedTextTail(sanitizeDiagnosticText(runtimeStderrTail), MANAGED_STDERR_TAIL_MAX_BYTES),
    });
    const recordManagedProcessExit = (code, signal) => {
      if (code !== null && code !== undefined) observedExitCode = code;
      if (signal !== null && signal !== undefined) observedSignalCode = signal;
      state.lastManagedOpenCodeProcess = getManagedProcessSnapshot();
    };
    const attachRuntimeStderrCapture = () => {
      if (runtimeStderrAttached) return;
      runtimeStderrAttached = true;
      child.stderr?.on('data', (chunk) => {
        runtimeStderrTail = getBoundedTextTail(
          `${runtimeStderrTail}${chunk.toString()}`,
          MANAGED_STDERR_TAIL_MAX_BYTES,
        );
      });
    };
    try {
      child = spawn(binary, args, {
        cwd,
        env: processEnv,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.on('exit', recordManagedProcessExit);
      child.on('close', recordManagedProcessExit);

      // Register immediately after spawn, not only after the URL is parsed.
      // A detached child that survives a startup failure must remain eligible
      // for the existing orphan-reaper; unregister only after confirmed exit.
      if (Number.isInteger(child.pid)) {
        registrationPromise = registerManagedProcess({
          pid: child.pid,
          ownerPid: process.pid,
          port,
          binary,
          runtime: process.env.OPENCHAMBER_RUNTIME || 'web',
        });
        registered = true;
      }
      child.once?.('close', () => {
        if (hasChildProcessExited(child)) releaseManagedStartupSecretLease(launchSecretLease);
      });

      const startupOutputFormatter = getManagedStartupFormatter(processEnv);
      const url = await new Promise((resolve, reject) => {
        // stdout and stderr are separate labels in the final diagnostic, but
        // their bytes form one startup stream for redaction. A managed secret
        // can cross the OS pipe boundary, so each capture must feed the same
        // match-aware state and only the final capture flushes its overlap.
        const sharedStartupRedactor = startupOutputFormatter.createStreamingRedactor({
          outputLimit: MANAGED_STARTUP_CAPTURE_LIMIT * 2,
        });
      const stdoutCapture = createManagedStartupCapture(startupOutputFormatter, sharedStartupRedactor);
      const stderrCapture = createManagedStartupCapture(startupOutputFormatter, sharedStartupRedactor);
      let stdoutForUrlParsing = '';
      let done = false;
      const finish = (handler, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.stdout?.off('data', onStdout);
        child.stderr?.off('data', onStderr);
        child.off('exit', onExit);
        child.off('error', onError);
        handler(value);
      };

      const onStdout = (chunk) => {
        const text = chunk?.toString?.() ?? String(chunk ?? '');
        stdoutCapture.append(text);
        const remaining = MANAGED_STARTUP_CAPTURE_LIMIT - stdoutForUrlParsing.length;
        if (remaining > 0) stdoutForUrlParsing += text.slice(0, remaining);
        const lines = stdoutForUrlParsing.split('\n');
        for (const line of lines) {
          if (!line.startsWith('opencode server listening')) continue;
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (!match) {
            finish(reject, sanitizeManagedStartupError(
              new Error('Failed to parse server url from OpenCode startup output'),
              processEnv,
            ));
            return;
          }
          attachRuntimeStderrCapture();
          finish(resolve, match[1]);
          return;
        }
      };

      const onStderr = (chunk) => {
        stderrCapture.append(chunk);
      };

      const onExit = (code, signal) => {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        const stdout = stdoutCapture.finish({ flush: false });
        const stderr = stderrCapture.finish();
        const appBundleHint = process.platform === 'darwin' && /\/OpenCode\.app\/Contents\/MacOS\/(?:OpenCode|opencode-cli)$/i.test(binary)
          ? ' The configured binary appears to point at the macOS desktop app bundle; OpenChamber needs the standalone opencode CLI.'
          : '';
        finish(reject, sanitizeManagedStartupError(
          new Error(
            `OpenCode process exited before serving with ${reason}. Binary used: ${binary}.${appBundleHint} ${startupOutputFormatter.formatCapturedOutput({
              stdout: stdout.value,
              stderr: stderr.value,
              stdoutTruncated: stdout.truncated,
              stderrTruncated: stderr.truncated,
            })}`,
          ),
          processEnv,
        ));
      };

      const onError = (error) => {
        finish(reject, sanitizeManagedStartupError(error, processEnv));
      };

      const timer = setTimeout(() => {
        finish(reject, sanitizeManagedStartupError(
          new Error(`Timeout waiting for OpenCode to start after ${timeout}ms`),
          processEnv,
        ));
      }, timeout);

      child.stdout?.on('data', onStdout);
      child.stderr?.on('data', onStderr);
      child.on('exit', onExit);
      child.on('error', onError);
      });

      await registrationPromise;
      return {
        url,
        pid: child.pid || null,
        get exitCode() {
          return observedExitCode ?? child.exitCode;
        },
        get signalCode() {
          return observedSignalCode ?? child.signalCode;
        },
        get stderrTail() {
          return getManagedProcessSnapshot().stderrTail;
        },
        async close() {
          try {
            await closeManagedOpenCodeChild(child);
          } finally {
            if (hasChildProcessExited(child)) releaseManagedStartupSecretLease(launchSecretLease);
          }
        },
      };
    } catch (error) {
      // Startup can fail during capture, URL parsing, readiness, or an early
      // exit. Detached children and their pipes still belong to this launch and
      // must be terminated before the rejection lets startOpenCode() retry.
      let cleanupError = null;
      if (child) {
        try {
          await terminateChildProcess(child);
        } catch (terminationError) {
          cleanupError = terminationError;
        } finally {
          destroyChildPipes(child);
        }
      }

      await registrationPromise;
      if (registered && child && Number.isInteger(child.pid) && hasChildProcessExited(child)) {
        unregisterManagedProcess(child.pid);
      }
      if (!child || hasChildProcessExited(child)) {
        releaseManagedStartupSecretLease(launchSecretLease);
      }
      if (cleanupError) {
        cleanupError.cause = error;
        throw cleanupError;
      }
      throw error;
    }
  };

  const resolveManagedOpenCodePort = async (
    requestedPort,
    hostname = env.ENV_CONFIGURED_OPENCODE_HOSTNAME,
  ) => {
    if (typeof requestedPort === 'number' && Number.isFinite(requestedPort) && requestedPort > 0) {
      return requestedPort;
    }

    return await new Promise((resolve, reject) => {
      const server = net.createServer();
      const cleanup = () => {
        server.removeAllListeners('error');
        server.removeAllListeners('listening');
      };

      server.once('error', (error) => {
        cleanup();
        reject(error);
      });

      server.once('listening', () => {
        const address = server.address();
        const port = address && typeof address === 'object' ? address.port : 0;
        server.close(() => {
          cleanup();
          if (port > 0) {
            resolve(port);
            return;
          }
          reject(new Error('Failed to allocate OpenCode port'));
        });
      });

      server.listen(0, hostname);
    });
  };

  const probeOpenCodeHealthDetailed = async () => {
    if (!state.openCodeProcess || !state.openCodePort) {
      return {
        healthy: false,
        failure: {
          class: 'error',
          detail: 'Managed OpenCode process or port is unavailable',
        },
      };
    }

    if (state.openCodeProcess.isGuardianManaged === true) {
      if (typeof state.openCodeProcess.health !== 'function') return false;
      try {
        const result = await state.openCodeProcess.health();
        return result?.healthy === true;
      } catch {
        return false;
      }
    }

    try {

      const response = await fetch(buildOpenCodeUrl(OPENCODE_HEALTH_PATH, ''), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      if (!response.ok) {
        return {
          healthy: false,
          failure: {
            class: 'invalid_response',
            detail: `Health endpoint returned HTTP ${response.status ?? 'unknown'}`,
          },
        };
      }
      let body;
      try {
        body = await response.json();
      } catch {
        return {
          healthy: false,
          failure: {
            class: 'invalid_response',
            detail: 'Health endpoint returned invalid JSON',
          },
        };
      }
      if (body?.healthy !== true) {
        return {
          healthy: false,
          failure: {
            class: 'invalid_response',
            detail: 'Health endpoint did not report healthy=true',
          },
        };
      }
      return { healthy: true, failure: null };
    } catch (error) {
      return {
        healthy: false,
        failure: classifyHealthProbeError(error),
      };
    }
  };

  const isOpenCodeProcessHealthy = async () => (await probeOpenCodeHealthDetailed()).healthy;

  const probeExternalOpenCode = async (port, origin) => {
    if (!port || port <= 0) {
      return false;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const base = origin ?? buildManagedOpenCodeOrigin({
        hostname: env.ENV_CONFIGURED_OPENCODE_HOSTNAME,
        port,
      });
      const response = await fetch(`${base}${OPENCODE_HEALTH_PATH}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) return false;
      const body = await response.json().catch(() => null);
      return body?.healthy === true;
    } catch {
      return false;
    }
  };

  const waitForOpenCodePort = async (timeoutMs = 15000) => {
    if (state.openCodePort !== null) {
      return state.openCodePort;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (state.openCodePort !== null) {
        return state.openCodePort;
      }
    }

    throw new Error('Timed out waiting for OpenCode port');
  };

  const START_OPEN_CODE_MAX_ATTEMPTS = 2;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const startOpenCodeOnce = async (attempt) => {
    const attemptStartedAt = performance.now();
    let phaseStartedAt = attemptStartedAt;
    recordStartupPerformance('opencode.attempt.start', { attempt });
    const desiredPort = env.ENV_CONFIGURED_OPENCODE_PORT ?? 0;
    const spawnPort = await resolveManagedOpenCodePort(desiredPort, env.ENV_CONFIGURED_OPENCODE_HOSTNAME);
    console.log(
      desiredPort > 0
        ? `Starting OpenCode on requested port ${desiredPort}...`
        : `Starting OpenCode on allocated port ${spawnPort}...`
    );

    const managedLaunch = await buildManagedOpenCodeSpawnEnv({
      rotatePassword: true,
      onBinaryReady: () => {
        recordStartupPerformance('opencode.binary.ready', {
          attempt,
          durationMs: performance.now() - phaseStartedAt,
          totalDurationMs: performance.now() - attemptStartedAt,
        });
        phaseStartedAt = performance.now();
      },
      onEnvironmentReady: () => {
        recordStartupPerformance('opencode.environment.ready', {
          attempt,
          durationMs: performance.now() - phaseStartedAt,
          totalDurationMs: performance.now() - attemptStartedAt,
        });
        phaseStartedAt = performance.now();
      },
    });

    let serverInstance = null;
    let startupSucceeded = false;
    try {
      serverInstance = await createManagedOpenCodeServerProcess({
        hostname: env.ENV_CONFIGURED_OPENCODE_HOSTNAME,
        port: spawnPort,
        timeout: 30000,
        cwd: state.openCodeWorkingDirectory,
        shellEnvKeysCount: managedLaunch.shellEnvKeysCount,
        env: managedLaunch.env,
        startupSecretLease: managedLaunch.startupSecretLease,
      });

      if (!serverInstance || !serverInstance.url) {
        throw new Error('OpenCode server started but URL is missing');
      }
      recordStartupPerformance('opencode.process.ready', {
        attempt,
        durationMs: performance.now() - phaseStartedAt,
        totalDurationMs: performance.now() - attemptStartedAt,
      });
      phaseStartedAt = performance.now();

      const url = new URL(serverInstance.url);
      const port = parseInt(url.port, 10);
      const prefix = normalizeApiPrefix(url.pathname);

      if (await waitForReady(serverInstance.url, 10000)) {
        state.openCodeBaseUrl = new URL(serverInstance.url).origin;
        setOpenCodePort(port);
        setDetectedOpenCodeApiPrefix(prefix);

        state.isOpenCodeReady = true;
        state.lastOpenCodeError = null;
        state.openCodeNotReadySince = 0;

        recordStartupPerformance('opencode.health.ready', {
          attempt,
          durationMs: performance.now() - phaseStartedAt,
          totalDurationMs: performance.now() - attemptStartedAt,
          outcome: 'ready',
        });

        startupSucceeded = true;
        return serverInstance;
      }

      throw new Error('Server started but health check failed (timeout)');

    } catch (error) {
      let cleanupError = null;
      if (serverInstance && !startupSucceeded) {
        try {
          await serverInstance.close();
        } catch (terminationError) {
          // A live child after escalation is the authoritative failure: do not
          // mask it with the health/startup error or let startOpenCode retry
          // beside the leaked detached process.
          cleanupError = terminationError;
          if (cleanupError && typeof cleanupError === 'object' && !cleanupError.cause) {
            cleanupError.cause = error;
          }
        }
      }
      const failure = cleanupError || error;
      const safeError = sanitizeManagedStartupError(failure, managedLaunch.env);
      const message = safeError.message;
      state.lastOpenCodeError = message;
      state.openCodePort = null;
      state.openCodeBaseUrl = null;
      syncToHmrState();
      recordStartupPerformance('opencode.attempt.error', {
        attempt,
        totalDurationMs: performance.now() - attemptStartedAt,
        outcome: 'error',
      });
      console.error(`Failed to start OpenCode: ${message}`);
      throw safeError;
    }
  };

  const startOpenCode = async ({ admissionChecked = false } = {}) => {
    if (!admissionChecked) await assertLegacyLaunchAdmission();
    const fenceResolution = await reconcileGuardianOutcomeUnknownFenceForLifecycle();
    if (fenceResolution.resolved && state.openCodeProcess) {
      return state.openCodeProcess;
    }
    // Legacy managed spawn only applies when this OpenChamber instance owns a
    // managed local OpenCode. Explicit external/skip-start mode must never spawn
    // a local child; the bootstrap reordering makes this unreachable in the
    // normal startup path, but the guard keeps the contract explicit so a
    // direct caller in external mode fails fast instead of spawning.
    if (!ownsManagedLocalOpenCode()) {
      throw new Error('Managed OpenCode spawn is disabled in external/skip-start mode');
    }
    let lastError = null;
    for (let attempt = 1; attempt <= START_OPEN_CODE_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await startOpenCodeOnce(attempt);
      } catch (error) {
        const safeError = sanitizeManagedStartupError(error);
        lastError = safeError;
        if (isAmbiguousGuardianRequestError(safeError)) break;
        if (safeError?.code === 'OPENCODE_BINARY_INVALID') {
          break;
        }
        if (safeError?.code === 'OPENCODE_CHILD_STILL_RUNNING') {
          break;
        }
        if (attempt >= START_OPEN_CODE_MAX_ATTEMPTS) {
          break;
        }

        const message = safeError.message;
        console.warn(`[OpenCode] Managed server startup failed on attempt ${attempt}/${START_OPEN_CODE_MAX_ATTEMPTS}; retrying: ${message}`);
        state.openCodePort = null;
        state.isOpenCodeReady = false;
        state.openCodeNotReadySince = Date.now();
        syncToHmrState();
        await delay(750 * attempt);
      }
    }

    throw lastError;
  };

  const startOpenCodeThroughGuardian = async () => {
    const fenceResolution = await reconcileGuardianOutcomeUnknownFenceForLifecycle();
    if (fenceResolution.resolved && state.openCodeProcess) {
      return state.openCodeProcess;
    }
    if (!canUseGuardian) {
      throw new Error('Guardian launch requires a stable OpenChamber owner identity');
    }
    // Guardian-managed initial spawn only applies when this OpenChamber instance
    // owns a managed local OpenCode. Explicit external/skip-start mode must never
    // spawn through the guardian; the bootstrap reordering makes this unreachable
    // in the normal startup path, but the guard keeps the contract explicit for
    // direct callers (e.g. tests, restart handoff).
    if (!ownsManagedLocalOpenCode()) {
      throw new Error('Guardian-managed OpenCode spawn is disabled in external/skip-start mode');
    }
    const client = createGuardianClient({ connectTimeoutMs: 5000 });
    let successor = null;
    let successorOwner = null;
    let launch = null;
    let guardianLaunch = null;
    let connected = false;

    try {
      await client.connect();
      connected = true;
      const desiredPort = env.ENV_CONFIGURED_OPENCODE_PORT ?? 0;
      const spawnPort = await resolveManagedOpenCodePort(desiredPort, env.ENV_CONFIGURED_OPENCODE_HOSTNAME);
      launch = await buildManagedOpenCodeSpawnEnv({ rotatePassword: true });
      guardianLaunch = createGuardianLaunch({
        binary: launch.binary,
        args: launch.args,
        hostname: env.ENV_CONFIGURED_OPENCODE_HOSTNAME,
        port: spawnPort,
        cwd: state.openCodeWorkingDirectory,
      });
      successorOwner = guardianLaunch.owner;

       successor = await client.spawn({
        port: spawnPort,
        hostname: env.ENV_CONFIGURED_OPENCODE_HOSTNAME,
        binary: launch.binary,
        args: launch.args,
        cwd: state.openCodeWorkingDirectory,
        env: buildGuardianSpawnEnv(launch.env),
         ...guardianLaunch,
       });
       const activeOwner = hasCompleteOwnerIdentity(successor?.owner)
         ? successor.owner
         : successorOwner;
       if (!successor?.port || !successor?.incarnation || !hasCompleteOwnerIdentity(activeOwner)) {
         throw new Error('Guardian initial OpenCode launch failed health check');
       }
        await waitForGuardianReady({
          client,
          incarnation: successor.incarnation,
          owner: activeOwner,
          timeoutMs: 10_000,
        });

        retainGuardianStartupSecretLease(successor.incarnation, launch.startupSecretLease);
        state.openCodeProcess = createGuardianChildProxy({
          pid: successor.pid,
          incarnation: successor.incarnation,
          client,
          owner: activeOwner,
          startupSecretLease: launch.startupSecretLease,
        });
       state.openCodeBaseUrl = getAuthoritativeGuardianOrigin({
         child: successor,
         launchSpec: guardianLaunch.launchSpec,
         port: successor.port,
       });
       setOpenCodePort(successor.port);
      resetOpenCodeApiPrefixState();
      state.currentIncarnation = successor.incarnation;
      state.currentOwner = activeOwner;
      state.isExternalOpenCode = false;
      state.isOpenCodeReady = true;
      state.lastOpenCodeError = null;
      state.openCodeNotReadySince = 0;
      syncToHmrState();

      if (state.expressApp) {
        setupProxy(state.expressApp);
        ensureOpenCodeApiPrefix();
      }
      return state.openCodeProcess;
    } catch (error) {
      const ambiguousRequest = isAmbiguousGuardianRequestError(error);
      let cleanupUncertain = false;
      let ambiguousCleanupError = ambiguousRequest ? error : null;
      if (ambiguousRequest) {
        // The initial guardian spawn is also a non-idempotent side effect. A
        // lost response does not prove that no child was created, so retain a
        // successor-owner fence before disconnecting and never stop, retry, or
        // fall back beside the unknown child.
        persistGuardianOutcomeUnknownFence({
          kind: 'initial-spawn',
          incarnation: successor?.incarnation || null,
          owner: successorOwner,
          successorOwner,
          launchSpec: guardianLaunch?.launchSpec || null,
          oldStopped: true,
          source: error,
          lease: launch?.startupSecretLease,
        });
      } else if (successor?.incarnation) {
        try {
          assertGuardianStopIsUnfenced();
          await stopGuardianChildAndVerify({
            client,
            incarnation: successor.incarnation,
            owner: hasCompleteOwnerIdentity(successor.owner) ? successor.owner : successorOwner,
            lease: launch?.startupSecretLease,
            cleanupTarget: 'successor',
            oldStopped: true,
          });
        } catch (cleanupError) {
          if (isAmbiguousGuardianRequestError(cleanupError)) {
            ambiguousCleanupError = cleanupError;
            persistGuardianOutcomeUnknownFence({
              kind: 'stop',
              incarnation: successor.incarnation,
              owner: hasCompleteOwnerIdentity(successor.owner) ? successor.owner : successorOwner,
              preparedRecord: successor,
              cleanupTarget: 'successor',
              oldStopped: true,
              source: cleanupError,
              lease: launch?.startupSecretLease,
            });
          }
          cleanupUncertain = true;
        }
      } else if (successorOwner) {
        let liveSuccessor = null;
        try {
          liveSuccessor = await findLiveGuardianSuccessor(client, successorOwner);
          if (liveSuccessor?.incarnation) {
            assertGuardianStopIsUnfenced();
            await stopGuardianChildAndVerify({
              client,
              incarnation: liveSuccessor.incarnation,
              owner: successorOwner,
              lease: launch?.startupSecretLease,
              cleanupTarget: 'successor',
              oldStopped: true,
            });
          }
        } catch (cleanupError) {
          if (isAmbiguousGuardianRequestError(cleanupError) && liveSuccessor?.incarnation) {
            ambiguousCleanupError = cleanupError;
            persistGuardianOutcomeUnknownFence({
              kind: 'stop',
              incarnation: liveSuccessor.incarnation,
              owner: successorOwner,
              preparedRecord: liveSuccessor,
              cleanupTarget: 'successor',
              oldStopped: true,
              source: cleanupError,
              lease: launch?.startupSecretLease,
            });
          }
          cleanupUncertain = true;
        }
      }
      if (connected && !(await disconnectGuardianClient(client))) {
        cleanupUncertain = true;
      }
      if (cleanupUncertain) {
        const cleanupError = new Error(
          `Guardian initial OpenCode launch failed without confirmed cleanup: ${error?.message || String(error)}`,
        );
        const cleanupFence = state.guardianOutcomeUnknownFence;
        const cleanupFenceIsAmbiguous = cleanupFence?.ambiguous === true;
        cleanupError.code = ambiguousRequest || cleanupFenceIsAmbiguous
          ? GUARDIAN_AMBIGUOUS_REQUEST_CODE
          : 'GUARDIAN_CLEANUP_UNCERTAIN';
        if (ambiguousRequest || ambiguousCleanupError || cleanupFenceIsAmbiguous) {
          copyStructuredStartupErrorMetadata(cleanupError, ambiguousCleanupError || error);
        }
        throw cleanupError;
      }
      if (!state.guardianOutcomeUnknownFence) {
        releaseManagedStartupSecretLease(launch?.startupSecretLease);
      }
      throw error;
    }
  };

  const restartOpenCode = async (reason = 'managed-restart') => {
    if (state.isShuttingDown) return;
    if (state.currentRestartPromise) {
      await state.currentRestartPromise;
      return;
    }

    state.currentRestartPromise = (async () => {
      let previousRuntimeState = {
        openCodeProcess: state.openCodeProcess,
        openCodePort: state.openCodePort,
        openCodeBaseUrl: state.openCodeBaseUrl,
        currentIncarnation: state.currentIncarnation,
        currentOwner: state.currentOwner,
        isOpenCodeReady: state.isOpenCodeReady,
        openCodeNotReadySince: state.openCodeNotReadySince,
        lastOpenCodeError: state.lastOpenCodeError,
      };
      state.isRestartingOpenCode = true;
      state.isOpenCodeReady = false;
      state.openCodeNotReadySince = Date.now();
      console.log('Restarting OpenCode process...');

      // A persisted ambiguity fence is checked before every lifecycle entry
      // point that could stop, spawn, retry, or fall back.  Reconciliation is
      // the only path allowed to perform the owner-scoped cutover while the
      // fence is unresolved; a missing/partial/mismatched authenticated record
      // remains a hard blocker.
      const fenceResolution = await reconcileGuardianOutcomeUnknownFenceForLifecycle();
      if (fenceResolution.resolved && fenceResolution.adopted) {
        if (state.expressApp) {
          setupProxy(state.expressApp);
          ensureOpenCodeApiPrefix();
        }
        return;
      }

      if (state.isExternalOpenCode) {
        console.log('Re-probing external OpenCode server...');
        const probePort = state.openCodePort ?? env.ENV_EFFECTIVE_PORT ?? 4096;
        const probeOrigin = state.openCodeBaseUrl ?? env.ENV_CONFIGURED_OPENCODE_HOST?.origin;
        const healthy = await probeExternalOpenCode(probePort, probeOrigin);
        if (healthy) {
          console.log(`External OpenCode server on port ${probePort} is healthy`);
          state.openCodeBaseUrl = probeOrigin ?? null;
          setOpenCodePort(probePort);
          state.isOpenCodeReady = true;
          state.lastOpenCodeError = null;
          state.openCodeNotReadySince = 0;
          syncToHmrState();
        } else {
          resetSessionRuntimeForOpenCodeReplacement();
          state.lastOpenCodeError = `External OpenCode server on port ${probePort} is not responding`;
          console.error(state.lastOpenCodeError);
          throw new Error(state.lastOpenCodeError);
        }

        if (state.expressApp) {
          setupProxy(state.expressApp);
          ensureOpenCodeApiPrefix();
        }
        return;
      }

      // Restart handoff/legacy spawn only applies when this OpenChamber instance
      // owns a managed local OpenCode. `state.isExternalOpenCode` (set during
      // bootstrap) normally short-circuits above, but guard the handoff section
      // with the normalized ownership decision too: an explicit external/skip-start
      // configuration must never perform guardian handoff or managed spawn, and
      // a restart invoked before bootstrap set the external flag must still be
      // safe. The running guardian (possibly a separate service) is NOT shut down
      // here — external mode only means this instance does not manage OpenCode
      // through it.
      if (!ownsManagedLocalOpenCode()) {
        throw new Error('OpenCode restart handoff is disabled in external/skip-start mode');
      }

      captureRestartDiagnostics(reason);
      resetSessionRuntimeForOpenCodeReplacement();
      let portToKill = state.openCodePort;
      let guardianRunningObserved = false;

      // Phase 2B/3: Try guardian handoff restart on the supported web
      // transports (POSIX Unix socket or Windows loopback TCP).
      // Handoff is enabled by default. CLI flag `--no-handoff` (or env
      // OPENCHAMBER_RESTART_HANDOFF=disabled) forces the legacy restart path
      // so callers can opt out without losing the rest of the lifecycle.
      // W-C: the `process.platform !== 'win32'` gate is removed. Handoff now
      // runs on Windows through the new portPath (loopback TCP + per-user
      // discovery file under %LOCALAPPDATA%); the transport factory
      // dispatches per-platform inside GuardianClient / isGuardianRunning.
      const handoffEnabled = process.env.OPENCHAMBER_RESTART_HANDOFF !== 'disabled';
      let currentGuardianOwner = state.currentOwner || state.openCodeProcess?.owner || null;
      const outcomeUnknownFence = getGuardianOutcomeUnknownFence();
      if (outcomeUnknownFence && (!handoffEnabled || !canUseGuardian)) {
        throw createGuardianOutcomeUnknownError(
          outcomeUnknownFence,
          'Guardian outcome-unknown fence blocks restart while owner-scoped handoff is unavailable',
        );
      }
      if (handoffEnabled && canUseGuardian) {
        const guardianRunning = await probeGuardianRunning();

        if (outcomeUnknownFence && !guardianRunning) {
          throw createGuardianOutcomeUnknownError(
            outcomeUnknownFence,
            'Guardian outcome-unknown fence cannot be reconciled while the guardian is unavailable',
          );
        }

        if (guardianRunning) {
          guardianRunningObserved = true;
          const socketPath = getGuardianSocket();
          const portPath = getWindowsPortPath();
          let adoptedGuardianClient = null;

           if (outcomeUnknownFence) {
             const fenceClient = createGuardianClient({ connectTimeoutMs: 5000 });
             let keepFenceClient = false;
             try {
               await fenceClient.connect();
               const reconciliation = await reconcileGuardianOutcomeUnknownFence({
                 client: fenceClient,
                 fence: outcomeUnknownFence,
               });
               if (reconciliation.adopted) {
                 keepFenceClient = true;
                 if (state.expressApp) {
                   setupProxy(state.expressApp);
                   ensureOpenCodeApiPrefix();
                 }
                 return;
               }
             } finally {
               if (!keepFenceClient) await disconnectGuardianClient(fenceClient);
             }
           }

            // HMR, legacy startup, and migration states can retain a live
           // guardian child without retaining its incarnation in memory.
           // Inspect the authenticated record set before allowing the legacy
           // path to spawn. `detectAndAdoptGuardianChild` rejects ownerless,
           // ambiguous, unhealthy, and unavailable guardian states; none of
           // those may be treated as an empty guardian.
          if (!state.currentIncarnation || !hasCompleteOwnerIdentity(currentGuardianOwner)) {
            const adopted = await adoptGuardianChildForRestart({ socketPath, portPath });
            if (adopted) {
              adoptedGuardianClient = adopted.client;
              currentGuardianOwner = state.currentOwner;
              portToKill = state.openCodePort;
              previousRuntimeState = {
                ...previousRuntimeState,
                openCodeProcess: state.openCodeProcess,
                openCodePort: state.openCodePort,
                openCodeBaseUrl: state.openCodeBaseUrl,
                currentIncarnation: state.currentIncarnation,
                currentOwner: state.currentOwner,
                isOpenCodeReady: state.isOpenCodeReady,
                openCodeNotReadySince: state.openCodeNotReadySince,
                lastOpenCodeError: state.lastOpenCodeError,
              };
            }
          }

          if (!state.currentIncarnation || !hasCompleteOwnerIdentity(currentGuardianOwner)) {
            // No exact owner child exists. The later legacy path may proceed
            // only after the owner-scoped state above has proved that there is
            // no child to hand off.
            console.log('[lifecycle] guardian has no exact child for this owner; using legacy restart');
          } else {
            const client = adoptedGuardianClient || createGuardianClient({ connectTimeoutMs: 5000 });
            const previousIncarnation = state.currentIncarnation;
            const previousOwner = currentGuardianOwner;
            const fixedPort = Number.isFinite(env.ENV_CONFIGURED_OPENCODE_PORT)
              && env.ENV_CONFIGURED_OPENCODE_PORT > 0;
            let prepared = false;
            let oldStopped = false;
            let successor = null;
            let successorOwner = null;
            let successorStopped = false;
            let restoreOpenCodeAuthState = null;
            let launch = null;
            let preparedRecord = null;
            let guardianLaunch = null;
            let handoffPhase = null;

          try {
            await client.connect();
            const newPort = fixedPort
              ? env.ENV_CONFIGURED_OPENCODE_PORT
              : await resolveManagedOpenCodePort(0, env.ENV_CONFIGURED_OPENCODE_HOSTNAME);

            // Fence the old record before either handoff ordering. The
            // fixed-port path must stop and release the old listener before
            // spawning its successor; dynamic ports can start the successor
            // first and keep the cutover fast.
            handoffPhase = 'prepare';
            preparedRecord = await client.prepareHandoff(withOwner({ incarnation: previousIncarnation }, previousOwner));
            handoffPhase = null;
            prepared = true;

            if (typeof captureOpenCodeAuthState === 'function') {
              const restore = captureOpenCodeAuthState();
              restoreOpenCodeAuthState = typeof restore === 'function' ? restore : null;
            }
            launch = await buildManagedOpenCodeSpawnEnv({ rotatePassword: true });
            guardianLaunch = createGuardianLaunch({
              binary: launch.binary,
              args: launch.args,
              hostname: env.ENV_CONFIGURED_OPENCODE_HOSTNAME,
              port: newPort,
              cwd: state.openCodeWorkingDirectory,
            });
            successorOwner = guardianLaunch.owner;

            if (fixedPort) {
              handoffPhase = 'stop-old';
              assertGuardianStopIsUnfenced();
              await stopGuardianChildAndVerify({
                client,
                incarnation: previousIncarnation,
                owner: previousOwner,
                lease: guardianStartupSecretLeases.get(previousIncarnation),
              });
              handoffPhase = null;
              releaseGuardianStartupSecretLease(previousIncarnation);
              oldStopped = true;
              state.openCodeProcess = null;
              state.currentIncarnation = null;
              state.currentOwner = null;
              syncToHmrState();

              if (!(await waitForPortRelease(newPort, 5000, env.ENV_CONFIGURED_OPENCODE_HOSTNAME))) {
                throw new Error(`Fixed OpenCode port ${newPort} was not released after stopping the previous child`);
              }
            }

            handoffPhase = 'spawn';
            successor = await client.spawn({
              port: newPort,
              hostname: env.ENV_CONFIGURED_OPENCODE_HOSTNAME,
              binary: launch.binary,
              args: launch.args,
              cwd: state.openCodeWorkingDirectory,
              env: buildGuardianSpawnEnv(launch.env),
              ...guardianLaunch,
            });
            handoffPhase = null;

            const activeOwner = hasCompleteOwnerIdentity(successor?.owner)
              ? successor.owner
              : successorOwner;
            if (!successor?.port || !successor?.incarnation || !hasCompleteOwnerIdentity(activeOwner)) {
              throw new Error('Guardian successor failed health check');
            }
            await waitForGuardianReady({
              client,
              incarnation: successor.incarnation,
              owner: activeOwner,
              timeoutMs: 10_000,
            });

            if (!fixedPort) {
              handoffPhase = 'stop-old';
              assertGuardianStopIsUnfenced();
              await stopGuardianChildAndVerify({
                client,
                incarnation: previousIncarnation,
                owner: previousOwner,
                lease: guardianStartupSecretLeases.get(previousIncarnation),
              });
              handoffPhase = null;
              releaseGuardianStartupSecretLease(previousIncarnation);
              oldStopped = true;
            }

            retainGuardianStartupSecretLease(successor.incarnation, launch.startupSecretLease);
            state.openCodeProcess = createGuardianChildProxy({
              pid: successor.pid,
              incarnation: successor.incarnation,
              client,
              owner: activeOwner,
              startupSecretLease: launch.startupSecretLease,
            });
            state.openCodeBaseUrl = getAuthoritativeGuardianOrigin({
              child: successor,
              launchSpec: guardianLaunch.launchSpec,
              port: successor.port,
            });
            setOpenCodePort(successor.port);
            resetOpenCodeApiPrefixState();
            state.currentIncarnation = successor.incarnation;
            state.isOpenCodeReady = true;
            state.lastOpenCodeError = null;
            state.openCodeNotReadySince = 0;
            state.currentOwner = activeOwner;
            syncToHmrState();

            if (state.expressApp) {
              setupProxy(state.expressApp);
              ensureOpenCodeApiPrefix();
            }
            return;
          } catch (error) {
            // A rehydrated child that fails its identity check is not a
            // recoverable handoff failure. Legacy port cleanup could target a
            // reused PID or a foreign listener, so refuse fallback and leave
            // the guardian attention record authoritative.
            const ambiguousRequest = isAmbiguousGuardianRequestError(error);
            const ambiguousHandoffPhase = ambiguousRequest
              && (handoffPhase === 'prepare' || handoffPhase === 'spawn' || handoffPhase === 'stop-old');
            let cleanupUncertain = error?.code === 'GUARDIAN_CHILD_IDENTITY_INVALID'
              || ambiguousRequest;
            let ambiguousCleanupError = ambiguousRequest ? error : null;

            if (ambiguousHandoffPhase) {
              persistGuardianOutcomeUnknownFence({
                kind: handoffPhase === 'stop-old' ? 'stop' : handoffPhase,
                incarnation: previousIncarnation,
                owner: previousOwner,
                preparedRecord,
                successorOwner,
                cleanupTarget: handoffPhase === 'stop-old' ? 'old' : undefined,
                launchSpec: handoffPhase === 'spawn' ? guardianLaunch?.launchSpec : null,
                oldStopped,
                source: error,
                lease: launch?.startupSecretLease,
              });
            }

            if (!ambiguousRequest && successor?.incarnation && !successorStopped) {
              try {
                assertGuardianStopIsUnfenced();
                await stopGuardianChildAndVerify({
                  client,
                  incarnation: successor.incarnation,
                  owner: hasCompleteOwnerIdentity(successor.owner) ? successor.owner : successorOwner,
                  lease: launch?.startupSecretLease,
                  cleanupTarget: 'successor',
                  rollbackIncarnation: previousIncarnation,
                  rollbackOwner: previousOwner,
                  oldStopped,
                });
                successorStopped = true;
                releaseManagedStartupSecretLease(launch?.startupSecretLease);
                } catch (cleanupError) {
                  if (isAmbiguousGuardianRequestError(cleanupError)) {
                    ambiguousCleanupError = cleanupError;
                    persistGuardianOutcomeUnknownFence({
                      kind: 'stop',
                      incarnation: successor.incarnation,
                      owner: hasCompleteOwnerIdentity(successor.owner) ? successor.owner : successorOwner,
                      preparedRecord: successor,
                      cleanupTarget: 'successor',
                      rollbackIncarnation: previousIncarnation,
                      rollbackOwner: previousOwner,
                      oldStopped,
                      source: cleanupError,
                      lease: launch?.startupSecretLease,
                    });
                  }
                  cleanupUncertain = true;
                }
            } else if (!ambiguousRequest && !successor?.incarnation) {
              let liveSuccessor = null;
              try {
                liveSuccessor = await findLiveGuardianSuccessor(client, successorOwner);
                if (liveSuccessor?.incarnation) {
                  assertGuardianStopIsUnfenced();
                  await stopGuardianChildAndVerify({
                    client,
                    incarnation: liveSuccessor.incarnation,
                    owner: successorOwner,
                    lease: launch?.startupSecretLease,
                    cleanupTarget: 'successor',
                    rollbackIncarnation: previousIncarnation,
                    rollbackOwner: previousOwner,
                    oldStopped,
                   });
                   releaseManagedStartupSecretLease(launch?.startupSecretLease);
                 } else if (oldStopped) {
                   // A non-ambiguous spawn failure plus a fresh authenticated
                   // empty owner-scoped list is the only proof that no
                   // successor exists. Release this launch's lease once, but
                   // retain it if any durable operation or ambiguity fence is
                   // still unresolved.
                   await confirmGuardianNoSuccessor(client, successorOwner);
                   releaseManagedStartupSecretLease(launch?.startupSecretLease);
                 }
              } catch (cleanupError) {
                if (isAmbiguousGuardianRequestError(cleanupError) && liveSuccessor?.incarnation) {
                  ambiguousCleanupError = cleanupError;
                  persistGuardianOutcomeUnknownFence({
                    kind: 'stop',
                    incarnation: liveSuccessor.incarnation,
                    owner: successorOwner,
                    preparedRecord: liveSuccessor,
                    cleanupTarget: 'successor',
                    rollbackIncarnation: previousIncarnation,
                    rollbackOwner: previousOwner,
                    oldStopped,
                    source: cleanupError,
                    lease: launch?.startupSecretLease,
                  });
                }
                cleanupUncertain = true;
              }
            }

            // A prepared handoff can fall back only after an old child that
            // was not confirmed stopped is explicitly returned to active and
            // health-checked. This includes the dynamic ordering where the
            // successor is launched before the old stop attempt: a rejected
            // old stop is not proof that the old child is gone.
            let oldRollbackConfirmed = false;
            if (prepared && !oldStopped && !ambiguousRequest) {
              let rollbackError = null;
              try {
                if (typeof client.abortHandoff !== 'function') {
                  throw new Error('Guardian client cannot abort the old handoff');
                }
                // Guardian.abortHandoff returns the active record directly;
                // it does not use the protocol's { ok, record } envelope.
                const rollback = await client.abortHandoff(
                  withOwner({ incarnation: previousIncarnation }, previousOwner),
                );
                if (rollback?.state !== 'active' || rollback?.incarnation !== previousIncarnation) {
                  throw new Error(
                    `Guardian old-child rollback did not return active incarnation ${previousIncarnation}`,
                  );
                }
                if (typeof client.health === 'function') {
                  const health = await client.health({
                    incarnation: previousIncarnation,
                    owner: previousOwner,
                  });
                  oldRollbackConfirmed = health?.healthy === true;
                  if (!oldRollbackConfirmed) {
                    throw new Error('Guardian old-child rollback health check failed');
                  }
                } else {
                  oldRollbackConfirmed = true;
                }
                if (oldRollbackConfirmed && restoreOpenCodeAuthState) {
                  restoreOpenCodeAuthState();
                  restoreOpenCodeAuthState = null;
                }
              } catch (rollbackFailure) {
                rollbackError = rollbackFailure;
                if (isAmbiguousGuardianRequestError(rollbackFailure)) {
                  ambiguousCleanupError = rollbackFailure;
                  persistGuardianOutcomeUnknownFence({
                    kind: 'abort-handoff',
                    incarnation: previousIncarnation,
                    owner: previousOwner,
                    preparedRecord,
                    rollbackIncarnation: previousIncarnation,
                    rollbackOwner: previousOwner,
                    oldStopped,
                    source: rollbackFailure,
                    lease: launch?.startupSecretLease,
                  });
                }
              }

              if (oldRollbackConfirmed) {
                console.log(
                  `[lifecycle] guardian handoff old-child rollback confirmed for ${previousIncarnation}`,
                );
              } else {
                cleanupUncertain = true;
                console.warn(
                  `[lifecycle] guardian handoff old-child rollback failed for ${previousIncarnation}: ${rollbackError?.message || 'unconfirmed'}`,
                );
              }
            } else if (prepared && oldStopped) {
              // Once the old child is confirmed stopped, a failed successor
              // cannot safely fall back to a legacy spawn beside an unknown
              // replacement state.
              cleanupUncertain = true;
            }

            if (oldStopped) {
              state.openCodeProcess = null;
              state.openCodeBaseUrl = null;
              state.currentIncarnation = null;
              state.currentOwner = null;
              state.isOpenCodeReady = false;
              syncToHmrState();
            } else {
              // The old child was never confirmed stopped. Restore the
              // reference/readiness so an explicit failure does not strand a
              // still-valid owner or make a fallback create a second child.
              // Rebind the proxy to this still-connected client when rollback
              // was confirmed; the legacy fallback must stop this exact owner
              // before it can spawn anything directly.
              if (oldRollbackConfirmed
                  && hasCompleteOwnerIdentity(previousOwner)
                  && (previousRuntimeState.openCodeProcess?.isGuardianManaged === true
                    || !previousRuntimeState.openCodeProcess)) {
                state.openCodeProcess = createGuardianChildProxy({
                  pid: previousRuntimeState.openCodeProcess?.pid ?? null,
                  incarnation: previousIncarnation,
                  client,
                  owner: previousOwner,
                });
              } else {
                state.openCodeProcess = previousRuntimeState.openCodeProcess;
              }
              state.openCodePort = previousRuntimeState.openCodePort;
              state.openCodeBaseUrl = previousRuntimeState.openCodeBaseUrl;
              state.currentIncarnation = previousRuntimeState.currentIncarnation;
              state.currentOwner = previousRuntimeState.currentOwner;
              state.isOpenCodeReady = previousRuntimeState.isOpenCodeReady;
              state.openCodeNotReadySince = previousRuntimeState.openCodeNotReadySince;
              state.lastOpenCodeError = previousRuntimeState.lastOpenCodeError;
              syncToHmrState();
            }

            if (ambiguousRequest || ambiguousCleanupError) {
              // The RPC may have crossed its side-effect boundary even though
              // the response was lost. Do not claim the old child is healthy,
              // abort a possibly-applied handoff, or continue into the legacy
              // spawn path.
              state.isOpenCodeReady = false;
              state.openCodeNotReadySince = Date.now();
              syncToHmrState();
            }

            const retainGuardianClientForFallback = oldRollbackConfirmed
              && state.openCodeProcess?.isGuardianManaged === true;
            if (!retainGuardianClientForFallback && !(await disconnectGuardianClient(client))) {
              cleanupUncertain = true;
            }

            if (cleanupUncertain) {
              const failure = new Error(
                `Guardian handoff failed without a confirmed rollback: ${error?.message || String(error)}`,
              );
              if (ambiguousCleanupError) copyStructuredStartupErrorMetadata(failure, ambiguousCleanupError);
              else failure.code = 'GUARDIAN_CLEANUP_UNCERTAIN';
              failure.cause = error;
              throw failure;
            }

             console.log('[lifecycle] guardian handoff failed, falling back to legacy restart:', error.message);
          }
        }
      }
      }

      // A guardian may have no exact child for this owner while still holding
      // foreign-owner attention or a durable operation. Before any direct
      // legacy close/port cleanup/start, query the guardian's global
      // admission authority; owner-scoped adoption above remains separate.
      if (guardianRunningObserved || await probeGuardianRunning()) {
        await assertLegacyLaunchAdmission({ guardianRunning: true });
      }

      if (state.openCodeProcess) {
        console.log('Stopping existing OpenCode process...');
        if (state.openCodeProcess.isGuardianManaged) {
          if (typeof state.openCodeProcess.stopOwnedOpenCode !== 'function') {
            throw new Error('Guardian-managed OpenCode has no owner-scoped stop operation');
          }
          // A guardian-managed child must be stopped through its exact owner;
          // never continue to a port-wide kill after an owner-scoped failure.
          await state.openCodeProcess.stopOwnedOpenCode();
          if (typeof state.openCodeProcess.detach === 'function') {
            await state.openCodeProcess.detach();
          }
        } else {
          try {
            await state.openCodeProcess.close();
          } catch (error) {
            if (error?.code === 'OPENCODE_CHILD_STILL_RUNNING') {
              // Do not discard the cleanup uncertainty and spawn a successor
              // beside a detached child that survived escalation.
              throw error;
            }
            console.warn('Error closing OpenCode process:', error);
          }
        }
        state.openCodeProcess = null;
        syncToHmrState();
      }

      if (previousRuntimeState.openCodeProcess?.isGuardianManaged !== true) {
        // Once an authenticated guardian was observed, an absent exact owner
        // is an authoritative no-child result. A port-wide kill at this point
        // could terminate a foreign listener that reused the old port.
        if (!guardianRunningObserved) killProcessOnPort(portToKill);
        if (!(await waitForPortRelease(portToKill, 5000))) {
          console.warn(`Timed out waiting for OpenCode port ${portToKill} to be released`);
        }
      } else if (!(await waitForPortRelease(portToKill, 5000))) {
        console.warn(`Timed out waiting for guardian-managed OpenCode port ${portToKill} to be released`);
      }

      if (env.ENV_CONFIGURED_OPENCODE_PORT) {
        console.log(`Using OpenCode port from environment: ${env.ENV_CONFIGURED_OPENCODE_PORT}`);
        setOpenCodePort(env.ENV_CONFIGURED_OPENCODE_PORT);
      } else {
        state.openCodePort = null;
      }
      // The next managed launch publishes its own listening origin. Never
      // let a previous adopted/external origin survive into that launch.
      state.openCodeBaseUrl = null;
      syncToHmrState();

      state.openCodeApiPrefixDetected = true;
      state.openCodeApiPrefix = '';
      if (state.openCodeApiDetectionTimer) {
        clearTimeout(state.openCodeApiDetectionTimer);
        state.openCodeApiDetectionTimer = null;
      }

      state.lastOpenCodeError = null;
      state.openCodeProcess = await startOpenCode({ admissionChecked: true });
      state.currentIncarnation = null;
      state.currentOwner = null;
      syncToHmrState();

      if (state.expressApp) {
        setupProxy(state.expressApp);
        ensureOpenCodeApiPrefix();
      }

      // The restart may have landed on a NEW port (the old one can remain
      // occupied if killProcessOnPort/waitForPortRelease didn't free it in
      // time, on any platform). Upstream event readers pinned to the old
      // process would keep the UI silent forever, so rebind them to the
      // current port. Best effort: a failure here must not fail the restart
      // itself.
      try {
        onOpenCodeRestarted?.();
      } catch (error) {
        console.warn('Failed to rebind event stream after OpenCode restart:', error?.message ?? error);
      }
    })();

    try {
      await state.currentRestartPromise;
    } catch (error) {
      const safeError = sanitizeManagedStartupError(error);
      console.error(`Failed to restart OpenCode: ${safeError.message}`);
      state.lastOpenCodeError = safeError.message;
      if (!env.ENV_EFFECTIVE_PORT) {
        state.openCodePort = null;
        syncToHmrState();
      }
      state.openCodeApiPrefixDetected = true;
      state.openCodeApiPrefix = '';
      throw safeError;
    } finally {
      state.currentRestartPromise = null;
      state.isRestartingOpenCode = false;
    }
  };

  const waitForOpenCodeReady = async (timeoutMs = 20000, intervalMs = 400) => {
    if (!state.openCodePort) {
      throw new Error('OpenCode port is not available');
    }

    if (state.openCodeProcess?.isGuardianManaged === true) {
      if (typeof state.openCodeProcess.health !== 'function') {
        throw new Error('Guardian-managed OpenCode has no owner-scoped health operation');
      }
      try {
        await waitForGuardianManagedOpenCodeReady({
          timeoutMs,
          intervalMs,
          check: () => state.openCodeProcess.health(),
        });
        state.isOpenCodeReady = true;
        state.lastOpenCodeError = null;
        return;
      } catch (error) {
        state.lastOpenCodeError = error.message || String(error);
        throw error;
      }
    }

    const ready = await waitForReady(buildOpenCodeUrl(OPENCODE_HEALTH_PATH, ''), timeoutMs);
    if (ready) {
      state.isOpenCodeReady = true;
      state.lastOpenCodeError = null;
      return;
    }
    const timeoutError = new Error('Timed out waiting for OpenCode to become ready');
    state.lastOpenCodeError = timeoutError.message;
    throw timeoutError;
  };

  const waitForAgentPresence = async (agentName, timeoutMs = 15000, intervalMs = 300) => {
    if (!state.openCodePort) {
      throw new Error('OpenCode port is not available');
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(buildOpenCodeUrl('/agent'), {
          method: 'GET',
          headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        });

        if (response.ok) {
          const agents = await response.json();
          if (Array.isArray(agents) && agents.some((agent) => agent?.name === agentName)) {
            return;
          }
        }
      } catch {
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Agent "${agentName}" not available after OpenCode restart`);
  };

  const refreshOpenCodeAfterConfigChange = async (reason, options = {}) => {
    const { agentName } = options;

    console.log(`Refreshing OpenCode after ${reason}`);
    clearResolvedOpenCodeBinary();
    await applyOpencodeBinaryFromSettings();

    await restartOpenCode(reason || 'config-change');

    // A managed OpenCode process is restarted (and thus re-reads config from
    // disk) by restartOpenCode(). An external OpenCode server is NOT owned by
    // OpenChamber: restartOpenCode() only re-probes its health, so the freshly
    // written config is on disk but the running server keeps serving its old,
    // startup-cached config until the user restarts it themselves. Report this
    // honestly so callers don't claim the change is live.
    const external = state.isExternalOpenCode === true;

    try {
      await waitForOpenCodeReady();
      state.isOpenCodeReady = true;
      state.openCodeNotReadySince = 0;

      // Waiting for the agent to appear only makes sense when we actually
      // reloaded config. An external server will never surface it here.
      if (agentName && !external) {
        await waitForAgentPresence(agentName);
      }

      state.isOpenCodeReady = true;
      state.openCodeNotReadySince = 0;
    } catch (error) {
      state.isOpenCodeReady = false;
      state.openCodeNotReadySince = Date.now();
      console.error(`Failed to refresh OpenCode after ${reason}:`, error.message);
      throw error;
    }

    return { reloaded: !external, external };
  };

  const bootstrapOpenCodeAtStartup = async () => {
    const bootstrapStartedAt = performance.now();
    let bootstrapError = null;
    recordStartupPerformance('opencode.bootstrap.start');
    try {
      // Before doing anything, reap any OpenCode process WE spawned in a prior
      // run that was orphaned by a crash/hard-exit. Verified + scoped to our own
      // pids, so it never touches a live instance's or the user's own server.
      try {
        const orphanReapStartedAt = performance.now();
        const { reaped } = await reapManagedOrphanedProcesses({ log: (msg) => console.log(msg) });
        recordStartupPerformance('opencode.orphan-reap.ready', {
          durationMs: performance.now() - orphanReapStartedAt,
          totalDurationMs: performance.now() - bootstrapStartedAt,
        });
        if (reaped > 0) console.log(`[lifecycle] startup reaped ${reaped} orphaned OpenCode process(es)`);
      } catch (error) {
        console.warn('[lifecycle] orphan reap failed:', error?.message ?? error);
      }

      syncFromHmrState();
      if (env.ENV_SKIP_OPENCODE_START && !env.ENV_EFFECTIVE_PORT) {
        state.openCodeProcess = null;
        state.openCodePort = null;
        state.openCodeBaseUrl = null;
        state.currentIncarnation = null;
        state.currentOwner = null;
        state.isOpenCodeReady = false;
        state.isExternalOpenCode = false;
        state.openCodeNotReadySince = Date.now();
        syncToHmrState();
        throw new Error('OpenCode skip-start mode requires an effective port');
      }
      const fenceResolution = await reconcileGuardianOutcomeUnknownFenceForLifecycle();
      if (fenceResolution.resolved && fenceResolution.adopted) {
        if (state.expressApp) {
          setupProxy(state.expressApp);
          ensureOpenCodeApiPrefix();
        }
        console.log(`[HMR] Reusing existing OpenCode process on port ${state.openCodePort}`);
      } else if (await isOpenCodeProcessHealthy()) {
        console.log(`[HMR] Reusing existing OpenCode process on port ${state.openCodePort}`);
      } else {
        resetSessionRuntimeForOpenCodeReplacement();
        state.openCodeProcess = null;
        state.currentIncarnation = null;
        state.currentOwner = null;
        // Explicit external/skip-start mode is an operator decision that this
        // OpenChamber instance does NOT own a managed local OpenCode. It must
        // win over guardian adoption: a previously-running guardian (possibly
        // a separate operator-owned service) may still hold a child matching
        // our persisted owner metadata, but adopting it would couple our
        // lifecycle to a process we explicitly declined to manage. Resolve the
        // skip-start/external branch first; guardian adoption only runs when
        // this instance owns managed local OpenCode.
        if (env.ENV_SKIP_OPENCODE_START && env.ENV_EFFECTIVE_PORT) {
          const label = env.ENV_CONFIGURED_OPENCODE_HOST ? env.ENV_CONFIGURED_OPENCODE_HOST.origin : `http://localhost:${env.ENV_EFFECTIVE_PORT}`;
          console.log(`Using external OpenCode server at ${label} (skip-start mode)`);
          state.openCodeBaseUrl = env.ENV_CONFIGURED_OPENCODE_HOST?.origin ?? null;
          setOpenCodePort(env.ENV_EFFECTIVE_PORT);
          state.isOpenCodeReady = true;
          state.isExternalOpenCode = true;
          state.currentIncarnation = null;
          state.currentOwner = null;
          state.lastOpenCodeError = null;
          state.openCodeNotReadySince = 0;
          syncToHmrState();
        } else if (env.ENV_EFFECTIVE_PORT && await probeExternalOpenCode(env.ENV_EFFECTIVE_PORT, env.ENV_CONFIGURED_OPENCODE_HOST?.origin)) {
          const label = env.ENV_CONFIGURED_OPENCODE_HOST ? env.ENV_CONFIGURED_OPENCODE_HOST.origin : `http://localhost:${env.ENV_EFFECTIVE_PORT}`;
          console.log(`Auto-detected existing OpenCode server at ${label}`);
          state.openCodeBaseUrl = env.ENV_CONFIGURED_OPENCODE_HOST?.origin ?? null;
          setOpenCodePort(env.ENV_EFFECTIVE_PORT);
          state.isOpenCodeReady = true;
          state.isExternalOpenCode = true;
          state.currentIncarnation = null;
          state.currentOwner = null;
          state.lastOpenCodeError = null;
          state.openCodeNotReadySince = 0;
          syncToHmrState();
        } else {
          // W-C: previously this branch was gated `else if (process.platform
          // !== 'win32')` and the Windows path was duplicated below. The
          // platform gate is removed; `detectAndAdoptGuardianChild()` now
          // works on both platforms (loopback TCP via `portPath` on
          // Windows; Unix-domain socket via `socketPath` on Linux). The
          // post-adoption cascade is the same on every platform.
          //
          // Adoption only runs after the skip-start/external branches above
          // declined, i.e. when this instance owns managed local OpenCode.
          const portPath = getWindowsPortPath();
          const guardianChild = canUseGuardian
            ? await detectAndAdoptGuardianChild(getGuardianSocket(), portPath, getGuardianAdoptionOptions())
            : null;
          if (guardianChild) {
            console.log(`[lifecycle] Adopted guardian-managed OpenCode on port ${guardianChild.port}`);
            // Construct a fresh GuardianClient for the adopted child so the
            // proxy can later ask the guardian to stop it. The client lazily
            // connects on first use; if the guardian is unreachable when
            // shutdown runs, ownership is preserved rather than killing a
            // potentially unrelated listener on that port.
            const adoptionClient = createGuardianClient();
            state.openCodeProcess = createGuardianChildProxy({
              pid: guardianChild.pid,
              incarnation: guardianChild.incarnation,
              client: adoptionClient,
              owner: guardianChild.owner || null,
            });
            state.openCodeBaseUrl = getAuthoritativeGuardianOrigin({ child: guardianChild });
            setOpenCodePort(guardianChild.port);
            resetOpenCodeApiPrefixState();
            state.isOpenCodeReady = true;
            state.isExternalOpenCode = false;
            state.isRestartingOpenCode = false;
            state.currentIncarnation = guardianChild.incarnation;
            state.currentOwner = guardianChild.owner || null;
            syncToHmrState();
          } else {
            // We never auto-attach to an arbitrary pre-existing OpenCode instance.
            // Attaching to an external server requires explicit opt-in via env
            // (OPENCODE_HOST / OPENCODE_PORT / OPENCODE_SKIP_START), handled by the
            // branches above. Without that opt-in we always start our OWN managed
            // instance on a freshly-allocated port. A blind probe of the default
            // port 4096 used to hijack a user's separately-running OpenCode (e.g.
            // the OpenCode desktop app), coupling our lifecycle to theirs and
            // breaking init against an unexpected server version/config.
            // Probe even when this runtime lacks a stable owner identity. A
            // live guardian is not the same as an unavailable guardian, and
            // direct startup beside it would create an unowned duplicate.
            const guardianRunning = await probeGuardianRunning();
            if (guardianRunning) {
              try {
                await startOpenCodeThroughGuardian();
              } catch (error) {
                const safeError = sanitizeManagedStartupError(error);
                const guardianFailure = new Error(
                  `Guardian is running but initial OpenCode launch failed; refusing legacy fallback: ${safeError.message}`,
                );
                guardianFailure.code = isAmbiguousGuardianRequestError(safeError)
                  ? GUARDIAN_AMBIGUOUS_REQUEST_CODE
                  : safeError?.code === 'GUARDIAN_CLEANUP_UNCERTAIN'
                  ? safeError.code
                  : 'GUARDIAN_LIVE_START_FAILED';
                if (isAmbiguousGuardianRequestError(safeError)) {
                  copyStructuredStartupErrorMetadata(guardianFailure, safeError);
                }
                guardianFailure.cause = safeError;
                state.isOpenCodeReady = false;
                state.openCodeNotReadySince = Date.now();
                state.lastOpenCodeError = guardianFailure.message;
                syncToHmrState();
                console.error(`[lifecycle] ${guardianFailure.message}`);
                throw guardianFailure;
              }
            } else if (env.ENV_EFFECTIVE_PORT) {
              console.log(`Using OpenCode port from environment: ${env.ENV_EFFECTIVE_PORT}`);
              setOpenCodePort(env.ENV_EFFECTIVE_PORT);
            } else {
              state.openCodePort = null;
              syncToHmrState();
              state.currentIncarnation = null;
              state.currentOwner = null;
            }

            if (!state.openCodeProcess) {
              state.lastOpenCodeError = null;
              state.openCodeProcess = await startOpenCode();
            }
            state.isExternalOpenCode = false;
            state.currentIncarnation = state.currentIncarnation || null;
            state.currentOwner = state.currentOwner || null;
            syncToHmrState();
          }
          }
        }
      await waitForOpenCodePort();
      try {
      await waitForOpenCodeReady();
      } catch (error) {
        bootstrapError = error;
        console.error(`OpenCode readiness check failed: ${redactManagedStartupDiagnostic(error?.message || String(error))}`);
      }
    } catch (error) {
      bootstrapError = error;
      if (
        error?.code === 'GUARDIAN_CLEANUP_UNCERTAIN'
        || error?.code === 'OPENCODE_CHILD_STILL_RUNNING'
        || isAmbiguousGuardianRequestError(error)
      ) {
        throw sanitizeManagedStartupError(error);
      }
      const safeError = sanitizeManagedStartupError(error);
      console.error(`Failed to start OpenCode: ${safeError.message}`);
      console.log('Continuing without OpenCode integration...');
      state.lastOpenCodeError = safeError.message;
    }
    recordStartupPerformance(
      bootstrapError ? 'opencode.bootstrap.error' : 'opencode.bootstrap.ready',
      {
        totalDurationMs: performance.now() - bootstrapStartedAt,
        outcome: bootstrapError ? 'error' : 'ready',
      },
    );
    if (!bootstrapError) {
      void warmOpenCodeDirectories();
    }
  };

  // OpenCode initializes each project directory lazily on its first
  // directory-scoped request, and that initialization takes seconds on large
  // session stores. Without warming, the user's first session open pays it
  // interactively (the chat waits on the message fetch until the directory
  // finishes initializing). Warm the most recently used directories right
  // after readiness so the work overlaps UI startup instead. Sequential and
  // best-effort: a failed or slow directory never blocks the others for long,
  // and a restart invalidates the pass via the port/readiness guard.
  const warmOpenCodeDirectories = async () => {
    let directories = [];
    try {
      directories = await getWarmupDirectories();
    } catch {
      return;
    }
    if (!Array.isArray(directories) || directories.length === 0) return;

    const warmedPort = state.openCodePort;
    for (const directory of directories.slice(0, WARMUP_DIRECTORY_LIMIT)) {
      if (typeof directory !== 'string' || !directory) continue;
      if (!state.isOpenCodeReady || state.openCodePort !== warmedPort) return;
      let timeout = null;
      try {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), WARMUP_REQUEST_TIMEOUT_MS);
        const url = `${buildOpenCodeUrl('/session/status', '')}?directory=${encodeURIComponent(directory)}`;
        await fetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
          signal: controller.signal,
        });
      } catch {
        // Best-effort — the directory stays lazy and the UI's own request warms it.
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
  };

  /**
   * Perform an immediate (one-shot) health check and restart OpenCode if it's
   * not healthy.  Callers on the SSE / WS proxy path use this to trigger
   * recovery without waiting for the next periodic interval (up to 15 s).
   *
   * Skips restart when sessions are actively busy — a busy server under
   * concurrent load can fail the health check timeout without actually
   * being dead (the health endpoint competes with LLM work).
   * Forces restart if sessions stay "busy" and the server stays unhealthy
   * for over 2 minutes (staleness guard against stuck session state).
   */
  const STALE_BUSY_GRACE_MS = 2 * 60 * 1000;
  let lastUnhealthyWithBusySessionsAt = 0;
  let consecutiveHealthFailures = 0;
  let lastCountedHealthFailureAt = 0;
  let healthProbePromise = null;
  let healthCheckCyclePromise = null;
  let lastHealthProbeResult = null;
  let healthFailureCountIntervalMs = 15_000;

  const resetHealthFailureState = () => {
    consecutiveHealthFailures = 0;
    lastUnhealthyWithBusySessionsAt = 0;
    lastCountedHealthFailureAt = 0;
  };

  const probeOpenCodeHealth = async () => {
    const checkedAt = now();
    if (lastHealthProbeResult && checkedAt - lastHealthProbeResult.at < HEALTH_CHECK_RESULT_CACHE_MS) {
      return lastHealthProbeResult;
    }

    if (healthProbePromise) {
      return healthProbePromise;
    }

    healthProbePromise = probeOpenCodeHealthDetailed()
      .then((result) => {
        lastHealthProbeResult = { at: now(), ...result };
        return lastHealthProbeResult;
      })
      .finally(() => {
        healthProbePromise = null;
      });

    return healthProbePromise;
  };

  const shouldSkipRestartForBusySessions = () => {
    const activeCount = getActiveSessionCount();
    if (activeCount === 0) {
      lastUnhealthyWithBusySessionsAt = 0;
      return { skip: false, staleBusy: false };
    }

    const checkedAt = now();
    if (!lastUnhealthyWithBusySessionsAt) {
      lastUnhealthyWithBusySessionsAt = checkedAt;
      return { skip: true, staleBusy: false };
    }

    if (checkedAt - lastUnhealthyWithBusySessionsAt >= STALE_BUSY_GRACE_MS) {
      console.warn(
        `[lifecycle] OpenCode unhealthy with ${activeCount} busy session(s) for > 2 min — forcing restart`
      );
      lastUnhealthyWithBusySessionsAt = 0;
      return { skip: false, staleBusy: true };
    }

    return { skip: true, staleBusy: false };
  };

  const runHealthCheckCycle = async (source) => {
    if (!state.openCodeProcess || state.isShuttingDown || state.isRestartingOpenCode) return;
    if (healthCheckCyclePromise) return healthCheckCyclePromise;

    healthCheckCyclePromise = (async () => {
      const healthResult = await probeOpenCodeHealth();
      if (!healthResult.healthy) {
        if (!isManagedOpenCodeProcessAlive()) {
          console.log(`[lifecycle] ${source} health check: OpenCode process exited, restarting...`);
          consecutiveHealthFailures = 0;
          lastHealthProbeResult = null;
          await restartOpenCode(`${source}-process-exited`);
          return;
        }
        const checkedAt = now();
        if (lastCountedHealthFailureAt && checkedAt - lastCountedHealthFailureAt < healthFailureCountIntervalMs) {
          return;
        }
        lastCountedHealthFailureAt = checkedAt;
        consecutiveHealthFailures += 1;
        const healthFailure = healthResult.failure || {
          class: 'error',
          detail: 'Health check failed without diagnostic detail',
        };
        state.lastOpenCodeHealthFailure = {
          class: healthFailure.class,
          detail: healthFailure.detail,
          at: new Date(checkedAt).toISOString(),
          source,
        };
        console.warn(
          `[lifecycle] ${source} health check failed (${consecutiveHealthFailures}/${HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES}) class=${healthFailure.class}`
        );
        if (consecutiveHealthFailures < HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES) return;
        const busyDecision = shouldSkipRestartForBusySessions();
        if (busyDecision.skip) return;
        console.log(`[lifecycle] ${source} health check failure threshold reached, restarting OpenCode...`);
        consecutiveHealthFailures = 0;
        lastHealthProbeResult = null;
        await restartOpenCode(
          busyDecision.staleBusy
            ? `${source}-stale-busy-health-failure`
            : `${source}-health-failure`,
        );
      } else {
        resetHealthFailureState();
      }
    })().finally(() => {
      healthCheckCyclePromise = null;
    });

    return healthCheckCyclePromise;
  };

  const triggerHealthCheck = async () => {
    try {
      await runHealthCheckCycle('immediate');
    } catch (error) {
      console.error(`[lifecycle] immediate health check error: ${error.message}`);
    }
  };

  const startHealthMonitoring = (healthCheckIntervalMs) => {
    if (state.healthCheckInterval) {
      clearInterval(state.healthCheckInterval);
    }

    const effectiveIntervalMs = HEALTH_CHECK_INTERVAL_OVERRIDE_MS || healthCheckIntervalMs;
    healthFailureCountIntervalMs = effectiveIntervalMs;

    state.healthCheckInterval = setInterval(async () => {
      try {
        await runHealthCheckCycle('periodic');
      } catch (error) {
        console.error(`Health check error: ${error.message}`);
      }
    }, effectiveIntervalMs);
  };

  const runtime = {
    killProcessOnPort,
    startOpenCode,
    restartOpenCode,
    waitForOpenCodeReady,
    waitForAgentPresence,
    refreshOpenCodeAfterConfigChange,
    bootstrapOpenCodeAtStartup,
    startHealthMonitoring,
    triggerHealthCheck,
    waitForPortRelease,
  };
  Object.defineProperty(runtime, '__testManagedStartupSecretState', {
    value: getManagedStartupSecretState,
    enumerable: false,
  });
  Object.defineProperty(runtime, '__testGuardianStartupSecretLeaseCount', {
    value: getGuardianStartupSecretLeaseCount,
    enumerable: false,
  });
  Object.defineProperty(runtime, '__testReconcileGuardianOutcomeUnknownFence', {
    value: reconcileGuardianOutcomeUnknownFenceForLifecycle,
    enumerable: false,
  });
  // Exposed so the atomic supersession contract can be tested directly: the
  // pure builder must throw before any state mutation, and the replacement
  // must swap keys in one state transition + one HMR sync.
  Object.defineProperty(runtime, '__testBuildGuardianOutcomeUnknownFence', {
    value: buildGuardianOutcomeUnknownFence,
    enumerable: false,
  });
  Object.defineProperty(runtime, '__testReplaceGuardianOutcomeUnknownFence', {
    value: replaceGuardianOutcomeUnknownFence,
    enumerable: false,
  });
  return runtime;
};

// Kept separate from the lifecycle runtime surface so tests can exercise the
// streaming redaction contract without observing it only after diagnostic
// formatting has already joined multiple child-process emissions.
export const __test__ = {
  createManagedStartupOutputFormatter,
  createManagedStartupCapture,
  createRedactedStartupError,
  MANAGED_STARTUP_CAPTURE_LIMIT,
};
