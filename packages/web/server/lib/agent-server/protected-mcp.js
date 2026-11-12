import express from 'express';
import { z } from 'zod';
import { createLocalMcpReader } from '../opencode/mcp-local-reader.js';
import { createMcpConfigRuntime } from '../opencode/mcp-config-runtime.js';
import {
  projectIdentitySchema, mcpNameSchema, MAX_SELECTION_MIRROR_BYTES,
  replaceSelectionMirror, readSelectionMirror,
} from '../protected-mcp/selection-mirror-documents.js';

export const AGENT_PROTECTED_MCP_ROUTE = '/api/openchamber/protected-mcp-agent';
const directorySchema = z.string().min(1).max(4096).regex(/^\/[^\x00-\x1f\x7f-\x9f]*$/);
const identityReply = z.object({ identity: projectIdentitySchema }).strict();
const namesReply = z.object({ names: z.array(mcpNameSchema).max(256) }).strict();

/** Only the authenticated agent composition mounts these non-secret, server-owned operations. */
export function registerAgentProtectedMcpRoutes(app, { agentServer, dataDir, listProjectDirectories }) {
  if (!agentServer) return;
  const local = createLocalMcpReader(dataDir);
  const config = createMcpConfigRuntime({ dataDir });
  const readRoute = (suffix, schema, read) => app.get(`${AGENT_PROTECTED_MCP_ROUTE}/${suffix}`, async (req, res) => {
    const query = new URL(req.originalUrl, 'http://localhost').searchParams;
    const parsed = directorySchema.safeParse(query.get('directory'));
    if (!parsed.success || query.getAll('directory').length !== 1 || [...query.keys()].some((key) => key !== 'directory')) {
      return res.status(400).json({ code: 'agent_mcp_invalid_request' });
    }
    try {
      if (!(await listProjectDirectories()).includes(parsed.data)) return res.status(403).json({ code: 'agent_project_not_registered' });
      const result = schema.safeParse(await read(parsed.data));
      if (!result.success) return res.status(502).json({ code: 'agent_mcp_invalid_response' });
      return res.json(result.data);
    } catch { return res.status(502).json({ code: 'agent_mcp_unavailable' }); }
  });
  readRoute('identity', identityReply, (directory) => ({ identity: local.resolve(directory).identity }));
  readRoute('names', namesReply, (directory) => ({ names: config.listMcpConfigs(directory).map((entry) => entry.name) }));
  const parser = express.json({ limit: MAX_SELECTION_MIRROR_BYTES });
  app.put(`${AGENT_PROTECTED_MCP_ROUTE}/selections`, (req, res, next) => {
    parser(req, res, (error) => error ? res.status(error.status === 413 ? 413 : 400).json({ code: 'agent_mcp_invalid_request' }) : next());
  }, async (req, res) => {
    try {
      if (new URL(req.originalUrl, 'http://localhost').search) return res.status(400).json({ code: 'agent_mcp_invalid_request' });
      await replaceSelectionMirror(dataDir, req.body);
      return res.json({ mirrored: true });
    } catch (error) {
      return res.status(error instanceof z.ZodError ? 400 : 503).json({ code: 'agent_mcp_mirror_failed' });
    }
  });
}

export async function readAgentProjectIdentity(upstream, directory) {
  const query = new URLSearchParams({ directory: directorySchema.parse(directory) });
  return identityReply.parse(await upstream.json(`${AGENT_PROTECTED_MCP_ROUTE}/identity?${query}`, { timeoutMs: 5000 })).identity;
}

export async function readAgentOrdinaryMcpNames(upstream, directory) {
  const query = new URLSearchParams({ directory: directorySchema.parse(directory) });
  return namesReply.parse(await upstream.json(`${AGENT_PROTECTED_MCP_ROUTE}/names?${query}`, { timeoutMs: 5000 })).names;
}

/** Responses cannot change owner selections or service authority. Re-read in the serialized queue. */
export function createProtectedMcpMirror({ upstream, dataDir, log = (code) => console.warn('[protected-mcp] selection_mirror_failed', { code }) }) {
  let pending = Promise.resolve();
  const push = () => {
    pending = pending.then(async () => {
      try {
        const snapshot = await readSelectionMirror(dataDir);
        const body = JSON.stringify(snapshot);
        if (Buffer.byteLength(body) > MAX_SELECTION_MIRROR_BYTES) { log('selection_mirror_too_large'); return; }
        await upstream.json(`${AGENT_PROTECTED_MCP_ROUTE}/selections`, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body,
        });
      } catch { log('selection_mirror_unavailable'); }
    });
    return pending;
  };
  return { push, flush: () => pending };
}
