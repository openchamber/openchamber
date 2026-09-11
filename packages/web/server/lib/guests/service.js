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

import { readExtensionStore, writeExtensionStore } from './persist.js';
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

export class GuestServiceError extends Error {
  /**
   * @param {string} message
   * @param {'NO_SERVICE' | 'SERVICE_FAILED' | 'BAD_PATH' | 'BAD_METHOD'} code
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
const waitForServiceReady = async (port, token) => {
  const deadline = Date.now() + SERVICE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
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
const isServiceGranted = async (guestId, persistPath) => {
  const store = await readExtensionStore(persistPath);
  return (store.capabilityGrants?.[guestId] ?? []).includes('service');
};

/**
 * @param {string} guestId
 * @param {string} persistPath
 * @param {boolean} enabled
 */
export const setGuestEnabled = async (guestId, persistPath, enabled) => {
  const store = await readExtensionStore(persistPath);
  const disabledGuests = { ...(store.disabledGuests ?? {}) };
  if (enabled) {
    delete disabledGuests[guestId];
  } else {
    disabledGuests[guestId] = true;
  }
  await writeExtensionStore(persistPath, {
    paths: store.paths,
    sources: store.sources,
    gitOrigins: store.gitOrigins,
    capabilityGrants: store.capabilityGrants,
    disabledGuests,
    serviceSocketOverrides: store.serviceSocketOverrides,
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
  const store = await readExtensionStore(persistPath);
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
  await writeExtensionStore(persistPath, {
    paths: store.paths,
    sources: store.sources,
    gitOrigins: store.gitOrigins,
    capabilityGrants: store.capabilityGrants,
    disabledGuests: store.disabledGuests,
    serviceSocketOverrides,
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
export const stopGuestService = async (guestId) => {
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
  await new Promise((resolve) => {
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
};

export const stopAllGuestServices = async () => {
  const ids = [...runtimes.keys()];
  await Promise.all(ids.map((id) => stopGuestService(id)));
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
}) => {
  const existing = runtimes.get(guestId);
  if (existing?.status === 'ready' && existing.child.exitCode === null && !existing.child.signalCode) {
    return existing;
  }
  if (existing) {
    await stopGuestService(guestId);
  }

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

  const port = await reserveLoopbackPort();
  const token = crypto.randomBytes(24).toString('hex');
  const socketEnv = socketBindings.length > 0
    ? await resolveServiceSocketEnv(socketBindings, socketOverrides)
    : {};
  const env = {
    ...inheritedServiceEnv(process.env),
    OPENCHAMBER_SERVICE_PORT: String(port),
    OPENCHAMBER_SERVICE_TOKEN: token,
    ELECTRON_RUN_AS_NODE: '1',
  };
  if (Object.keys(socketEnv).length > 0) {
    env.OPENCHAMBER_SERVICE_SOCKETS = JSON.stringify(socketEnv);
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

  const ready = await waitForServiceReady(port, token);
  if (!ready || child.exitCode !== null || child.signalCode) {
    runtime.status = 'failed';
    const detail = output.snapshot();
    await stopGuestService(guestId);
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
 * @param {{
 *   guestId: string,
 *   packageRoot: string,
 *   service: { entry: string, permissions?: { sockets?: Array<{ id: string, candidatesByPlatform?: Partial<Record<'linux' | 'darwin' | 'win32', string[]>> }>, exec?: string[] } },
 *   persistPath: string,
 *   method: string,
 *   path: string,
 *   query?: Record<string, string>,
 *   body?: string,
 * }} params
 */
export const proxyGuestServiceRequest = async ({
  guestId,
  guestName,
  packageRoot,
  service,
  persistPath,
  method,
  path: requestPath,
  query,
  body,
}) => {
  if (!METHODS.has(method)) {
    throw new GuestServiceError('Unsupported request method.', 'BAD_METHOD');
  }
  if (!isGuestRequestPath(requestPath)) {
    throw new GuestServiceError('Request path must stay on the service.', 'BAD_PATH');
  }
  const store = await readExtensionStore(persistPath);
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
  if (!await isServiceGranted(guestId, persistPath)) {
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
    });
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
    Accept: 'application/json',
    [OPENCHAMBER_SERVICE_AUTH_HEADER]: `Bearer ${runtime.token}`,
  };
  if (body !== undefined && method !== 'GET') {
    headers['Content-Type'] = 'application/json';
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || body === undefined ? undefined : body,
      redirect: 'manual',
      signal: AbortSignal.timeout(GUEST_REQUEST_TIMEOUT_MS),
    });
  } catch {
    runtime.status = 'failed';
    throw new GuestServiceError('Guest service request failed.', 'SERVICE_FAILED');
  }

  const text = await response.text();
  return {
    status: response.status,
    body: text.length <= GUEST_REQUEST_RESPONSE_MAX
      ? text
      : text.slice(0, GUEST_REQUEST_RESPONSE_MAX),
  };
};
