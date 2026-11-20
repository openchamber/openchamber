import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import {
  GUEST_REQUEST_RESPONSE_MAX,
  GUEST_REQUEST_TIMEOUT_MS,
  OPENCHAMBER_HOST_CALLBACK_URL,
  OPENCHAMBER_SERVICE_DATA_DIR,
  isGuestRequestPath,
  serviceProvides,
} from '@openchamber/sdk';

import { isGuestPackageUnloaded } from './catalog.js';
import { hostCallbackUrl } from './host-callback.js';
import { readExtensionStore, updateExtensionStore } from './persist.js';
import { readBoundedResponseText } from './response-body.js';
import {
  SERVICE_TOKEN_ENV,
  reapOrphanedGuestServices,
  recordGuestService,
  releaseGuestService,
} from './service-registry.js';
import { resolveServiceSocketEnv } from './sockets.js';
import { guestDataDir } from './storage.js';
import type { ChildProcess } from 'node:child_process';
import type { ServiceContribution } from '@openchamber/sdk';
import type { createGuestOpenCodeProvider } from './opencode-provider/index.js';
import { hasErrorMessage, isString } from './input-guards.js';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const SERVICE_READY_TIMEOUT_MS = 15_000;
const SERVICE_KILL_TIMEOUT_MS = 5_000;
const SERVICE_HEALTH_PATH = '/health';
const OPENCHAMBER_SERVICE_AUTH_HEADER = 'authorization';
type ServiceHeaders = { Accept: string; authorization: string; 'Content-Type'?: string };

type ServiceRuntime = {
  child: ChildProcess;
  port: number;
  token: string;
  status: 'starting' | 'ready' | 'failed' | 'stopped';
  packageRoot: string;
  entry: string;
  released: Promise<void>;
};
type HostLifecycle = {
  accepting: boolean;
  registryDir: string | null;
  orphansReaped: Promise<void | Awaited<ReturnType<typeof reapOrphanedGuestServices>>>;
};
type ServiceStart = {
  guestId: string;
  packageRoot: string;
  entry: string;
  socketBindings?: NonNullable<NonNullable<ServiceContribution['permissions']>['sockets']>;
  socketOverrides?: Record<string, string>;
  dataDir: string;
  openCode?: boolean;
  epoch: number;
  lifecycle: HostLifecycle;
};
export type GuestServiceRequest = {
  guestId: string;
  guestName?: string | undefined;
  packageRoot: string;
  service: ServiceContribution | undefined;
  granted: string[] | undefined;
  persistPath: string;
  method: string;
  path: string;
  query?: Record<string, string> | undefined;
  body?: string | undefined;
  accept?: string;
  headers?: Record<string, string> | undefined;
  timeoutMs?: number;
  idleStopMs?: number | undefined;
  signal?: AbortSignal | undefined;
};
const runtimes = new Map<string, ServiceRuntime>();
const startingByGuest = new Map<string, Promise<ServiceRuntime>>();
const stoppingByGuest = new Map<string, Promise<void>>();

let hostLifecycle: HostLifecycle = { accepting: true, registryDir: null, orphansReaped: Promise.resolve() };
let openCodeProvider: ReturnType<typeof createGuestOpenCodeProvider> | null = null;

export const configureGuestOpenCodeProvider = (provider: ReturnType<typeof createGuestOpenCodeProvider>) => {
  if (openCodeProvider) throw new Error('Stop the previous OpenCode provider before replacing it.');
  openCodeProvider = provider;
};

export const beginGuestServiceHost = ({ registryDir = null }: { registryDir?: string | null } = {}) => {
  if (runtimes.size || startingByGuest.size || stoppingByGuest.size) {
    throw new Error('Guest services must finish stopping before a new host starts.');
  }
  hostLifecycle.accepting = false;
  hostLifecycle = {
    accepting: true,
    registryDir,
    orphansReaped: registryDir
      ? reapOrphanedGuestServices(registryDir, { log: (message) => console.log(message) })
      : Promise.resolve(),
  };
};

export const beginGuestServiceShutdown = () => {
  hostLifecycle.accepting = false;
  openCodeProvider?.revokeAll();
};

const assertGuestHostActive = (lifecycle: HostLifecycle) => {
  if (!lifecycle.accepting) {
    throw new GuestServiceError('The host is shutting down.', 'NO_SERVICE');
  }
};

export class GuestServiceError extends Error {
  code: 'NO_SERVICE' | 'SERVICE_FAILED' | 'REQUEST_FAILED' | 'RESPONSE_TOO_LARGE' | 'BAD_PATH' | 'BAD_METHOD' | 'DISABLED' | 'CANCELLED';
  constructor(message: string, code: GuestServiceError['code']) {
    super(message);
    this.name = 'GuestServiceError';
    this.code = code;
  }
}

const reserveLoopbackPort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || isString(address) || !('port' in address)) {
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

const sleep = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

const waitForServiceReady = async (port: number, token: string, shouldStop = () => false) => {
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
      await sleep(200);
      continue;
    }
    await sleep(200);
  }
  return false;
};

export const setGuestEnabled = async (guestId: string, persistPath: string, enabled: boolean) => {
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

export const setServiceSocketOverride = async (guestId: string, socketId: string, persistPath: string, socketPath: string | null) => {
  await updateExtensionStore(persistPath, (store) => {
    const serviceSocketOverrides = { ...(store.serviceSocketOverrides ?? {}) };
    const forGuest = { ...(serviceSocketOverrides[guestId] ?? {}) };
    const trimmed = socketPath?.trim() ?? '';
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

const lastFailures = new Map<string, { at: number; output: string }>();

export const getServiceFailure = (guestId: string) => lastFailures.get(guestId) ?? null;

export const forgetServiceFailure = (guestId: string) => {
  lastFailures.delete(guestId);
};

export const getServiceStatus = (guestId: string): ServiceRuntime['status'] => {
  const runtime = runtimes.get(guestId);
  if (!runtime) {
    return 'stopped';
  }
  return runtime.status;
};

const stopEpochs = new Map<string, number>();

const stopEpochOf = (guestId: string) => stopEpochs.get(guestId) ?? 0;

const idleStops = new Map<string, { timer: ReturnType<typeof setTimeout>; inflight: number; idleMs: number }>();

const clearIdleStop = (guestId: string) => {
  const entry = idleStops.get(guestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  idleStops.delete(guestId);
};

const holds = new Map<string, number>();

const armIdleStop = (guestId: string, idleMs: number) => {
  const previous = idleStops.get(guestId);
  const inflight = previous?.inflight ?? 0;
  if (previous) clearTimeout(previous.timer);
  const timer = setTimeout(() => {
    const current = idleStops.get(guestId);
    if (!current || current.inflight > 0 || (holds.get(guestId) ?? 0) > 0) {
      return;
    }
    idleStops.delete(guestId);
    void discardRuntime(guestId);
  }, idleMs);
  timer.unref?.();
  idleStops.set(guestId, { timer, inflight, idleMs });
};

export const holdGuestService = (guestId: string) => {
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

const trackInflight = (guestId: string, delta: number) => {
  const entry = idleStops.get(guestId);
  if (!entry) return;
  entry.inflight = Math.max(0, entry.inflight + delta);
};

export const stopGuestService = async (guestId: string) => {
  stopEpochs.set(guestId, stopEpochOf(guestId) + 1);
  openCodeProvider?.revokeGuest(guestId);
  clearIdleStop(guestId);
  await discardRuntime(guestId);
};

const discardRuntime = async (guestId: string) => {
  const stopping = stoppingByGuest.get(guestId);
  if (stopping) return stopping;
  const runtime = runtimes.get(guestId);
  if (!runtime) {
    return;
  }
  openCodeProvider?.revokeGuest(guestId);
  runtimes.delete(guestId);
  runtime.status = 'stopped';
  announceServiceEnded(guestId);
  const { child } = runtime;
  if (child.exitCode !== null || child.signalCode) {
    await runtime.released;
    return;
  }
  const stopped = new Promise<void>((resolve) => {
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
    if (child.exitCode !== null || child.signalCode) await runtime.released;
  } finally {
    stoppingByGuest.delete(guestId);
  }
};

export const guestIdOfServiceToken = (token: string) => {
  for (const [guestId, runtime] of runtimes) {
    if (runtime.status !== 'stopped' && runtime.status !== 'failed' && runtime.token === token) return guestId;
  }
  return null;
};

const serviceEndedListeners = new Set<(guestId: string) => void>();

export const onGuestServiceEnded = (listener: (guestId: string) => void) => {
  serviceEndedListeners.add(listener);
  return () => {
    serviceEndedListeners.delete(listener);
  };
};

const announceServiceEnded = (guestId: string) => {
  for (const listener of serviceEndedListeners) {
    try {
      listener(guestId);
    } catch (error) {
      console.warn('[guest-service] a service-ended listener failed:', hasErrorMessage(error) ? error.message ?? error : error);
    }
  }
};

export const readServicePid = (guestId: string) => runtimes.get(guestId)?.child.pid ?? null;

export const stopAllGuestServices = async () => {
  const starts = [...startingByGuest.values()];
  const ids = new Set([...runtimes.keys(), ...startingByGuest.keys(), ...stoppingByGuest.keys()]);
  const stops = [...ids].map((id) => stopGuestService(id));
  await Promise.allSettled([...starts, ...stops]);
  const provider = openCodeProvider;
  openCodeProvider = null;
  await provider?.stop();
};

const recordServiceProcess = (registryDir: string | null, child: ChildProcess, service: { guestId: string; token: string; entry: string }) => {
  const { pid } = child;
  if (!registryDir || pid === undefined || !Number.isInteger(pid)) return Promise.resolve();
  const recorded = recordGuestService(registryDir, { pid, ...service });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', resolve);
  });
  return Promise.all([recorded, exited]).then(() => releaseGuestService(registryDir, pid));
};

const collectProcessOutput = (child: ChildProcess, maxChars = 2_000) => {
  let stdout = '';
  let stderr = '';
  const append = (stream: 'stdout' | 'stderr', chunk: string | Buffer) => {
    const text = isString(chunk) ? chunk : chunk.toString('utf8');
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

const startGuestService = async ({
  guestId,
  packageRoot,
  entry,
  socketBindings = [],
  socketOverrides = {},
  dataDir,
  openCode = false,
  epoch,
  lifecycle,
}: ServiceStart) => {
  assertGuestHostActive(lifecycle);
  await lifecycle.orphansReaped;
  assertGuestHostActive(lifecycle);
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
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 }).catch(() => {
    throw new GuestServiceError('The service\'s data folder could not be created.', 'SERVICE_FAILED');
  });
  if (cancelled()) {
    throw stoppedError();
  }
  const env: NodeJS.ProcessEnv = {
    ...inheritedServiceEnv(process.env),
    OPENCHAMBER_SERVICE_PORT: String(port),
    [SERVICE_TOKEN_ENV]: token,
    [OPENCHAMBER_SERVICE_DATA_DIR]: dataDir,
    ELECTRON_RUN_AS_NODE: '1',
  };
  if (Object.keys(socketEnv).length > 0) {
    env.OPENCHAMBER_SERVICE_SOCKETS = JSON.stringify(socketEnv);
  }
  env[OPENCHAMBER_HOST_CALLBACK_URL] = await hostCallbackUrl();
  if (openCode) {
    if (!openCodeProvider) throw new GuestServiceError('OpenCode access is unavailable on this host.', 'NO_SERVICE');
    Object.assign(env, await openCodeProvider.environmentFor({ guestId, token }));
  }
  if (cancelled()) {
    openCodeProvider?.revokeGuest(guestId);
    throw stoppedError();
  }
  const child = spawn(process.execPath, [absoluteEntry], {
    cwd: packageRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const released = recordServiceProcess(lifecycle.registryDir, child, { guestId, token, entry: absoluteEntry });
  const output = collectProcessOutput(child);

  const runtime: ServiceRuntime = {
    child,
    port,
    token,
    status: 'starting',
    packageRoot,
    entry,
    released,
  };
  runtimes.set(guestId, runtime);

  child.once('exit', (code, signal) => {
    const current = runtimes.get(guestId);
    if (current === runtime) {
      if (code || signal) {
        const detail = [output.snapshot(), signal ? `Stopped by ${signal}.` : ''].filter(Boolean).join('\n');
        lastFailures.set(guestId, { at: Date.now(), output: detail });
      }
      runtime.status = runtime.status === 'starting' ? 'failed' : 'stopped';
      openCodeProvider?.revokeGuest(guestId);
      announceServiceEnded(guestId);
    }
  });

  const ready = await waitForServiceReady(port, token, () => cancelled() || child.exitCode !== null || Boolean(child.signalCode));
  if (cancelled()) {
    if (runtimes.get(guestId) === runtime) {
      await discardRuntime(guestId);
    }
    throw stoppedError();
  }
  if (!ready || child.exitCode !== null || child.signalCode) {
    runtime.status = 'failed';
    const detail = output.snapshot();
    lastFailures.set(guestId, { at: Date.now(), output: detail });
    await discardRuntime(guestId);
    throw new GuestServiceError(
      detail
        ? `The extension's service failed to start. ${detail}`
        : "The extension's service failed to start.",
      'SERVICE_FAILED',
    );
  }
  runtime.status = 'ready';
  lastFailures.delete(guestId);
  return runtime;
};

const INHERITED_SERVICE_ENV_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'TZ',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'WINDIR',
]);

const inheritedServiceEnv = (source: NodeJS.ProcessEnv) => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (isString(value) && INHERITED_SERVICE_ENV_NAMES.has(name.toUpperCase())) {
      env[name] = value;
    }
  }
  return env;
};

const ensureGuestService = async (params: ServiceStart) => {
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
}: GuestServiceRequest) => {
  const lifecycle = hostLifecycle;
  assertGuestHostActive(lifecycle);
  if (!METHODS.has(method)) {
    throw new GuestServiceError('Unsupported request method.', 'BAD_METHOD');
  }
  if (!isGuestRequestPath(requestPath)) {
    throw new GuestServiceError('Request path must stay on the service.', 'BAD_PATH');
  }
  const epoch = stopEpochOf(guestId);
  const store = await readExtensionStore(persistPath);
  assertGuestHostActive(lifecycle);
  if (store.disabledGuests?.[guestId]) {
    const label = guestName?.trim() ? guestName.trim() : 'This extension';
    throw new GuestServiceError(
      `${label} is disabled in Settings → Extensions.`,
      'DISABLED',
    );
  }
  if (!Array.isArray(granted) || !granted.includes('service')) {
    throw new GuestServiceError('Allow this extension\'s local service in Settings → Extensions.', 'NO_SERVICE');
  }

  const socketOverrides = store.serviceSocketOverrides?.[guestId] ?? {};
  if (!service) throw new TypeError("Cannot read properties of undefined (reading 'permissions')");
  const socketBindings = service.permissions?.sockets ?? [];

  let runtime = runtimes.get(guestId);
  if (!runtime || runtime.status !== 'ready' || runtime.child.exitCode !== null || runtime.child.signalCode) {
    if (isGuestPackageUnloaded(packageRoot)) {
      throw new GuestServiceError('The extension is being rebuilt; try again once its build finishes.', 'NO_SERVICE');
    }
    runtime = await ensureGuestService({
      guestId,
      packageRoot,
      entry: service.entry,
      socketBindings,
      socketOverrides,
      dataDir: guestDataDir(persistPath, guestId),
      openCode: serviceProvides(service, 'opencode'),
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

  const headers: ServiceHeaders = {
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
    if (runtimes.get(guestId) === runtime) armIdleStop(guestId, idleStopMs);
  };
  let response;
  try {
    const request: RequestInit = {
      method,
      headers,
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    };
    if (method !== 'GET' && body !== undefined) request.body = body;
    response = await fetch(url, request);
  } catch {
    settleIdle();
    if (signal?.aborted) {
      throw new GuestServiceError('The request was cancelled.', 'CANCELLED');
    }
    runtime.status = 'failed';
    announceServiceEnded(guestId);
    throw new GuestServiceError('Guest service request failed.', 'REQUEST_FAILED');
  }
  return {
    response,
    finished: settleIdle,
  };
};

export const proxyGuestServiceRequest = async ({ responseMax = GUEST_REQUEST_RESPONSE_MAX, ...params }: GuestServiceRequest & { responseMax?: number }) => {
  const { response, finished } = await openGuestServiceRequest(params);
  let body;
  try {
    body = await readBoundedResponseText(response, responseMax);
  } catch {
    finished();
    if (params.signal?.aborted) {
      throw new GuestServiceError('The request was cancelled.', 'CANCELLED');
    }
    const runtime = runtimes.get(params.guestId);
    if (runtime) {
      runtime.status = 'failed';
      announceServiceEnded(params.guestId);
    }
    throw new GuestServiceError('Guest service request failed.', 'REQUEST_FAILED');
  }
  finished();
  if (body.tooLarge) {
    throw new GuestServiceError(`The service answered with more than ${responseMax} bytes.`, 'RESPONSE_TOO_LARGE');
  }
  return {
    status: response.status,
    body: body.text,
  };
};
