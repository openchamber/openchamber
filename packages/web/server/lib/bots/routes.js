import express from 'express';
import { z } from 'zod';
import { sourceCandidateSchema } from './prompts.js';

const json = express.json({ limit: '256kb' });
const id = z.string().min(1).max(512);
const admission = sourceCandidateSchema.extend({ botId: id });
const answer = z.object({ text: z.string().min(1).max(100_000), eventId: id }).strict();
const approval = z.object({ file: id, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const run = z.object({ occurrence: id.optional() }).strict();
const edit = z.object({ config: z.json() }).strict();
const identityEdit = z.object({ expectedRevision: z.number().int().positive(), definition: z.json() }).strict();
const identityDelete = z.object({ expectedRevision: z.number().int().positive() }).strict();
const parse = (schema, body) => {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw Object.assign(new Error('Invalid bot request'), { status: 400, code: 'BOT_INVALID_REQUEST' });
  return result.data;
};

/** Register after API authentication and before the generic OpenCode proxy. */
export const registerBotRoutes = (app, { botsRuntime, identities }) => {
  for (const name of ['list', 'create', 'update', 'remove']) if (!(identities?.[name] instanceof Function)) throw new TypeError(`identities.${name} is required`);
  const base = '/api/projects/:projectId/bots';
  const handle = (operation) => async (req, res) => {
    try { return res.json(await operation(req)); }
    catch (failure) {
      if (failure?.code === 'BOT_DISCOVERY_PENDING' && failure.status === 202) {
        return res.status(202).json({ pending: true, ...failure.pending });
      }
      const candidate = failure?.statusCode ?? failure?.status;
      const status = failure instanceof z.ZodError ? 400 : Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
      // Upstream error bodies and secret-bearing identity inputs never reach HTTP.
      return res.status(status).json({ code: failure?.code ?? (status === 400 ? 'BOT_INVALID_REQUEST' : 'BOT_REQUEST_FAILED'), error: status >= 500 ? 'Bot request failed. Existing state was preserved.' : failure instanceof z.ZodError ? 'Invalid bot request' : failure.message });
    }
  };
  app.get(base, handle((req) => botsRuntime.getProject(req.params.projectId)));
  app.get(`${base}/config`, handle((req) => botsRuntime.getConfig(req.params.projectId)));
  app.put(`${base}/config`, json, handle((req) => botsRuntime.saveConfig(req.params.projectId, parse(edit, req.body).config)));
  app.get(`${base}/items`, handle((req) => botsRuntime.getItems(req.params.projectId)));
  app.post(`${base}/items`, json, handle(async (req) => {
    const { botId, ...candidate } = parse(admission, req.body);
    const item = await botsRuntime.admit(req.params.projectId, botId, candidate);
    await botsRuntime.pump(req.params.projectId);
    return botsRuntime.detail(req.params.projectId, item.id);
  }));
  app.get(`${base}/archive`, handle((req) => botsRuntime.getArchive(req.params.projectId, req.query.month)));
  app.get(`${base}/items/:itemId`, handle((req) => botsRuntime.detail(req.params.projectId, req.params.itemId)));
  app.post(`${base}/items/:itemId/answer`, json, handle((req) => botsRuntime.answer(req.params.projectId, req.params.itemId, parse(answer, req.body))));
  app.post(`${base}/items/:itemId/resume`, handle((req) => botsRuntime.resume(req.params.projectId, req.params.itemId)));
  app.post(`${base}/items/:itemId/stop`, handle((req) => botsRuntime.stopItem(req.params.projectId, req.params.itemId)));
  app.post(`${base}/:botId/run`, json, handle((req) => botsRuntime.runScheduled(req.params.projectId, req.params.botId, parse(run, req.body).occurrence ?? `manual:${Date.now()}`)));
  app.get(`${base}/policy`, handle((req) => botsRuntime.getPolicy(req.params.projectId)));
  app.post(`${base}/policy/approve`, json, handle((req) => botsRuntime.approvePolicy(req.params.projectId, parse(approval, req.body))));
  const checkProject = (req) => botsRuntime.getConfig(req.params.projectId);
  app.get(`${base}/identities`, handle(async (req) => { await checkProject(req); return { identities: await identities.list() }; }));
  app.post(`${base}/identities`, json, handle(async (req) => { await checkProject(req); return { identity: await identities.create(req.body) }; }));
  app.put(`${base}/identities/:identityId`, json, handle(async (req) => {
    await checkProject(req);
    const { expectedRevision, definition } = parse(identityEdit, req.body);
    return { identity: await identities.update(req.params.identityId, expectedRevision, definition) };
  }));
  app.delete(`${base}/identities/:identityId`, json, handle(async (req) => { await checkProject(req); return identities.remove(req.params.identityId, parse(identityDelete, req.body).expectedRevision); }));
};
