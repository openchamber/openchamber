import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type {
  AgentLoopInstance,
  StartAgentLoopParams,
  WorkpackageFile,
} from '@/types/agentloop';
import { validateWorkpackageFile } from '@/types/agentloop';
import { opencodeClient } from '@/lib/opencode/client';
import { useSessionStore } from './sessionStore';
import { useMessageStore } from './messageStore';

/**
 * Agent Loop Store
 *
 * Thin client that delegates all loop orchestration to the backend service.
 * Planning session management remains client-side.
 */

/** Status of a planning session */
export type PlanningSessionStatus = 'planning' | 'validating' | 'done' | 'failed';

/** Tracks a session created to generate a workpackage plan */
export interface PlanningSession {
  sessionId: string;
  goal: string;
  status: PlanningSessionStatus;
  /** Validated workpackage file (set when status is 'done') */
  workpackageFile?: WorkpackageFile;
  error?: string;
  /** How many times we've reprompted for valid JSON */
  repromptCount: number;
  /** Provider + model used, so we can reprompt with the same config */
  providerID: string;
  modelID: string;
  agent?: string;
  /** Project directory the planning session belongs to */
  directory?: string;
}

/** Parameters for starting a planning session */
export interface StartPlanningSessionParams {
  goal: string;
  providerID: string;
  modelID: string;
  agent?: string;
  directory?: string;
}

interface AgentLoopState {
  /** All agent loop instances (keyed by loop ID) */
  loops: Map<string, AgentLoopInstance>;
  /** Active planning sessions (keyed by sessionId) */
  planningSessions: Map<string, PlanningSession>;
  /** Whether a loop is currently being created */
  isCreating: boolean;
  /** Error from the last operation */
  error: string | null;
}

interface AgentLoopActions {
  /** Start a new agent loop via the backend */
  startLoop: (params: StartAgentLoopParams) => Promise<string | null>;
  /** Pause a loop */
  pauseLoop: (loopId: string) => Promise<void>;
  /** Resume a paused loop */
  resumeLoop: (loopId: string) => Promise<void>;
  /** Skip the current workpackage */
  skipCurrent: (loopId: string) => Promise<void>;
  /** Stop the loop entirely */
  stopLoop: (loopId: string) => Promise<void>;
  /** Retry from the first failed task */
  retryFailed: (loopId: string) => Promise<void>;
  /** Clear error */
  clearError: () => void;
  /** Get a loop instance by ID */
  getLoop: (loopId: string) => AgentLoopInstance | undefined;
  /** Get loop instance by parent session ID */
  getLoopByParentSession: (sessionId: string) => AgentLoopInstance | undefined;
  /** Get loop instance that contains a specific child session */
  getLoopByChildSession: (sessionId: string) => AgentLoopInstance | undefined;
  /** Get loop instance that owns a session (checks trackedSessionIds across all loops) */
  getLoopForSession: (sessionId: string) => AgentLoopInstance | undefined;
  /** Update model/agent/variant config on an existing loop */
  updateLoopConfig: (loopId: string, patch: Pick<Partial<AgentLoopInstance>, 'providerID' | 'modelID' | 'agent' | 'variant'>) => Promise<void>;
  /** Fetch all loops from backend and update store */
  fetchLoops: () => Promise<void>;
  /** Start polling the backend for loop updates */
  startPolling: () => void;
  /** Stop polling */
  stopPolling: () => void;

  // Planning session actions
  startPlanningSession: (params: StartPlanningSessionParams) => Promise<string | null>;
  onPlanningSessionCompleted: (sessionId: string) => Promise<void>;
  dismissPlanningSession: (sessionId: string) => void;
  getPlanningSession: (sessionId: string) => PlanningSession | undefined;
  implementPlan: (sessionId: string, extras?: { systemPrompt?: string }) => Promise<string | null>;
  registerOrRefreshPlanningSession: (
    sessionId: string,
    sessionTitle: string,
    isSessionBusy: boolean,
  ) => Promise<void>;
}

type AgentLoopStore = AgentLoopState & AgentLoopActions;

/** Max auto-reprompt attempts if the model outputs invalid JSON */
const MAX_REPROMPT_ATTEMPTS = 2;

/** The filename the planning agent always writes the workpackage plan to */
export const WORKPACKAGE_FILENAME = 'workpackage.json';

/** Prompt template for generating a workpackage plan */
export const PLAN_GENERATION_PROMPT = `You are a project planning assistant. The user wants to accomplish the following:

{USER_GOAL}

Your job:
1. Analyse the codebase to understand its structure and conventions.
2. Produce a detailed workpackage plan as JSON matching the schema below.
3. Write the plan to the file \`workpackage.json\` in the project root using the write-file tool — do NOT print the JSON to the chat.
4. Once the file is saved, reply with a short confirmation, e.g. "Plan saved — N tasks ready."

JSON schema for the file:
{
  "name": "Short human-readable plan name",
  "workpackages": [
    {
      "id": "unique-kebab-case-id",
      "title": "Short task title",
      "description": "Full context needed for an AI agent to complete this task independently.",
      "status": "pending"
    }
  ]
}

Rules:
- Break work into small, focused tasks each completable independently
- Include enough context in each description so an agent can work without the others
- Order tasks so dependencies come first
- Use descriptive kebab-case IDs (e.g. "setup-database", "add-auth-middleware")
- All statuses must be "pending"`;

/** Prompt sent when the plan file was not found or was invalid */
const REPROMPT_WRITE_FILE = `The workpackage plan was not found. Please write it now to \`workpackage.json\` in the project root using the write-file tool with the following structure (all statuses "pending"):

{
  "name": "Short plan name",
  "workpackages": [
    {
      "id": "unique-kebab-id",
      "title": "Task title",
      "description": "Full task description",
      "status": "pending"
    }
  ]
}

After writing, reply with a short confirmation.`;

/**
 * Search through all fields of an object for a string value that looks like
 * a file path ending in the target filename.
 */
function findPathInObject(obj: Record<string, unknown>, target: string): string | null {
  for (const val of Object.values(obj)) {
    if (typeof val === 'string' && val.length < 500) {
      if (
        val === target ||
        val.endsWith(`/${target}`) ||
        val.endsWith(`\\${target}`)
      ) {
        return val;
      }
    }
  }
  return null;
}

/**
 * Search through all fields of an object for a string that parses as valid
 * workpackage JSON.
 */
function findWorkpackageJsonInObject(obj: Record<string, unknown>): unknown | null {
  for (const val of Object.values(obj)) {
    if (typeof val !== 'string' || val.length < 10) continue;
    try {
      const parsed = JSON.parse(val);
      if (validateWorkpackageFile(parsed)) return parsed;
    } catch {
      // not JSON
    }
  }
  return null;
}

/**
 * Extract the workpackage plan from the tool call parts in a session's messages.
 */
function extractWorkpackageFromToolCalls(sessionId: string): WorkpackageFile | null {
  const messages = useMessageStore.getState().messages.get(sessionId);
  if (!messages || messages.length === 0) {
    return null;
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info?.role !== 'assistant') continue;

    for (const part of msg.parts) {
      const p = part as Record<string, unknown>;
      if (p.type !== 'tool') continue;

      const state = (p.state ?? {}) as Record<string, unknown>;
      const input = (state.input ?? {}) as Record<string, unknown>;
      const metadata = (state.metadata ?? {}) as Record<string, unknown>;

      const filePath =
        findPathInObject(input, WORKPACKAGE_FILENAME) ??
        findPathInObject(metadata, WORKPACKAGE_FILENAME) ??
        findPathInObject(state, WORKPACKAGE_FILENAME);

      const metadataFilePath = (() => {
        if (!Array.isArray(metadata.files)) return null;
        for (const f of metadata.files) {
          if (!f || typeof f !== 'object') continue;
          const fp = findPathInObject(f as Record<string, unknown>, WORKPACKAGE_FILENAME);
          if (fp) return fp;
        }
        return null;
      })();

      const resolvedPath = filePath ?? metadataFilePath;
      if (!resolvedPath) continue;

      const parsed =
        findWorkpackageJsonInObject(input) ??
        findWorkpackageJsonInObject(state);

      if (parsed && validateWorkpackageFile(parsed)) {
        return { ...(parsed as WorkpackageFile), filePath: resolvedPath };
      }
    }
  }

  return null;
}

/** Polling interval handle */
let pollingInterval: ReturnType<typeof setInterval> | null = null;
const POLLING_INTERVAL_MS = 2000;

/**
 * Convert a backend loop response object to an AgentLoopInstance.
 */
function toLoopInstance(raw: Record<string, unknown>): AgentLoopInstance {
  return {
    id: raw.id as string,
    name: raw.name as string,
    status: raw.status as AgentLoopInstance['status'],
    workpackages: (raw.workpackages as AgentLoopInstance['workpackages']) ?? [],
    providerID: (raw.providerID as string) ?? '',
    modelID: (raw.modelID as string) ?? '',
    agent: raw.agent as string | undefined,
    variant: raw.variant as string | undefined,
    systemPrompt: raw.systemPrompt as string | undefined,
    directory: raw.directory as string | undefined,
    parentSessionId: raw.parentSessionId as string | undefined,
    currentIndex: (raw.currentIndex as number) ?? 0,
    startedAt: (raw.startedAt as number) ?? Date.now(),
    lastActivityAt: raw.lastActivityAt as number | undefined,
    error: raw.error as string | undefined,
    trackedSessionIds: Array.isArray(raw.trackedSessionIds)
      ? (raw.trackedSessionIds as string[])
      : undefined,
    workpackageFile: raw.filePath
      ? { name: raw.name as string, workpackages: (raw.workpackages as AgentLoopInstance['workpackages']) ?? [], filePath: raw.filePath as string }
      : undefined,
  };
}

export const useAgentLoopStore = create<AgentLoopStore>()(
  devtools(
    (set, get) => ({
      loops: new Map(),
      planningSessions: new Map(),
      isCreating: false,
      error: null,

      getLoop: (loopId) => get().loops.get(loopId),

      getLoopByParentSession: (sessionId) => {
        for (const loop of get().loops.values()) {
          if (loop.parentSessionId === sessionId) return loop;
        }
        return undefined;
      },

      getLoopByChildSession: (sessionId) => {
        for (const loop of get().loops.values()) {
          if (loop.workpackages.some((wp) => wp.sessionId === sessionId)) return loop;
        }
        return undefined;
      },

      getLoopForSession: (sessionId) => {
        for (const loop of get().loops.values()) {
          if (loop.trackedSessionIds?.includes(sessionId)) return loop;
        }
        return undefined;
      },

      clearError: () => set({ error: null }),

      // ── Loop actions (thin API wrappers) ────────────────────────────────

      startLoop: async (params) => {
        set({ isCreating: true, error: null });

        try {
          const result = await opencodeClient.startAgentLoop({
            filePath: params.filePath,
            providerID: params.providerID,
            modelID: params.modelID,
            agent: params.agent,
            variant: params.variant,
            systemPrompt: params.systemPrompt,
            directory: params.directory,
          });

          if (!result) {
            set({ error: 'Failed to start agent loop', isCreating: false });
            return null;
          }

          const loopData = (result as { loop: Record<string, unknown> }).loop;
          const instance = toLoopInstance(loopData);

          set((state) => {
            const next = new Map(state.loops);
            next.set(instance.id, instance);
            return { loops: next, isCreating: false };
          });

          // Refresh sessions so the root appears in sidebar
          try {
            await useSessionStore.getState().loadSessions();
          } catch {
            // Ignore
          }

          return instance.id;
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to start agent loop',
            isCreating: false,
          });
          return null;
        }
      },

      pauseLoop: async (loopId) => {
        const result = await opencodeClient.pauseAgentLoop(loopId);
        if (result) {
          const loopData = (result as { loop: Record<string, unknown> }).loop;
          const instance = toLoopInstance(loopData);
          set((state) => {
            const next = new Map(state.loops);
            next.set(instance.id, instance);
            return { loops: next };
          });
        }
      },

      resumeLoop: async (loopId) => {
        const result = await opencodeClient.resumeAgentLoop(loopId);
        if (result) {
          const loopData = (result as { loop: Record<string, unknown> }).loop;
          const instance = toLoopInstance(loopData);
          set((state) => {
            const next = new Map(state.loops);
            next.set(instance.id, instance);
            return { loops: next };
          });
        }
      },

      skipCurrent: async (loopId) => {
        const result = await opencodeClient.skipAgentLoopTask(loopId);
        if (result) {
          const loopData = (result as { loop: Record<string, unknown> }).loop;
          const instance = toLoopInstance(loopData);
          set((state) => {
            const next = new Map(state.loops);
            next.set(instance.id, instance);
            return { loops: next };
          });
        }
      },

      stopLoop: async (loopId) => {
        const result = await opencodeClient.stopAgentLoop(loopId);
        if (result) {
          const loopData = (result as { loop: Record<string, unknown> }).loop;
          const instance = toLoopInstance(loopData);
          set((state) => {
            const next = new Map(state.loops);
            next.set(instance.id, instance);
            return { loops: next };
          });
        }
      },

      retryFailed: async (loopId) => {
        const result = await opencodeClient.retryAgentLoop(loopId);
        if (result) {
          const loopData = (result as { loop: Record<string, unknown> }).loop;
          const instance = toLoopInstance(loopData);
          set((state) => {
            const next = new Map(state.loops);
            next.set(instance.id, instance);
            return { loops: next };
          });
        }
      },

      updateLoopConfig: async (loopId, patch) => {
        const result = await opencodeClient.updateAgentLoopConfig(loopId, patch);
        if (result) {
          const loopData = (result as { loop: Record<string, unknown> }).loop;
          const instance = toLoopInstance(loopData);
          set((state) => {
            const next = new Map(state.loops);
            next.set(instance.id, instance);
            return { loops: next };
          });
        }
      },

      fetchLoops: async () => {
        const result = await opencodeClient.getAgentLoops();
        if (!result) return;

        const loopsArray = (result as { loops: Record<string, unknown>[] }).loops;
        if (!Array.isArray(loopsArray)) return;

        const next = new Map<string, AgentLoopInstance>();
        for (const raw of loopsArray) {
          const instance = toLoopInstance(raw);
          next.set(instance.id, instance);
        }
        set({ loops: next });
      },

      startPolling: () => {
        if (pollingInterval) return;
        pollingInterval = setInterval(() => {
          void get().fetchLoops();
        }, POLLING_INTERVAL_MS);
      },

      stopPolling: () => {
        if (pollingInterval) {
          clearInterval(pollingInterval);
          pollingInterval = null;
        }
      },

      // ── Planning session actions ──────────────────────────────────────────

      getPlanningSession: (sessionId) => get().planningSessions.get(sessionId),

      startPlanningSession: async ({ goal, providerID, modelID, agent, directory }) => {
        try {
          const shortGoal = goal.trim().slice(0, 60);
          const session = await opencodeClient.createSession({
            title: `[Plan] ${shortGoal}${goal.trim().length > 60 ? '...' : ''}`,
            directory,
          });

          const planning: PlanningSession = {
            sessionId: session.id,
            goal: goal.trim(),
            status: 'planning',
            repromptCount: 0,
            providerID,
            modelID,
            agent,
            directory,
          };

          set((state) => {
            const next = new Map(state.planningSessions);
            next.set(session.id, planning);
            return { planningSessions: next };
          });

          try {
            await useSessionStore.getState().loadSessions();
          } catch {
            // Ignore
          }

          const prompt = PLAN_GENERATION_PROMPT.replace('{USER_GOAL}', goal.trim());
          await opencodeClient.sendMessage({
            id: session.id,
            providerID,
            modelID,
            text: prompt,
            agent: agent || undefined,
          });

          return session.id;
        } catch (error) {
          set({ error: error instanceof Error ? error.message : 'Failed to start planning session' });
          return null;
        }
      },

      onPlanningSessionCompleted: async (sessionId) => {
        const state = get();
        const ps = state.planningSessions.get(sessionId);
        if (!ps || ps.status !== 'planning') return;

        set((s) => {
          const next = new Map(s.planningSessions);
          next.set(sessionId, { ...ps, status: 'validating' });
          return { planningSessions: next };
        });

        try {
          const result = extractWorkpackageFromToolCalls(sessionId);

          if (result) {
            set((s) => {
              const next = new Map(s.planningSessions);
              next.set(sessionId, {
                ...ps,
                status: 'done',
                workpackageFile: result,
                repromptCount: ps.repromptCount,
              });
              return { planningSessions: next };
            });
            return;
          }

          if (ps.repromptCount < MAX_REPROMPT_ATTEMPTS) {
            set((s) => {
              const next = new Map(s.planningSessions);
              next.set(sessionId, { ...ps, status: 'planning', repromptCount: ps.repromptCount + 1 });
              return { planningSessions: next };
            });
            await opencodeClient.sendMessage({
              id: sessionId,
              providerID: ps.providerID,
              modelID: ps.modelID,
              text: REPROMPT_WRITE_FILE,
              agent: ps.agent || undefined,
            });
          } else {
            set((s) => {
              const next = new Map(s.planningSessions);
              next.set(sessionId, {
                ...ps,
                status: 'failed',
                error: `Could not find a valid ${WORKPACKAGE_FILENAME} after writing. Check that the file was created in the project root.`,
              });
              return { planningSessions: next };
            });
          }
        } catch (error) {
          set((s) => {
            const next = new Map(s.planningSessions);
            next.set(sessionId, {
              ...ps,
              status: 'failed',
              error: error instanceof Error ? error.message : 'Failed to validate plan',
            });
            return { planningSessions: next };
          });
        }
      },

      registerOrRefreshPlanningSession: async (sessionId, sessionTitle, isSessionBusy) => {
        const existing = get().planningSessions.get(sessionId);
        if (existing && existing.status !== 'planning') return;

        if (isSessionBusy) {
          if (!existing) {
            const goal = sessionTitle.replace(/^\[Plan\]\s*/, '').replace(/\.{3}$/, '');
            const ps: PlanningSession = {
              sessionId,
              goal,
              status: 'planning',
              repromptCount: 0,
              providerID: '',
              modelID: '',
            };
            set((s) => {
              const next = new Map(s.planningSessions);
              next.set(sessionId, ps);
              return { planningSessions: next };
            });
          }
          return;
        }

        const result = extractWorkpackageFromToolCalls(sessionId);
        const goal = sessionTitle.replace(/^\[Plan\]\s*/, '').replace(/\.{3}$/, '');

        const ps: PlanningSession = result
          ? {
              sessionId,
              goal,
              status: 'done',
              workpackageFile: result,
              repromptCount: 0,
              providerID: '',
              modelID: '',
            }
          : {
              sessionId,
              goal,
              status: 'failed',
              error: `Could not find ${WORKPACKAGE_FILENAME}. Try regenerating the plan.`,
              repromptCount: MAX_REPROMPT_ATTEMPTS,
              providerID: '',
              modelID: '',
            };

        set((s) => {
          const next = new Map(s.planningSessions);
          next.set(sessionId, ps);
          return { planningSessions: next };
        });
      },

      dismissPlanningSession: (sessionId) => {
        set((state) => {
          const next = new Map(state.planningSessions);
          next.delete(sessionId);
          return { planningSessions: next };
        });
      },

      implementPlan: async (sessionId, extras) => {
        const ps = get().planningSessions.get(sessionId);
        if (!ps || ps.status !== 'done' || !ps.workpackageFile) return null;

        const filePath = ps.workpackageFile.filePath ?? WORKPACKAGE_FILENAME;
        const loopId = await get().startLoop({
          filePath,
          providerID: ps.providerID,
          modelID: ps.modelID,
          agent: ps.agent,
          systemPrompt: extras?.systemPrompt,
          directory: ps.directory,
        });

        if (loopId) {
          get().dismissPlanningSession(sessionId);
        }

        return loopId;
      },
    }),
    { name: 'agent-loop-store' }
  )
);
