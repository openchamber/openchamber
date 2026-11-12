import crypto from 'node:crypto';
import { z } from 'zod';
import { createCodeOut } from '../spaces/code-out.js';
import { buildExtUrl, createTransferSession } from '../spaces/code-transfer.js';
import { IMAGE_GIT, requireSpaceProjectPath } from '../spaces/layout.js';
import { createSpaceRecords } from '../spaces/space-records.js';
import { requireApprovalModel } from '../spaces/approval-profile.js';
import { createTokenSnapshotReader } from './token-usage.js';
import { approvalError, commitSchema, workerModelSchema } from './approval-contract.js';

const PURPOSE = 'pr-fix-loop-approval';
const sessionSchema = z.object({ data: z.object({ id: z.string().regex(/^ses_[A-Za-z0-9]{1,64}$/) }) });
const queueSchema = z.object({ sessions: z.array(z.object({
  sessionId: z.string(), items: z.array(z.object({ id: z.string() })), sendingId: z.string().nullable(),
})) });
const activeSchema = z.object({ data: z.record(z.string(), z.object({ type: z.enum(['busy', 'retry', 'idle']) })) });
const RECENT_MESSAGE_LIMIT = 100; // Same page size as token-usage.js.
// At 8 MiB per response, 32 pages match code-out's 256 MiB transfer ceiling.
const MAX_TURN_PAGES = 32;
const turnPageSchema = z.object({ data: z.array(z.unknown()).max(RECENT_MESSAGE_LIMIT),
  cursor: z.object({ next: z.string().min(1).nullable().optional(), previous: z.string().min(1).nullable().optional() }) });
const messageTime = z.object({ created: z.number(), completed: z.number().optional() });
const messageBase = z.object({ id: z.string().startsWith('msg_'), time: messageTime });
const recentMessageSchema = z.discriminatedUnion('type', [
  messageBase.extend({ type: z.literal('idle'), outcome: z.enum(['succeeded', 'failed', 'interrupted']).optional(), error: z.never().optional() }),
  messageBase.extend({ type: z.literal('user'), text: z.string() }),
  messageBase.extend({ type: z.literal('assistant'), error: z.never().optional(), retry: z.never().optional(),
    finish: z.enum(['stop', 'length', 'tool-calls', 'content-filter', 'error', 'unknown']).optional(),
    content: z.array(z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), text: z.string() }),
      z.object({ type: z.literal('reasoning'), text: z.string() }),
      z.object({ type: z.literal('tool'), state: z.object({ status: z.enum(['streaming', 'running', 'completed', 'error']) }) }),
    ])),
  }),
]);

// Parse only the newest turn. A prior idle or user cannot supply a missing result.
async function completedTurnResult(readPage) {
  let assistant = null;
  let idle = null;
  let previousCreated = Infinity;
  let cursor;
  const cursors = new Set();
  const messages = new Set();
  for (let index = 0; index < MAX_TURN_PAGES; index += 1) {
    const page = turnPageSchema.parse(await readPage(cursor));
    for (const raw of page.data) {
      const message = recentMessageSchema.parse(raw);
      if (messages.has(message.id) || message.time.created > previousCreated) throw approvalError('The worker history overlaps or is out of order.');
      messages.add(message.id);
      previousCreated = message.time.created;
      switch (message.type) {
        case 'idle':
          if (idle || assistant || (message.outcome !== undefined && message.outcome !== 'succeeded')) {
            throw approvalError('The worker turn did not complete successfully.');
          }
          idle = message;
          break;
        case 'assistant':
          if (!assistant) {
            if (message.time.completed === undefined) return null;
            if (message.time.completed < message.time.created || (idle && message.time.completed > idle.time.created)
              || (message.finish !== undefined && message.finish !== 'stop')
              || message.content.some((part) => part.type === 'tool' && part.state.status !== 'completed')) {
              throw approvalError('The worker assistant result is incomplete or failed.');
            }
            assistant = message;
          }
          break;
        case 'user':
          if (!assistant) {
            if (idle) throw approvalError('The worker turn has no completed assistant result.');
            return null;
          }
          return assistant;
        default:
          throw approvalError('The worker history contains an unsupported record.');
      }
    }
    // The pinned server may emit next even on its last nonempty page.
    if (page.data.length < RECENT_MESSAGE_LIMIT) throw approvalError('The worker turn boundary has not been observed.');
    const next = page.cursor.next;
    if (!next || cursors.has(next)) throw approvalError('The worker history cursor is missing or repeated.');
    cursors.add(next);
    cursor = next;
  }
  throw approvalError('The worker turn exceeded its history read limit.');
}

/** Only the space id selects transport. Responses from inside never select host auth or a host operation. */
export function createSpaceWorker({ dataDir, getHost, git, gitServices, readHostSession, seedHead = null, upstream = null }) {
  const records = createSpaceRecords({ dataDir });
  const { withHostGit } = createTransferSession({ git, temporaryDirectory: dataDir, name: 'approval worker' });
  const host = () => {
    const current = getHost();
    if (!current) throw approvalError('Enable isolated spaces explicitly before preparing an approval worker.');
    return current;
  };
  const request = async (worker, requestPath, { method = 'GET', body } = {}) => {
    const headers = { accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    const response = await host().dispatcher.requestInside(worker.spaceId, {
      method, path: requestPath, timeoutMs: 15_000,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    });
    const deadline = setTimeout(() => response.destroy(approvalError('The worker response timed out.')), 15_000);
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of response) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw approvalError('The worker response exceeded its limit.');
        chunks.push(chunk);
      }
      if (response.statusCode < 200 || response.statusCode >= 300) throw approvalError(`Worker request failed with status ${response.statusCode}.`);
      const text = Buffer.concat(chunks).toString('utf8');
      return text === '' ? null : JSON.parse(text);
    } finally { clearTimeout(deadline); response.destroy(); }
  };
  const validate = async (worker, { running = true, access = true, checkParent = false } = {}) => {
    const current = host();
    if (checkParent) {
      const parent = z.object({ id: z.string(), location: z.object({ directory: z.string() }) }).parse(await readHostSession(worker.parentSessionId));
      if (parent.id !== worker.parentSessionId || parent.location.directory !== worker.directory) {
        throw approvalError('The original host session moved or is unavailable.');
      }
    }
    const { record } = records.read(worker.spaceId);
    const selectedModel = requireApprovalModel(PURPOSE, { providerID: worker.model.providerID, modelID: worker.model.modelID });
    if (!record || record.purpose !== PURPOSE || record.repository !== worker.directory
      || record.approvalModel?.providerID !== selectedModel.providerID || record.approvalModel?.modelID !== selectedModel.modelID
      || record.network.mode !== 'allowlist' || record.network.domains.length !== 0) {
      throw approvalError('A freshly prepared protected approval worker is required.');
    }
    const listed = (await current.journey.listSpaces({ access })).find((space) => space.id === worker.spaceId);
    if (!listed || listed.purpose !== PURPOSE || listed.damaged || (running && listed.state !== 'running')) {
      throw approvalError('The protected worker is unavailable. Start or repair its space before resuming.');
    }
    if ((await current.manager.verify(worker.spaceId)).length !== 0) throw approvalError('The worker isolation could not be verified.');
    const selectedGrant = record.grants.find((grant) => grant.provider === worker.model.providerID);
    if (access && (!selectedGrant || !['granted', 'needs_access'].includes(listed.access)
      || listed.needsAccess.includes(selectedGrant.id))) {
      throw approvalError('Explicitly grant the selected model to this worker before activation.');
    }
    return record;
  };
  const readTurn = (worker) => completedTurnResult((cursor) => request(worker,
    `/api/session/${worker.sessionId}/message?limit=${RECENT_MESSAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
  return {
    async prepare({ parentSessionId, directory, model, name, placeId }) {
      const parsed = workerModelSchema.safeParse(model);
      if (!parsed.success) throw approvalError('Select an explicit provider and model for the worker.', 400);
      const selected = parsed.data;
      let approvalModel;
      try { approvalModel = requireApprovalModel(PURPOSE, { providerID: selected.providerID, modelID: selected.modelID }); }
      catch (error) { throw approvalError(error.message, 400); }
      const parent = z.object({ id: z.string(), location: z.object({ directory: z.string() }) }).parse(await readHostSession(parentSessionId));
      if (parent.id !== parentSessionId || parent.location.directory !== directory || directory.startsWith('/spaces/')) {
        throw approvalError('Prepare the worker from its original host session and directory.');
      }
      const space = await host().journey.createSpace({ projectDirectory: directory, name, placeId,
        start: 'clean', purpose: PURPOSE, approvalModel, network: { mode: 'allowlist', domains: [] }, setupCommands: [] });
      return { id: crypto.randomUUID(), spaceId: space.id, parentSessionId, directory, model: selected, sessionId: null, spacePath: null };
    },
    validate,
    async initialize(loop, snapshot) {
      const worker = loop.worker;
      const record = await validate(worker);
      if (worker.sessionId) return worker;
      const spacePath = requireSpaceProjectPath(worker.spaceId, record.spacePath);
      const head = commitSchema.parse(snapshot.headSha);
      // Fetch the provider-resolved PR head even when this checkout has no local branch or object.
      if (seedHead) await seedHead(loop, snapshot, { manager: host().manager, spaceId: worker.spaceId, spacePath });
      else {
        await gitServices().fetchHead(loop, snapshot);
        await withHostGit('approval_seed_failed', async (g) => {
          const url = buildExtUrl([...(await host().manager.execArgv(worker.spaceId)), IMAGE_GIT, 'receive-pack', spacePath]);
          await g.output(worker.directory, ['-c', 'protocol.ext.allow=always', 'push', '--no-verify', '--', url,
            `${head}:refs/heads/openchamber-fix-loop`], { timeoutMs: 300_000, killTree: true });
        });
      }
      const checkout = await host().manager.exec(worker.spaceId, [IMAGE_GIT, '-C', spacePath, 'checkout', '--force', '--detach', head], { timeoutMs: 60_000 });
      if (checkout.code !== 0) throw approvalError('The PR head could not be checked out inside the worker.');
      const created = sessionSchema.parse(await request(worker, '/api/session', { method: 'POST', body: {
        title: `Fix loop #${loop.number}`, location: { directory: spacePath },
        metadata: { openchamber: { fixLoop: { loopId: loop.id, hostSessionId: loop.sessionId, spaceId: worker.spaceId } } },
      } }));
      if (created.data.id === loop.sessionId) throw approvalError('The worker returned an invalid session identity.');
      return { ...worker, sessionId: created.data.id, spacePath };
    },
    async enqueue(loop, item) {
      await validate(loop.worker);
      // The worker's turn stays an ordinary message: its turn reader uses the latest user message as the boundary.
      const { origin: _origin, notice: _notice, ...message } = item;
      const response = await request(loop.worker, `/api/message-queue/sessions/${loop.worker.sessionId}/items`, {
        method: 'POST', body: { directory: loop.worker.spacePath, item: { ...message, sendConfig: loop.worker.model } },
      });
      z.object({ itemId: z.string().min(1) }).parse(response);
    },
    async working(loop) {
      await validate(loop.worker);
      const queue = queueSchema.parse(await request(loop.worker, '/api/message-queue'));
      if (queue.sessions.some((session) => session.items.length > 0 || session.sendingId !== null)) return true;
      const active = activeSchema.parse(await request(loop.worker, '/api/session/active'));
      if (Object.values(active.data).some((status) => status.type !== 'idle')) return true;
      return await readTurn(loop.worker) === null;
    },
    async usage(loop) {
      const reader = createTokenSnapshotReader({
        buildOpenCodeUrl: (pathname) => `http://worker.invalid${pathname}`,
        getOpenCodeAuthHeaders: () => ({}),
        fetchImpl: async (url, { signal }) => {
          signal.throwIfAborted();
          const parsed = new URL(url);
          const body = await request(loop.worker, `${parsed.pathname}${parsed.search}`);
          signal.throwIfAborted();
          return Response.json(body);
        },
      });
      return reader(loop.worker.sessionId, loop.worker.spacePath, { since: loop.createdAt });
    },
    async export(loop) {
      const record = await validate(loop.worker);
      return createCodeOut({ git, place: host().manager, temporaryDirectory: dataDir, upstream, dataDir }).bringCodeOut({
        repository: record.repository, spaceId: loop.worker.spaceId, spacePath: record.spacePath,
      });
    },
    async reviewResult(loop) {
      const assistant = await readTurn(loop.worker);
      if (!assistant) throw approvalError('The worker assistant result has not completed.');
      return assistant.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    },
    async stop(loop) {
      // Stop both containers from the trusted manager, even when the server inside lies or is dead.
      await host().journey.stopSpace(loop.worker.spaceId);
    },
    async resume(loop) {
      await validate(loop.worker, { running: false, access: false, checkParent: true });
      await host().journey.startSpace(loop.worker.spaceId);
      await validate(loop.worker);
    },
  };
}
