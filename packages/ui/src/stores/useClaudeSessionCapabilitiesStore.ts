import { create } from 'zustand';
import {
  harnessSessionCapabilities,
  type ClaudeSessionCapabilities,
} from '@/lib/harness/client';

/** Built-in Claude slash commands offered before the first system/init. */
export const CLAUDE_BUILTIN_SLASH_COMMANDS = Object.freeze([
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
]) as readonly string[];

type ClaudeCapabilitiesStore = {
  bySessionId: Record<string, ClaudeSessionCapabilities>;
  loadingBySessionId: Record<string, boolean>;
  errorBySessionId: Record<string, string | null>;
  getCapabilities: (sessionId: string | null | undefined) => ClaudeSessionCapabilities | null;
  getSlashCommands: (sessionId: string | null | undefined) => readonly string[];
  refresh: (sessionId: string) => Promise<ClaudeSessionCapabilities | null>;
  reset: () => void;
};

const emptyCapabilities = (sessionId: string): ClaudeSessionCapabilities => ({
  sessionId,
  // Freeze so selectors can return this array by reference without reallocating.
  slashCommands: CLAUDE_BUILTIN_SLASH_COMMANDS as string[],
  skills: [],
  agents: [],
  tools: [],
  mcpServers: [],
  updatedAt: 0,
});

/**
 * Stable slash-command list for React selectors. Never allocate a fresh array
 * for the built-in fallback — that would break referential equality and can
 * infinite-loop effects that depend on the list.
 */
export function selectClaudeSlashCommands(
  state: Pick<ClaudeCapabilitiesStore, 'bySessionId'>,
  sessionId: string | null | undefined,
): readonly string[] {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (id) {
    const caps = state.bySessionId[id];
    if (caps?.slashCommands?.length) return caps.slashCommands;
  }
  return CLAUDE_BUILTIN_SLASH_COMMANDS;
}

export const useClaudeSessionCapabilitiesStore = create<ClaudeCapabilitiesStore>((set, get) => ({
  bySessionId: {},
  loadingBySessionId: {},
  errorBySessionId: {},

  getCapabilities: (sessionId) => {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id) return null;
    return get().bySessionId[id] ?? null;
  },

  getSlashCommands: (sessionId) => selectClaudeSlashCommands(get(), sessionId),

  refresh: async (sessionId) => {
    const id = sessionId.trim();
    if (!id) return null;
    set((state) => ({
      loadingBySessionId: { ...state.loadingBySessionId, [id]: true },
      errorBySessionId: { ...state.errorBySessionId, [id]: null },
    }));
    try {
      const result = await harnessSessionCapabilities(id);
      const capabilities = result.capabilities;
      // Prefer the server list when present; otherwise keep the stable built-in
      // reference so subscribers do not see a new array identity on every refresh.
      const slashCommands = capabilities.slashCommands.length > 0
        ? capabilities.slashCommands
        : (CLAUDE_BUILTIN_SLASH_COMMANDS as string[]);
      set((state) => ({
        bySessionId: {
          ...state.bySessionId,
          [id]: { ...capabilities, slashCommands },
        },
        loadingBySessionId: { ...state.loadingBySessionId, [id]: false },
      }));
      return get().bySessionId[id] ?? null;
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
