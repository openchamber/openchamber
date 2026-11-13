// A fake tracker for the Teaboard Tracker example: a loopback HTTP server
// that keeps two projects and six items in memory and answers a small JSON
// API behind one bearer. Run it with Bun, connect its address and token on
// the Teaboard card in Settings → Integrations, and search its items from the
// picker. It is a test double for the role's contract. Everything it keeps is
// lost when it stops.
import http from 'node:http';

/** Teaboard's own state kinds; the service maps them to OpenChamber's neutral categories. */
export type TeaboardStateKind = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled';
export type TeaboardPerson = { id: string; login: string; name: string };
export type TeaboardProject = { id: string; key: string; name: string };
export type TeaboardWorkflowState = { id: string; projectId: string; name: string; kind: TeaboardStateKind; position: number };
export type TeaboardLabel = { id: string; name: string; color: string };
export type TeaboardComment = { id: string; body: string; createdAt: string; authorId: string };
export type TeaboardItem = {
  id: string;
  /** The human key, `TEA-1`; matched case-insensitively. */
  key: string;
  projectId: string;
  title: string;
  description: string;
  stateId: string;
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: 0 | 1 | 2 | 3 | 4;
  labels: TeaboardLabel[];
  assigneeId: string | null;
  creatorId: string;
  /** ISO 8601. */
  updatedAt: string;
  comments: TeaboardComment[];
};

/** Everything the server keeps. Tests read it to see a write land; writes change it in place. */
export type TrackerServerState = {
  /** Who the accepted token belongs to. */
  account: TeaboardPerson;
  people: TeaboardPerson[];
  projects: TeaboardProject[];
  states: TeaboardWorkflowState[];
  items: TeaboardItem[];
};

export type TrackerServer = {
  /** `http://127.0.0.1:<port>`: the instance origin. */
  origin: string;
  token: string;
  state: TrackerServerState;
  close: () => Promise<void>;
};

/** Items in one `/api/items` page; small so a listing of six items has a second page. */
const PAGE_SIZE = 2;

const KINDS: readonly TeaboardStateKind[] = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'cancelled'];
const STATE_NAMES = {
  triage: 'Triage', backlog: 'Backlog', unstarted: 'Todo', started: 'In Progress', completed: 'Done', cancelled: 'Canceled',
} satisfies Record<TeaboardStateKind, string>;
const PEOPLE_FILTERS = ['anyone', 'assigned', 'created'] as const;

const MONA: TeaboardPerson = { id: 'u1', login: 'mona', name: 'Mona Teapot' };
const OCTO: TeaboardPerson = { id: 'u2', login: 'octo', name: 'Octo Kettle' };
const BUG: TeaboardLabel = { id: 'l-bug', name: 'bug', color: '#e5484d' };
const FEATURE: TeaboardLabel = { id: 'l-feature', name: 'feature', color: '#3e63dd' };
const DOCS: TeaboardLabel = { id: 'l-docs', name: 'docs', color: '#30a46c' };

const statesOf = (projectId: string): TeaboardWorkflowState[] => KINDS.map((kind, position) => ({
  id: `${projectId}-${kind}`, projectId, name: STATE_NAMES[kind], kind, position,
}));

/** A fresh copy of the sample data, so one server's writes never show on another. */
const createTrackerServerState = (): TrackerServerState => ({
  account: MONA,
  people: [MONA, OCTO],
  projects: [
    { id: 'p-tea', key: 'TEA', name: 'Teaboard' },
    { id: 'p-ops', key: 'OPS', name: 'Operations' },
  ],
  states: [...statesOf('p-tea'), ...statesOf('p-ops')],
  items: [
    {
      id: 'it-101', key: 'TEA-1', projectId: 'p-tea', title: 'Steep timer loses a second each minute',
      description: 'Over a ten minute steep the timer ends nine seconds early. The interval is 999 ms.',
      stateId: 'p-tea-unstarted', priority: 2, labels: [BUG], assigneeId: MONA.id, creatorId: OCTO.id, updatedAt: '2026-10-30T09:12:00.000Z',
      comments: [{ id: 'c-1', body: 'Reproduced with the kitchen clock.', createdAt: '2026-10-30T09:10:00.000Z', authorId: OCTO.id }],
    },
    {
      id: 'it-102', key: 'TEA-2', projectId: 'p-tea', title: 'Add oolong to the tea list',
      description: 'Oolong steeps at 90 °C for three minutes.',
      stateId: 'p-tea-started', priority: 3, labels: [FEATURE], assigneeId: OCTO.id, creatorId: MONA.id, updatedAt: '2026-10-29T16:40:00.000Z', comments: [],
    },
    {
      id: 'it-103', key: 'TEA-3', projectId: 'p-tea', title: 'Kettle whistles in the wrong key',
      description: 'It whistles a G. The manual says A.',
      stateId: 'p-tea-completed', priority: 4, labels: [BUG], assigneeId: MONA.id, creatorId: MONA.id, updatedAt: '2026-10-28T11:05:00.000Z', comments: [],
    },
    {
      id: 'it-104', key: 'TEA-4', projectId: 'p-tea', title: 'Write the brewing guide',
      description: '',
      stateId: 'p-tea-backlog', priority: 0, labels: [DOCS], assigneeId: null, creatorId: MONA.id, updatedAt: '2026-10-27T08:00:00.000Z', comments: [],
    },
    {
      id: 'it-201', key: 'OPS-1', projectId: 'p-ops', title: 'Rotate the pantry keys',
      description: 'The spare key went missing on Tuesday.',
      stateId: 'p-ops-triage', priority: 1, labels: [], assigneeId: MONA.id, creatorId: OCTO.id, updatedAt: '2026-10-30T07:30:00.000Z', comments: [],
    },
    {
      id: 'it-202', key: 'OPS-2', projectId: 'p-ops', title: 'Replace the broken shelf',
      description: 'The shelf was glued instead.',
      stateId: 'p-ops-cancelled', priority: 3, labels: [], assigneeId: OCTO.id, creatorId: MONA.id, updatedAt: '2026-10-26T13:20:00.000Z', comments: [],
    },
  ],
});

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Answer = { status: number; body: Json };

const ok = (body: Json): Answer => ({ status: 200, body });
const bad = (status: number, error: string): Answer => ({ status, body: { error } });

const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});

const parseJsonObject = (body: string): Record<string, Json> | null => {
  try {
    const parsed: Json = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const escapeHtml = (text: string): string => text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char);

/** The API routes with one path parameter. `/api/items/<id>/comments` takes the item's key. */
const ITEM_ROUTE = /^\/api\/items\/([^/]+)$/;
const ITEM_STATE_ROUTE = /^\/api\/items\/([^/]+)\/state$/;
const ITEM_COMMENTS_ROUTE = /^\/api\/items\/([^/]+)\/comments$/;
const PROJECT_STATES_ROUTE = /^\/api\/projects\/([^/]+)\/states$/;
/** An item's page: `/items/TEA-1`, or the same under any path, as the manifest's URL templates say. */
const ITEM_PAGE = /^(?:\/[^/]+)*\/items\/([^/]+)$/;

export const startTrackerServer = ({ token = 'demo', port = 0, log = (): void => {} }: { token?: string; port?: number; log?: (line: string) => void } = {}): Promise<TrackerServer> => new Promise((resolve, reject) => {
  const state = createTrackerServerState();
  let nextCommentId = 100;

  const personById = (id: string | null) => state.people.find((person) => person.id === id) ?? null;
  const projectById = (id: string) => state.projects.find((project) => project.id === id) ?? null;
  const stateById = (id: string) => state.states.find((workflowState) => workflowState.id === id) ?? null;
  const itemById = (id: string) => state.items.find((item) => item.id === id) ?? null;
  const itemByKey = (key: string) => state.items.find((item) => item.key.toLowerCase() === key.toLowerCase()) ?? null;
  /** An item's page and its state take the id or the key: OpenChamber asks by key when the user pastes a link or an identifier. */
  const itemByIdOrKey = (value: string) => itemById(value) ?? itemByKey(value);

  const personJson = (id: string | null): Json => {
    const person = personById(id);
    return person ? { name: person.name } : null;
  };
  const stateJson = (id: string): Json => {
    const workflowState = stateById(id);
    return workflowState ? { id: workflowState.id, name: workflowState.name, kind: workflowState.kind } : null;
  };
  const projectJson = (project: TeaboardProject): Json => ({ id: project.id, key: project.key, name: project.name });
  /** An item as the API answers it; a listing leaves out the description and the comments. */
  const itemJson = (item: TeaboardItem, full: boolean): Json => {
    const project = projectById(item.projectId);
    const summary = {
      id: item.id,
      key: item.key,
      title: item.title,
      state: stateJson(item.stateId),
      priority: item.priority,
      labels: item.labels.map((label) => ({ id: label.id, name: label.name, color: label.color })),
      assignee: personJson(item.assigneeId),
      project: project ? projectJson(project) : null,
      updatedAt: item.updatedAt,
    };
    if (!full) return summary;
    return {
      ...summary,
      description: item.description,
      comments: item.comments.map((comment) => ({ id: comment.id, body: comment.body, createdAt: comment.createdAt, author: personJson(comment.authorId) })),
    };
  };

  const listItems = (params: URLSearchParams): Answer => {
    const stateFilter = params.get('state') ?? 'open';
    const people = params.get('people') ?? 'anyone';
    const priority = params.get('priority') ?? 'all';
    const project = params.get('project');
    const query = (params.get('query') ?? '').trim().toLowerCase();
    const cursor = params.get('cursor');
    if (stateFilter !== 'open' && stateFilter !== 'all' && !KINDS.some((kind) => kind === stateFilter)) return bad(400, `unknown state filter "${stateFilter}"`);
    if (!PEOPLE_FILTERS.some((filter) => filter === people)) return bad(400, `unknown people filter "${people}"`);
    if (priority !== 'all' && !/^[0-4]$/.test(priority)) return bad(400, `unknown priority "${priority}"`);
    if (project !== null && !projectById(project)) return bad(404, `no project "${project}"`);
    const offset = cursor === null ? 0 : Number(cursor);
    if (!Number.isInteger(offset) || offset < 0) return bad(400, `bad cursor "${cursor}"`);
    const matches = [...state.items]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .filter((item) => {
        const kind = stateById(item.stateId)?.kind;
        if (stateFilter === 'open') return kind !== 'completed' && kind !== 'cancelled';
        return stateFilter === 'all' || kind === stateFilter;
      })
      .filter((item) => people === 'anyone' || (people === 'assigned' ? item.assigneeId === state.account.id : item.creatorId === state.account.id))
      .filter((item) => priority === 'all' || item.priority === Number(priority))
      .filter((item) => project === null || item.projectId === project)
      .filter((item) => !query || item.title.toLowerCase().includes(query) || item.key.toLowerCase().includes(query));
    const page = matches.slice(offset, offset + PAGE_SIZE);
    const end = offset + PAGE_SIZE;
    return ok({ items: page.map((item) => itemJson(item, false)), nextCursor: end < matches.length ? String(end) : null });
  };

  const updateState = (item: TeaboardItem, body: string): Answer => {
    const input = parseJsonObject(body);
    const stateId = input?.stateId;
    if (String(stateId) !== stateId) return bad(400, 'stateId is required');
    const target = stateById(stateId);
    if (!target || target.projectId !== item.projectId) return bad(400, `no state "${stateId}" in this project`);
    item.stateId = target.id;
    item.updatedAt = new Date().toISOString();
    log(`[state] ${item.key} → ${target.name}`);
    return ok(itemJson(item, true));
  };

  const addComment = (item: TeaboardItem, body: string): Answer => {
    const input = parseJsonObject(body);
    const text = input?.body;
    if (String(text) !== text || text.length === 0) return bad(400, 'body is required');
    const comment: TeaboardComment = { id: `c-${nextCommentId += 1}`, body: text, createdAt: new Date().toISOString(), authorId: state.account.id };
    item.comments.push(comment);
    item.updatedAt = comment.createdAt;
    log(`[comment] ${item.key}: ${text.split('\n')[0]}`);
    return { status: 201, body: { id: comment.id, body: comment.body, createdAt: comment.createdAt, author: personJson(comment.authorId) } };
  };

  const summaries = (params: URLSearchParams): Answer => {
    const keys = (params.get('identifiers') ?? '').split(',').map((key) => key.trim()).filter(Boolean);
    const items: Json[] = [];
    for (const key of keys) {
      const item = itemByKey(key);
      const workflowState = item ? stateById(item.stateId) : null;
      if (item && workflowState) items.push({ key: item.key, title: item.title, state: { name: workflowState.name, kind: workflowState.kind } });
    }
    return ok({ items });
  };

  /** One API call, authorized already. */
  const api = async (req: http.IncomingMessage, url: URL): Promise<Answer> => {
    const { pathname } = url;
    const method = req.method ?? 'GET';
    if (method === 'GET' && pathname === '/api/me') return ok({ id: state.account.id, login: state.account.login, name: state.account.name });
    if (method === 'GET' && pathname === '/api/items') return listItems(url.searchParams);
    if (method === 'GET' && pathname === '/api/projects') return ok({ projects: state.projects.map(projectJson) });
    if (method === 'GET' && pathname === '/api/summaries') return summaries(url.searchParams);
    const projectStates = pathname.match(PROJECT_STATES_ROUTE);
    if (method === 'GET' && projectStates) {
      const projectId = decodeURIComponent(projectStates[1]);
      if (!projectById(projectId)) return bad(404, `no project "${projectId}"`);
      return ok({ states: state.states.filter((workflowState) => workflowState.projectId === projectId).map((workflowState) => ({
        id: workflowState.id, name: workflowState.name, kind: workflowState.kind, position: workflowState.position,
      })) });
    }
    const one = pathname.match(ITEM_ROUTE);
    if (method === 'GET' && one) {
      const item = itemByIdOrKey(decodeURIComponent(one[1]));
      return item ? ok(itemJson(item, true)) : bad(404, 'no such item');
    }
    const stateRoute = pathname.match(ITEM_STATE_ROUTE);
    if (method === 'POST' && stateRoute) {
      const item = itemByIdOrKey(decodeURIComponent(stateRoute[1]));
      return item ? updateState(item, await readBody(req)) : bad(404, 'no such item');
    }
    const commentsRoute = pathname.match(ITEM_COMMENTS_ROUTE);
    if (method === 'POST' && commentsRoute) {
      const item = itemByKey(decodeURIComponent(commentsRoute[1]));
      return item ? addComment(item, await readBody(req)) : bad(404, 'no such item');
    }
    return bad(404, 'not found');
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = ({ status, body }: Answer) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/health') {
        send(ok({ teaboard: true }));
        return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        send(bad(401, 'unauthorized'));
        return;
      }
      api(req, url).then(send, () => send(bad(500, 'the request could not be read')));
      return;
    }
    const page = url.pathname.match(ITEM_PAGE);
    const item = page ? itemByKey(decodeURIComponent(page[1])) : null;
    if (!item) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${escapeHtml(item.key)}: ${escapeHtml(item.title)}</title><h1>${escapeHtml(item.key)}</h1><p>${escapeHtml(item.title)}</p>`);
  });
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;
    resolve({
      origin: `http://127.0.0.1:${boundPort}`,
      token,
      state,
      close: () => new Promise((done) => { server.close(() => done()); }),
    });
  });
});

if (import.meta.main) {
  const token = process.env.TEABOARD_TOKEN || 'demo';
  const server = await startTrackerServer({ token, port: Number(process.env.TEABOARD_PORT || 4568), log: (line) => console.log(line) });
  console.log(`Teaboard listening on ${server.origin}`);
  console.log(`Connect it on the Teaboard card under Extension accounts in Settings → Integrations with the address above and the token "${token}".`);
  console.log(`Items: ${server.state.items.map((item) => item.key).join(', ')}. An item's page is ${server.origin}/items/TEA-1.`);
}
