import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type {
  AgentLoopInstance,
  AgentLoopStatus,
  StartAgentLoopParams,
  Workpackage,
  WorkpackageFile,
} from '@/types/agentloop';
import { opencodeClient } from '@/lib/opencode/client';
import { useSessionStore } from './sessionStore';

/**
 * Agent Loop Store
 *
 * Manages sequential execution of workpackages through OpenCode sessions.
 * Each workpackage gets its own session (as a child of a "root" session).
 * The store subscribes to session status changes to detect completion
 * and automatically advance to the next workpackage.
 */

interface AgentLoopState {
  /** All agent loop instances (keyed by loop ID) */
  loops: Map<string, AgentLoopInstance>;
  /** Whether a loop is currently being created */
  isCreating: boolean;
  /** Error from the last operation */
  error: string | null;
}

interface AgentLoopActions {
  /** Start a new agent loop from a workpackage file */
  startLoop: (params: StartAgentLoopParams) => Promise<string | null>;
  /** Pause the loop (stops advancing to the next workpackage) */
  pauseLoop: (loopId: string) => void;
  /** Resume a paused loop */
  resumeLoop: (loopId: string) => void;
  /** Skip the current workpackage and move to the next */
  skipCurrent: (loopId: string) => void;
  /** Stop the loop entirely */
  stopLoop: (loopId: string) => void;
  /** Called when a session transitions to idle — advances the loop */
  onSessionCompleted: (sessionId: string) => void;
  /** Clear error */
  clearError: () => void;
  /** Get a loop instance by ID */
  getLoop: (loopId: string) => AgentLoopInstance | undefined;
  /** Get loop instance by parent session ID */
  getLoopByParentSession: (sessionId: string) => AgentLoopInstance | undefined;
  /** Get loop instance that contains a specific child session */
  getLoopByChildSession: (sessionId: string) => AgentLoopInstance | undefined;
}

type AgentLoopStore = AgentLoopState & AgentLoopActions;

/** Generate a unique loop ID */
const generateLoopId = (): string =>
  `loop_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

/**
 * Build the prompt for a single workpackage, optionally prepending
 * a system prompt.
 */
const buildTaskPrompt = (wp: Workpackage, systemPrompt?: string): string => {
  const parts: string[] = [];
  if (systemPrompt && systemPrompt.trim()) {
    parts.push(systemPrompt.trim());
  }
  parts.push(`## Task: ${wp.title}\n\n${wp.description}`);
  return parts.join('\n\n');
};

/**
 * Normalise a workpackage file's tasks so they all have valid statuses.
 */
const normalizeWorkpackages = (file: WorkpackageFile): Workpackage[] =>
  file.workpackages.map((wp) => ({
    ...wp,
    status: wp.status && wp.status !== 'pending' ? wp.status : 'pending',
    sessionId: wp.sessionId ?? undefined,
    error: wp.error ?? undefined,
  }));

export const useAgentLoopStore = create<AgentLoopStore>()(
  devtools(
    (set, get) => ({
      loops: new Map(),
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

      clearError: () => set({ error: null }),

      startLoop: async (params) => {
        const { workpackageFile, providerID, modelID, agent, variant, systemPrompt } = params;

        set({ isCreating: true, error: null });

        try {
          const loopId = generateLoopId();
          const workpackages = normalizeWorkpackages(workpackageFile);

          // Find the first pending workpackage to start from
          const startIndex = workpackages.findIndex((wp) => wp.status === 'pending');
          if (startIndex === -1) {
            set({ error: 'All workpackages are already completed', isCreating: false });
            return null;
          }

          // Create a root/parent session for the agent loop
          const rootSession = await opencodeClient.createSession({
            title: `🔄 ${workpackageFile.name}`,
          });

          const instance: AgentLoopInstance = {
            id: loopId,
            name: workpackageFile.name,
            status: 'running',
            workpackages,
            providerID,
            modelID,
            agent,
            variant,
            systemPrompt,
            parentSessionId: rootSession.id,
            currentIndex: startIndex,
            startedAt: Date.now(),
          };

          set((state) => {
            const next = new Map(state.loops);
            next.set(loopId, instance);
            return { loops: next, isCreating: false };
          });

          // Refresh sessions so the root appears in the sidebar
          try {
            await useSessionStore.getState().loadSessions();
          } catch {
            // Ignore refresh errors
          }

          // Kick off the first workpackage
          void executeWorkpackage(loopId, startIndex);

          return loopId;
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to start agent loop',
            isCreating: false,
          });
          return null;
        }
      },

      pauseLoop: (loopId) => {
        set((state) => {
          const loop = state.loops.get(loopId);
          if (!loop || loop.status !== 'running') return state;
          const next = new Map(state.loops);
          next.set(loopId, { ...loop, status: 'paused' });
          return { loops: next };
        });
      },

      resumeLoop: (loopId) => {
        const loop = get().loops.get(loopId);
        if (!loop || loop.status !== 'paused') return;

        set((state) => {
          const updated = new Map(state.loops);
          updated.set(loopId, { ...loop, status: 'running' });
          return { loops: updated };
        });

        // Find the next pending task and run it
        const nextIndex = loop.workpackages.findIndex(
          (wp, i) => i >= loop.currentIndex && wp.status === 'pending'
        );
        if (nextIndex !== -1) {
          void executeWorkpackage(loopId, nextIndex);
        }
      },

      skipCurrent: (loopId) => {
        const loop = get().loops.get(loopId);
        if (!loop) return;

        const idx = loop.currentIndex;
        const wp = loop.workpackages[idx];
        if (!wp || wp.status !== 'running') return;

        // Mark as skipped
        const updatedWps = [...loop.workpackages];
        updatedWps[idx] = { ...wp, status: 'skipped' };

        const nextIndex = updatedWps.findIndex(
          (w, i) => i > idx && w.status === 'pending'
        );

        set((state) => {
          const updated = new Map(state.loops);
          updated.set(loopId, {
            ...loop,
            workpackages: updatedWps,
            currentIndex: nextIndex !== -1 ? nextIndex : idx,
            status: nextIndex === -1 ? 'completed' : loop.status,
          });
          return { loops: updated };
        });

        // Advance to next if the loop is running
        if (nextIndex !== -1 && loop.status === 'running') {
          void executeWorkpackage(loopId, nextIndex);
        }
      },

      stopLoop: (loopId) => {
        set((state) => {
          const loop = state.loops.get(loopId);
          if (!loop) return state;

          const updatedWps = loop.workpackages.map((wp) =>
            wp.status === 'running' ? { ...wp, status: 'skipped' as const } : wp
          );

          const next = new Map(state.loops);
          next.set(loopId, { ...loop, workpackages: updatedWps, status: 'completed' });
          return { loops: next };
        });
      },

      onSessionCompleted: (sessionId) => {
        const state = get();
        let targetLoop: AgentLoopInstance | undefined;
        let targetWpIndex = -1;

        for (const loop of state.loops.values()) {
          if (loop.status !== 'running') continue;
          const wpIdx = loop.workpackages.findIndex(
            (wp) => wp.sessionId === sessionId && wp.status === 'running'
          );
          if (wpIdx !== -1) {
            targetLoop = loop;
            targetWpIndex = wpIdx;
            break;
          }
        }

        if (!targetLoop || targetWpIndex === -1) return;

        // Mark the workpackage as completed
        const updatedWps = [...targetLoop.workpackages];
        updatedWps[targetWpIndex] = {
          ...updatedWps[targetWpIndex],
          status: 'completed',
        };

        // Find the next pending workpackage
        const nextIndex = updatedWps.findIndex(
          (wp, i) => i > targetWpIndex && wp.status === 'pending'
        );

        const isAllDone = nextIndex === -1;
        const newStatus: AgentLoopStatus = isAllDone ? 'completed' : 'running';

        set((prev) => {
          const updated = new Map(prev.loops);
          updated.set(targetLoop!.id, {
            ...targetLoop!,
            workpackages: updatedWps,
            currentIndex: nextIndex !== -1 ? nextIndex : targetWpIndex,
            status: newStatus,
          });
          return { loops: updated };
        });

        // Advance to the next workpackage
        if (nextIndex !== -1) {
          // Small delay before starting the next task to avoid overwhelming the server
          setTimeout(() => {
            void executeWorkpackage(targetLoop!.id, nextIndex);
          }, 2000);
        }
      },
    }),
    { name: 'agent-loop-store' }
  )
);

/**
 * Execute a specific workpackage by index within a loop.
 * Creates a child session and sends the task prompt.
 */
async function executeWorkpackage(loopId: string, wpIndex: number): Promise<void> {
  const store = useAgentLoopStore.getState();
  const loop = store.loops.get(loopId);
  if (!loop || loop.status !== 'running') return;

  const wp = loop.workpackages[wpIndex];
  if (!wp || wp.status !== 'pending') return;

  try {
    // Mark as running
    updateWorkpackage(loopId, wpIndex, { status: 'running' });

    // Create a child session under the root
    const session = await opencodeClient.createSession({
      title: `[${wpIndex + 1}/${loop.workpackages.length}] ${wp.title}`,
      parentID: loop.parentSessionId,
    });

    // Save the session ID to the workpackage
    updateWorkpackage(loopId, wpIndex, { sessionId: session.id });

    // Refresh sessions so the child appears in the sidebar
    try {
      await useSessionStore.getState().loadSessions();
    } catch {
      // Ignore
    }

    // Build and send the prompt
    const prompt = buildTaskPrompt(wp, loop.systemPrompt);

    await opencodeClient.sendMessage({
      id: session.id,
      providerID: loop.providerID,
      modelID: loop.modelID,
      text: prompt,
      agent: loop.agent,
      variant: loop.variant,
    });
  } catch (error) {
    console.warn('[AgentLoop] Failed to execute workpackage:', error);
    updateWorkpackage(loopId, wpIndex, {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    // Try to advance to next
    const updatedLoop = useAgentLoopStore.getState().loops.get(loopId);
    if (updatedLoop && updatedLoop.status === 'running') {
      const nextIndex = updatedLoop.workpackages.findIndex(
        (w, i) => i > wpIndex && w.status === 'pending'
      );
      if (nextIndex !== -1) {
        void executeWorkpackage(loopId, nextIndex);
      } else {
        useAgentLoopStore.setState((state) => {
          const updated = new Map(state.loops);
          updated.set(loopId, { ...updatedLoop, status: 'completed' });
          return { loops: updated };
        });
      }
    }
  }
}

/**
 * Helper to update a single workpackage's fields within a loop.
 */
function updateWorkpackage(
  loopId: string,
  wpIndex: number,
  patch: Partial<Workpackage>
): void {
  useAgentLoopStore.setState((state) => {
    const loop = state.loops.get(loopId);
    if (!loop) return state;

    const updatedWps = [...loop.workpackages];
    updatedWps[wpIndex] = { ...updatedWps[wpIndex], ...patch };

    const updated = new Map(state.loops);
    updated.set(loopId, { ...loop, workpackages: updatedWps });
    return { loops: updated };
  });
}
