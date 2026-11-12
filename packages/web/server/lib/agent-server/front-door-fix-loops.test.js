import { Readable } from 'node:stream';
import express from 'express';
import request from 'supertest';
import { afterEach, expect, test, vi } from 'vitest';
import { frontDoorRequestGate } from './front-door.js';
import { classify } from './ownership.js';
import { registerFrontDoorFixLoopRoutes } from './front-door-fix-loops.js';
import { FIX_LOOP_BYTES, FIX_LOOP_ROUTE, FIX_LOOP_SERVICE_ROUTE } from './fix-loop-contract.js';
import { autoLoop, CONTEXT, PULL, TARGET } from './fix-loop-test-fixture.js';

const rawResponse = (text, statusCode = 200) => Object.assign(Readable.from([Buffer.from(text)]), { statusCode });
const response = (body, statusCode = 200) => rawResponse(JSON.stringify(body), statusCode);
function setup({ isSpaceSession = () => false } = {}) {
  const own = autoLoop('fixloop_owner'); own.config.pushMode = 'approval'; own.sessionId = 'ses_owner';
  const runtime = { load: vi.fn(async () => undefined), list: vi.fn(async () => [own]),
    ownsIdentity: (id) => ['fixloop_owner', 'worker-owner'].includes(id), ownsLoop: (id) => id === own.id,
    create: vi.fn(async (input) => ({ ...own, ...input })), prepareWorker: vi.fn(async () => ({ id: 'worker-owner' })),
    listPreparedWorkers: vi.fn(async () => [{ id: 'worker-owner' }]), forgetPreparedWorker: vi.fn(async () => ({ ok: true })),
    update: vi.fn(async () => own), stopLoop: vi.fn(async () => own), resume: vi.fn(async () => own),
    refresh: vi.fn(async () => own), approve: vi.fn(async () => own), remove: vi.fn(async () => ({ ok: true })) };
  const services = { admit: vi.fn(async () => ({ context: CONTEXT, pull: PULL })) };
  const upstream = { request: vi.fn(async (input) => response(input.method === 'GET' ? { loops: [autoLoop()] }
    : input.method === 'DELETE' ? { ok: true } : { loop: autoLoop() })) };
  const app = express(); app.use(frontDoorRequestGate); app.use(express.json());
  const readDefaults = vi.fn(async () => ({ pushMode: 'auto' }));
  const logger = { warn: vi.fn() };
  registerFrontDoorFixLoopRoutes(app, { runtime, services, upstream, readDefaults, isSpaceSession, logger, listProjectDirectories: async () => ['/repo'] });
  return { app, runtime, services, upstream, own, readDefaults, logger };
}
test('a worker prepared from a linked PR row drops the row fields the UI sends with it', async () => {
  // Given the body a linked PR row's dialog posts: the pull reference with its key, provider, instance and thread.
  const fixture = setup();
  const row = { key: 'github:upstream/app#7', provider: 'github', instance: 'github.com', thread: { kind: 'pull', number: 7 } };
  // When the worker is prepared, then it is, with only the named fields.
  await request(fixture.app).post(`${FIX_LOOP_ROUTE}/workers`).query(CONTEXT)
    .send({ ...TARGET, ...row, sessionId: 'ses_host', name: 'Worker', placeId: 'host', model: { providerID: 'openai', modelID: 'gpt-4.1' } }).expect(202);
  expect(fixture.runtime.prepareWorker).toHaveBeenCalledExactlyOnceWith({ sessionId: 'ses_host', directory: '/repo',
    model: { providerID: 'openai', modelID: 'gpt-4.1' }, name: 'Worker', placeId: 'host' });
  // And, once the owner's approval loop on that PR stopped, an automatic loop from the same row reaches the agent without them.
  fixture.own.status = 'stopped';
  await request(fixture.app).post(FIX_LOOP_ROUTE).query(CONTEXT).send({ ...TARGET, ...row, sessionId: 'ses_auto', config: { pushMode: 'auto' } }).expect(200);
  expect(JSON.parse(fixture.upstream.request.mock.calls.at(-1)[0].body)).toEqual({ ...TARGET, sessionId: 'ses_auto', config: { pushMode: 'auto' } });
});
test('the normalized fix-loop family is local even with a carried Space directory', async () => {
  const url = '/API/source-control/github/pr/fix-loops/workers';
  expect(classify({ method: 'POST', url, headers: { 'x-opencode-directory': '/spaces/aabbccddeeff/repo' } })).toBe('local');
  const fixture = setup();
  await request(fixture.app).post(`${FIX_LOOP_ROUTE}/workers`).query(CONTEXT)
    .send({ ...TARGET, sessionId: 'ses_host', name: 'Worker', model: { providerID: 'openai', modelID: 'gpt-4.1' } }).expect(202);
  expect(fixture.upstream.request).not.toHaveBeenCalled();
  expect(fixture.services.admit).toHaveBeenCalledExactlyOnceWith({ context: CONTEXT, ...TARGET });
  expect(fixture.runtime.prepareWorker.mock.calls[0][0]).not.toHaveProperty('snapshot');
});
test('explicit approval and persisted approval defaults create locally after bound admission while auto stays remote', async () => {
  const fixture = setup();
  fixture.own.number = 9;
  const elsewhere = { ...autoLoop(), sessionId: 'ses_other', number: 8 };
  fixture.upstream.request.mockImplementation(async (input) => response(input.method === 'GET' ? { loops: [elsewhere] } : { loop: autoLoop() }));
  const body = { ...TARGET, sessionId: 'ses_host', config: { pushMode: 'approval' } };
  await request(fixture.app).post(FIX_LOOP_ROUTE).query(CONTEXT).send(body).expect(200);
  expect(fixture.runtime.create.mock.calls[0][0]).toMatchObject({ accountId: 'account', readContext: CONTEXT, snapshot: PULL.snapshot });
  fixture.readDefaults.mockResolvedValue({ pushMode: 'approval' });
  await request(fixture.app).post(FIX_LOOP_ROUTE).query(CONTEXT).send({ ...TARGET, sessionId: 'ses_host' }).expect(200);
  expect(fixture.runtime.create).toHaveBeenCalledTimes(2);
  expect(fixture.upstream.request.mock.calls.map(([input]) => input.method)).toEqual(['GET', 'GET']);
  fixture.readDefaults.mockResolvedValue({ pushMode: 'auto' });
  await request(fixture.app).post(FIX_LOOP_ROUTE).query(CONTEXT).send({ ...TARGET, sessionId: 'ses_host' }).expect(200);
  // The mode the front door chose travels with the request, so the agent's own defaults cannot change it.
  const forwarded = fixture.upstream.request.mock.calls.at(-1)[0];
  expect(forwarded.method).toBe('POST');
  expect(JSON.parse(forwarded.body).config).toEqual({ pushMode: 'auto' });
  expect(fixture.services.admit).toHaveBeenCalledTimes(2);
});
test('an approval loop is refused while an agent loop holds its session or pull request', async () => {
  // Given agent loops that hold the same pull request, the same host session, or neither.
  const fixture = setup();
  const approval = { ...TARGET, sessionId: 'ses_host', config: { pushMode: 'approval' } };
  for (const held of [autoLoop(), { ...autoLoop(), number: 8, sessionId: 'ses_host' }]) {
    fixture.upstream.request.mockImplementation(async () => response({ loops: [held] }));
    // When the owner starts an approval loop, then it is refused before admission.
    const refused = await request(fixture.app).post(FIX_LOOP_ROUTE).query(CONTEXT).send(approval).expect(409);
    expect(refused.body.code).toBe('fix_loop_automation_conflict');
  }
  expect(fixture.services.admit).not.toHaveBeenCalled(); expect(fixture.runtime.create).not.toHaveBeenCalled();
  fixture.upstream.request.mockImplementation(async () => response({ loops: [{ ...autoLoop(), status: 'stopped' }] }));
  await request(fixture.app).post(FIX_LOOP_ROUTE).query(CONTEXT).send(approval).expect(200);
  expect(fixture.runtime.create).toHaveBeenCalledOnce();
});
test('an automatic loop is not forwarded while a local approval loop holds its session or pull request', async () => {
  // Given the owner's own approval loop on the same pull request.
  const fixture = setup();
  const auto = { ...TARGET, sessionId: 'ses_host', config: { pushMode: 'auto' } };
  // When an automatic loop is requested for it, then the agent never sees the request.
  expect((await request(fixture.app).post(FIX_LOOP_ROUTE).query(CONTEXT).send(auto).expect(409)).body.code).toBe('fix_loop_automation_conflict');
  expect(fixture.upstream.request).not.toHaveBeenCalled();
  // And once that loop stopped without a receipt, the request is forwarded.
  fixture.own.status = 'stopped';
  await request(fixture.app).post(FIX_LOOP_ROUTE).query(CONTEXT).send(auto).expect(200);
  expect(fixture.upstream.request).toHaveBeenCalledOnce();
});
test.each([
  ['patch', '', 'update', { config: { maxIterations: 3 } }], ['post', '/stop', 'stopLoop', {}],
  ['post', '/resume', 'resume', {}], ['post', '/refresh', 'refresh', {}],
  ['post', '/approve', 'approve', { receiptId: 'receipt' }], ['delete', '', 'remove', {}],
])('routes %s %s by local persisted loop ownership', async (method, suffix, action, body) => {
  const fixture = setup();
  await request(fixture.app)[method](`${FIX_LOOP_ROUTE}/fixloop_owner${suffix}`).send(body).expect(200);
  expect(fixture.runtime[action]).toHaveBeenCalledOnce(); expect(fixture.upstream.request).not.toHaveBeenCalled();
  if (suffix !== '/approve') {
    await request(fixture.app)[method](`${FIX_LOOP_ROUTE}/fixloop_agent${suffix}`).send(body).expect(200);
    expect(fixture.upstream.request).toHaveBeenCalledOnce();
  } else await request(fixture.app)[method](`${FIX_LOOP_ROUTE}/fixloop_agent${suffix}`).send(body).expect(404);
});
test('worker list and forget stay local and worker IDs never select an agent loop operation', async () => {
  const fixture = setup();
  expect((await request(fixture.app).get(`${FIX_LOOP_ROUTE}/workers`).expect(200)).body.workers).toEqual([{ id: 'worker-owner' }]);
  await request(fixture.app).delete(`${FIX_LOOP_ROUTE}/workers/worker-owner`).expect(200);
  await request(fixture.app).post(`${FIX_LOOP_ROUTE}/worker-owner/resume`).send({}).expect(404);
  expect(fixture.upstream.request).not.toHaveBeenCalled();
});
test('duplicate activation stays with its local approval owner when a default would otherwise select auto', async () => {
  const fixture = setup();
  fixture.own.sessionId = 'ses_host';
  await request(fixture.app).post(FIX_LOOP_ROUTE).query(CONTEXT).send({ ...TARGET, sessionId: 'ses_host' }).expect(200);
  expect(fixture.runtime.create).toHaveBeenCalledOnce(); expect(fixture.upstream.request).not.toHaveBeenCalled();
});
test('merged lists retain local approval entries, filter colliding IDs and strip remote unknown authority', async () => {
  const fixture = setup();
  fixture.upstream.request.mockResolvedValue(response({ loops: [autoLoop('fixloop_owner'), autoLoop('worker-owner'),
    { ...autoLoop(), internal: { authority: 'forged' }, accountId: 'private', spaceId: 'forged' }] }));
  const result = await request(fixture.app).get(FIX_LOOP_ROUTE).expect(200);
  expect(result.body.loops.map((loop) => loop.id)).toEqual(['fixloop_owner', 'fixloop_agent']);
  expect(result.body.loops[0].config.pushMode).toBe('approval');
  expect(JSON.stringify(result.body)).not.toMatch(/private|forged|authority/);
});
test.each(['worker', 'pendingApproval', 'review', 'mode'])('merged list leaves out an agent entry claiming %s approval authority, and only it', async (claim) => {
  // Given an agent list with one entry claiming approval authority, as a migrated approval record does, beside a plain one.
  const fixture = setup(); const loop = autoLoop('fixloop_claims');
  if (claim === 'mode') loop.config.pushMode = 'approval';
  else loop[claim] = { state: 'awaitingPublication', id: 'forged' };
  fixture.upstream.request.mockResolvedValue(response({ loops: [loop, autoLoop()] }));
  // When the owner lists, then the owner's loops and the plain agent loop stay.
  expect((await request(fixture.app).get(FIX_LOOP_ROUTE).expect(200)).body.loops.map((entry) => entry.id)).toEqual(['fixloop_owner', 'fixloop_agent']);
  expect(fixture.logger.warn).toHaveBeenCalledOnce();
});
test('list and remote mutation adapters refuse oversized, malformed, unreachable and substituted-ID replies', async () => {
  const fixture = setup();
  for (const value of ['{', 'a'.repeat(FIX_LOOP_BYTES + 1)]) {
    fixture.upstream.request.mockImplementation(async () => rawResponse(value));
    await request(fixture.app).get(FIX_LOOP_ROUTE).expect(502);
  }
  // Two entries under one id: neither can be told apart from a forgery, so both are left out.
  fixture.upstream.request.mockImplementation(async () => response({ loops: [autoLoop(), autoLoop(), autoLoop('fixloop_other')] }));
  expect((await request(fixture.app).get(FIX_LOOP_ROUTE).expect(200)).body.loops.map((entry) => entry.id)).toEqual(['fixloop_owner', 'fixloop_other']);
  fixture.upstream.request.mockImplementation(async () => { throw new Error('secret transport detail'); });
  expect((await request(fixture.app).get(FIX_LOOP_ROUTE).expect(502)).body).toEqual({ code: 'agent_fix_loop_operation_failed' });
  for (const id of ['fixloop_owner', 'fixloop_other']) {
    fixture.upstream.request.mockImplementation(async () => response({ loop: autoLoop(id) }));
    await request(fixture.app).post(`${FIX_LOOP_ROUTE}/fixloop_agent/stop`).send({}).expect(502);
  }
});
test('owner clients cannot enter the private service namespace and malformed creation grants no authority', async () => {
  const fixture = setup();
  await request(fixture.app).post(`${FIX_LOOP_SERVICE_ROUTE}/publish`).send({}).expect(403);
  await request(fixture.app).get(`${FIX_LOOP_SERVICE_ROUTE}/head-bundle`).expect(403);
  await request(fixture.app).post(FIX_LOOP_ROUTE).send({ ...TARGET, sessionId: 'ses_host', config: { pushMode: 'unsafe' } }).expect(400);
  expect(fixture.upstream.request).not.toHaveBeenCalled(); expect(fixture.services.admit).not.toHaveBeenCalled();
  // A field no route reads, such as a Space id, is dropped: it reaches neither runtime.
  const other = { ...TARGET, number: 9 };
  await request(fixture.app).post(FIX_LOOP_ROUTE).query(CONTEXT).send({ ...other, sessionId: 'ses_new', spaceId: 'forged', config: { pushMode: 'approval' } }).expect(200);
  expect(fixture.runtime.create.mock.calls[0][0]).not.toHaveProperty('spaceId');
  await request(fixture.app).post(FIX_LOOP_ROUTE).query(CONTEXT).send({ ...other, sessionId: 'ses_new2', spaceId: 'forged', config: { pushMode: 'auto' } }).expect(200);
  expect(JSON.parse(fixture.upstream.request.mock.calls.at(-1)[0].body)).not.toHaveProperty('spaceId');
});
test('agent auto list and mutation responses cannot claim an owner-indexed Space session', async () => {
  const fixture = setup({ isSpaceSession: (id) => id === 'ses_space' });
  const forged = { ...autoLoop('fixloop_fake'), sessionId: 'ses_space' };
  fixture.upstream.request.mockImplementation(async () => response({ loops: [forged, autoLoop()] }));
  expect((await request(fixture.app).get(FIX_LOOP_ROUTE).expect(200)).body.loops.map((loop) => loop.id))
    .toEqual(['fixloop_owner', 'fixloop_agent']);
  fixture.upstream.request.mockImplementation(async () => response({ loop: { ...forged, id: 'fixloop_agent' } }));
  await request(fixture.app).post(`${FIX_LOOP_ROUTE}/fixloop_agent/stop`).send({}).expect(502);
});
test('two overlapping creations for one pull request are admitted one after the other', async () => {
  // Given an agent that answers an automatic creation slowly, and lists it once made.
  const fixture = setup();
  let made = false;
  let answer;
  fixture.upstream.request.mockImplementation(async (input) => {
    if (input.method === 'GET') return response({ loops: made ? [autoLoop()] : [] });
    await new Promise((resolve) => { answer = resolve; });
    made = true;
    return response({ loop: autoLoop() });
  });
  fixture.own.status = 'stopped';
  // When an automatic and an approval creation for the same pull request overlap.
  const auto = request(fixture.app).post(FIX_LOOP_ROUTE).query(CONTEXT).send({ ...TARGET, sessionId: 'ses_auto', config: { pushMode: 'auto' } }).then((r) => r);
  await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
  const approval = request(fixture.app).post(FIX_LOOP_ROUTE).query(CONTEXT).send({ ...TARGET, sessionId: 'ses_host', config: { pushMode: 'approval' } }).then((r) => r);
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  answer();
  // Then the approval check runs after the automatic loop exists and refuses.
  expect((await auto).status).toBe(200);
  expect((await approval).body.code).toBe('fix_loop_automation_conflict');
  expect(fixture.runtime.create).not.toHaveBeenCalled();
});

const servers = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }); });
/** The fixture's app on a real socket, so a client can leave in the middle. */
const serve = async (app) => {
  const server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  servers.push(server);
  return (body, signal) => fetch(`http://127.0.0.1:${server.address().port}${FIX_LOOP_ROUTE}?${new URLSearchParams(CONTEXT)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  }).then(async (response) => ({ status: response.status, body: await response.json() }), (error) => ({ error: error.name }));
};
/** An agent whose automatic creations wait for `answer()`; its list holds what it made. */
const slowAgent = (fixture, { listMade = true } = {}) => {
  const agent = { made: false, answer: null };
  fixture.upstream.request.mockImplementation(async (input) => {
    if (input.method === 'GET') return response({ loops: listMade && agent.made ? [autoLoop()] : [] });
    await new Promise((resolve) => { agent.answer = resolve; });
    agent.made = true;
    return response({ loop: autoLoop() });
  });
  return agent;
};
const settle = () => new Promise((resolve) => { setTimeout(resolve, 150); });
test('a creation holds its turn until its work settles, though its client left', async () => {
  // Given an automatic creation the agent is still making, whose client gave up.
  const fixture = setup();
  fixture.own.status = 'stopped';
  const agent = slowAgent(fixture);
  const post = await serve(fixture.app);
  const leaving = new AbortController();
  const first = post({ ...TARGET, sessionId: 'ses_auto', config: { pushMode: 'auto' } }, leaving.signal);
  await vi.waitFor(() => expect(agent.answer).toBeTypeOf('function'));
  leaving.abort();
  expect(await first).toEqual({ error: 'AbortError' });
  // When an approval loop is asked for the same pull request meanwhile.
  const second = post({ ...TARGET, sessionId: 'ses_host', config: { pushMode: 'approval' } });
  await settle();
  // Then it waits for that creation, and once the agent's loop exists it is refused.
  expect(fixture.services.admit).not.toHaveBeenCalled();
  agent.answer();
  expect((await second).body.code).toBe('fix_loop_automation_conflict');
  expect(fixture.runtime.create).not.toHaveBeenCalled();
});
test('a creation whose client left while it waited does nothing, and the next one still waits its turn', async () => {
  // Given an automatic creation in progress, one waiting whose client then leaves, and one more waiting.
  const fixture = setup();
  fixture.own.status = 'stopped';
  const agent = slowAgent(fixture, { listMade: false });
  const post = await serve(fixture.app);
  const first = post({ ...TARGET, sessionId: 'ses_auto', config: { pushMode: 'auto' } });
  await vi.waitFor(() => expect(agent.answer).toBeTypeOf('function'));
  const leaving = new AbortController();
  const abandoned = post({ ...TARGET, number: 9, sessionId: 'ses_left', config: { pushMode: 'approval' } }, leaving.signal);
  await settle();
  leaving.abort();
  expect(await abandoned).toEqual({ error: 'AbortError' });
  const third = post({ ...TARGET, number: 10, sessionId: 'ses_third', config: { pushMode: 'approval' } });
  await settle();
  // When the first creation ends.
  expect(fixture.services.admit).not.toHaveBeenCalled();
  agent.answer();
  // Then the third runs and the abandoned one never does.
  expect((await first).status).toBe(200);
  expect((await third).status).toBe(200);
  expect(fixture.services.admit.mock.calls.map(([input]) => input.number)).toEqual([10]);
});
