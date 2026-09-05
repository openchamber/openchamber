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

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const AGENT_READY_TIMEOUT_MS = 15_000;
const AGENT_KILL_TIMEOUT_MS = 5_000;
const AGENT_HEALTH_PATH = '/health';
/** Inbound auth header the agent must require. */
const OPENCHAMBER_AGENT_AUTH_HEADER = 'authorization';

/**
 * @typedef {{
 *   child: import('node:child_process').ChildProcess,
 *   port: number,
 *   token: string,
 *   status: 'starting' | 'ready' | 'failed' | 'stopped',
 *   packageRoot: string,
 *   entry: string,
 * }} AgentRuntime
 */

/** @type {Map<string, AgentRuntime>} */
const runtimes = new Map();

/** @type {Map<string, Promise<AgentRuntime>>} */
const startingByGuest = new Map();

export class GuestAgentError extends Error {
  /**
   * @param {string} message
   * @param {'NO_AGENT' | 'AGENT_FAILED' | 'BAD_PATH' | 'BAD_METHOD'} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'GuestAgentError';
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
const waitForAgentReady = async (port, token) => {
  const deadline = Date.now() + AGENT_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${AGENT_HEALTH_PATH}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          [OPENCHAMBER_AGENT_AUTH_HEADER]: `Bearer ${token}`,
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
const isAgentGranted = async (guestId, persistPath) => {
  const store = await readExtensionStore(persistPath);
  return Boolean(store.agentGrants?.[guestId]);
};

/**
 * @param {string} guestId
 * @param {string} persistPath
 * @param {boolean} granted
 */
export const setAgentGranted = async (guestId, persistPath, granted) => {
  const store = await readExtensionStore(persistPath);
  const agentGrants = { ...(store.agentGrants ?? {}) };
  if (granted) {
    agentGrants[guestId] = true;
  } else {
    delete agentGrants[guestId];
  }
  await writeExtensionStore(persistPath, {
    paths: store.paths,
    sources: store.sources,
    agentGrants,
  });
};

/**
 * @param {string} guestId
 */
export const getAgentStatus = (guestId) => {
  const runtime = runtimes.get(guestId);
  if (!runtime) {
    return 'stopped';
  }
  return runtime.status;
};

/**
 * @param {string} guestId
 */
export const stopGuestAgent = async (guestId) => {
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
    }, AGENT_KILL_TIMEOUT_MS);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.kill('SIGTERM');
  });
};

export const stopAllGuestAgents = async () => {
  const ids = [...runtimes.keys()];
  await Promise.all(ids.map((id) => stopGuestAgent(id)));
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
 * }} params
 */
const startGuestAgent = async ({ guestId, packageRoot, entry }) => {
  const existing = runtimes.get(guestId);
  if (existing?.status === 'ready' && existing.child.exitCode === null && !existing.child.signalCode) {
    return existing;
  }
  if (existing) {
    await stopGuestAgent(guestId);
  }

  const absoluteEntry = path.resolve(packageRoot, entry);
  const rootResolved = path.resolve(packageRoot);
  if (!absoluteEntry.startsWith(`${rootResolved}${path.sep}`)) {
    throw new GuestAgentError('Agent entry must stay inside the package.', 'NO_AGENT');
  }
  try {
    await fs.access(absoluteEntry);
  } catch {
    throw new GuestAgentError('Agent entry is missing.', 'NO_AGENT');
  }

  const port = await reserveLoopbackPort();
  const token = crypto.randomBytes(24).toString('hex');
  const env = {
    ...process.env,
    OPENCHAMBER_AGENT_PORT: String(port),
    OPENCHAMBER_AGENT_TOKEN: token,
    ELECTRON_RUN_AS_NODE: '1',
  };
  const child = spawn(process.execPath, [absoluteEntry], {
    cwd: packageRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = collectProcessOutput(child);

  /** @type {AgentRuntime} */
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

  const ready = await waitForAgentReady(port, token);
  if (!ready || child.exitCode !== null || child.signalCode) {
    runtime.status = 'failed';
    const detail = output.snapshot();
    await stopGuestAgent(guestId);
    throw new GuestAgentError(
      detail
        ? `Guest agent failed to become ready. ${detail}`
        : 'Guest agent failed to become ready.',
      'AGENT_FAILED',
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
 * }} params
 */
const ensureGuestAgent = async (params) => {
  const existing = runtimes.get(params.guestId);
  if (existing?.status === 'ready' && existing.child.exitCode === null && !existing.child.signalCode) {
    return existing;
  }
  const inflight = startingByGuest.get(params.guestId);
  if (inflight) {
    return inflight;
  }
  const pending = startGuestAgent(params).finally(() => {
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
 *   agent: { entry: string, permissions?: { sockets?: string[], exec?: string[] } },
 *   persistPath: string,
 *   method: string,
 *   path: string,
 *   query?: Record<string, string>,
 *   body?: string,
 * }} params
 */
export const proxyGuestAgentRequest = async ({
  guestId,
  packageRoot,
  agent,
  persistPath,
  method,
  path: requestPath,
  query,
  body,
}) => {
  if (!METHODS.has(method)) {
    throw new GuestAgentError('Unsupported request method.', 'BAD_METHOD');
  }
  if (!isGuestRequestPath(requestPath)) {
    throw new GuestAgentError('Request path must stay on the agent.', 'BAD_PATH');
  }
  const needsGrant = Boolean(
    (agent.permissions?.sockets && agent.permissions.sockets.length > 0)
    || (agent.permissions?.exec && agent.permissions.exec.length > 0),
  );
  if (needsGrant && !await isAgentGranted(guestId, persistPath)) {
    throw new GuestAgentError('Allow this extension\'s local agent in Settings → Extensions.', 'NO_AGENT');
  }

  let runtime = runtimes.get(guestId);
  if (!runtime || runtime.status !== 'ready' || runtime.child.exitCode !== null || runtime.child.signalCode) {
    runtime = await ensureGuestAgent({
      guestId,
      packageRoot,
      entry: agent.entry,
    });
  }

  let url;
  try {
    url = new URL(requestPath, `http://127.0.0.1:${runtime.port}/`);
  } catch {
    throw new GuestAgentError('Request path must stay on the agent.', 'BAD_PATH');
  }
  if (url.hostname !== '127.0.0.1' || url.port !== String(runtime.port)) {
    throw new GuestAgentError('Request path must stay on the agent.', 'BAD_PATH');
  }
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }

  /** @type {Record<string, string>} */
  const headers = {
    Accept: 'application/json',
    [OPENCHAMBER_AGENT_AUTH_HEADER]: `Bearer ${runtime.token}`,
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
    throw new GuestAgentError('Guest agent request failed.', 'AGENT_FAILED');
  }

  const text = await response.text();
  return {
    status: response.status,
    body: text.length <= GUEST_REQUEST_RESPONSE_MAX
      ? text
      : text.slice(0, GUEST_REQUEST_RESPONSE_MAX),
  };
};
