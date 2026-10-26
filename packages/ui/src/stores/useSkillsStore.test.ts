import { beforeEach, describe, expect, mock, test } from 'bun:test';

const activeProjectPath = '/workspace/project-with-agents-skills';

let runtimeFetchCalls: Array<{ url: string; headers?: HeadersInit }> = [];
let runtimeFetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () => (
  new Response(JSON.stringify({ skills: [] }), {
    headers: { 'Content-Type': 'application/json' },
  })
);
let getDirectoryImpl: () => string | undefined = () => undefined;
type Policy = { resource: string; effect: 'allow' | 'deny'; path: string | null };
let policiesImpl: () => Promise<Policy[]> = async () => [];

const runtimeFetchMock = async (url: string, init?: RequestInit) => {
  runtimeFetchCalls.push({ url: String(url), headers: init?.headers });
  return runtimeFetchImpl(url, init);
};

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: () => getDirectoryImpl(),
    checkHealth: async () => true,
    getIntegrationPolicies: () => policiesImpl(),
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

const { invalidateSkillsLoadCache, selectAvailableSkillsForDirectory, useSkillsStore } = await import('./useSkillsStore');

describe('useSkillsStore directory resolution', () => {
  beforeEach(() => {
    runtimeFetchCalls = [];
    getDirectoryImpl = () => undefined;
    policiesImpl = async () => [];
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
    invalidateSkillsLoadCache('/workspace/other-project');
    useSkillsStore.setState({
      selectedSkillName: null,
      skills: [],
      skillsByDirectory: {},
      policiesByDirectory: {},
      isLoading: false,
      skillDraft: null,
    });
  });

  test('loading another project leaves the active project\'s skills alone', async () => {
    // Settings can browse a project the app is not on. Chat autocompletes read
    // `skills`, so that list must keep describing the active project.
    const activeSkills = [{
      id: 'active-only',
      name: 'active-only',
      path: `${activeProjectPath}/.agents/skills/active-only/SKILL.md`,
      scope: 'project' as const,
      source: 'agents' as const,
      description: 'Active project skill',
      group: undefined,
      renamable: false,
    }];
    useSkillsStore.setState({
      skills: activeSkills,
      skillsByDirectory: { [activeProjectPath]: activeSkills },
    });

    const loaded = await useSkillsStore.getState().loadSkills('/workspace/other-project');

    expect(loaded).toBe(true);
    expect(runtimeFetchCalls[0]?.url).toContain(`directory=${encodeURIComponent('/workspace/other-project')}`);
    const state = useSkillsStore.getState();
    expect(state.skills).toEqual(activeSkills);
    expect(state.skillsByDirectory['/workspace/other-project']?.map((skill) => skill.name)).toEqual(['repo-local-skill']);
  });

  test('loadSkills scopes discovery to the active project even when client directory is unset', async () => {
    const loaded = await useSkillsStore.getState().loadSkills();

    expect(loaded).toBe(true);
    expect(runtimeFetchCalls.length).toBe(1);
    expect(runtimeFetchCalls[0]?.url).toContain(`directory=${encodeURIComponent(activeProjectPath)}`);
    expect(useSkillsStore.getState().skills).toEqual([{
      id: 'repo-local-skill',
      name: 'repo-local-skill',
      path: `${activeProjectPath}/.agents/skills/repo-local-skill/SKILL.md`,
      scope: 'project',
      source: 'agents',
      description: 'Repository local',
      group: undefined,
      renamable: false,
    }]);
  });

  test('loadSkills maps authoritative renamable from the list response', async () => {
    runtimeFetchImpl = async () => new Response(JSON.stringify({
      skills: [
        {
          name: 'managed-skill',
          path: `${activeProjectPath}/.opencode/skills/managed-skill/SKILL.md`,
          scope: 'project',
          source: 'opencode',
          renamable: true,
          sources: { md: { description: 'Managed' } },
        },
        {
          name: 'cache-skill',
          path: '/home/ubuntu/.cache/opencode/skills/hash/cache-skill/SKILL.md',
          scope: 'user',
          source: 'opencode',
          renamable: false,
          sources: { md: { description: 'Cache' } },
        },
      ],
    }), {
      headers: { 'Content-Type': 'application/json' },
    });

    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(useSkillsStore.getState().skills).toEqual([
      {
        id: 'managed-skill',
        name: 'managed-skill',
        path: `${activeProjectPath}/.opencode/skills/managed-skill/SKILL.md`,
        scope: 'project',
        source: 'opencode',
        description: 'Managed',
        group: undefined,
        renamable: true,
      },
      {
        id: 'cache-skill',
        name: 'cache-skill',
        path: '/home/ubuntu/.cache/opencode/skills/hash/cache-skill/SKILL.md',
        scope: 'user',
        source: 'opencode',
        description: 'Cache',
        group: 'hash',
        renamable: false,
      },
    ]);
  });

  test('renameSkill uses getRequestDirectory query and x-opencode-directory header', async () => {
    runtimeFetchImpl = async (_url, init) => {
      if (init?.method === 'PATCH') {
        return new Response(JSON.stringify({
          success: true,
          requiresReload: false,
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({
        skills: [{
          name: 'new-skill',
          path: `${activeProjectPath}/.opencode/skills/new-skill/SKILL.md`,
          scope: 'project',
          source: 'opencode',
          renamable: true,
          sources: { md: { description: 'Renamed' } },
        }],
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const renamed = await useSkillsStore.getState().renameSkill('old-skill', 'new-skill');
    expect(renamed).toBe(true);

    const renameCall = runtimeFetchCalls.find((call) => String(call.url).includes('/api/config/skills/old-skill'));
    expect(renameCall).toBeTruthy();
    expect(renameCall?.url).toContain(`directory=${encodeURIComponent(activeProjectPath)}`);

    const headers = new Headers(renameCall?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-opencode-directory')).toBe(activeProjectPath);
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
  test('a partial list keeps previously known OpenCode skills and is not cached as fresh', async () => {
    const builtIn = {
      id: 'OpenCode',
      name: 'OpenCode',
      path: '<built-in>',
      scope: 'user' as const,
      source: 'opencode' as const,
      description: 'Built-in',
      group: undefined,
      renamable: false,
    };
    const deletedManaged = {
      id: 'deleted-managed',
      name: 'deleted-managed',
      path: `${activeProjectPath}/.opencode/skills/deleted-managed/SKILL.md`,
      scope: 'project' as const,
      source: 'opencode' as const,
      description: 'Gone from disk',
      group: undefined,
      renamable: true,
    };
    useSkillsStore.setState({
      skills: [builtIn, deletedManaged],
      skillsByDirectory: { [activeProjectPath]: [builtIn, deletedManaged] },
    });
    const diskOnly = {
      name: 'repo-local-skill',
      path: `${activeProjectPath}/.agents/skills/repo-local-skill/SKILL.md`,
      scope: 'project',
      source: 'agents',
      sources: { md: { description: 'Repository local' } },
    };
    runtimeFetchImpl = async () => new Response(JSON.stringify({
      skills: [diskOnly],
      openCodeSkillsUnavailable: true,
    }), { headers: { 'Content-Type': 'application/json' } });

    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(useSkillsStore.getState().skills.map((skill) => skill.name)).toEqual(['repo-local-skill', 'OpenCode']);

    // Not cached: the next load asks again, and a complete answer is authoritative.
    runtimeFetchImpl = async () => new Response(JSON.stringify({ skills: [diskOnly] }), {
      headers: { 'Content-Type': 'application/json' },
    });
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(runtimeFetchCalls.length).toBe(2);
    expect(useSkillsStore.getState().skills.map((skill) => skill.name)).toEqual(['repo-local-skill']);
  });

  test('a switched-off skill stays installed but leaves the available list; a failed policy read keeps it off', async () => {
    const deny: Policy = { resource: 'skill:repo-local-skill', effect: 'deny', path: '/home/u/.config/opencode/opencode.json' };
    policiesImpl = async () => [deny];
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    const state = useSkillsStore.getState();
    expect(state.skillsByDirectory[activeProjectPath].map((skill) => skill.id)).toEqual(['repo-local-skill']);
    expect(selectAvailableSkillsForDirectory(state)).toEqual([]);

    policiesImpl = async () => { throw new Error('offline'); };
    invalidateSkillsLoadCache();
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(useSkillsStore.getState().policiesByDirectory[activeProjectPath]).toEqual([deny]);
    expect(selectAvailableSkillsForDirectory(useSkillsStore.getState())).toEqual([]);
  });

  test('a switch write moves the skill only after the server answers', async () => {
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    const [skill] = useSkillsStore.getState().skillsByDirectory[activeProjectPath];

    runtimeFetchImpl = async () => new Response(JSON.stringify({ error: 'Failed to write OpenCode configuration' }), { status: 500 });
    expect(await useSkillsStore.getState().setSkillEnabled(skill, false)).toBe(false);
    expect(selectAvailableSkillsForDirectory(useSkillsStore.getState())).toEqual([skill]);

    let body = '';
    runtimeFetchImpl = async (_url, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ changed: [`${activeProjectPath}/.opencode/opencode.json`] }), { headers: { 'Content-Type': 'application/json' } });
    };
    expect(await useSkillsStore.getState().setSkillEnabled(skill, false)).toBe(true);
    expect(JSON.parse(body)).toEqual({ id: 'repo-local-skill', enabled: false, scope: 'project' });
    expect(runtimeFetchCalls.at(-1)?.url).toContain('/api/config/skill-switch');
    expect(selectAvailableSkillsForDirectory(useSkillsStore.getState())).toEqual([]);
    expect(useSkillsStore.getState().policiesByDirectory[activeProjectPath]).toEqual([
      { resource: 'skill:repo-local-skill', effect: 'deny', path: `${activeProjectPath}/.opencode/opencode.json` },
    ]);
  });

  test('statements never read are unknown, not empty, and the next load asks again', async () => {
    policiesImpl = async () => { throw new Error('offline'); };
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(useSkillsStore.getState().policiesByDirectory[activeProjectPath]).toBeUndefined();

    policiesImpl = async () => [{ resource: 'skill:repo-local-skill', effect: 'deny', path: '/home/u/.config/opencode/opencode.json' }];
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(runtimeFetchCalls.length).toBe(2);
    expect(selectAvailableSkillsForDirectory(useSkillsStore.getState())).toEqual([]);
  });

  test('a user skill switched off shows off in every loaded directory; nothing written is a failure', async () => {
    const globalConfig = '/home/u/.config/opencode/opencode.json';
    useSkillsStore.setState({ policiesByDirectory: { '/workspace/other-project': [] } });
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    const skill = { ...useSkillsStore.getState().skillsByDirectory[activeProjectPath][0], scope: 'user' as const };

    runtimeFetchImpl = async () => new Response(JSON.stringify({ changed: [globalConfig] }), { headers: { 'Content-Type': 'application/json' } });
    expect(await useSkillsStore.getState().setSkillEnabled(skill, false)).toBe(true);
    const deny: Policy = { resource: 'skill:repo-local-skill', effect: 'deny', path: globalConfig };
    expect(useSkillsStore.getState().policiesByDirectory).toEqual({ [activeProjectPath]: [deny], '/workspace/other-project': [deny] });

    // The deny lives where the server cannot edit it: on writes nothing.
    useSkillsStore.setState({ policiesByDirectory: { [activeProjectPath]: [{ ...deny, path: '/broken/opencode.json' }] } });
    runtimeFetchImpl = async () => new Response(JSON.stringify({ changed: [] }), { headers: { 'Content-Type': 'application/json' } });
    expect(await useSkillsStore.getState().setSkillEnabled(skill, true)).toBe(false);
  });

  test('renaming a switched-off skill carries its rule to the new id', async () => {
    const projectConfig = `${activeProjectPath}/.opencode/opencode.json`;
    policiesImpl = async () => [{ resource: 'skill:repo-local-skill', effect: 'deny', path: projectConfig }];
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);

    const switches: unknown[] = [];
    runtimeFetchImpl = async (url, init) => {
      if (String(url).includes('/api/config/skill-switch')) {
        const body = JSON.parse(String(init?.body));
        switches.push(body);
        return new Response(JSON.stringify({ changed: [projectConfig] }), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ skills: [] }), { headers: { 'Content-Type': 'application/json' } });
    };
    expect(await useSkillsStore.getState().renameSkill('repo-local-skill', 'shipped')).toBe(true);
    expect(switches).toEqual([
      { id: 'shipped', enabled: false, scope: 'project' },
      { id: 'repo-local-skill', enabled: true, scope: 'project' },
    ]);
  });
});
