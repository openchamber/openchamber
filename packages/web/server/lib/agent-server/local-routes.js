import { z } from 'zod';
import { registerSettingsRoutes } from '../opencode/routes.js';
import { registerSettingsUtilityRoutes } from '../opencode/core-routes.js';
import { registerProtectedMcpRoutes } from '../protected-mcp/routes.js';
import { createProjectIdFromPath } from '../projects/project-id.js';
import { registerSystemStatsRoutes } from '../system-stats/routes.js';
import { createSystemStatsCollector } from '../system-stats/collect.js';
import { randomUUID } from 'node:crypto';
import { readAgentProjectIdentity, readAgentOrdinaryMcpNames } from './protected-mcp.js';
import { registerFrontDoorTrackedItemsRoutes } from './tracked-items.js';

const pathSchema = z.string().trim().min(1).max(4096).refine((value) => value.startsWith('/') && !value.includes('\0') && !/^\/spaces(?:\/|$)/.test(value));
const directorySchema = z.object({ path: pathSchema, create: z.literal(false).optional() });

/** Owner routes receive registry text only. Every project operation is forwarded before here. */
export function registerFrontDoorLocalRoutes(app, deps) {
  registerFrontDoorTrackedItemsRoutes(app, { service: deps.frontDoorTrackedItems });
  registerSettingsRoutes(app, deps);
  registerSettingsUtilityRoutes(app, deps);
  registerSystemStatsRoutes(app, { collector: createSystemStatsCollector({ os: deps.os, fsPromises: deps.fsPromises, process }), openchamberVersion: deps.openchamberVersion, isOpenCodeRunning: () => false });
  app.get('/api/openchamber/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.openchamberBrowserCapable = req.query.browser === '1';
    res.openchamberConnectionId = randomUUID();
    const clients = deps.getOpenChamberEventClients();
    clients.add(res);
    deps.frontDoorTrackedItems.openConnection(res.openchamberConnectionId);
    deps.writeSseEvent(res, { type: 'openchamber:event-stream-ready', properties: { connectedAt: Date.now(), connectionId: res.openchamberConnectionId } });
    const heartbeat = setInterval(() => deps.writeSseEvent(res, { type: 'openchamber:heartbeat', properties: { timestamp: Date.now() } }), 25_000);
    res.once('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
      void deps.frontDoorTrackedItems.closeConnection(res.openchamberConnectionId).catch(() => {});
    });
  });
  registerProtectedMcpRoutes(app, {
    dataDir: deps.openchamberDataDir,
    isSupported: () => true,
    resolveOptionalProjectDirectory: async (req) => {
      const candidate = req.query.directory ?? req.get('x-opencode-directory');
      if (!candidate) return { directory: null };
      const parsed = pathSchema.safeParse(candidate);
      if (!parsed.success) return { error: 'Invalid project directory' };
      const projects = await deps.listConfiguredProjects();
      if (!projects.some((project) => project.path === parsed.data)) return { error: 'Project directory is not registered' };
      return { directory: parsed.data };
    },
    resolveProjectIdentity: (directory) => readAgentProjectIdentity(deps.agentUpstream, directory),
    listOrdinaryMcpNames: (directory) => readAgentOrdinaryMcpNames(deps.agentUpstream, directory),
    selectionMirror: deps.protectedMcpMirror,
  });
  app.post('/api/openchamber/directory', async (req, res) => {
    const parsed = directorySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ code: 'project_path_refused', error: 'An absolute existing project path is required. Directory creation runs on the agent server.' });
    const directory = deps.path.posix.normalize(parsed.data.path);
    try {
      const current = await deps.readSettingsFromDiskMigrated();
      const projects = current.projects ?? [];
      const id = createProjectIdFromPath(directory);
      const next = projects.some((project) => project.path === directory) ? projects : [...projects, { id, path: directory, addedAt: Date.now(), lastOpenedAt: Date.now() }];
      const settings = await deps.persistSettings({ projects: next, activeProjectId: id, lastDirectory: directory });
      res.json({ success: true, restarted: false, path: directory, settings });
    } catch (error) {
      const code = /^(?:share_project_|project_path_|project_registry_|space_project_refused)/.test(error?.code ?? '') ? error.code : 'project_registry_failed';
      res.status(error?.status ?? 503).json({ code, error: code });
    }
  });
}
