import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createMessageQueueRuntime } from '../message-queue/runtime.js';
import { createBotStore } from './store.js';
import { createBotsConfig } from './config.js';
import { createBotItem } from './schema.js';
import { createBotNotices } from './notices.js';

/** Real queue, item store and HTTP admission; the inference server is local. */
export async function createNoticeDriver(root) {
  const directory = path.join(root, 'checkout');
  const projectId = 'project';
  const itemId = 'item';
  const sessionId = 'ses_bot_fixing';
  const store = createBotStore({ projectsDirPath: path.join(root, 'projects') });
  const config = createBotsConfig({ projectConfigRuntime: {
    readBotsSection: async () => ({ definitions: [{ id: 'bot', name: 'Bot', mission: 'Fix bugs', isolated: false }] }),
  } });
  await store.update(projectId, (snapshot) => ({ snapshot: { ...snapshot, items: [createBotItem({ id: itemId, botId: 'bot', source: { kind: 'manual', id: 'source' }, title: 'Bug' })] } }));
  await store.update(projectId, (snapshot) => ({ snapshot: { ...snapshot, items: snapshot.items.map((item) => ({ ...item, state: 'investigating', worktree: directory, sessions: { fixing: sessionId } })) } }));
  const state = { active: { [sessionId]: { type: 'running' } }, messages: new Map(), attempts: [], switches: [], loseResponse: false, sent: [], knowledge: [], queued: [], waiters: [], settled: [] };
  const records = new Map();
  const record = (id, stage, extra = {}) => ({ id, directory, isolated: false, metadata: { openchamber: { automation: { source: 'bot', projectId, botId: 'bot', itemId, stage } } }, ...extra });
  records.set(sessionId, record(sessionId, 'fixing'));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://notice.test');
    const send = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/session/active') return send({ data: state.active });
    if (url.pathname.endsWith('/message')) return send({ data: [], cursor: {} });
    if (req.method === 'GET') return send({ data: {} });
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (url.pathname.endsWith('/model') || url.pathname.endsWith('/agent')) state.switches.push(body);
    state.attempts.push({ path: url.pathname, body });
    if (!url.pathname.endsWith('/synthetic')) return send({ error: 'unexpected write' }, 500);
    if (state.messages.has(body.id)) return send({ error: 'duplicate' }, 409);
    // Check durable admission before accepting the remote effect.
    const persisted = JSON.parse(await fs.readFile(path.join(root, 'queue', 'message-queue.json'), 'utf8'));
    if (!Object.values(persisted.sessions).some((queue) => queue.items.some((item) => item.messageId === body.id))) return send({ error: 'queue not persisted' }, 500);
    state.messages.set(body.id, { sessionId: decodeURIComponent(url.pathname.split('/')[3]), ...body });
    if (state.loseResponse) { state.loseResponse = false; req.socket.destroy(); return; }
    return send({ data: { id: body.id } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || !Number.isInteger(address.port)) throw new Error('Missing test HTTP address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let runtime;
  let notices;
  const create = (options = {}) => {
    let sending = false;
    runtime = createMessageQueueRuntime({
      globalEventHub: { subscribeEvent: () => () => {}, subscribeStatus: () => () => {} },
      buildOpenCodeUrl: (route) => baseUrl + route, getOpenCodeAuthHeaders: () => ({}),
      dataDir: path.join(root, 'queue'), dispatchQuietMs: 0, retryDelayMs: () => 60_000,
      assertBotDispatch: (input) => notices.assertDispatch(input),
      sessionKnowledgeRuntime: { sync: async (...args) => { state.knowledge.push(args); } },
      onPromptSent: (id) => { state.sent.push(id); for (const resolve of state.waiters.splice(0)) resolve(id); },
      broadcastGlobalUiEvent: (event) => {
        const current = Boolean(event.properties.session.sendingId);
        if (sending && !current) for (const resolve of state.settled.splice(0)) resolve();
        sending = current;
      },
      ...options,
    });
    notices = createBotNotices({ store, config, readSession: async ({ sessionId: id }) => records.get(id), queueFor: async (target) => { state.queued.push(target); return runtime; } });
    return { runtime, notices };
  };
  const current = create();
  const request = { projectId, item: { id: itemId }, eventId: 'event-1', text: 'Review feedback' };
  return {
    ...current, state, store, config, records, record, request, projectId, itemId, sessionId, directory,
    create,
    currentItem: async () => (await store.read(projectId)).items[0],
    changeItem: (change) => store.update(projectId, (snapshot) => ({ snapshot: { ...snapshot, items: snapshot.items.map(change) } })),
    nextSent: () => new Promise((resolve) => state.waiters.push(resolve)),
    nextSettled: () => new Promise((resolve) => state.settled.push(resolve)),
    close: async () => { runtime.stop(); await runtime.flush(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}
