import { beforeEach, describe, expect, mock, test } from 'bun:test';

const activeProjectPath = '/workspace/project-with-agents-skills';

let runtimeFetchCalls: Array<{ url: string; headers?: HeadersInit }> = [];
let runtimeFetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () => (
  new Response(JSON.stringify({ skills: [] }), {
    headers: { 'Content-Type': 'application/json' },
  })
);
let getDirectoryImpl: () => string | undefined = () => undefined;

const runtimeFetchMock = async (url: string, init?: RequestInit) => {
  runtimeFetchCalls.push({ url: String(url), headers: init?.headers });
  return runtimeFetchImpl(url, init);
};

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: () => getDirectoryImpl(),
    checkHealth: async () => true,
  },
}));

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      getActiveProject: () => ({ path: activeProjectPath }),
    }),
  },
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

mock.module('@/lib/background-network', () => ({
  runBackgroundNetworkTask: async <T,>(task: () => Promise<T>) => task(),
}));

mock.module('@/lib/configUpdate', () => ({
  startConfigUpdate: mock(() => undefined),
  finishConfigUpdate: mock(() => undefined),
  updateConfigUpdateMessage: mock(() => undefined),
}));

mock.module('@/lib/configSync', () => ({
  emitConfigChange: mock(() => undefined),
  scopeMatches: mock(() => false),
  subscribeToConfigChanges: mock(() => () => undefined),
}));

mock.module('./utils/safeStorage', () => ({
  createDeferredSafeJSONStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

const { invalidateSkillsLoadCache, useSkillsStore } = await import('./useSkillsStore');

describe('useSkillsStore directory resolution', () => {
  beforeEach(() => {
    runtimeFetchCalls = [];
    getDirectoryImpl = () => undefined;
    runtimeFetchImpl = async () => new Response(JSON.stringify({
      skills: [{
        name: 'repo-local-skill',
        path: `${activeProjectPath}/.agents/skills/repo-local-skill/SKILL.md`,
        scope: 'project',
        source: 'agents',
        sources: { md: { description: 'Repository local' } },
      }],
    }), {
      headers: { 'Content-Type': 'application/json' },
    });

    invalidateSkillsLoadCache(activeProjectPath);
    useSkillsStore.setState({
      selectedSkillName: null,
      skills: [],
      isLoading: false,
      skillDraft: null,
    });
  });

  test('loadSkills scopes discovery to the active project even when client directory is unset', async () => {
    const loaded = await useSkillsStore.getState().loadSkills();

    expect(loaded).toBe(true);
    expect(runtimeFetchCalls.length).toBe(1);
    expect(runtimeFetchCalls[0]?.url).toContain(`directory=${encodeURIComponent(activeProjectPath)}`);
    expect(useSkillsStore.getState().skills).toEqual([{
      name: 'repo-local-skill',
      path: `${activeProjectPath}/.agents/skills/repo-local-skill/SKILL.md`,
      scope: 'project',
      source: 'agents',
      description: 'Repository local',
      group: undefined,
    }]);
  });

  test('invalidateSkillsLoadCache() with no argument clears the active-project cache key used by loadSkills', async () => {
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(runtimeFetchCalls.length).toBe(1);

    // Wrong key: client-directory-first null maps to __default__, not the active project.
    invalidateSkillsLoadCache(null);
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(runtimeFetchCalls.length).toBe(1);

    // Default resolution must match loadSkills (active project first).
    invalidateSkillsLoadCache();
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(runtimeFetchCalls.length).toBe(2);
    expect(runtimeFetchCalls[1]?.url).toContain(`directory=${encodeURIComponent(activeProjectPath)}`);
  });
});
