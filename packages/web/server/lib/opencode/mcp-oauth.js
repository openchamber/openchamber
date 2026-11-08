import fsPromises from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { collectForwardProxyHeaders } from '../../proxy-headers.js';
import { requestOrigin } from '../guests/routes.js';
import { isRecord } from '../shared/guards.js';
import { writeFileAtomic } from './atomic-write.js';

/**
 * Query parameters a provider can return on the OAuth redirect. Anything else
 * in the request is dropped before the callback is forwarded to the loopback
 * listener: the endpoint is unauthenticated, so it forwards a known set of
 * values and nothing an outside caller chooses.
 */
const CALLBACK_QUERY_KEYS = ['code', 'state', 'error', 'error_description', 'error_uri', 'iss'];

// OpenCode's own limit for an attempt, used when its answer names no expiry.
const ATTEMPT_LIFETIME_MS = 10 * 60 * 1000;
const CALLBACK_TIMEOUT_MS = 10_000;
const UPSTREAM_TIMEOUT_MS = 60_000;
// OpenCode picks a config write up through its file watcher, so the first
// start after a write can still run on the old redirect.
const CONFIG_PICKUP_TIMEOUT_MS = 8_000;
const CONFIG_PICKUP_RETRY_MS = 250;
// A save that lands during preparation sends the sign-in back to planning.
const MAX_PLANNING_ROUNDS = 3;

// Said only by an OpenCode older than 2.2.6, which cannot take the redirect
// address pasted back from the browser.
const RELAY_REFUSAL = 'MCP sign-in cannot finish over the private relay with this OpenCode version, because the provider has to redirect the browser to an address that reaches OpenChamber directly. Update OpenCode to 2.2.6 or newer, or open OpenChamber at its LAN or tunnel address and sign in from there.';
const OFF_MACHINE_REFUSAL = 'MCP sign-in cannot finish here with this OpenCode version, because OpenCode runs on another machine and only that machine can receive the provider\'s redirect. Update OpenCode to 2.2.6 or newer, sign in where OpenCode runs, or set this server\'s oauth.redirect_uri to an address that reaches that machine.';
const STALE_CONFIG_REFUSAL = 'OpenCode has not picked up the sign-in address for this MCP server yet, so the sign-in did not start. Try again in a moment.';
const CHANGING_CONFIG_REFUSAL = 'This MCP server\'s config kept changing while the sign-in was being prepared, so the sign-in did not start. Try again in a moment.';
const INVALID_CALLBACK_MESSAGE = 'OpenChamber cannot finish this sign-in from here. If OpenChamber is still waiting for it, copy this page\'s address and paste it there. Otherwise start the sign-in again from the server\'s page in OpenChamber.';
const LISTENER_UNREACHABLE_MESSAGE = 'The sign-in could not reach the local callback listener, which usually means OpenCode stopped or the sign-in already ended. Start the sign-in again from the server\'s page in OpenChamber.';

const isLoopbackHostname = (hostname) => (
  hostname === 'localhost'
  || hostname === '::1'
  || hostname === '[::1]'
  || /^127\.\d+\.\d+\.\d+$/.test(hostname)
);

const hostnameOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

const bareAddress = (hostname) => hostname.replace(/^\[|\]$/g, '').toLowerCase();

const localAddresses = () => Object.values(os.networkInterfaces())
  .flatMap((addresses) => addresses ?? [])
  .map((address) => address.address.toLowerCase());

/**
 * OpenCode's OAuth listener binds this machine's loopback, so OpenChamber can
 * forward to it only when the OpenCode it talks to runs here. The answer comes
 * from the address OpenChamber connects to: a name it cannot match counts as
 * another machine, and the sign-in then says so before consent.
 */
export const isSameMachineUrl = (url, addresses = localAddresses()) => {
  const hostname = hostnameOf(url);
  if (!hostname) return false;
  return isLoopbackHostname(hostname) || addresses.includes(bareAddress(hostname));
};

const decodeDirectory = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

// The header as OpenCode reads it. The SDK encodes it without any marker, and
// the proxy's normalization has already decoded the marked form, so a second
// decode here is what OpenCode would apply to either.
const headerDirectoryOf = (req) => {
  const header = req.headers['x-opencode-directory'];
  return header ? decodeDirectory(header) : null;
};

// OpenCode's order: the location query, then the header.
const openCodeDirectoryOf = (req) => (
  new URL(req.originalUrl, 'http://localhost').searchParams.get('location[directory]') || headerDirectoryOf(req)
);

// `resolveProjectDirectory` reads its hint as a path, so it gets the decoded one.
const directoryRequest = (directory) => ({
  get: (name) => (name === 'x-opencode-directory' ? directory : null),
  query: {},
});

const browserOriginOf = (req) => {
  try {
    const url = new URL(requestOrigin(req));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
};

const mcpOAuthCallbackPath = (name) => `/api/mcp/oauth/${name}/callback`;

const isUsablePort = (port) => Number.isInteger(port) && port > 0 && port <= 65535;

const listenOnLoopback = (port) => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.unref();
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => {
    const bound = server.address()?.port ?? 0;
    server.close(() => resolve(bound));
  });
});

const isLoopbackPortFree = (port) => listenOnLoopback(port).then(() => true, () => false);

const allocateLoopbackPort = async (takenPorts) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await listenOnLoopback(0);
    if (port && !takenPorts.has(port)) return port;
  }
  throw new Error('Could not allocate an MCP callback port');
};

/**
 * The redirects OpenChamber generated, keyed by port. An entry whose redirect
 * and port match a record here is ours to move; anything else in `oauth` was
 * written by a person and stays as it is, however much its path looks like
 * ours. A missing file is an empty store; an unreadable one fails the sign-in,
 * because reading it as empty would turn every generated entry into a user's.
 */
const createAssignmentStore = (storePath) => ({
  read: async () => {
    let text;
    try {
      text = await fsPromises.readFile(storePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
    const parsed = JSON.parse(text);
    if (!isRecord(parsed?.assignments)) throw new Error(`${storePath} has no assignments`);
    return parsed.assignments;
  },
  write: (assignments) => {
    writeFileAtomic(storePath, `${JSON.stringify({ assignments }, null, 2)}\n`);
  },
});

const ownsRouting = (assignments, name, oauth) => {
  const assignment = assignments[oauth?.callback_port];
  return assignment?.name === name && assignment.redirectUri === oauth?.redirect_uri;
};

/**
 * How one sign-in reaches OpenCode's listener.
 *
 * - `proxy`: OpenCode's own redirect works, or a person configured the route.
 * - `track`: a generated redirect is in place; the attempt only needs binding.
 * - `prepare`: this browser needs a generated redirect on its own origin.
 * - `{ pasteOnly }`: the provider's redirect can never reach the listener, so
 *   the user pastes the address it lands on; `pasteOnly` is the refusal for
 *   an OpenCode that cannot take one.
 */
const planSignIn = ({ oauth, owned, relay, origin, sameMachine }) => {
  const configured = Boolean(oauth?.redirect_uri || oauth?.callback_port);
  if (configured && !owned) return 'proxy';
  if (!sameMachine) return { pasteOnly: OFF_MACHINE_REFUSAL };
  if (relay) return owned ? 'track' : { pasteOnly: RELAY_REFUSAL };
  if (!origin || isLoopbackHostname(hostnameOf(origin))) return owned ? 'track' : 'proxy';
  return 'prepare';
};

const forwardedQuery = (params) => {
  const forwarded = new URLSearchParams();
  for (const key of CALLBACK_QUERY_KEYS) {
    for (const value of params.getAll(key)) {
      forwarded.append(key, value);
    }
  }
  return forwarded.toString();
};

const sendUpstream = async (res, upstream) => {
  res.status(upstream.status);
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.setHeader('content-type', contentType);
  return res.send(Buffer.from(await upstream.arrayBuffer()));
};

const refuse = (res, status, message) => res.status(status).json({ _tag: 'InvalidRequestError', message, kind: 'mcp_oauth' });

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * MCP OAuth from a browser that cannot reach OpenCode's loopback listener.
 * `DOCUMENTATION.md`, "Remote MCP OAuth", has the contract. Attempts live in
 * memory: a restart ends them, and their callbacks are then refused.
 */
export const createMcpOAuthSignIn = ({
  storePath,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  resolveProjectDirectory,
  getMcpConfig,
  listMcpConfigs,
  updateMcpConfig,
  allocatePort = allocateLoopbackPort,
  isPortFree = isLoopbackPortFree,
  configPickupTimeoutMs = CONFIG_PICKUP_TIMEOUT_MS,
  configPickupRetryMs = CONFIG_PICKUP_RETRY_MS,
}) => {
  const assignmentStore = createAssignmentStore(storePath);
  const attemptsByState = new Map();
  let preparing = Promise.resolve();

  const pruneAttempts = () => {
    const now = Date.now();
    for (const [state, attempt] of attemptsByState) {
      if (attempt.expiresAt <= now) attemptsByState.delete(state);
    }
  };

  const callOpenCode = (req, method, path, body) => {
    const headers = collectForwardProxyHeaders(req.headers, getOpenCodeAuthHeaders());
    delete headers['x-opencode-directory-encoding'];
    // OpenCode decodes this header once, and fetch refuses non-Latin-1 values.
    const directory = headerDirectoryOf(req);
    if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
    headers['accept-encoding'] = 'identity';
    return fetch(buildOpenCodeUrl(path, ''), {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  };

  const cancelUpstream = (req, integrationID, attemptID, search) => (
    callOpenCode(req, 'DELETE', `/api/integration/${integrationID}/connect/oauth/${attemptID}${search}`)
      .then(() => {}, () => {})
  );

  // A fixed callback port holds one listener, so a new start for a server ends
  // the attempt it replaces.
  const supersedeAttempts = async (req, serverKey, search) => {
    const cancelled = [];
    for (const [state, attempt] of attemptsByState) {
      if (attempt.serverKey !== serverKey) continue;
      attemptsByState.delete(state);
      cancelled.push(cancelUpstream(req, attempt.integrationID, attempt.attemptID, search));
    }
    await Promise.all(cancelled);
  };

  /**
   * Picks this entry's redirect and port and writes them. Runs one at a time,
   * and the store takes the port before the config does, so two sign-ins in
   * any two projects never hold the same generated port. The plan rests on
   * `entry`, so a save that lands in the queue or during allocation sends the
   * sign-in back to planning. The last check and the writes run without an
   * await between them, so a custom redirect saved earlier is never overwritten.
   */
  const assignRouting = async ({ name, directory, entry, origin }) => {
    const entryChanged = () => !isDeepStrictEqual(getMcpConfig(name, directory), entry);
    if (entryChanged()) return { replan: true };

    const assignments = await assignmentStore.read();
    const redirectUri = `${origin}${mcpOAuthCallbackPath(name)}`;
    const current = ownsRouting(assignments, name, entry.oauth) ? entry.oauth.callback_port : null;

    const otherEntries = listMcpConfigs(directory).filter((candidate) => candidate.name !== name);
    const takenPorts = new Set([
      ...Object.keys(assignments).map(Number),
      ...otherEntries.map((candidate) => candidate.oauth?.callback_port).filter(isUsablePort),
      ...Array.from(attemptsByState.values(), (attempt) => attempt.port),
    ]);
    takenPorts.delete(current);
    const collides = otherEntries.some((candidate) => candidate.oauth?.callback_port === current);

    const keepsPort = current !== null && !collides && await isPortFree(current);
    const port = keepsPort ? current : await allocatePort(takenPorts);
    if (entryChanged()) return { replan: true };
    if (port === current && redirectUri === entry.oauth?.redirect_uri) {
      return { redirectUri, port, written: false };
    }

    const nextAssignments = { ...assignments };
    if (current !== null) delete nextAssignments[current];
    nextAssignments[port] = { name, redirectUri };
    assignmentStore.write(nextAssignments);
    updateMcpConfig(name, {
      oauth: { ...entry.oauth, redirect_uri: redirectUri, callback_port: port },
    }, directory);
    return { redirectUri, port, written: true };
  };

  const prepareRouting = (input) => {
    const result = preparing.then(() => assignRouting(input));
    preparing = result.catch(() => {});
    return result;
  };

  /**
   * Starts OpenCode's attempt and binds it. The authorization URL is the
   * authority on the redirect OpenCode really uses, so an attempt that still
   * runs on the old config is cancelled and started again.
   */
  const startBoundAttempt = async ({ req, res, integrationID, search, name, serverKey, routing }) => {
    const body = JSON.stringify(req.body ?? {});
    const deadline = Date.now() + configPickupTimeoutMs;
    const path = `/api/integration/${integrationID}/connect/oauth${search}`;
    // Each start can register a client with the provider, so the wait doubles.
    let retryDelay = configPickupRetryMs;
    const waitForPickup = async () => {
      await sleep(retryDelay);
      retryDelay *= 2;
    };

    for (;;) {
      const upstream = await callOpenCode(req, 'POST', path, body);
      const retriable = Date.now() < deadline;
      if (!upstream.ok) {
        // OpenCode replaces the server's method while it applies a write.
        if (routing.written && retriable) {
          await waitForPickup();
          continue;
        }
        return sendUpstream(res, upstream);
      }

      const payload = await upstream.json();
      const attempt = isRecord(payload?.data) ? payload.data : payload;
      const authorization = new URL(attempt.url);
      if (authorization.searchParams.get('redirect_uri') !== routing.redirectUri) {
        await cancelUpstream(req, integrationID, attempt.attemptID, search);
        if (!retriable) return refuse(res, 503, STALE_CONFIG_REFUSAL);
        await waitForPickup();
        continue;
      }

      const state = authorization.searchParams.get('state');
      if (!state) {
        await cancelUpstream(req, integrationID, attempt.attemptID, search);
        return refuse(res, 502, 'OpenCode started the sign-in without a state value, so its callback could not be verified.');
      }

      attemptsByState.set(state, {
        name,
        serverKey,
        integrationID,
        attemptID: attempt.attemptID,
        port: routing.port,
        path: new URL(routing.redirectUri).pathname,
        expiresAt: Number.isFinite(attempt.time?.expires)
          ? attempt.time.expires
          : Date.now() + ATTEMPT_LIFETIME_MS,
      });
      return res.status(upstream.status).json(payload);
    }
  };

  /**
   * Starts an attempt whose redirect cannot come back by itself, on OpenCode's
   * own route: the user pastes the address the browser lands on. An OpenCode
   * that does not announce `paste` (before 2.2.6) would leave the user waiting
   * for nothing, so its attempt is cancelled and the start refused.
   */
  const startPasteOnlyAttempt = async ({ req, res, integrationID, search, refusal }) => {
    const path = `/api/integration/${integrationID}/connect/oauth${search}`;
    const upstream = await callOpenCode(req, 'POST', path, JSON.stringify(req.body ?? {}));
    if (!upstream.ok) return sendUpstream(res, upstream);
    const payload = await upstream.json();
    const attempt = isRecord(payload?.data) ? payload.data : payload;
    if (attempt?.paste === true) return res.status(upstream.status).json(payload);
    if (attempt?.attemptID) await cancelUpstream(req, integrationID, attempt.attemptID, search);
    return refuse(res, 400, refusal);
  };

  const readMcpServerName = async (req, integrationID, search) => {
    const upstream = await callOpenCode(req, 'GET', `/api/integration/${integrationID}${search}`);
    if (!upstream.ok) return { upstream };
    const payload = await upstream.json();
    const integration = isRecord(payload?.data) ? payload.data : payload;
    return { name: integration?.metadata?.source === 'mcp' ? integration.name : null };
  };

  const startSignIn = async (req, res, next, readBody) => {
    const { integrationID } = req.params;
    if (!integrationID.startsWith('mcp_')) return next();

    try {
      await readBody(req, res);
      const search = new URL(req.originalUrl, 'http://localhost').search;
      const { name, upstream } = await readMcpServerName(req, integrationID, search);
      if (upstream) return sendUpstream(res, upstream);
      if (!name) return next();

      const namedDirectory = openCodeDirectoryOf(req);
      const { directory = null, error } = await resolveProjectDirectory(directoryRequest(namedDirectory));
      // Global config would answer for the wrong folder here.
      if (namedDirectory && error) return refuse(res, 400, error);
      const serverKey = `${directory}\0${name}`;

      for (let round = 0; round < MAX_PLANNING_ROUNDS; round += 1) {
        const entry = getMcpConfig(name, directory);
        if (entry?.type !== 'remote' || entry.oauth === false) return next();

        const assignments = await assignmentStore.read();
        const owned = ownsRouting(assignments, name, entry.oauth);
        const plan = planSignIn({
          oauth: entry.oauth,
          owned,
          relay: Boolean(req.headers['x-openchamber-relay-connection']),
          origin: browserOriginOf(req),
          sameMachine: isSameMachineUrl(buildOpenCodeUrl('/', '')),
        });
        if (plan === 'proxy') return next();
        if (plan.pasteOnly) {
          return await startPasteOnlyAttempt({ req, res, integrationID, search, refusal: plan.pasteOnly });
        }

        pruneAttempts();
        await supersedeAttempts(req, serverKey, search);
        const routing = plan === 'prepare'
          ? await prepareRouting({ name, directory, entry, origin: browserOriginOf(req) })
          : { redirectUri: entry.oauth.redirect_uri, port: entry.oauth.callback_port, written: false };
        if (!routing.replan) {
          return await startBoundAttempt({ req, res, integrationID, search, name, serverKey, routing });
        }
      }
      return refuse(res, 503, CHANGING_CONFIG_REFUSAL);
    } catch (error) {
      console.error(`[mcp-oauth] sign-in start failed: ${error?.message ?? error}`);
      if (res.headersSent) return undefined;
      return refuse(res, 502, 'OpenChamber could not prepare this MCP sign-in. Check the server log and try again.');
    }
  };

  const forgetAttempt = (attemptID) => {
    for (const [state, attempt] of attemptsByState) {
      if (attempt.attemptID === attemptID) attemptsByState.delete(state);
    }
  };

  // One callback per attempt: taking it here means a replay finds nothing.
  const claimAttempt = (name, state) => {
    pruneAttempts();
    const attempt = state ? attemptsByState.get(state) : undefined;
    if (attempt?.name !== name) return null;
    attemptsByState.delete(state);
    return attempt;
  };

  return {
    /**
     * The provider's redirect. It is open without a session, so only a state
     * value this server handed to a live attempt reaches the loopback listener,
     * on the port and path saved with that attempt. Nothing is read from the
     * current project or from config, which another client can change while
     * consent is open.
     */
    registerCallbackRoute: (app) => {
      app.get('/api/mcp/oauth/:name/callback', async (req, res) => {
        const params = new URL(req.originalUrl || req.url || '', 'http://127.0.0.1').searchParams;
        const attempt = claimAttempt(req.params.name, params.get('state'));
        if (!attempt) {
          return res.status(400).type('text/plain').send(INVALID_CALLBACK_MESSAGE);
        }

        const target = `http://127.0.0.1:${attempt.port}${attempt.path}?${forwardedQuery(params)}`;
        try {
          // The listener answers the callback page directly. Never follow a
          // redirect here: the route is open without a session, and a 3xx from
          // whatever holds the port would make it fetch an address of that
          // service's choosing and return the body.
          const upstream = await fetch(target, {
            redirect: 'manual',
            signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
          });
          return await sendUpstream(res, upstream);
        } catch {
          return res.status(502).type('text/plain').send(LISTENER_UNREACHABLE_MESSAGE);
        }
      });
    },

    registerStartRoutes: (app, { readBody }) => {
      app.post('/api/integration/:integrationID/connect/oauth', (req, res, next) => (
        startSignIn(req, res, next, readBody)
      ));
      app.delete('/api/integration/:integrationID/connect/oauth/:attemptID', (req, _res, next) => {
        forgetAttempt(req.params.attemptID);
        next();
      });
    },
  };
};
