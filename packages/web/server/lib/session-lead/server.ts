import { z } from 'zod';
import { asNonEmptyString } from '../shared/guards.js';
import { readSessionCacheLifetime } from '../session-warming/runtime.js';
import { createLeadActions } from './actions.js';
import { createLeadBriefStore } from './brief-store.js';
import { readLead } from './metadata.js';
import { createSessionLeadRuntime } from './runtime.js';
import type { Application, ExpressFactory, Request } from '../shared/http-contracts.js';
import type { SessionMetadata } from '../openchamber-sessions/session-metadata-store.js';
import type { LeadActionDependencies } from './actions.js';
import type { SessionLeadRuntimeOptions } from './runtime.js';
import type { createOpenChamberControlService } from '../openchamber-control/service.js';

const childrenSchema = z.object({
  sessions: z.array(z.object({ id: z.string(), title: z.string().optional(), status: z.object({ type: z.string() }).optional() })),
});

interface WorkflowApprovalSettings {
  agentWorkflowAutoApprove?: unknown;
  agentWorkflowAutoApproveLeads?: unknown;
}

interface SessionLeadServerOptions extends Pick<SessionLeadRuntimeOptions, 'buildOpenCodeUrl' | 'getOpenCodeAuthHeaders' | 'isSessionWarm'> {
  dataDir: string;
  readSessionMetadata: (sessionId: string, options: { directory: string }) => Promise<SessionMetadata | null | undefined>;
  updateMetadata: LeadActionDependencies['updateMetadata'];
  resolveSessionDirectory: (sessionId: string) => Promise<string | null>;
  syncBriefEntry: LeadActionDependencies['syncBriefEntry'];
  executeControl: ReturnType<typeof createOpenChamberControlService>['execute'];
  readWorkflowSettings: () => Promise<WorkflowApprovalSettings | null>;
  createError: LeadActionDependencies['createError'];
}

export const createSessionLeadServer = ({
  dataDir,
  readSessionMetadata,
  updateMetadata,
  resolveSessionDirectory,
  syncBriefEntry,
  executeControl,
  readWorkflowSettings,
  createError,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  isSessionWarm,
}: SessionLeadServerOptions) => {
  const briefs = createLeadBriefStore({ dataDir });

  const actions = createLeadActions({
    getSession: async (sessionId) => {
      const directory = await resolveSessionDirectory(sessionId) ?? '';
      return { id: sessionId, directory, metadata: await readSessionMetadata(sessionId, { directory }) };
    },
    updateMetadata,
    briefs,
    syncBriefEntry,
    createError,
  });

  const runtime = createSessionLeadRuntime({
    briefs,
    readSessionMetadata,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    readCacheLifetime: (sessionId, directory) => readSessionCacheLifetime({ fetchImpl: fetch, buildOpenCodeUrl, getOpenCodeAuthHeaders }, sessionId, directory),
    isSessionWarm,
    listChildren: async (sessionId) => childrenSchema.parse(await executeControl('session.list', { mine: true }, undefined, { contextSessionId: sessionId })).sessions,
  });

  const startsWorkflowWithoutApproval = async (sessionId: string) => {
    const settings = await readWorkflowSettings();
    if (settings?.agentWorkflowAutoApprove === true) return true;
    if (settings?.agentWorkflowAutoApproveLeads !== true) return false;
    return readLead(await readSessionMetadata(sessionId, { directory: '' }).catch(() => null)) !== null;
  };

  const registerRoutes = (app: Application, express: Pick<ExpressFactory, 'json'>, authorize: (req: Pick<Request, 'socket' | 'headers'>) => boolean) => {
    app.post<{ sessionID?: unknown }>('/api/openchamber/agent-tool/lead-compaction', express.json({ limit: '16kb' }), async (req, res) => {
      if (!authorize(req)) return res.status(401).json({ error: 'Unauthorized' });
      const sessionID = asNonEmptyString(req.body?.sessionID);
      const summary = sessionID ? await runtime.sleepSummary(sessionID).catch(() => null) : null;
      return res.json({ summary });
    });
  };

  return {
    readBrief: briefs.read,
    actions,
    processPayload: runtime.processPayload,
    startsWorkflowWithoutApproval,
    registerRoutes,
  };
};
