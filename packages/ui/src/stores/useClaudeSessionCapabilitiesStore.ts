import { create } from 'zustand';
import {
  harnessSessionCapabilities,
  type ClaudeSessionCapabilities,
} from '@/lib/harness/client';

/** Built-in Claude slash commands offered before the first system/init. */
export const CLAUDE_BUILTIN_SLASH_COMMANDS = [
  'clear',
  'compact',
  'context',
  'cost',
  'init',
  'pr-comments',
  'release-notes',
  'review',
  'security-review',
  'usage',
] as const;

type ClaudeCapabilitiesStore = {
  bySessionId: Record<string, ClaudeSessionCapabilities>;
  loadingBySessionId: Record<string, boolean>;
  errorBySessionId: Record<string, string | null>;
  getCapabilities: (sessionId: string | null | undefined) => ClaudeSessionCapabilities | null;
  getSlashCommands: (sessionId: string | null | undefined) => string[];
  refresh: (sessionId: string) => Promise<ClaudeSessionCapabilities | null>;
  reset: () => void;
};

const emptyCapabilities = (sessionId: string): ClaudeSessionCapabilities => ({
  sessionId,
  slashCommands: [...CLAUDE_BUILTIN_SLASH_COMMANDS],
  skills: [],
  agents: [],
  tools: [],
  mcpServers: [],
  updatedAt: 0,
});

export const useClaudeSessionCapabilitiesStore = create<ClaudeCapabilitiesStore>((set, get) => ({
  bySessionId: {},
  loadingBySessionId: {},
  errorBySessionId: {},

  getCapabilities: (sessionId) => {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id) return null;
    return get().bySessionId[id] ?? null;
  },

  getSlashCommands: (sessionId) => {
    const caps = get().getCapabilities(sessionId);
    if (caps?.slashCommands?.length) return caps.slashCommands;
    return [...CLAUDE_BUILTIN_SLASH_COMMANDS];
  },

  refresh: async (sessionId) => {
    const id = sessionId.trim();
    if (!id) return null;
    set((state) => ({
      loadingBySessionId: { ...state.loadingBySessionId, [id]: true },
      errorBySessionId: { ...state.errorBySessionId, [id]: null },
    }));
    try {
      const result = await harnessSessionCapabilities(id);
      set((state) => ({
        bySessionId: { ...state.bySessionId, [id]: result.capabilities },
        loadingBySessionId: { ...state.loadingBySessionId, [id]: false },
      }));
      return result.capabilities;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load Claude capabilities';
      // Keep built-in slash defaults available on failure — do not clear prior success.
      set((state) => ({
        bySessionId: {
          ...state.bySessionId,
          [id]: state.bySessionId[id] ?? emptyCapabilities(id),
        },
        loadingBySessionId: { ...state.loadingBySessionId, [id]: false },
        errorBySessionId: { ...state.errorBySessionId, [id]: message },
      }));
      return get().bySessionId[id] ?? null;
    }
  },

  reset: () => {
    set({
      bySessionId: {},
      loadingBySessionId: {},
      errorBySessionId: {},
    });
  },
}));
