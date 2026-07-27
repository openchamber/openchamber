import { beforeEach, describe, expect, mock, test } from 'bun:test';

let harnessCapabilitiesImpl: () => Promise<{
  capabilities: {
    sessionId: string;
    slashCommands: string[];
    skills: string[];
    agents: string[];
    tools: string[];
    mcpServers: string[];
    updatedAt: number;
  };
}> = async () => ({
  capabilities: {
    sessionId: 'sess-1',
    slashCommands: [],
    skills: [],
    agents: [],
    tools: [],
    mcpServers: [],
    updatedAt: 1,
  },
});

mock.module('@/lib/harness/client', () => ({
  harnessSessionCapabilities: async (sessionId: string) => {
    const result = await harnessCapabilitiesImpl();
    return {
      capabilities: {
        ...result.capabilities,
        sessionId,
      },
    };
  },
}));

const {
  CLAUDE_BUILTIN_SLASH_COMMANDS,
  selectClaudeSlashCommands,
  useClaudeSessionCapabilitiesStore,
} = await import('./useClaudeSessionCapabilitiesStore');

describe('useClaudeSessionCapabilitiesStore slash selectors', () => {
  beforeEach(() => {
    useClaudeSessionCapabilitiesStore.getState().reset();
    harnessCapabilitiesImpl = async () => ({
      capabilities: {
        sessionId: 'sess-1',
        slashCommands: [],
        skills: [],
        agents: [],
        tools: [],
        mcpServers: [],
        updatedAt: 1,
      },
    });
  });

  test('builtin fallback returns a stable reference across calls', () => {
    const state = useClaudeSessionCapabilitiesStore.getState();
    const a = selectClaudeSlashCommands(state, null);
    const b = selectClaudeSlashCommands(state, 'missing-session');
    const c = state.getSlashCommands('also-missing');
    expect(a).toBe(CLAUDE_BUILTIN_SLASH_COMMANDS);
    expect(b).toBe(CLAUDE_BUILTIN_SLASH_COMMANDS);
    expect(c).toBe(CLAUDE_BUILTIN_SLASH_COMMANDS);
  });

  test('refresh with empty server slash list keeps the stable builtin reference', async () => {
    const before = selectClaudeSlashCommands(useClaudeSessionCapabilitiesStore.getState(), 'sess-1');
    await useClaudeSessionCapabilitiesStore.getState().refresh('sess-1');
    const after = selectClaudeSlashCommands(useClaudeSessionCapabilitiesStore.getState(), 'sess-1');
    expect(before).toBe(CLAUDE_BUILTIN_SLASH_COMMANDS);
    expect(after).toBe(CLAUDE_BUILTIN_SLASH_COMMANDS);
  });

  test('refresh with server slash list returns that session array by reference', async () => {
    const serverSlash = ['usage', 'compact'];
    harnessCapabilitiesImpl = async () => ({
      capabilities: {
        sessionId: 'sess-1',
        slashCommands: serverSlash,
        skills: [],
        agents: [],
        tools: [],
        mcpServers: [],
        updatedAt: 2,
      },
    });
    await useClaudeSessionCapabilitiesStore.getState().refresh('sess-1');
    const selected = selectClaudeSlashCommands(useClaudeSessionCapabilitiesStore.getState(), 'sess-1');
    expect(selected).toBe(serverSlash);
    expect(selected).toEqual(['usage', 'compact']);
  });
});
