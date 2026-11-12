import express from 'express';
import { z } from 'zod';
import { createProtectedSelectionStore } from './selections.js';
import { readServiceState, resolveClientConfigPath, requestAdmin } from './service-client.js';
import { requestOrigin, renderOauthCallbackPage } from '../shared/oauth-callback.js';
import { createAgentSubjectSync } from './agent-subject.js';

const selectionBodySchema = z.object({
  scope: z.enum(['global', 'project']),
  connection: z.string().regex(/^pmcp_[0-9a-f]{16}$/),
  disabled: z.boolean().optional(),
});
const removalBodySchema = z.object({ scope: z.enum(['global', 'project']) });

const fail = (res, status, code, message) => res.status(status).json({ code, error: message });
// The common middleware skips these paths, so this is their only parser and its failures never quote the body.
const parseJson = express.json({ limit: '1mb' });
const jsonBody = (req, res, next) => parseJson(req, res, (error) => {
  if (!error) return next();
  return error.status === 413
    ? fail(res, 413, 'body_too_large', 'The request body is too large')
    : fail(res, 400, 'invalid_request', 'The request body is not valid JSON');
});
const revisionSchema = z.object({ expectedRevision: z.number().int().safe() });
// The broker owns definition validation; this envelope never reports parser messages or values.
const definitionSchema = z.object({ name: z.string() }).passthrough();
const secretsSchema = z.record(z.string(), z.string()).optional();
const createSchema = z.object({ definition: definitionSchema, secrets: secretsSchema, use: removalBodySchema });
const updateSchema = revisionSchema.extend({ definition: definitionSchema, secrets: secretsSchema });
const enabledSchema = revisionSchema.extend({ enabled: z.boolean() });
const callbackSchema = z.object({ state: z.string().max(4096), code: z.string().max(4096).optional(), error: z.string().max(4096).optional() });
// 32 random bytes encoded as canonical, unpadded base64url by oauth-authorization.js.
const publicCallbackSchema = callbackSchema.extend({ state: z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/) });
// oauth.js allows 15 s per request: 2 resource metadata + 2 issuer metadata + 1 registration = 75 s, plus 5 s for the socket.
const OAUTH_START_TIMEOUT_MS = 80_000;
const OAUTH_COMPLETE_TIMEOUT_MS = 20_000;
const addressSchema = z.object({ address: z.string().max(4096).url() });
const callbackOutcomes = {
  authorized: [200, 'Signed in'],
  oauth_denied: [400, 'The sign-in was cancelled.'],
  oauth_state_invalid: [400, 'This sign-in link has expired or was already used. Start the sign-in again in OpenChamber.'],
  oauth_connection_changed: [409, 'The server changed during the sign-in. Start the sign-in again in OpenChamber.'],
  oauth_exchange_failed: [502, 'The sign-in server did not accept the code. Start the sign-in again in OpenChamber.'],
};

/**
 * OpenChamber's side of protected MCP: redacted status from the service and
 * the selections the managed OpenCode plugin turns into relay entries, and
 * administration over the broker's private socket. Credentials pass straight
 * from authenticated request bodies to that socket and are never retained here.
 */
export function registerProtectedMcpRoutes(app, {
  dataDir,
  resolveOptionalProjectDirectory,
  isSupported,
  listOrdinaryMcpNames,
  resolveProjectIdentity,
  selectionMirror,
  platform = process.platform,
  env = process.env,
}) {
  const selections = createProtectedSelectionStore({ dataDir, resolveProjectIdentity, enforceMirrorCapacity: Boolean(selectionMirror) });
  let callbacksInFlight = 0;
  const host = () => {
    if (platform !== 'linux') return { supported: false, reason: 'unsupported_platform' };
    if (!isSupported()) return { supported: false, reason: 'external_opencode' };
    return { supported: true, reason: null };
  };
  const service = () => readServiceState({ clientConfigPath: resolveClientConfigPath(env), platform });
  const admin = (frame, timeoutMs) => requestAdmin({ clientConfigPath: resolveClientConfigPath(env), frame, timeoutMs });
  const agentSubject = createAgentSubjectSync({ dataDir, clientConfigPath: () => resolveClientConfigPath(env) });
  if (host().supported) void agentSubject.start();
  if (host().supported) void selectionMirror?.push();
  const supported = (_req, res, next) => host().supported ? next() : fail(res, 501, host().reason, 'Protected MCP connections are not available on this host');
  const ask = async (res, frame, timeoutMs) => {
    const result = await admin(frame, timeoutMs);
    if (!result.ok) { fail(res, result.status, result.code, result.message); return null; }
    return result.answer;
  };
  /** Names of ordinary MCP entries here, or null when a broken config file makes them unknown. */
  const ordinaryNames = async (directory) => {
    try {
      return new Set(await listOrdinaryMcpNames(directory));
    } catch {
      return null;
    }
  };

  app.get('/api/protected-mcp/status', async (req, res) => {
    const { directory, error } = await resolveOptionalProjectDirectory(req);
    if (error) return fail(res, 400, 'invalid_directory', error);
    let current = null;
    let selectionsError = null;
    try {
      current = await selections.read(directory);
    } catch {
      selectionsError = 'selections_unreadable';
    }
    const ordinary = await ordinaryNames(directory);
    return res.json({
      host: host(),
      service: await service(),
      selections: current,
      selectionsError,
      // Null when unknown; a protected selection wins over an ordinary entry of its name either way.
      conflicts: current && ordinary ? Object.keys(current.effective).filter((name) => ordinary.has(name)) : null,
    });
  });

  app.put('/api/protected-mcp/selections/:name', jsonBody, supported, async (req, res) => {
    const body = selectionBodySchema.safeParse(req.body ?? {});
    if (!body.success) return fail(res, 400, 'invalid_request', 'scope and connection are required');
    const { directory, error } = await resolveOptionalProjectDirectory(req);
    if (error) return fail(res, 400, 'invalid_directory', error);
    if (body.data.scope === 'project' && !directory) return fail(res, 400, 'project_required', 'A project selection needs a project directory');
    const name = req.params.name;
    if (!body.data.disabled) {
      const state = await service();
      if (state.state !== 'available') return fail(res, 503, 'service_unavailable', 'The protected MCP service is not available');
      if (!state.status.connections.some((connection) => connection.id === body.data.connection)) {
        return fail(res, 404, 'connection_not_found', 'The protected MCP service has no such connection');
      }
      if (directory && (await ordinaryNames(directory))?.has(name)) return fail(res, 409, 'name_in_use', `An MCP server named "${name}" already exists here`);
    }
    try {
      await selections.set({ scope: body.data.scope, directory, name, connection: body.data.connection, disabled: body.data.disabled === true });
    } catch (cause) {
      return fail(res, cause?.code === 'PROTECTED_SELECTION_CAPACITY' ? 413 : cause?.code === 'PROTECTED_SELECTION_INVALID' ? 400 : 500, 'selection_not_saved', 'The selection could not be saved');
    }
    // A change the agents' subject did not take yet is said so: until it does, the agents keep the old connections.
    const subject = await agentSubject.push();
    void selectionMirror?.push();
    return res.json({ selections: await selections.read(directory), agentAccessUpdated: subject.ok });
  });

  app.delete('/api/protected-mcp/selections/:name', jsonBody, supported, async (req, res) => {
    const body = removalBodySchema.safeParse(req.body ?? {});
    if (!body.success) return fail(res, 400, 'invalid_request', 'scope is required');
    const { directory, error } = await resolveOptionalProjectDirectory(req);
    if (error) return fail(res, 400, 'invalid_directory', error);
    if (body.data.scope === 'project' && !directory) return fail(res, 400, 'project_required', 'A project selection needs a project directory');
    try {
      await selections.remove({ scope: body.data.scope, directory, name: req.params.name });
    } catch (cause) {
      return fail(res, cause?.code === 'PROTECTED_SELECTION_INVALID' ? 400 : 500, 'selection_not_saved', 'The selection could not be removed');
    }
    // A change the agents' subject did not take yet is said so: until it does, the agents keep the old connections.
    const subject = await agentSubject.push();
    void selectionMirror?.push();
    return res.json({ selections: await selections.read(directory), agentAccessUpdated: subject.ok });
  });

  app.get('/api/protected-mcp/connections/:id', supported, async (req, res) => {
    const answer = await ask(res, { type: 'get', id: req.params.id });
    if (answer) res.json({ connection: answer.connection });
  });
  app.post('/api/protected-mcp/connections', supported, jsonBody, async (req, res) => {
    const body = createSchema.safeParse(req.body);
    if (!body.success) return fail(res, 400, 'invalid_request', 'definition and use are required');
    const { directory, error } = await resolveOptionalProjectDirectory(req);
    if (error) return fail(res, 400, 'invalid_directory', error);
    const { definition, secrets, use } = body.data;
    if (use.scope === 'project' && !directory) return fail(res, 400, 'project_required', 'A project selection needs a project directory');
    const ordinary = directory ? await ordinaryNames(directory) : new Set();
    if (!ordinary) return fail(res, 500, 'ordinary_mcp_unreadable', 'The MCP configuration could not be read');
    if (ordinary.has(definition.name)) return fail(res, 409, 'name_in_use', 'An MCP server already uses this name here');
    try {
      if (Object.hasOwn((await selections.read(directory))[use.scope] ?? {}, definition.name)) return fail(res, 409, 'selection_name_in_use', 'A selection already uses this name');
    } catch { return fail(res, 500, 'selections_unreadable', 'The protected MCP selections could not be read'); }
    const answer = await ask(res, { type: 'apply', operation: { kind: 'create', definition, secrets } });
    if (!answer) return;
    const connection = answer.connection;
    try {
      await selections.set({ scope: use.scope, directory, name: definition.name, connection: connection.id });
    } catch {
      const rollback = await admin({ type: 'apply', operation: { kind: 'remove', id: connection.id, expectedRevision: connection.revision } });
      return res.status(500).json({ code: 'selection_not_saved', error: 'The selection could not be saved', connectionRemoved: rollback.ok });
    }
    const subject = await agentSubject.push();
    void selectionMirror?.push();
    return res.status(201).json({ connection, selections: await selections.read(directory), agentAccessUpdated: subject.ok });
  });
  for (const { method, suffix, schema, kind } of [
    { method: 'put', suffix: '', schema: updateSchema, kind: 'update' },
    { method: 'put', suffix: '/enabled', schema: enabledSchema, kind: 'set-enabled' },
    { method: 'post', suffix: '/revoke', schema: revisionSchema, kind: 'revoke-credentials' },
    { method: 'delete', suffix: '', schema: revisionSchema, kind: 'remove' },
  ]) app[method](`/api/protected-mcp/connections/:id${suffix}`, supported, jsonBody, async (req, res) => {
    const body = schema.safeParse(req.body);
    if (!body.success) return fail(res, 400, 'invalid_request', 'The connection change is invalid');
    const result = await admin({ type: 'apply', operation: { kind, id: req.params.id, ...body.data } });
    const alreadyRemoved = kind === 'remove' && !result.ok && result.status === 404 && result.code === 'connection_not_found';
    if (!result.ok && !alreadyRemoved) return fail(res, result.status, result.code, result.message);
    if (kind !== 'remove') return res.json({ connection: result.answer.connection });
    try {
      const cleanup = await selections.removeConnection(req.params.id);
      return res.json({ removed: true, selectionsRemoved: cleanup.removed, selectionsNotUpdated: cleanup.notUpdated });
    } catch {
      return res.json({ removed: true, selectionsRemoved: [], selectionsNotUpdated: ['mcp-protected'] });
    } finally {
      void agentSubject.push();
      void selectionMirror?.push();
    }
  });
  app.post('/api/protected-mcp/connections/:id/oauth', supported, jsonBody, async (req, res) => {
    const body = revisionSchema.safeParse(req.body);
    if (!body.success) return fail(res, 400, 'invalid_request', 'expectedRevision is required');
    const origin = requestOrigin(req);
    if (!origin) return fail(res, 400, 'origin_unknown', 'The request origin is unknown');
    const answer = await ask(res, { type: 'oauth-start', id: req.params.id, ...body.data, redirectUri: `${origin}/api/protected-mcp/oauth/callback` }, OAUTH_START_TIMEOUT_MS);
    if (answer) res.json({ attempt: answer.attempt, authorizationUrl: answer.authorizationUrl });
  });
  app.get('/api/protected-mcp/oauth/attempts/:attempt', supported, async (req, res) => {
    const answer = await ask(res, { type: 'oauth-attempt', attempt: req.params.attempt });
    if (answer) { const { type: _type, ...attempt } = answer; res.json(attempt); }
  });
  app.post('/api/protected-mcp/oauth/complete', supported, jsonBody, async (req, res) => {
    const body = addressSchema.safeParse(req.body);
    if (!body.success) return fail(res, 400, 'invalid_request', 'A final sign-in address is required');
    const url = new URL(body.data.address);
    const fields = callbackSchema.safeParse(Object.fromEntries(url.searchParams));
    if (!fields.success) return fail(res, 400, 'invalid_request', 'The sign-in address is invalid');
    const answer = await ask(res, { type: 'oauth-complete', ...fields.data }, OAUTH_COMPLETE_TIMEOUT_MS);
    if (answer) res.json({ outcome: answer.outcome, name: answer.name });
  });
  app.get('/api/protected-mcp/oauth/callback', supported, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const fields = publicCallbackSchema.safeParse(req.query);
    let result = { ok: true, answer: { outcome: 'oauth_state_invalid' } };
    if (fields.success) {
      if (callbacksInFlight >= 4) result = { ok: false };
      else {
        callbacksInFlight += 1;
        try { result = await admin({ type: 'oauth-complete', ...fields.data }, OAUTH_COMPLETE_TIMEOUT_MS); }
        finally { callbacksInFlight -= 1; }
      }
    }
    const outcome = result.ok ? result.answer.outcome : null;
    const [status, text] = callbackOutcomes[outcome] ?? [503, 'The protected MCP service is not answering.'];
    const message = outcome === 'authorized' ? `Signed in to ${result.answer.name}. You can close this tab and return to OpenChamber.` : text;
    return res.status(status).type('html').send(renderOauthCallbackPage({ title: status === 200 ? 'Signed in' : 'Could not sign in', message }));
  });
}
