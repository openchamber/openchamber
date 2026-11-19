import fsPromises from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { collectForwardProxyHeaders } from '../../proxy-headers.js';
import { requestOrigin } from '../guests/routes.js';
import { isRecord, isString } from '../shared/guards.js';
import { writeFileAtomic } from './atomic-write.js';
import type { Request, Response as HttpResponse, NextFunction, Application } from '../shared/http-contracts.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { McpEntity, McpOAuth } from './config-v2.js';

interface WireFields {
  data?: unknown;
  assignments?: unknown;
  name?: unknown;
  redirectUri?: unknown;
  url?: unknown;
  attemptID?: unknown;
  paste?: unknown;
  time?: unknown;
  expires?: unknown;
  metadata?: unknown;
  source?: unknown;
  code?: unknown;
  message?: unknown;
}
const hasWireFields = (value: unknown): value is WireFields => value != null;
const optionalFields = <Value>(value: Value) => hasWireFields(value) ? value : undefined;
const requiredFields = <Value>(value: Value, property: 'url' | 'redirectUri') => {
  if (hasWireFields(value)) return value;
  throw new TypeError(`Cannot read properties of ${value} (reading '${property}')`);
};
const requiredOAuth = (oauth: McpOAuth | undefined, property: 'callback_port' | 'redirect_uri') => {
  if (oauth === undefined) throw new TypeError(`Cannot read properties of undefined (reading '${property}')`);
  return oauth;
};
const isJsonObject = (value: unknown): value is JsonObject => isRecord(value);
const isFiniteNumber = (value: unknown): value is number => Number.isFinite(value);
const isAddressInfo = (value: unknown): value is net.AddressInfo => value != null && typeof value !== 'string';
type DirectoryRequest = ReturnType<typeof directoryRequest>;
type McpConfigEntry = McpEntity & { name: string };
interface RoutingInput {
  name: string;
  directory: string | null;
  entry: McpConfigEntry;
  origin: string | null;
}
interface Routing {
  redirectUri: string | undefined;
  port: number | undefined;
  written: boolean;
  replan?: false;
}
interface AssignmentTable {
  [port: string]: JsonValue | { name: unknown; redirectUri: string } | undefined;
}
interface BoundAttempt {
  name: WireFields['name'];
  serverKey: string;
  integrationID: string;
  attemptID: unknown;
  port: number | undefined;
  path: string;
  expiresAt: number;
}
interface StartInput {
  req: Request;
  res: HttpResponse;
  integrationID: string;
  search: string;
}
export interface McpOAuthDependencies {
  storePath: string;
  buildOpenCodeUrl: (path: string, prefix: string) => string;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  resolveProjectDirectory: (request: DirectoryRequest) => Promise<{ directory?: string | null; error?: string | null }>;
  getMcpConfig: (name: string, directory: string | null) => McpConfigEntry | null;
  listMcpConfigs: (directory: string | null) => McpConfigEntry[];
  updateMcpConfig: (name: string, updates: { oauth: Omit<McpOAuth, 'callback_port'> & { callback_port: number | undefined } }, directory: string | null) => void;
  allocatePort?: (ports: Set<number | undefined>) => Promise<number>;
  isPortFree?: (port: number | undefined) => Promise<boolean>;
  configPickupTimeoutMs?: number;
  configPickupRetryMs?: number;
}
export interface McpOAuthBodyReader {
  readBody: (request: Request, response: HttpResponse) => Promise<Request['body']>;
}

const CALLBACK_QUERY_KEYS = ['code', 'state', 'error', 'error_description', 'error_uri', 'iss'];

const ATTEMPT_LIFETIME_MS = 10 * 60 * 1000;
const CALLBACK_TIMEOUT_MS = 10_000;
const UPSTREAM_TIMEOUT_MS = 60_000;
const CONFIG_PICKUP_TIMEOUT_MS = 8_000;
const CONFIG_PICKUP_RETRY_MS = 250;
const MAX_PLANNING_ROUNDS = 3;

const RELAY_REFUSAL = 'MCP sign-in cannot finish over the private relay with this OpenCode version, because the provider has to redirect the browser to an address that reaches OpenChamber directly. Update OpenCode to 2.2.6 or newer, or open OpenChamber at its LAN or tunnel address and sign in from there.';
const OFF_MACHINE_REFUSAL = 'MCP sign-in cannot finish here with this OpenCode version, because OpenCode runs on another machine and only that machine can receive the provider\'s redirect. Update OpenCode to 2.2.6 or newer, sign in where OpenCode runs, or set this server\'s oauth.redirect_uri to an address that reaches that machine.';
const STALE_CONFIG_REFUSAL = 'OpenCode has not picked up the sign-in address for this MCP server yet, so the sign-in did not start. Try again in a moment.';
const CHANGING_CONFIG_REFUSAL = 'This MCP server\'s config kept changing while the sign-in was being prepared, so the sign-in did not start. Try again in a moment.';
const INVALID_CALLBACK_MESSAGE = 'OpenChamber cannot finish this sign-in from here. If OpenChamber is still waiting for it, copy this page\'s address and paste it there. Otherwise start the sign-in again from the server\'s page in OpenChamber.';
const LISTENER_UNREACHABLE_MESSAGE = 'The sign-in could not reach the local callback listener, which usually means OpenCode stopped or the sign-in already ended. Start the sign-in again from the server\'s page in OpenChamber.';

const isLoopbackHostname = (hostname: string | null) => (
  hostname === 'localhost'
  || hostname === '::1'
  || hostname === '[::1]'
  || /^127\.\d+\.\d+\.\d+$/.test(String(hostname))
);

const hostnameOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

const bareAddress = (hostname: string) => hostname.replace(/^\[|\]$/g, '').toLowerCase();

const localAddresses = () => Object.values(os.networkInterfaces())
  .flatMap((addresses) => addresses ?? [])
  .map((address) => address.address.toLowerCase());

export const isSameMachineUrl = (url: string, addresses = localAddresses()) => {
  const hostname = hostnameOf(url);
  if (!hostname) return false;
  return isLoopbackHostname(hostname) || addresses.includes(bareAddress(hostname));
};

const decodeDirectory = (value: string | string[]) => {
  try {
    return decodeURIComponent(String(value));
  } catch {
    return value;
  }
};

const headerDirectoryOf = (req: Request) => {
  const header = req.headers['x-opencode-directory'];
  return header ? decodeDirectory(header) : null;
};

const openCodeDirectoryOf = (req: Request) => (
  new URL(req.originalUrl, 'http://localhost').searchParams.get('location[directory]') || headerDirectoryOf(req)
);

const directoryRequest = (directory: string | string[] | null) => ({
  get: (name: string) => (name === 'x-opencode-directory' ? directory : null),
  query: {},
});

const browserOriginOf = (req: Request) => {
  try {
    const url = new URL(String(requestOrigin(req)));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
};

const mcpOAuthCallbackPath = <Name>(name: Name) => `/api/mcp/oauth/${name}/callback`;

const isUsablePort = (port: number | undefined): port is number => Number.isInteger(port) && Number(port) > 0 && Number(port) <= 65535;

const listenOnLoopback = (port: number | undefined) => new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.unref();
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const bound = isAddressInfo(address) ? address.port : 0;
    server.close(() => resolve(bound));
  });
});

const isLoopbackPortFree = (port: number | undefined) => listenOnLoopback(port).then(() => true, () => false);

const allocateLoopbackPort = async (takenPorts: Set<number | undefined>) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await listenOnLoopback(0);
    if (port && !takenPorts.has(port)) return port;
  }
  throw new Error('Could not allocate an MCP callback port');
};

const createAssignmentStore = (storePath: string) => ({
  read: async () => {
    let text;
    try {
      text = await fsPromises.readFile(storePath, 'utf8');
    } catch (error) {
      if (optionalFields(error)?.code === 'ENOENT') return {};
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    const assignments = optionalFields(parsed)?.assignments;
    if (!isJsonObject(assignments)) throw new Error(`${storePath} has no assignments`);
    return assignments;
  },
  write: (assignments: AssignmentTable) => {
    writeFileAtomic(storePath, `${JSON.stringify({ assignments }, null, 2)}\n`);
  },
});

const ownsRouting = (assignments: AssignmentTable, name: WireFields['name'], oauth: McpOAuth | undefined) => {
  const assignment = optionalFields(assignments[String(oauth?.callback_port)]);
  return assignment?.name === name && requiredFields(assignment, 'redirectUri').redirectUri === oauth?.redirect_uri;
};

const planSignIn = ({ oauth, owned, relay, origin, sameMachine }: {
  oauth: McpOAuth | undefined; owned: boolean; relay: boolean; origin: string | null; sameMachine: boolean;
}) => {
  const configured = Boolean(oauth?.redirect_uri || oauth?.callback_port);
  if (configured && !owned) return 'proxy';
  if (!sameMachine) return { pasteOnly: OFF_MACHINE_REFUSAL };
  if (relay) return owned ? 'track' : { pasteOnly: RELAY_REFUSAL };
  if (!origin || isLoopbackHostname(hostnameOf(origin))) return owned ? 'track' : 'proxy';
  if (origin.startsWith('http:')) return owned ? 'track' : 'pasteOrPrepare';
  return 'prepare';
};

const forwardedQuery = (params: URLSearchParams) => {
  const forwarded = new URLSearchParams();
  for (const key of CALLBACK_QUERY_KEYS) {
    for (const value of params.getAll(key)) {
      forwarded.append(key, value);
    }
  }
  return forwarded.toString();
};

const sendUpstream = async (res: HttpResponse, upstream: Response) => {
  res.status(upstream.status);
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.setHeader('content-type', contentType);
  return res.send(Buffer.from(await upstream.arrayBuffer()));
};

const refuse = (res: HttpResponse, status: number, message: string) => res.status(status).json({ _tag: 'InvalidRequestError', message, kind: 'mcp_oauth' });

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

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
}: McpOAuthDependencies) => {
  const assignmentStore = createAssignmentStore(storePath);
  const attemptsByState = new Map<string, BoundAttempt>();
  let preparing: Promise<void | Routing | { replan: true }> = Promise.resolve();

  const pruneAttempts = () => {
    const now = Date.now();
    for (const [state, attempt] of attemptsByState) {
      if (attempt.expiresAt <= now) attemptsByState.delete(state);
    }
  };

  const callOpenCode = (req: Request, method: string, path: string, body?: string) => {
    const headers = collectForwardProxyHeaders(req.headers, getOpenCodeAuthHeaders());
    delete headers['x-opencode-directory-encoding'];
    const directory = headerDirectoryOf(req);
    if (directory) headers['x-opencode-directory'] = encodeURIComponent(String(directory));
    headers['accept-encoding'] = 'identity';
    return fetch(buildOpenCodeUrl(path, ''), {
      method,
      headers,
      body: body ?? null,
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  };

  const cancelUpstream = <AttemptID>(req: Request, integrationID: string, attemptID: AttemptID, search: string) => (
    callOpenCode(req, 'DELETE', `/api/integration/${integrationID}/connect/oauth/${attemptID}${search}`)
      .then(() => {}, () => {})
  );

  const supersedeAttempts = async (req: Request, serverKey: string, search: string) => {
    const cancelled = [];
    for (const [state, attempt] of attemptsByState) {
      if (attempt.serverKey !== serverKey) continue;
      attemptsByState.delete(state);
      cancelled.push(cancelUpstream(req, attempt.integrationID, attempt.attemptID, search));
    }
    await Promise.all(cancelled);
  };

  const assignRouting = async ({ name, directory, entry, origin }: RoutingInput): Promise<Routing | { replan: true }> => {
    const entryChanged = () => !isDeepStrictEqual(getMcpConfig(name, directory), entry);
    if (entryChanged()) return { replan: true };

    const assignments = await assignmentStore.read();
    const redirectUri = `${origin}${mcpOAuthCallbackPath(name)}`;
    const oauth = entry.oauth || undefined;
    const current = ownsRouting(assignments, name, oauth) ? requiredOAuth(oauth, 'callback_port').callback_port : null;

    const otherEntries = listMcpConfigs(directory).filter((candidate) => candidate.name !== name);
    const takenPorts = new Set<number | undefined>([
      ...Object.keys(assignments).map(Number),
      ...otherEntries.map((candidate) => (candidate.oauth || undefined)?.callback_port).filter(isUsablePort),
      ...Array.from(attemptsByState.values(), (attempt) => attempt.port),
    ]);
    if (current !== null) takenPorts.delete(current);
    const collides = otherEntries.some((candidate) => (candidate.oauth || undefined)?.callback_port === current);

    const keepsPort = current !== null && !collides && await isPortFree(current);
    const port = keepsPort ? current : await allocatePort(takenPorts);
    if (entryChanged()) return { replan: true };
    if (port === current && redirectUri === oauth?.redirect_uri) {
      return { redirectUri, port, written: false };
    }

    const nextAssignments: AssignmentTable = { ...assignments };
    if (current !== null) delete nextAssignments[String(current)];
    nextAssignments[String(port)] = { name, redirectUri };
    assignmentStore.write(nextAssignments);
    updateMcpConfig(name, {
      oauth: { ...oauth, redirect_uri: redirectUri, callback_port: port },
    }, directory);
    return { redirectUri, port, written: true };
  };

  const prepareRouting = (input: RoutingInput) => {
    const result = preparing.then(() => assignRouting(input));
    preparing = result.catch(() => {});
    return result;
  };

  const startBoundAttempt = async ({ req, res, integrationID, search, name, serverKey, routing }: StartInput & { name: string; serverKey: string; routing: Routing }) => {
    const body = JSON.stringify(req.body ?? {});
    const deadline = Date.now() + configPickupTimeoutMs;
    const path = `/api/integration/${integrationID}/connect/oauth${search}`;
    let retryDelay = configPickupRetryMs;
    const waitForPickup = async () => {
      await sleep(retryDelay);
      retryDelay *= 2;
    };

    for (;;) {
      const upstream = await callOpenCode(req, 'POST', path, body);
      const retriable = Date.now() < deadline;
      if (!upstream.ok) {
        if (routing.written && retriable) {
          await waitForPickup();
          continue;
        }
        return sendUpstream(res, upstream);
      }

      const payload: unknown = await upstream.json();
      const data = optionalFields(payload)?.data;
      const attempt = requiredFields(isRecord(data) ? data : payload, 'url');
      const authorization = new URL(String(attempt.url));
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

      const expires = optionalFields(attempt.time)?.expires;
      attemptsByState.set(state, {
        name,
        serverKey,
        integrationID,
        attemptID: attempt.attemptID,
        port: routing.port,
        path: new URL(String(routing.redirectUri)).pathname,
        expiresAt: isFiniteNumber(expires)
          ? expires
          : Date.now() + ATTEMPT_LIFETIME_MS,
      });
      return res.status(upstream.status).json(payload);
    }
  };

  const startPasteOnlyAttempt = async ({ req, res, integrationID, search, refusal }: StartInput & { refusal: string | null }) => {
    const path = `/api/integration/${integrationID}/connect/oauth${search}`;
    const upstream = await callOpenCode(req, 'POST', path, JSON.stringify(req.body ?? {}));
    if (!upstream.ok) return sendUpstream(res, upstream);
    const payload: unknown = await upstream.json();
    const data = optionalFields(payload)?.data;
    const attempt = optionalFields(isRecord(data) ? data : payload);
    if (attempt?.paste === true) return res.status(upstream.status).json(payload);
    if (attempt?.attemptID) await cancelUpstream(req, integrationID, attempt.attemptID, search);
    return refusal ? refuse(res, 400, refusal) : null;
  };

  const readMcpServerName = async (req: Request, integrationID: string, search: string) => {
    const upstream = await callOpenCode(req, 'GET', `/api/integration/${integrationID}${search}`);
    if (!upstream.ok) return { upstream };
    const payload: unknown = await upstream.json();
    const data = optionalFields(payload)?.data;
    const integration = optionalFields(isRecord(data) ? data : payload);
    return { name: optionalFields(integration?.metadata)?.source === 'mcp' && isString(integration?.name) ? integration.name : null };
  };

  const startSignIn = async (req: Request<unknown, { integrationID: string }>, res: HttpResponse, next: NextFunction, readBody: McpOAuthBodyReader['readBody']) => {
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
        if (plan !== 'track' && plan !== 'pasteOrPrepare' && plan !== 'prepare') {
          return await startPasteOnlyAttempt({ req, res, integrationID, search, refusal: plan.pasteOnly });
        }
        if (plan === 'pasteOrPrepare') {
          const sent = await startPasteOnlyAttempt({ req, res, integrationID, search, refusal: null });
          if (sent) return sent;
        }

        pruneAttempts();
        await supersedeAttempts(req, serverKey, search);
        const routing = plan === 'track'
          ? { redirectUri: requiredOAuth(entry.oauth, 'redirect_uri').redirect_uri, port: requiredOAuth(entry.oauth, 'callback_port').callback_port, written: false }
          : await prepareRouting({ name, directory, entry, origin: browserOriginOf(req) });
        if (!routing.replan) {
          return await startBoundAttempt({ req, res, integrationID, search, name, serverKey, routing });
        }
      }
      return refuse(res, 503, CHANGING_CONFIG_REFUSAL);
    } catch (error) {
      console.error(`[mcp-oauth] sign-in start failed: ${optionalFields(error)?.message ?? error}`);
      if (res.headersSent) return undefined;
      return refuse(res, 502, 'OpenChamber could not prepare this MCP sign-in. Check the server log and try again.');
    }
  };

  const forgetAttempt = (attemptID: string | undefined) => {
    for (const [state, attempt] of attemptsByState) {
      if (attempt.attemptID === attemptID) attemptsByState.delete(state);
    }
  };

  const claimAttempt = (name: string | undefined, state: string | null) => {
    pruneAttempts();
    const attempt = state ? attemptsByState.get(state) : undefined;
    if (!attempt || attempt.name !== name) return null;
    if (state) attemptsByState.delete(state);
    return attempt;
  };

  return {
    registerCallbackRoute: (app: Application) => {
      app.get('/api/mcp/oauth/:name/callback', async (req, res) => {
        const params = new URL(req.originalUrl || req.url || '', 'http://127.0.0.1').searchParams;
        const attempt = claimAttempt(req.params.name, params.get('state'));
        if (!attempt) {
          return res.status(400).type('text/plain').send(INVALID_CALLBACK_MESSAGE);
        }

        const target = `http://127.0.0.1:${attempt.port}${attempt.path}?${forwardedQuery(params)}`;
        try {
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

    registerStartRoutes: (app: Application, { readBody }: McpOAuthBodyReader) => {
      app.post<unknown, { integrationID: string }>('/api/integration/:integrationID/connect/oauth', async (req, res, next) => {
        await startSignIn(req, res, next, readBody);
      });
      app.delete('/api/integration/:integrationID/connect/oauth/:attemptID', (req, _res, next) => {
        forgetAttempt(req.params.attemptID);
        next();
      });
    },
  };
};
