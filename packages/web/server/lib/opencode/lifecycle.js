import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { registerManagedProcess, unregisterManagedProcess, reapOrphanedProcesses } from './managed-process-registry.js';
import { detectAndAdoptGuardianChild, getGuardianSocketPath, isGuardianRunning } from '../guardian/detection.js';
import { GuardianClient } from '../guardian/guardian-client.js';
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
const GUARDIAN_BLOCKED_ENV_KEY = /^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|COMSPEC|ComSpec)$/i;
const MANAGED_STARTUP_CAPTURE_LIMIT = 16 * 1024;
const MANAGED_STARTUP_DIAGNOSTIC_LIMIT = 32 * 1024;
const STARTUP_REDACTION = '[REDACTED]';
const MANAGED_CREDENTIAL_ENV_KEY = /(?:PASSWORD|TOKEN|SECRET|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)/i;

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
    resetSessionRuntimeForOpenCodeReplacement = () => {},
    waitForPortRelease: injectedWaitForPortRelease,
    now = Date.now,
  } = deps;

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

  const withOwner = (params, owner) => owner ? { ...params, owner } : params;

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
      await client.stop(withOwner({ incarnation }, owner));
      const lease = startupSecretLease || guardianStartupSecretLeases.get(incarnation);
      if (lease) {
        if (!(await verifyGuardianChildGone(client, { incarnation }))) {
          throw Object.assign(
            new Error(`Guardian child ${incarnation} cleanup was not confirmed`),
            { code: 'GUARDIAN_CLEANUP_UNCERTAIN' },
          );
        }
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
  const buildManagedOpenCodeSpawnEnv = async ({ rotatePassword } = {}) => {
    await applyOpencodeBinaryFromSettings({ strict: true });
    ensureOpencodeCliEnv();
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
      env: managedEnv,
      startupSecretLease,
    };
  };

  const killProcessOnPort = (port) => {
    if (!port || process.platform === 'win32') return;
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

  const hasChildProcessExited = (child) => !child || child.exitCode !== null || child.signalCode !== null;

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
        unregisterManagedProcess(pid);
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
    try {
      child = spawn(binary, args, {
        cwd,
        env: processEnv,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Register immediately after spawn, not only after the URL is parsed.
      // A detached child that survives a startup failure must remain eligible
      // for the existing orphan-reaper; unregister only after confirmed exit.
      if (Number.isInteger(child.pid)) {
        registerManagedProcess({
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

      return {
        url,
        pid: child.pid || null,
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

  const isOpenCodeProcessHealthy = async () => {
    if (!state.openCodeProcess || !state.openCodePort) {
      return false;
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
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
      try {
        const response = await fetch(buildOpenCodeUrl(OPENCODE_HEALTH_PATH, ''), {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            ...getOpenCodeAuthHeaders(),
          },
          signal: controller.signal,
        });
        if (!response.ok) return false;
        const body = await response.json().catch(() => null);
        return body?.healthy === true;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return false;
    }
  };

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

  const startOpenCodeOnce = async () => {
    const desiredPort = env.ENV_CONFIGURED_OPENCODE_PORT ?? 0;
    const spawnPort = await resolveManagedOpenCodePort(desiredPort, env.ENV_CONFIGURED_OPENCODE_HOSTNAME);
    console.log(
      desiredPort > 0
        ? `Starting OpenCode on requested port ${desiredPort}...`
        : `Starting OpenCode on allocated port ${spawnPort}...`
    );

    const managedLaunch = await buildManagedOpenCodeSpawnEnv({ rotatePassword: true });
    const shellEnv = typeof getManagedOpenCodeShellEnvSnapshot === 'function'
      ? getManagedOpenCodeShellEnvSnapshot() || {}
      : {};

    let serverInstance = null;
    let startupSucceeded = false;
    try {
      serverInstance = await createManagedOpenCodeServerProcess({
        hostname: env.ENV_CONFIGURED_OPENCODE_HOSTNAME,
        port: spawnPort,
        timeout: 30000,
        cwd: state.openCodeWorkingDirectory,
        shellEnvKeysCount: Object.keys(shellEnv).length,
        env: managedLaunch.env,
        startupSecretLease: managedLaunch.startupSecretLease,
      });

      if (!serverInstance || !serverInstance.url) {
        throw new Error('OpenCode server started but URL is missing');
      }

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
      console.error(`Failed to start OpenCode: ${message}`);
      throw safeError;
    }
  };

  const startOpenCode = async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= START_OPEN_CODE_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await startOpenCodeOnce();
      } catch (error) {
        const safeError = sanitizeManagedStartupError(error);
        lastError = safeError;
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
    if (!canUseGuardian) {
      throw new Error('Guardian launch requires a stable OpenChamber owner identity');
    }
    const client = createGuardianClient({ connectTimeoutMs: 5000 });
    let successor = null;
    let successorOwner = null;
    let launch = null;
    let connected = false;

    try {
      await client.connect();
      connected = true;
      const desiredPort = env.ENV_CONFIGURED_OPENCODE_PORT ?? 0;
      const spawnPort = await resolveManagedOpenCodePort(desiredPort, env.ENV_CONFIGURED_OPENCODE_HOSTNAME);
      launch = await buildManagedOpenCodeSpawnEnv({ rotatePassword: true });
      const guardianLaunch = createGuardianLaunch({
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
      let cleanupUncertain = false;
      if (successor?.incarnation) {
        try {
          await client.stop(withOwner(
            { incarnation: successor.incarnation },
            hasCompleteOwnerIdentity(successor.owner) ? successor.owner : successorOwner,
          ));
          if (!(await verifyGuardianChildGone(client, { incarnation: successor.incarnation }))) {
            cleanupUncertain = true;
          }
        } catch {
          cleanupUncertain = true;
        }
      } else if (successorOwner) {
        try {
          const liveSuccessor = await findLiveGuardianSuccessor(client, successorOwner);
          if (liveSuccessor?.incarnation) {
            await client.stop(withOwner({ incarnation: liveSuccessor.incarnation }, successorOwner));
            if (!(await verifyGuardianChildGone(client, { incarnation: liveSuccessor.incarnation }))) {
              cleanupUncertain = true;
            }
          }
        } catch {
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
        cleanupError.code = 'GUARDIAN_CLEANUP_UNCERTAIN';
        throw cleanupError;
      }
      releaseManagedStartupSecretLease(launch?.startupSecretLease);
      throw error;
    }
  };

  const restartOpenCode = async () => {
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

      if (state.isExternalOpenCode) {
        console.log('Re-probing external OpenCode server...');
        const probePort = state.openCodePort || env.ENV_CONFIGURED_OPENCODE_PORT || 4096;
        const probeOrigin = state.openCodeBaseUrl ?? env.ENV_CONFIGURED_OPENCODE_HOST?.origin;
        const healthy = await probeExternalOpenCode(probePort, probeOrigin);
        if (healthy) {
          console.log(`External OpenCode server on port ${probePort} is healthy`);
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
      if (handoffEnabled && canUseGuardian) {
        const guardianRunning = await probeGuardianRunning();

        if (guardianRunning) {
          guardianRunningObserved = true;
          const socketPath = getGuardianSocket();
          const portPath = getWindowsPortPath();
          let adoptedGuardianClient = null;

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

          try {
            await client.connect();
            const newPort = fixedPort
              ? env.ENV_CONFIGURED_OPENCODE_PORT
              : await resolveManagedOpenCodePort(0, env.ENV_CONFIGURED_OPENCODE_HOSTNAME);

            // Fence the old record before either handoff ordering. The
            // fixed-port path must stop and release the old listener before
            // spawning its successor; dynamic ports can start the successor
            // first and keep the cutover fast.
            await client.prepareHandoff(withOwner({ incarnation: previousIncarnation }, previousOwner));
            prepared = true;

            if (typeof captureOpenCodeAuthState === 'function') {
              const restore = captureOpenCodeAuthState();
              restoreOpenCodeAuthState = typeof restore === 'function' ? restore : null;
            }
            launch = await buildManagedOpenCodeSpawnEnv({ rotatePassword: true });
            const guardianLaunch = createGuardianLaunch({
              binary: launch.binary,
              args: launch.args,
              hostname: env.ENV_CONFIGURED_OPENCODE_HOSTNAME,
              port: newPort,
              cwd: state.openCodeWorkingDirectory,
            });
            successorOwner = guardianLaunch.owner;

            if (fixedPort) {
              await client.stop(withOwner({ incarnation: previousIncarnation }, previousOwner));
              if (!(await verifyGuardianChildGone(client, { incarnation: previousIncarnation }))) {
                throw Object.assign(
                  new Error(`Guardian previous child ${previousIncarnation} cleanup was not confirmed`),
                  { code: 'GUARDIAN_CLEANUP_UNCERTAIN' },
                );
              }
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

            successor = await client.spawn({
              port: newPort,
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
              throw new Error('Guardian successor failed health check');
            }
            await waitForGuardianReady({
              client,
              incarnation: successor.incarnation,
              owner: activeOwner,
              timeoutMs: 10_000,
            });

            if (!fixedPort) {
              await client.stop(withOwner({ incarnation: previousIncarnation }, previousOwner));
              if (!(await verifyGuardianChildGone(client, { incarnation: previousIncarnation }))) {
                throw Object.assign(
                  new Error(`Guardian previous child ${previousIncarnation} cleanup was not confirmed`),
                  { code: 'GUARDIAN_CLEANUP_UNCERTAIN' },
                );
              }
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
            let cleanupUncertain = error?.code === 'GUARDIAN_CHILD_IDENTITY_INVALID';

            if (successor?.incarnation && !successorStopped) {
              try {
                await client.stop(withOwner(
                  { incarnation: successor.incarnation },
                  hasCompleteOwnerIdentity(successor.owner) ? successor.owner : successorOwner,
                ));
                successorStopped = await verifyGuardianChildGone(client, {
                  incarnation: successor.incarnation,
                });
                if (!successorStopped) {
                  cleanupUncertain = true;
                } else {
                  releaseManagedStartupSecretLease(launch?.startupSecretLease);
                }
              } catch {
                cleanupUncertain = true;
              }
            } else if (!successor?.incarnation) {
              try {
                const liveSuccessor = await findLiveGuardianSuccessor(client, successorOwner);
                if (liveSuccessor?.incarnation) {
                  await client.stop(withOwner({ incarnation: liveSuccessor.incarnation }, successorOwner));
                  if (!(await verifyGuardianChildGone(client, { incarnation: liveSuccessor.incarnation }))) {
                    cleanupUncertain = true;
                  } else {
                    releaseManagedStartupSecretLease(launch?.startupSecretLease);
                  }
                }
              } catch {
                cleanupUncertain = true;
              }
            }

            // A prepared handoff can fall back only after an old child that
            // was not confirmed stopped is explicitly returned to active and
            // health-checked. This includes the dynamic ordering where the
            // successor is launched before the old stop attempt: a rejected
            // old stop is not proof that the old child is gone.
            let oldRollbackConfirmed = false;
            if (prepared && !oldStopped) {
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

            const retainGuardianClientForFallback = oldRollbackConfirmed
              && state.openCodeProcess?.isGuardianManaged === true;
            if (!retainGuardianClientForFallback && !(await disconnectGuardianClient(client))) {
              cleanupUncertain = true;
            }

            if (cleanupUncertain) {
              throw new Error(`Guardian handoff failed without a confirmed rollback: ${error?.message || String(error)}`);
            }

            console.log('[lifecycle] guardian handoff failed, falling back to legacy restart:', error.message);
          }
        }
      }
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
      state.openCodeProcess = await startOpenCode();
      state.currentIncarnation = null;
      state.currentOwner = null;
      syncToHmrState();

      if (state.expressApp) {
        setupProxy(state.expressApp);
        ensureOpenCodeApiPrefix();
      }
    })();

    try {
      await state.currentRestartPromise;
    } catch (error) {
      const safeError = sanitizeManagedStartupError(error);
      console.error(`Failed to restart OpenCode: ${safeError.message}`);
      state.lastOpenCodeError = safeError.message;
      if (!env.ENV_CONFIGURED_OPENCODE_PORT) {
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

    await restartOpenCode();

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
    try {
      // Before doing anything, reap any OpenCode process WE spawned in a prior
      // run that was orphaned by a crash/hard-exit. Verified + scoped to our own
      // pids, so it never touches a live instance's or the user's own server.
      try {
        const { reaped } = await reapOrphanedProcesses({ log: (msg) => console.log(msg) });
        if (reaped > 0) console.log(`[lifecycle] startup reaped ${reaped} orphaned OpenCode process(es)`);
      } catch (error) {
        console.warn('[lifecycle] orphan reap failed:', error?.message ?? error);
      }

      syncFromHmrState();
      if (await isOpenCodeProcessHealthy()) {
        console.log(`[HMR] Reusing existing OpenCode process on port ${state.openCodePort}`);
      } else {
        resetSessionRuntimeForOpenCodeReplacement();
        state.openCodeProcess = null;
        state.currentIncarnation = null;
        state.currentOwner = null;
        // W-C: previously this branch was gated `else if (process.platform
        // !== 'win32')` and the Windows path was duplicated below. The
        // platform gate is removed; `detectAndAdoptGuardianChild()` now
        // works on both platforms (loopback TCP via `portPath` on
        // Windows; Unix-domain socket via `socketPath` on Linux). The
        // post-adoption cascade (skip-start, external probe, fresh
        // spawn) is the same on every platform.
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
        } else if (env.ENV_SKIP_OPENCODE_START && env.ENV_EFFECTIVE_PORT) {
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
              guardianFailure.code = safeError?.code === 'GUARDIAN_CLEANUP_UNCERTAIN'
                ? safeError.code
                : 'GUARDIAN_LIVE_START_FAILED';
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
      await waitForOpenCodePort();
      try {
      await waitForOpenCodeReady();
      } catch (error) {
        console.error(`OpenCode readiness check failed: ${redactManagedStartupDiagnostic(error?.message || String(error))}`);
      }
    } catch (error) {
      if (
        error?.code === 'GUARDIAN_CLEANUP_UNCERTAIN'
        || error?.code === 'OPENCODE_CHILD_STILL_RUNNING'
      ) {
        throw sanitizeManagedStartupError(error);
      }
      const safeError = sanitizeManagedStartupError(error);
      console.error(`Failed to start OpenCode: ${safeError.message}`);
      console.log('Continuing without OpenCode integration...');
      state.lastOpenCodeError = safeError.message;
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
      return lastHealthProbeResult.healthy;
    }

    if (healthProbePromise) {
      return healthProbePromise;
    }

    healthProbePromise = isOpenCodeProcessHealthy()
      .then((healthy) => {
        lastHealthProbeResult = { at: now(), healthy };
        return healthy;
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
      return false;
    }

    const checkedAt = now();
    if (!lastUnhealthyWithBusySessionsAt) {
      lastUnhealthyWithBusySessionsAt = checkedAt;
      return true;
    }

    if (checkedAt - lastUnhealthyWithBusySessionsAt >= STALE_BUSY_GRACE_MS) {
      console.warn(
        `[lifecycle] OpenCode unhealthy with ${activeCount} busy session(s) for > 2 min — forcing restart`
      );
      lastUnhealthyWithBusySessionsAt = 0;
      return false;
    }

    return true;
  };

  const runHealthCheckCycle = async (source) => {
    if (!state.openCodeProcess || state.isShuttingDown || state.isRestartingOpenCode) return;
    if (healthCheckCyclePromise) return healthCheckCyclePromise;

    healthCheckCyclePromise = (async () => {
      const healthy = await probeOpenCodeHealth();
      if (!healthy) {
        if (!isManagedOpenCodeProcessAlive()) {
          console.log(`[lifecycle] ${source} health check: OpenCode process exited, restarting...`);
          consecutiveHealthFailures = 0;
          lastHealthProbeResult = null;
          await restartOpenCode();
          return;
        }
        const checkedAt = now();
        if (lastCountedHealthFailureAt && checkedAt - lastCountedHealthFailureAt < healthFailureCountIntervalMs) {
          return;
        }
        lastCountedHealthFailureAt = checkedAt;
        consecutiveHealthFailures += 1;
        console.warn(
          `[lifecycle] ${source} health check failed (${consecutiveHealthFailures}/${HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES})`
        );
        if (consecutiveHealthFailures < HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES) return;
        if (shouldSkipRestartForBusySessions()) return;
        console.log(`[lifecycle] ${source} health check failure threshold reached, restarting OpenCode...`);
        consecutiveHealthFailures = 0;
        lastHealthProbeResult = null;
        await restartOpenCode();
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
  return runtime;
};

// Kept separate from the lifecycle runtime surface so tests can exercise the
// streaming redaction contract without observing it only after diagnostic
// formatting has already joined multiple child-process emissions.
export const __test__ = {
  createManagedStartupOutputFormatter,
  createManagedStartupCapture,
  MANAGED_STARTUP_CAPTURE_LIMIT,
};
