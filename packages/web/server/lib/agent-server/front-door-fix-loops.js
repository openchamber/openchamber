import { z } from 'zod';
import { normalizeConfig, registerFixLoopRoutes, sendFixLoopCreateError } from '../pr-fix-loop/runtime.js';
import { agentFixLoopSchema } from './fix-loop-event-schema.js';
import { FIX_LOOP_BYTES, FIX_LOOP_ROUTE, fixLoopServiceError, readContextSchema, targetSchema } from './fix-loop-contract.js';
import { readBoundedBody } from './agent-upstream.js';
import { stripCredentialQuery } from '../spaces/dispatcher.js';
import { isAgentPayloadAllowed } from './session-boundary.js';

const agentList = z.object({ loops: z.array(z.unknown()).max(100) });
const ok = z.object({ ok: z.literal(true) });
const TERMINAL = new Set(['ready', 'stopped', 'closed', 'limitReached', 'budgetReached', 'error']);
const reserves = (loop) => !TERMINAL.has(loop.status) || Boolean(loop.pendingApproval)
  || Boolean(loop.review && loop.review.state !== 'complete');
// Other fields a client sends, such as a linked PR row's key and thread, are dropped: nothing reads them.
// `strip` lifts the strictness of the target schema alone.
const createBody = targetSchema.extend({ sessionId: z.string().regex(/^ses_[A-Za-z0-9]{1,128}$/),
  config: z.record(z.string(), z.unknown()).optional(), workerId: z.string().uuid().optional(),
  name: z.string().min(1).max(128).optional(), placeId: z.string().min(1).max(64).optional(),
  model: z.unknown().optional() }).strip();

/** One local family delegates auto operations only after consulting persisted owner IDs. */
export function registerFrontDoorFixLoopRoutes(app, { runtime, services, upstream, readDefaults, listProjectDirectories, isSpaceSession = () => false, logger = console }) {
  const failure = (res, error) => res.status(error?.statusCode ?? 502).json({ code: error?.code ?? 'agent_fix_loop_operation_failed' });
  // One creation at a time across both runtimes, from its admission check until its work settles,
  // whether or not its client is still there.
  let creating = Promise.resolve();
  const exclusive = (work) => {
    const turn = creating.then(work);
    creating = turn.catch(() => {});
    return turn;
  };
  const requestAgent = async ({ method, originalUrl, body: payload }, schema) => {
    const url = new URL(originalUrl, 'http://front');
    stripCredentialQuery(url);
    const body = ['GET', 'HEAD', 'DELETE'].includes(method) ? undefined : JSON.stringify(payload ?? {});
    const headers = { accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    const response = await upstream.request({ method, path: `${url.pathname}${url.search}`, body, headers, timeoutMs: 30_000 });
    let value;
    try { value = JSON.parse(await readBoundedBody(response, FIX_LOOP_BYTES)); }
    catch { throw fixLoopServiceError('agent_fix_loop_invalid_response'); }
    if (response.statusCode !== 200) throw fixLoopServiceError('agent_fix_loop_operation_failed',
      response.statusCode >= 400 && response.statusCode <= 599 ? response.statusCode : 502);
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw fixLoopServiceError('agent_fix_loop_invalid_response');
    return parsed.data;
  };
  /** The agent's automatic loops. An entry outside that shape, or claiming an owner identity or a Space session, is left out alone. */
  const agentLoops = async (req = { method: 'GET', originalUrl: FIX_LOOP_ROUTE }) => {
    const parsed = (await requestAgent(req, agentList)).loops.map((raw) => agentFixLoopSchema.safeParse(raw).data ?? null);
    const counts = new Map();
    for (const loop of parsed) if (loop) counts.set(loop.id, (counts.get(loop.id) ?? 0) + 1);
    const loops = parsed.filter((loop) => loop && counts.get(loop.id) === 1 && !runtime.ownsIdentity(loop.id) && isAgentPayloadAllowed(loop, isSpaceSession));
    if (loops.length < parsed.length) logger.warn?.(`[pr-fix-loop] ${parsed.length - loops.length} fix loops of the agent server were left out of the list`);
    return loops;
  };
  const forward = async (req, res, suffix) => {
    const response = await requestAgent(req, req.method === 'DELETE' ? ok : z.object({ loop: agentFixLoopSchema }));
    const expectedId = suffix.split('/')[1];
    if (response.loop && (runtime.ownsIdentity(response.loop.id) || !isAgentPayloadAllowed(response.loop, isSpaceSession)
      || expectedId && response.loop.id !== expectedId)) {
      throw fixLoopServiceError('agent_fix_loop_invalid_response');
    }
    return res.json(response);
  };
  const createLocally = async (req, { prepareWorker = false } = {}) => {
    const parsedBody = createBody.safeParse(req.body);
    if (!parsedBody.success) throw fixLoopServiceError('agent_fix_loop_invalid_request', 400);
    const body = parsedBody.data;
    const query = new URL(req.originalUrl, 'http://front').searchParams;
    const allowed = ['directory', 'repositoryId', 'provider', 'instance', 'accountId', 'bindingRevision', 'primaryRemote', 'linked'];
    if ([...query.keys()].some((key) => !allowed.includes(key) || query.getAll(key).length !== 1)
      || query.has('linked') && query.get('linked') !== '1') throw fixLoopServiceError('agent_fix_loop_invalid_request', 400);
    const contextInput = { provider: query.get('provider') ?? 'github', instance: query.get('instance') ?? 'github.com',
      accountId: query.get('accountId'), directory: query.get('directory'), repositoryId: query.get('repositoryId'),
      bindingRevision: query.has('bindingRevision') ? Number(query.get('bindingRevision')) : -1, primaryRemote: query.get('primaryRemote') };
    if (query.get('linked') === '1') contextInput.linked = true;
    const parsedContext = readContextSchema.safeParse(contextInput);
    if (!parsedContext.success) throw fixLoopServiceError('agent_fix_loop_invalid_request', 400);
    const context = parsedContext.data;
    if (!(await listProjectDirectories()).includes(context.directory)) throw fixLoopServiceError('agent_project_unregistered', 403);
    const admitted = await services.admit({ context, owner: body.owner, repo: body.repo, number: body.number });
    if (prepareWorker) return runtime.prepareWorker({ sessionId: body.sessionId, directory: context.directory,
      model: body.model, name: body.name, placeId: body.placeId });
    return runtime.create({ ...admitted.pull, sessionId: body.sessionId, directory: context.directory, accountId: context.accountId,
      readContext: admitted.context, config: body.config, workerId: body.workerId });
  };
  /** Admission and creation of one loop, in its turn: local, forwarded to the agent, or refused. */
  const create = async (req, res, target) => {
    const samePull = (loop) => loop.owner.toLowerCase() === target.owner.toLowerCase()
      && loop.repo.toLowerCase() === target.repo.toLowerCase() && loop.number === target.number;
    const local = await runtime.list();
    const existing = local.find((loop) => loop.sessionId === target.sessionId && samePull(loop));
    const mode = existing && reserves(existing) ? null : normalizeConfig(target.config, normalizeConfig(await readDefaults())).pushMode;
    // Each instance admits one automation per session and pull request; the other instance's loops count too.
    const held = (loops) => loops.some((loop) => reserves(loop) && (loop.sessionId === target.sessionId || samePull(loop)));
    if (mode !== null && held(mode === 'approval' ? await agentLoops() : local)) {
      return res.status(409).json({ code: 'fix_loop_automation_conflict', error: 'This session or pull request is owned by another automation.' });
    }
    if (mode !== 'auto') {
      try { return res.json({ loop: await createLocally(req) }); } catch (error) { return sendFixLoopCreateError(res, error); }
    }
    req.body = { ...target, config: { ...target.config, pushMode: 'auto' } };
    return forward(req, res, '');
  };
  app.use(FIX_LOOP_ROUTE, async (req, res, next) => {
    try {
      await runtime.load();
      const suffix = new URL(req.originalUrl, 'http://front').pathname.slice(FIX_LOOP_ROUTE.length).replace(/\/$/, '');
      if (/^\/workers(?:\/|$)/i.test(suffix)) return next();
      if (!suffix) {
        if (req.method === 'GET') return res.json({ loops: [...await runtime.list(), ...await agentLoops(req)] });
        if (req.method !== 'POST') return res.status(405).json({ code: 'fix_loop_method_refused' });
        const parsed = createBody.safeParse(req.body);
        if (!parsed.success || (parsed.data.config?.pushMode !== undefined && !['auto', 'approval'].includes(parsed.data.config.pushMode))) {
          throw fixLoopServiceError('agent_fix_loop_invalid_request', 400);
        }
        let left = false;
        res.once('close', () => { left = !res.writableFinished; });
        // A request whose client left while it waited for its turn does nothing.
        return await exclusive(() => (left ? undefined : create(req, res, parsed.data)));
      } else {
        const match = /^\/([^/]+)(?:\/(stop|resume|refresh|approve))?$/.exec(suffix);
        if (!match) return res.status(404).json({ code: 'fix_loop_not_found' });
        if (runtime.ownsLoop(match[1])) return next();
        if (runtime.ownsIdentity(match[1]) || match[2] === 'approve') return res.status(404).json({ code: 'fix_loop_not_found' });
      }
      return await forward(req, res, suffix);
    } catch (error) { return failure(res, error); }
  });
  registerFixLoopRoutes(app, { runtime, createWithContext: createLocally });
}
