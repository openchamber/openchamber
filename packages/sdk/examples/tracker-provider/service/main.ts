// A work item tracker for OpenChamber, written against Teaboard's JSON API
// (`../tracker-server.ts`). OpenChamber keeps the accounts, their tokens, the
// project mapping and the session records; this service only turns each
// forwarded call into a request to the tracker's server and the server's
// answer into OpenChamber's neutral tracker shapes. It never sees a token:
// every request goes through OpenChamber's outbound proxy with the call's
// handle, and OpenChamber adds the credential and keeps the request on the
// account's server.
import http from 'node:http';

import {
  TRACKER_PROVIDER_ERROR_MESSAGE_MAX,
  TRACKER_PROVIDER_PATH,
  TrackerOutboundError,
  createTrackerOutbound,
  readTrackerProviderRequest,
  type SourceControlJsonObject,
  type SourceControlOutboundResponse,
  type TrackerProviderComment,
  type TrackerProviderContainer,
  type TrackerProviderDataByMethod,
  type TrackerProviderError,
  type TrackerProviderInputs,
  type TrackerProviderItem,
  type TrackerProviderItemSummary,
  type TrackerProviderLiveSummary,
  type TrackerProviderMethod,
  type TrackerProviderPriority,
  type TrackerProviderResult,
  type TrackerProviderStateCategory,
  type TrackerProviderWorkflowState,
} from '@openchamber/sdk';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const serviceToken = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!port || !serviceToken) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}
const outbound = createTrackerOutbound({ env: process.env });

// The parts of Teaboard's JSON this service reads.
type TeaboardKind = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled';
type TeaboardAccount = { id: string; login: string; name?: string };
type TeaboardProject = { id: string; key: string; name: string };
type TeaboardState = { id: string; name: string; kind: TeaboardKind; position: number };
type TeaboardLabel = { id: string; name: string; color?: string | null };
type TeaboardPerson = { name: string };
type TeaboardComment = { id: string; body: string; createdAt: string; author: TeaboardPerson | null };
type TeaboardItem = {
  id: string; key: string; title: string; description?: string; state: TeaboardState | null; priority: number;
  labels: TeaboardLabel[]; assignee: TeaboardPerson | null; project: TeaboardProject | null; updatedAt: string; comments?: TeaboardComment[];
};
type TeaboardPage = { items: TeaboardItem[]; nextCursor: string | null };
type TeaboardSummary = { key: string; title: string; state: { name: string; kind: TeaboardKind } };

// Teaboard's words to OpenChamber's.
const CATEGORY = {
  triage: 'triage', backlog: 'backlog', unstarted: 'todo', started: 'in-progress', completed: 'done', cancelled: 'canceled',
} satisfies Record<TeaboardKind, TrackerProviderStateCategory>;
/** Teaboard's priority is a number, 0 none to 4 low. */
const PRIORITY: readonly TrackerProviderPriority[] = ['none', 'urgent', 'high', 'medium', 'low'];
/** The manifest's `stateFilters` as Teaboard's `/api/items?state=` takes them. */
const STATE_FILTER = new Map<string, string>([['open', 'open'], ['all', 'all'], ['todo', 'unstarted'], ['in-progress', 'started'], ['done', 'completed']]);
const PEOPLE_FILTER = { any: 'anyone', me: 'assigned', created: 'created' } satisfies Record<TrackerProviderInputs['items.list']['people'], string>;

/** Who a call is for: the server it reaches and the handle that reaches it. */
type Call = { instance: string; handle: string };

/** A failed call, answered as `{ ok: false, error }` with this status. */
class CallError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** A server 4xx or 5xx as a `CallError` with that status and the server's own message when it gave one. */
const serverFailure = (response: SourceControlOutboundResponse): CallError => {
  if (response.status === 401) return new CallError('Teaboard refused the credential.', 401);
  let message = `Teaboard answered ${response.status}.`;
  try {
    const parsed: { error?: string } = JSON.parse(response.body);
    if (parsed.error) message = `Teaboard answered ${response.status}: ${parsed.error}`;
  } catch {
    // The status says enough.
  }
  return new CallError(message, response.status);
};

/** One request to the server through OpenChamber's proxy, its JSON answer parsed. A 4xx or 5xx becomes a `CallError`. */
const api = async <T,>(
  call: Call,
  method: 'GET' | 'POST',
  path: string,
  options: { query?: Record<string, string>; body?: SourceControlJsonObject } = {},
): Promise<T> => {
  const response = await outbound.request(call.handle, {
    method,
    path,
    query: options.query,
    headers: options.body ? { accept: 'application/json', 'content-type': 'application/json' } : { accept: 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status >= 400) throw serverFailure(response);
  try {
    const data: T = JSON.parse(response.body);
    return data;
  } catch {
    throw new CallError('Teaboard answered with something other than JSON.', 502);
  }
};

/** The answer, or null when the server has no such item. */
const orNull = async <T,>(request: Promise<T>): Promise<T | null> => {
  try {
    return await request;
  } catch (error) {
    if (error instanceof CallError && error.status === 404) return null;
    throw error;
  }
};

const seg = encodeURIComponent;

// ---------------------------------------------------------------------------
// Teaboard JSON to the neutral shapes. Identifiers go out upper-case, the
// form OpenChamber compares them in.

const toContainer = (project: TeaboardProject): TrackerProviderContainer => ({ id: project.id, key: project.key, name: project.name });

const toPerson = (person: TeaboardPerson | null) => (person ? { name: person.name, avatarUrl: null } : null);

const toSummary = (call: Call, raw: TeaboardItem): TrackerProviderItemSummary => {
  const identifier = raw.key.toUpperCase();
  return {
    id: raw.id,
    identifier,
    title: raw.title,
    url: `${call.instance}/items/${seg(identifier)}`,
    state: raw.state ? { id: raw.state.id, name: raw.state.name, category: CATEGORY[raw.state.kind] ?? null } : null,
    priority: PRIORITY[raw.priority] ?? 'none',
    labels: raw.labels.map((label) => ({ id: label.id, name: label.name, color: label.color ?? null })),
    assignee: toPerson(raw.assignee),
    container: raw.project ? toContainer(raw.project) : null,
    updatedAt: raw.updatedAt,
  };
};

const toComment = (raw: TeaboardComment): TrackerProviderComment => ({ id: raw.id, body: raw.body, createdAt: raw.createdAt, author: toPerson(raw.author) });

const toItem = (call: Call, raw: TeaboardItem | null): TrackerProviderItem | null => (raw ? {
  ...toSummary(call, raw),
  description: raw.description ?? null,
  comments: (raw.comments ?? []).map(toComment),
} : null);

const toWorkflowState = (raw: TeaboardState): TrackerProviderWorkflowState => ({ id: raw.id, name: raw.name, category: CATEGORY[raw.kind] ?? null, position: raw.position });

const toLiveSummary = (raw: TeaboardSummary): TrackerProviderLiveSummary => ({
  identifier: raw.key.toUpperCase(),
  title: raw.title,
  state: { name: raw.state.name, category: CATEGORY[raw.state.kind] ?? 'todo' },
});

// ---------------------------------------------------------------------------
// One handler per call, typed against the SDK: a wrong input field or answer
// shape fails the type-check.

type Handlers = {
  [M in TrackerProviderMethod]: (call: Call, input: TrackerProviderInputs[M]) => Promise<TrackerProviderDataByMethod[M]>;
};

const handlers: Handlers = {
  'auth.probe': async (call) => {
    // The health route needs no token: any server that says it is Teaboard is one this tracker can work with.
    const response = await outbound.request(call.handle, { method: 'GET', path: '/api/health', headers: { accept: 'application/json' } });
    if (response.status !== 200) return { supported: false, message: `${call.instance} answered ${response.status} to /api/health.` };
    let health: { teaboard?: unknown };
    try {
      health = Object(JSON.parse(response.body));
    } catch {
      return { supported: false, message: `${call.instance} is not a Teaboard server.` };
    }
    return health.teaboard === true ? { supported: true } : { supported: false, message: `${call.instance} is not a Teaboard server.` };
  },

  'auth.verify': async (call) => {
    const me = await api<TeaboardAccount>(call, 'GET', '/api/me');
    const account: TrackerProviderDataByMethod['auth.verify']['account'] = { id: me.id, login: me.login };
    if (me.name) account.name = me.name;
    return { account };
  },

  'items.list': async (call, input) => {
    const query = {
      state: STATE_FILTER.get(input.state) ?? input.state,
      people: PEOPLE_FILTER[input.people],
      priority: input.priority === 'all' ? 'all' : String(PRIORITY.indexOf(input.priority)),
      ...(input.query ? { query: input.query } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.containerId ? { project: input.containerId } : {}),
    };
    const page = await api<TeaboardPage>(call, 'GET', '/api/items', { query });
    return { items: page.items.map((item) => toSummary(call, item)), cursor: page.nextCursor, hasMore: page.nextCursor !== null };
  },

  'items.get': async (call, input) => ({
    item: toItem(call, await orNull(api<TeaboardItem>(call, 'GET', `/api/items/${seg(input.id)}`))),
  }),

  'items.updateState': async (call, input) => ({
    item: toItem(call, await orNull(api<TeaboardItem>(call, 'POST', `/api/items/${seg(input.id)}/state`, { body: { stateId: input.stateId } }))),
  }),

  'items.liveSummaries': async (call, input) => {
    const { items } = await api<{ items: TeaboardSummary[] }>(call, 'GET', '/api/summaries', { query: { identifiers: input.identifiers.join(',') } });
    return { items: items.map(toLiveSummary) };
  },

  'states.list': async (call, input) => {
    const { states } = await api<{ states: TeaboardState[] }>(call, 'GET', `/api/projects/${seg(input.containerId)}/states`);
    return { states: states.map(toWorkflowState) };
  },

  'containers.list': async (call) => {
    const { projects } = await api<{ projects: TeaboardProject[] }>(call, 'GET', '/api/projects');
    return { containers: projects.map(toContainer) };
  },

  'comments.create': async (call, input) => {
    const comment = await orNull(api<TeaboardComment>(call, 'POST', `/api/items/${seg(input.identifier)}/comments`, { body: { body: input.body } }));
    return { comment: comment ? { id: comment.id } : null };
  },
};

// ---------------------------------------------------------------------------
// The loopback server OpenChamber talks to.

const failureOf = (error: Error): TrackerProviderError => {
  const text = error.message;
  const failure: TrackerProviderError = { message: text.slice(0, TRACKER_PROVIDER_ERROR_MESSAGE_MAX) || 'Unexpected failure' };
  if (error instanceof TrackerOutboundError) {
    // OpenChamber refused the request (a write through a read's handle, a path off the server) or could not reach the server.
    if (error.status >= 400 && error.status <= 599) failure.status = error.status;
    if (/^[A-Z_]{1,64}$/.test(error.code)) failure.code = error.code;
  } else if (error instanceof CallError) {
    failure.status = error.status;
  }
  return failure;
};

const answer = async <M extends TrackerProviderMethod>(method: M, call: Call, input: SourceControlJsonObject): Promise<TrackerProviderResult> => {
  try {
    // SAFETY: OpenChamber built and checked `input` for `method`; its shape is `TrackerProviderInputs[M]`.
    const data = await handlers[method](call, input as TrackerProviderInputs[M]);
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: failureOf(error instanceof Error ? error : new Error(String(error))) };
  }
};

const send = (res: http.ServerResponse, status: number, body: TrackerProviderResult | { ok: true } | { error: string }): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${serviceToken}`) {
    send(res, 401, { error: 'unauthorized' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/health') {
    send(res, 200, { ok: true });
    return;
  }
  if (url.pathname !== TRACKER_PROVIDER_PATH || req.method !== 'POST') {
    send(res, 404, { error: 'not-found' });
    return;
  }
  readBody(req).then(async (body) => {
    const request = readTrackerProviderRequest(body);
    if (!request) {
      send(res, 400, { error: 'not a tracker call this service understands' });
      return;
    }
    send(res, 200, await answer(request.method, { instance: request.session.instance, handle: request.session.handle }, request.input));
  }).catch(() => send(res, 500, { error: 'could not read the request' }));
});

server.listen(port, '127.0.0.1');
