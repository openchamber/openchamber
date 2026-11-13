import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

import { startTrackerServer, type TrackerServer } from '../examples/tracker-provider/tracker-server';
import { trackerProviderSchemasV1 as schemas } from '../src/service-provider-schemas';
import {
  OPENCHAMBER_HOST_CALLBACK_URL,
  SOURCE_CONTROL_OUTBOUND_METHODS,
  TRACKER_OUTBOUND_PATH,
  TRACKER_PROVIDER_PATH,
  isTrackerProviderWriteMethod,
  type TrackerProviderDataByMethod,
  type TrackerProviderInputs,
  type TrackerProviderMethod,
} from '../src/service-providers';

// Runs the checked-in service bundle the way OpenChamber does: a loopback
// port and bearer, a callback listener that plays OpenChamber's outbound proxy
// (handle → server origin, token and allowed methods), and the example's fake
// tracker behind it.

const serviceEntry = fileURLToPath(new URL('../examples/tracker-provider/service/main.js', import.meta.url));
const PROVIDER = 'ext-tracker-provider';
const READ_ONLY: readonly string[] = ['GET'];

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = Object(server.address());
    server.close(() => resolve(Number(port)));
  });
});

let tracker: TrackerServer;
let service: ChildProcess;
let servicePort: number;
const serviceToken = randomBytes(16).toString('hex');
const handles = new Map<string, { origin: string; token: string | null; methods: readonly string[] }>();
let callback: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  tracker = await startTrackerServer({ token: 'demo' });
  callback = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const grant = handles.get((request.headers.get('authorization') ?? '').replace(/^Bearer /, ''));
      if (new URL(request.url).pathname !== TRACKER_OUTBOUND_PATH || !grant) {
        return Response.json({ error: { message: 'Unknown handle', code: 'HANDLE_UNKNOWN' } }, { status: 403 });
      }
      const outbound = schemas.outboundRequest.safeParse(await request.json());
      if (!outbound.success) return Response.json({ error: { message: 'Malformed request', code: 'BAD_REQUEST' } }, { status: 400 });
      if (!grant.methods.includes(outbound.data.method)) {
        return Response.json({ error: { message: `A read's handle sends GET; ${outbound.data.method} is refused`, code: 'METHOD_NOT_ALLOWED' } }, { status: 403 });
      }
      const url = new URL(outbound.data.path, grant.origin);
      if (url.origin !== grant.origin) return Response.json({ error: { message: 'Off the instance', code: 'OFF_ORIGIN' } }, { status: 403 });
      for (const [key, value] of Object.entries(outbound.data.query ?? {})) url.searchParams.set(key, value);
      const headers = new Headers(outbound.data.headers);
      if (grant.token) headers.set('authorization', `Bearer ${grant.token}`);
      const answer = await fetch(url, { method: outbound.data.method, headers, body: outbound.data.body, redirect: 'manual' });
      return Response.json({ status: answer.status, headers: { 'content-type': answer.headers.get('content-type') ?? '' }, body: await answer.text() });
    },
  });
  servicePort = await freePort();
  service = spawn('node', [serviceEntry], {
    env: {
      PATH: process.env.PATH,
      OPENCHAMBER_SERVICE_PORT: String(servicePort),
      OPENCHAMBER_SERVICE_TOKEN: serviceToken,
      [OPENCHAMBER_HOST_CALLBACK_URL]: `http://127.0.0.1:${callback.port}`,
    },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await fetch(`http://127.0.0.1:${servicePort}/health`, { headers: { authorization: `Bearer ${serviceToken}` } })
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) return;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  throw new Error('the tracker provider service did not become ready');
});

afterAll(async () => {
  service?.kill();
  callback?.stop(true);
  await tracker?.close();
});

const ACCOUNT = { id: 'u1', login: 'mona' };
let requests = 0;
type CallOptions<M extends TrackerProviderMethod> = {
  token: string | null;
  account?: { id: string; login: string | null } | null;
  input?: TrackerProviderInputs[M];
  /** What the handle may send; OpenChamber's rule unless a test overrides it. */
  methods?: readonly string[];
};
/** One forwarded call with a fresh handle, the way OpenChamber mints one per call. */
const call = async <M extends TrackerProviderMethod>(method: M, { token, account = null, input, methods }: CallOptions<M>) => {
  const handle = randomBytes(16).toString('base64url');
  handles.set(handle, { origin: tracker.origin, token, methods: methods ?? (isTrackerProviderWriteMethod(method) ? SOURCE_CONTROL_OUTBOUND_METHODS : READ_ONLY) });
  try {
    const response = await fetch(`http://127.0.0.1:${servicePort}${TRACKER_PROVIDER_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, requestId: `req-${requests += 1}`, method, provider: PROVIDER, session: { instance: tracker.origin, handle, account }, input: input ?? {} }),
    });
    expect(response.status).toBe(200);
    return schemas.envelope.parse(await response.json());
  } finally {
    handles.delete(handle);
  }
};

/** A call as the connected account that must succeed; its `data` parsed the way OpenChamber parses it. */
const read = async <M extends TrackerProviderMethod>(method: M, input: TrackerProviderInputs[M]) => {
  const result = await call(method, { token: 'demo', account: ACCOUNT, input });
  if (!result.ok) throw new Error(`${method} failed: ${result.error.message}`);
  const parsed = schemas.data[method].safeParse(result.data);
  if (!parsed.success) throw new Error(`${method} does not match its schema: ${parsed.error.message}`);
  // SAFETY: `schemas.data[method]` is the schema of this method's answer, asserted against the SDK type in the schemas module.
  return parsed.data as TrackerProviderDataByMethod[M];
};

const LIST: TrackerProviderInputs['items.list'] = { state: 'open', people: 'any', priority: 'all', containerId: null };

describe('tracker provider example', () => {
  test('probes the server without a token and verifies who a token belongs to', async () => {
    expect(await call('auth.probe', { token: null })).toEqual({ ok: true, data: { supported: true } });
    const verified = await call('auth.verify', { token: 'demo' });
    expect(verified.ok && schemas.data['auth.verify'].parse(verified.data)).toEqual({ account: { id: 'u1', login: 'mona', name: 'Mona Teapot' } });
    const refused = await call('auth.verify', { token: 'wrong' });
    expect(refused).toMatchObject({ ok: false, error: { status: 401 } });
  });

  test('lists items by filter, two a page, and follows the cursor to the second page', async () => {
    const mine = await read('items.list', { ...LIST, people: 'me' });
    expect(mine.items.map((item) => item.identifier)).toEqual(['TEA-1', 'OPS-1']);
    expect(mine).toMatchObject({ cursor: null, hasMore: false });
    expect(mine.items[0]).toMatchObject({
      id: 'it-101', title: 'Steep timer loses a second each minute', url: `${tracker.origin}/items/TEA-1`,
      state: { id: 'p-tea-unstarted', name: 'Todo', category: 'todo' }, priority: 'high',
      labels: [{ id: 'l-bug', name: 'bug', color: '#e5484d' }], assignee: { name: 'Mona Teapot', avatarUrl: null },
      container: { id: 'p-tea', key: 'TEA', name: 'Teaboard' },
    });
    expect('provider' in mine.items[0]).toBe(false);

    expect((await read('items.list', { ...LIST, state: 'all', priority: 'high' })).items.map((item) => item.identifier)).toEqual(['TEA-1']);
    expect((await read('items.list', { ...LIST, state: 'all', query: 'kettle' })).items.map((item) => item.identifier)).toEqual(['TEA-3']);
    expect((await read('items.list', { ...LIST, state: 'done' })).items.map((item) => item.identifier)).toEqual(['TEA-3']);

    const first = await read('items.list', { ...LIST, state: 'all', containerId: 'p-tea' });
    expect(first.items.map((item) => item.identifier)).toEqual(['TEA-1', 'TEA-2']);
    expect(first.hasMore).toBe(true);
    expect(first.cursor).not.toBeNull();
    const second = await read('items.list', { ...LIST, state: 'all', containerId: 'p-tea', cursor: first.cursor ?? undefined });
    expect(second.items.map((item) => item.identifier)).toEqual(['TEA-3', 'TEA-4']);
    expect(second).toMatchObject({ cursor: null, hasMore: false });
  });

  test('reads one item with its comments, lists its container states, and changes its state', async () => {
    const { item } = await read('items.get', { id: 'it-101' });
    expect(item).toMatchObject({
      identifier: 'TEA-1', description: 'Over a ten minute steep the timer ends nine seconds early. The interval is 999 ms.',
      comments: [{ id: 'c-1', body: 'Reproduced with the kitchen clock.', createdAt: '2026-10-30T09:10:00.000Z', author: { name: 'Octo Kettle', avatarUrl: null } }],
    });
    expect(await read('items.get', { id: 'it-999' })).toEqual({ item: null });

    const { states } = await read('states.list', { containerId: 'p-tea' });
    expect(states.map((state) => [state.id, state.name, state.category, state.position])).toEqual([
      ['p-tea-triage', 'Triage', 'triage', 0], ['p-tea-backlog', 'Backlog', 'backlog', 1], ['p-tea-unstarted', 'Todo', 'todo', 2],
      ['p-tea-started', 'In Progress', 'in-progress', 3], ['p-tea-completed', 'Done', 'done', 4], ['p-tea-cancelled', 'Canceled', 'canceled', 5],
    ]);

    const updated = await read('items.updateState', { id: 'it-101', stateId: 'p-tea-started' });
    expect(updated.item).toMatchObject({ identifier: 'TEA-1', state: { id: 'p-tea-started', name: 'In Progress', category: 'in-progress' } });
    expect(tracker.state.items.find((candidate) => candidate.id === 'it-101')?.stateId).toBe('p-tea-started');
    expect(await read('items.updateState', { id: 'it-999', stateId: 'p-tea-started' })).toEqual({ item: null });
    const wrongProject = await call('items.updateState', { token: 'demo', account: ACCOUNT, input: { id: 'it-101', stateId: 'p-ops-started' } });
    expect(wrongProject).toMatchObject({ ok: false, error: { status: 400 } });
  });

  test('lists containers and the live summaries of the identifiers it knows, upper-cased', async () => {
    expect(await read('containers.list', {})).toEqual({ containers: [
      { id: 'p-tea', key: 'TEA', name: 'Teaboard' }, { id: 'p-ops', key: 'OPS', name: 'Operations' },
    ] });
    expect(await read('items.liveSummaries', { identifiers: ['tea-3', 'OPS-1', 'TEA-99'] })).toEqual({ items: [
      { identifier: 'TEA-3', title: 'Kettle whistles in the wrong key', state: { name: 'Done', category: 'done' } },
      { identifier: 'OPS-1', title: 'Rotate the pantry keys', state: { name: 'Triage', category: 'triage' } },
    ] });
  });

  test('posts a session comment on an item, and none on an identifier the server does not know', async () => {
    const body = 'OpenChamber session started: http://127.0.0.1:3000/?session=ses_1';
    const { comment } = await read('comments.create', { identifier: 'TEA-2', body });
    expect(comment).toEqual({ id: expect.stringMatching(/^c-\d+$/) });
    expect(tracker.state.items.find((candidate) => candidate.key === 'TEA-2')?.comments).toEqual([
      { id: comment?.id, body, createdAt: expect.any(String), authorId: 'u1' },
    ]);
    expect(await read('comments.create', { identifier: 'TEA-99', body })).toEqual({ comment: null });
  });

  test('a write through a read-only handle is refused by the proxy and reported as an error', async () => {
    const before = tracker.state.items.find((candidate) => candidate.id === 'it-102')?.stateId;
    const refused = await call('items.updateState', { token: 'demo', account: ACCOUNT, input: { id: 'it-102', stateId: 'p-tea-completed' }, methods: READ_ONLY });
    expect(refused).toMatchObject({ ok: false, error: { status: 403, code: 'METHOD_NOT_ALLOWED' } });
    expect(tracker.state.items.find((candidate) => candidate.id === 'it-102')?.stateId).toBe(before);
  });

  test('refuses a body that is not a tracker call, and a caller without the bearer', async () => {
    const junk = await fetch(`http://127.0.0.1:${servicePort}${TRACKER_PROVIDER_PATH}`, {
      method: 'POST', headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' }, body: '{"hello":"world"}',
    });
    expect(junk.status).toBe(400);
    const anonymous = await fetch(`http://127.0.0.1:${servicePort}${TRACKER_PROVIDER_PATH}`, { method: 'POST', body: '{}' });
    expect(anonymous.status).toBe(401);
  });
});
