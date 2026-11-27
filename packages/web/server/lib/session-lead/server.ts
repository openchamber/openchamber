import { z } from 'zod';
import { asNonEmptyString } from '../shared/guards.js';
import { readSessionModel } from '../session-warming/runtime.js';
import { createLeadActions } from './actions.js';
import { createLeadBriefEntry } from './brief-entry.js';
import { createLeadBriefStore } from './brief-store.js';
import { createLeadHandover } from './handover.js';
import { createOpenCodeClient } from '../openchamber-sessions/opencode-client.js';
import { inheritedFromParentPatch } from '../openchamber-sessions/fork-inheritance.js';
import { readLead } from './metadata.js';
import { createSessionLeadRuntime } from './runtime.js';
import type { Application, ExpressFactory, Request } from '../shared/http-contracts.js';
import type { SessionMetadata } from '../openchamber-sessions/session-metadata-store.js';
import type { LeadActionDependencies } from './actions.js';
import type { createLeadHandover as LeadHandoverFactory } from './handover.js';
import type { SessionLeadRuntimeOptions } from './runtime.js';
import type { createOpenChamberControlService } from '../openchamber-control/service.js';

const childrenSchema = z.object({
  sessions: z.array(z.object({ id: z.string(), title: z.string().optional(), status: z.object({ type: z.string() }).optional() })),
});

const leadsSchema = z.object({
  sessions: z.array(z.object({ id: z.string(), directory: z.string().optional() })),
});

interface WorkflowApprovalSettings {
  agentWorkflowAutoApprove?: unknown;
  agentWorkflowAutoApproveLeads?: unknown;
}

interface SessionLeadServerOptions extends Pick<SessionLeadRuntimeOptions, 'buildOpenCodeUrl' | 'getOpenCodeAuthHeaders' | 'isSessionWarm' | 'quiet'> {
  dataDir: string;
  readSessionMetadata: (sessionId: string, options: { directory: string }) => Promise<SessionMetadata | null | undefined>;
  updateMetadata: LeadActionDependencies['updateMetadata'];
  resolveSessionDirectory: (sessionId: string) => Promise<string | null>;
  syncBriefEntry: (sessionId: string, directory: string, brief: string) => Promise<boolean>;
  executeControl: ReturnType<typeof createOpenChamberControlService>['execute'];
  readWorkflowSettings: () => Promise<WorkflowApprovalSettings | null>;
  createError: LeadActionDependencies['createError'];
  registerResult: Parameters<typeof LeadHandoverFactory>[0]['registerResult'];
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
  quiet,
  registerResult,
}: SessionLeadServerOptions) => {
  const briefs = createLeadBriefStore({ dataDir });
  const briefEntry = createLeadBriefEntry({ briefs, putEntry: syncBriefEntry });

  const openCode = (directory: string) => createOpenCodeClient({ baseUrl: String(buildOpenCodeUrl('/', '')).replace(/\/$/, ''), headers: getOpenCodeAuthHeaders(), directory });

  const runtime = createSessionLeadRuntime({
    briefs,
    readSessionMetadata,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    readModel: (sessionId, directory) => readSessionModel({ fetchImpl: fetch, buildOpenCodeUrl, getOpenCodeAuthHeaders }, sessionId, directory),
    isSessionWarm,
    quiet,
    listChildren: async (sessionId) => childrenSchema.parse(await executeControl('session.list', { mine: true }, undefined, { contextSessionId: sessionId })).sessions,
    listLeads: async () => leadsSchema.parse(await executeControl('session.list', { leads: true })).sessions.map(({ id, directory }) => ({ id, directory: directory ?? '' })),
    clearInherited: async (sessionId, parentId, directory) => {
      const parent = await readSessionMetadata(parentId, { directory });
      return updateMetadata(sessionId, inheritedFromParentPatch(parent), directory);
    },
  });

  const handover = createLeadHandover({
    resolveSessionDirectory,
    readSessionMetadata,
    updateMetadata,
    openCode,
    isBusy: runtime.isBusy,
    registerResult,
    createError,
  });

  const actions = createLeadActions({
    getSession: async (sessionId) => {
      const directory = await resolveSessionDirectory(sessionId) ?? '';
      return { id: sessionId, directory, metadata: await readSessionMetadata(sessionId, { directory }) };
    },
    updateMetadata,
    briefs,
    handOver: handover.handOver,
    createError,
  });

  const refreshBriefEntry = async (sessionId: string) => {
    const directory = await resolveSessionDirectory(sessionId) ?? '';
    const lead = readLead(await readSessionMetadata(sessionId, { directory }));
    await briefEntry.refresh(sessionId, directory, lead !== null);
  };

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
      if (!sessionID) return res.json({ summary: null });
      const refreshed = await refreshBriefEntry(sessionID).then(() => true, (error: Error) => {
        console.warn('[session-lead] brief entry refresh failed:', error.message);
        return false;
      });
      const summary = await runtime.sleepSummary(sessionID).catch(() => null);
      return res.json({ summary: refreshed ? summary : null });
    });
  };

  return {
    readBriefForEntry: briefEntry.forEntry,
    actions,
    processPayload: runtime.processPayload,
    resumeSleep: runtime.resumeSleep,
    startsWorkflowWithoutApproval,
    registerRoutes,
  };
};
