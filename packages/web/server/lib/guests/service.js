import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import {
  GUEST_REQUEST_RESPONSE_MAX,
  GUEST_REQUEST_TIMEOUT_MS,
  isGuestRequestPath,
} from '@openchamber/sdk';

import { readExtensionStore, updateExtensionStore } from './persist.js';
import { resolveServiceSocketEnv } from './sockets.js';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const SERVICE_READY_TIMEOUT_MS = 15_000;
const SERVICE_KILL_TIMEOUT_MS = 5_000;
const SERVICE_HEALTH_PATH = '/health';
/** Inbound auth header the service must require. */
const OPENCHAMBER_SERVICE_AUTH_HEADER = 'authorization';

/**
 * @typedef {{
 *   child: import('node:child_process').ChildProcess,
 *   port: number,
 *   token: string,
 *   status: 'starting' | 'ready' | 'failed' | 'stopped',
 *   packageRoot: string,
 *   entry: string,
 * }} ServiceRuntime
 */

/** @type {Map<string, ServiceRuntime>} */
const runtimes = new Map();

/** @type {Map<string, Promise<ServiceRuntime>>} */
const startingByGuest = new Map();

/** @type {Map<string, Promise<void>>} */
const stoppingByGuest = new Map();

// Requests retain their lifecycle object across awaits. A later host start
// cannot reopen admission for work that belonged to the previous host.
let hostLifecycle = { accepting: true };

export const beginGuestServiceHost = () => {
  if (runtimes.size || startingByGuest.size || stoppingByGuest.size) {
    throw new Error('Guest services must finish stopping before a new host starts.');
  }
  hostLifecycle.accepting = false;
  hostLifecycle = { accepting: true };
};

export const beginGuestServiceShutdown = () => {
  hostLifecycle.accepting = false;
};

const assertGuestHostActive = (lifecycle) => {
  if (!lifecycle.accepting) {
    throw new GuestServiceError('The host is shutting down.', 'NO_SERVICE');
  }
};

export class GuestServiceError extends Error {
  /**
   * @param {string} message
   * @param {'NO_SERVICE' | 'SERVICE_FAILED' | 'REQUEST_FAILED' | 'BAD_PATH' | 'BAD_METHOD' | 'DISABLED' | 'CANCELLED'} code
   * `SERVICE_FAILED` is a service that never became ready: nothing was sent
   * to it. `REQUEST_FAILED` is a request that was sent and got no usable
   * answer (timeout, dropped connection, unreadable body): the service may
   * have acted on it.
   */
  constructor(message, code) {
    super(message);
    this.name = 'GuestServiceError';
    this.code = code;
  }
}

const reserveLoopbackPort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || !('port' in address)) {
      server.close();
      reject(new Error('Could not reserve a loopback port'));
      return;
    }
    const { port } = address;
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(port);
    });
  });
  server.on('error', reject);
});

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * @param {number} port
 * @param {string} token
 */
const waitForServiceReady = async (port, token, shouldStop = () => false) => {
  const deadline = Date.now() + SERVICE_READY_TIMEOUT_MS;
  while (Date.now() < deadline && !shouldStop()) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${SERVICE_HEALTH_PATH}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          [OPENCHAMBER_SERVICE_AUTH_HEADER]: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(1_500),
      });
      if (response.status === 200) {
        return true;
      }
    } catch {
      // keep polling
    }
    await sleep(200);
  }
  return false;
};

/**
 * @param {string} guestId
 * @param {string} persistPath
 */
/**
 * @param {string} guestId
 * @param {string} persistPath
 * @param {boolean} enabled
 */
export const setGuestEnabled = async (guestId, persistPath, enabled) => {
  await updateExtensionStore(persistPath, (store) => {
    const disabledGuests = { ...(store.disabledGuests ?? {}) };
    if (enabled) {
      delete disabledGuests[guestId];
    } else {
      disabledGuests[guestId] = true;
    }
    return { ...store, disabledGuests };
  });
  if (!enabled) {
    await stopGuestService(guestId);
  }
};

/**
 * @param {string} guestId
 * @param {string} socketId
 * @param {string} persistPath
 * @param {string | null} socketPath empty/null clears the override
 */
export const setServiceSocketOverride = async (guestId, socketId, persistPath, socketPath) => {
  await updateExtensionStore(persistPath, (store) => {
    const serviceSocketOverrides = { ...(store.serviceSocketOverrides ?? {}) };
    const forGuest = { ...(serviceSocketOverrides[guestId] ?? {}) };
    const trimmed = typeof socketPath === 'string' ? socketPath.trim() : '';
    if (trimmed) {
      forGuest[socketId] = trimmed;
    } else {
      delete forGuest[socketId];
    }
    if (Object.keys(forGuest).length > 0) {
      serviceSocketOverrides[guestId] = forGuest;
    } else {
      delete serviceSocketOverrides[guestId];
    }
    return { ...store, serviceSocketOverrides };
  });
  await stopGuestService(guestId);
};

/**
 * @param {string} guestId
 */
export const getServiceStatus = (guestId) => {
  const runtime = runtimes.get(guestId);
  if (!runtime) {
    return 'stopped';
  }
  return runtime.status;
};

/**
 * @param {string} guestId
 */
/**
 * Bumped by every stop. A start that began before the bump is cancelled: it
 * checks the epoch after each await and kills whatever it spawned, so Pause
 * during the seconds before the process is registered still stops it.
 * @type {Map<string, number>}
 */
const stopEpochs = new Map();

const stopEpochOf = (guestId) => stopEpochs.get(guestId) ?? 0;

/**
 * Services the host starts on its own (a provider role) have no panel whose
 * closing would end them, so they end themselves: a request arms a timer, the
 * next request re-arms it, and when it fires with nothing in flight the
 * process goes away. The next request starts it again. A panel-driven service
 * passes no `idleStopMs` and keeps today's lifetime.
 * @type {Map<string, { timer: ReturnType<typeof setTimeout>, inflight: number, idleMs: number }>}
 */
const idleStops = new Map();

const clearIdleStop = (guestId) => {
  const entry = idleStops.get(guestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  idleStops.delete(guestId);
};

/** Long-lived consumers (a surface viewer) that keep an idle-stopping service up. */
const holds = new Map();

const armIdleStop = (guestId, idleMs) => {
  const previous = idleStops.get(guestId);
  const inflight = previous?.inflight ?? 0;
  if (previous) clearTimeout(previous.timer);
  const timer = setTimeout(() => {
    const current = idleStops.get(guestId);
    if (!current || current.inflight > 0 || (holds.get(guestId) ?? 0) > 0) {
      // A request is running or a viewer is attached; whichever ends last
      // re-arms the timer.
      return;
    }
    idleStops.delete(guestId);
    void discardRuntime(guestId);
  }, idleMs);
  timer.unref?.();
  idleStops.set(guestId, { timer, inflight, idleMs });
};

/**
 * Keeps an idle-stopping service alive while the returned release function
 * has not been called. Releasing the last hold restarts the idle window.
 * @param {string} guestId
 */
export const holdGuestService = (guestId) => {
  holds.set(guestId, (holds.get(guestId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (holds.get(guestId) ?? 1) - 1;
    if (remaining > 0) {
      holds.set(guestId, remaining);
      return;
    }
    holds.delete(guestId);
    const entry = idleStops.get(guestId);
    if (entry && runtimes.get(guestId)) armIdleStop(guestId, entry.idleMs);
  };
};

const trackInflight = (guestId, delta) => {
  const entry = idleStops.get(guestId);
  if (!entry) return;
  entry.inflight = Math.max(0, entry.inflight + delta);
};

/**
 * A user-facing stop (Pause, Remove, withdrawn approval, socket change,
 * host quit): ends the process and cancels any request or start in flight.
 * @param {string} guestId
 */
export const stopGuestService = async (guestId) => {
  stopEpochs.set(guestId, stopEpochOf(guestId) + 1);
  clearIdleStop(guestId);
  await discardRuntime(guestId);
};

/**
 * Internal cleanup of a runtime that is dead or failed, before a restart.
 * Does not bump the epoch: replacing a crashed process is not a Pause and
 * must not cancel the request that triggered the restart.
 * @param {string} guestId
 */
const discardRuntime = async (guestId) => {
  const stopping = stoppingByGuest.get(guestId);
  if (stopping) return stopping;
  const runtime = runtimes.get(guestId);
  if (!runtime) {
    return;
  }
  runtimes.delete(guestId);
  runtime.status = 'stopped';
  const { child } = runtime;
  if (child.exitCode !== null || child.signalCode) {
    return;
  }
  const stopped = new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(undefined);
    }, SERVICE_KILL_TIMEOUT_MS);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.kill('SIGTERM');
  });
  stoppingByGuest.set(guestId, stopped);
  try {
    await stopped;
  } finally {
    stoppingByGuest.delete(guestId);
  }
};

/** Test seam: the pid of a guest's running service, or `null`. */
export const readServicePid = (guestId) => runtimes.get(guestId)?.child.pid ?? null;

export const stopAllGuestServices = async () => {
  const starts = [...startingByGuest.values()];
  const ids = new Set([...runtimes.keys(), ...startingByGuest.keys(), ...stoppingByGuest.keys()]);
  const stops = [...ids].map((id) => stopGuestService(id));
  // Cancelled starts reject normally. Await their cleanup as well as children
  // already registered when shutdown began.
  await Promise.allSettled([...starts, ...stops]);
};

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} maxChars
 */
const collectProcessOutput = (child, maxChars = 2_000) => {
  let stdout = '';
  let stderr = '';
  const append = (/** @type {'stdout' | 'stderr'} */ stream, chunk) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (stream === 'stdout') {
      stdout = `${stdout}${text}`.slice(-maxChars);
      return;
    }
    stderr = `${stderr}${text}`.slice(-maxChars);
  };
  child.stdout?.on('data', (chunk) => append('stdout', chunk));
  child.stderr?.on('data', (chunk) => append('stderr', chunk));
  return {
    snapshot: () => {
      const out = stdout.trim();
      const err = stderr.trim();
      if (err && out) return `${err}\n${out}`;
      return err || out;
    },
  };
};

/**
 * @param {{
 *   guestId: string,
 *   packageRoot: string,
 *   entry: string,
 *   socketBindings?: Array<{ id: string, candidatesByPlatform?: Partial<Record<'linux' | 'darwin' | 'win32', string[]>> }>,
 *   socketOverrides?: Record<string, string>,
 * }} params
 */
const startGuestService = async ({
  guestId,
  packageRoot,
  entry,
  socketBindings = [],
  socketOverrides = {},
  epoch,
  lifecycle,
}) => {
  assertGuestHostActive(lifecycle);
  // A replacement must not occupy the same guest slot while its previous
  // child is still stopping; host shutdown must be able to drain both.
  const previousStop = stoppingByGuest.get(guestId);
  if (previousStop) await previousStop;
  assertGuestHostActive(lifecycle);
  const existing = runtimes.get(guestId);
  if (existing?.status === 'ready' && existing.child.exitCode === null && !existing.child.signalCode) {
    return existing;
  }
  if (existing) {
    await discardRuntime(guestId);
  }
  // The request's epoch, read before its first store access: a Pause that
  // finished anywhere since then is a cancellation, spawn included.
  const cancelled = () => !lifecycle.accepting || stopEpochOf(guestId) !== epoch;
  const stoppedError = () => new GuestServiceError('The service was stopped before it became ready.', 'NO_SERVICE');

  const absoluteEntry = path.resolve(packageRoot, entry);
  const rootResolved = path.resolve(packageRoot);
  if (!absoluteEntry.startsWith(`${rootResolved}${path.sep}`)) {
    throw new GuestServiceError('Service entry must stay inside the package.', 'NO_SERVICE');
  }
  try {
    await fs.access(absoluteEntry);
  } catch {
    throw new GuestServiceError('Service entry is missing.', 'NO_SERVICE');
  }

  if (cancelled()) {
    throw stoppedError();
  }
  const port = await reserveLoopbackPort();
  if (cancelled()) throw stoppedError();
  const token = crypto.randomBytes(24).toString('hex');
  const socketEnv = socketBindings.length > 0
    ? await resolveServiceSocketEnv(socketBindings, socketOverrides)
    : {};
  if (cancelled()) {
    throw stoppedError();
  }
  const env = {
    ...inheritedServiceEnv(process.env),
    OPENCHAMBER_SERVICE_PORT: String(port),
    OPENCHAMBER_SERVICE_TOKEN: token,
    ELECTRON_RUN_AS_NODE: '1',
  };
  if (Object.keys(socketEnv).length > 0) {
    env.OPENCHAMBER_SERVICE_SOCKETS = JSON.stringify(socketEnv);
  }
  if (cancelled()) {
    throw stoppedError();
  }
  const child = spawn(process.execPath, [absoluteEntry], {
    cwd: packageRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = collectProcessOutput(child);

  /** @type {ServiceRuntime} */
  const runtime = {
    child,
    port,
    token,
    status: 'starting',
    packageRoot,
    entry,
  };
  runtimes.set(guestId, runtime);

  child.once('exit', () => {
    const current = runtimes.get(guestId);
    if (current === runtime) {
      runtime.status = runtime.status === 'starting' ? 'failed' : 'stopped';
    }
  });

  const ready = await waitForServiceReady(port, token, () => cancelled() || child.exitCode !== null || Boolean(child.signalCode));
  if (cancelled()) {
    // Pause landed while the process was coming up; stopGuestService found
    // this runtime (registered above) and is killing it, or already did.
    if (runtimes.get(guestId) === runtime) {
      await discardRuntime(guestId);
    }
    throw stoppedError();
  }
  if (!ready || child.exitCode !== null || child.signalCode) {
    runtime.status = 'failed';
    const detail = output.snapshot();
    await discardRuntime(guestId);
    throw new GuestServiceError(
      detail
        ? `Guest service failed to become ready. ${detail}`
        : 'Guest service failed to become ready.',
      'SERVICE_FAILED',
    );
  }
  runtime.status = 'ready';
  return runtime;
};

/**
 * One spawn in flight per guest. Parallel panel requests must not kill each other.
 * @param {{
 *   guestId: string,
 *   packageRoot: string,
 *   entry: string,
 *   socketBindings?: Array<{ id: string, candidatesByPlatform?: Partial<Record<'linux' | 'darwin' | 'win32', string[]>> }>,
 *   socketOverrides?: Record<string, string>,
 * }} params
 */
/**
 * Environment variables a guest service may inherit from the host process.
 * The host env also carries the UI password, tool tokens, and whatever API
 * keys the user exported; a third-party process gets none of that, only what
 * a locale-aware Node process needs to find its tools and temp dir.
 */
const INHERITED_SERVICE_ENV_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'TZ',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'WINDIR',
]);

/** @param {NodeJS.ProcessEnv} source */
export const inheritedServiceEnv = (source) => {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === 'string' && INHERITED_SERVICE_ENV_NAMES.has(name.toUpperCase())) {
      env[name] = value;
    }
  }
  return env;
};

const ensureGuestService = async (params) => {
  const existing = runtimes.get(params.guestId);
  if (existing?.status === 'ready' && existing.child.exitCode === null && !existing.child.signalCode) {
    return existing;
  }
  const inflight = startingByGuest.get(params.guestId);
  if (inflight) {
    return inflight;
  }
  const pending = startGuestService(params).finally(() => {
    if (startingByGuest.get(params.guestId) === pending) {
      startingByGuest.delete(params.guestId);
    }
  });
  startingByGuest.set(params.guestId, pending);
  return pending;
};

/**
 * Starts the guest's service if needed and sends it one HTTP request, giving
 * back the raw `Response`. This is the one place a host-driven caller (a
 * provider role, a shared surface) or a panel proxy talks to the loopback:
 * the enabled check, the grant, the spawn, the epoch, and the bearer live
 * here. The caller reads the body as it needs it (text, JSON, image bytes).
 *
 * @param {{
 *   guestId: string,
 *   guestName?: string,
 *   packageRoot: string,
 *   service: { entry: string, permissions?: { sockets?: Array<{ id: string, candidatesByPlatform?: Partial<Record<'linux' | 'darwin' | 'win32', string[]>> }>, exec?: string[] } },
 *   granted: string[],
 *   persistPath: string,
 *   method: string,
 *   path: string,
 *   query?: Record<string, string>,
 *   body?: string,
 *   accept?: string,
 *   headers?: Record<string, string>,
 *   timeoutMs?: number,
 *   idleStopMs?: number,
 *   signal?: AbortSignal,
 * }} params `timeoutMs` and `idleStopMs` are for host-driven calls; a
 * panel's `serviceRequest` keeps the SDK limits. With `idleStopMs` the
 * service stops itself after that long without a request; `holdGuestService`
 * suspends that while a long-lived consumer (a surface viewer) is attached.
 */
export const openGuestServiceRequest = async ({
  guestId,
  guestName,
  packageRoot,
  service,
  granted,
  persistPath,
  method,
  path: requestPath,
  query,
  body,
  accept = 'application/json',
  headers: extraHeaders,
  timeoutMs = GUEST_REQUEST_TIMEOUT_MS,
  idleStopMs,
  signal,
}) => {
  const lifecycle = hostLifecycle;
  assertGuestHostActive(lifecycle);
  if (!METHODS.has(method)) {
    throw new GuestServiceError('Unsupported request method.', 'BAD_METHOD');
  }
  if (!isGuestRequestPath(requestPath)) {
    throw new GuestServiceError('Request path must stay on the service.', 'BAD_PATH');
  }
  // A Pause that lands anywhere between here and the proxied call bumps
  // this; the request then ends with NO_SERVICE instead of using the
  // enabled flag it read before the pause.
  const epoch = stopEpochOf(guestId);
  const store = await readExtensionStore(persistPath);
  assertGuestHostActive(lifecycle);
  if (store.disabledGuests?.[guestId]) {
    const label = typeof guestName === 'string' && guestName.trim() ? guestName.trim() : 'This extension';
    throw new GuestServiceError(
      `${label} is disabled in Settings → Extensions.`,
      'DISABLED',
    );
  }
  // Every service is a third-party process running as the user. Declared
  // permissions describe what it intends to touch; they do not confine it, so
  // the grant is required whether or not the manifest declared any.
  // `granted` is the catalog's effective list: it already drops `service`
  // when the package's permissions changed after the user approved them.
  if (!Array.isArray(granted) || !granted.includes('service')) {
    throw new GuestServiceError('Allow this extension\'s local service in Settings → Extensions.', 'NO_SERVICE');
  }

  const socketOverrides = store.serviceSocketOverrides?.[guestId] ?? {};
  const socketBindings = service.permissions?.sockets ?? [];

  let runtime = runtimes.get(guestId);
  if (!runtime || runtime.status !== 'ready' || runtime.child.exitCode !== null || runtime.child.signalCode) {
    runtime = await ensureGuestService({
      guestId,
      packageRoot,
      entry: service.entry,
      socketBindings,
      socketOverrides,
      epoch,
      lifecycle,
    });
  }
  if (!lifecycle.accepting || stopEpochOf(guestId) !== epoch) {
    if (runtimes.get(guestId) === runtime) {
      await discardRuntime(guestId);
    }
    throw new GuestServiceError('The service was stopped before the request could run.', 'NO_SERVICE');
  }

  let url;
  try {
    url = new URL(requestPath, `http://127.0.0.1:${runtime.port}/`);
  } catch {
    throw new GuestServiceError('Request path must stay on the service.', 'BAD_PATH');
  }
  if (url.hostname !== '127.0.0.1' || url.port !== String(runtime.port)) {
    throw new GuestServiceError('Request path must stay on the service.', 'BAD_PATH');
  }
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }

  /** @type {Record<string, string>} */
  const headers = {
    // Host-set context (surface viewer headers) first: nothing in it can
    // replace the bearer or the content type below.
    ...extraHeaders,
    Accept: accept,
    [OPENCHAMBER_SERVICE_AUTH_HEADER]: `Bearer ${runtime.token}`,
  };
  if (body !== undefined && method !== 'GET') {
    headers['Content-Type'] = 'application/json';
  }

  if (idleStopMs) {
    armIdleStop(guestId, idleStopMs);
    trackInflight(guestId, 1);
  }
  const settleIdle = () => {
    if (!idleStopMs) return;
    trackInflight(guestId, -1);
    // Measured from the end of the last request, not its start: a long
    // action must not be cut short by a timer armed before it began.
    if (runtimes.get(guestId) === runtime) armIdleStop(guestId, idleStopMs);
  };
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || body === undefined ? undefined : body,
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  } catch {
    settleIdle();
    if (signal?.aborted) {
      throw new GuestServiceError('The request was cancelled.', 'CANCELLED');
    }
    runtime.status = 'failed';
    throw new GuestServiceError('Guest service request failed.', 'REQUEST_FAILED');
  }
  // The body is still streaming when we return; the idle window starts once
  // the caller has read it (or dropped it), which is what `finished` marks.
  return {
    response,
    finished: settleIdle,
  };
};

/**
 * Panel-shaped proxy: text answer, capped. Same params as
 * `openGuestServiceRequest` plus `responseMax`.
 */
export const proxyGuestServiceRequest = async ({ responseMax = GUEST_REQUEST_RESPONSE_MAX, ...params }) => {
  const { response, finished } = await openGuestServiceRequest(params);
  let text;
  try {
    text = await response.text();
  } catch {
    finished();
    if (params.signal?.aborted) {
      throw new GuestServiceError('The request was cancelled.', 'CANCELLED');
    }
    const runtime = runtimes.get(params.guestId);
    if (runtime) runtime.status = 'failed';
    throw new GuestServiceError('Guest service request failed.', 'REQUEST_FAILED');
  }
  finished();
  return {
    status: response.status,
    body: text.length <= responseMax
      ? text
      : text.slice(0, responseMax),
  };
};
