import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RuntimeFetchOptions } from '@/lib/runtime-fetch';
import type { SkillPolicyEntry } from './skillAvailability';

const activeProjectPath = '/workspace/project-with-agents-skills';
// The project the app is on; tests that switch projects change it.
let currentProjectPath = activeProjectPath;

let runtimeFetchCalls: Array<{ url: string; init?: RuntimeFetchOptions }> = [];
let runtimeFetchImpl: (url: string, init?: RuntimeFetchOptions) => Promise<Response> = async () => (
  new Response(JSON.stringify({ skills: [] }), {
    headers: { 'Content-Type': 'application/json' },
  })
);
let getDirectoryImpl: () => string | undefined = () => undefined;

const runtimeFetchMock = async (url: string, init?: RuntimeFetchOptions) => {
  runtimeFetchCalls.push({ url: String(url), init });
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
      getActiveProject: () => ({ path: currentProjectPath }),
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

const {
  invalidateSkillsLoadCache,
  selectAvailableSkillsForDirectory,
  skillSwitchKey,
  useSkillsStore,
  withoutSwitchedOffQueuedSkills,
} = await import('./useSkillsStore');
const { buildSkillMentionInstruction } = await import('@/lib/skillMentionInstruction');

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
    invalidateSkillsLoadCache('/workspace/other-project');
    useSkillsStore.setState({
      selectedSkillId: null,
      skills: [],
      skillsByDirectory: {},
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

    const renamed = await useSkillsStore.getState().renameSkill({ id: 'old-skill', name: 'old-skill' }, 'new-skill');
    expect(renamed).toEqual({ ok: true, id: 'new-skill', oldRuleCleanupFailed: [] });

    const renameCall = runtimeFetchCalls.find((call) => String(call.url).includes('/api/config/skills/old-skill'));
    expect(renameCall).toBeTruthy();
    expect(renameCall?.init?.query).toEqual({ id: 'old-skill', directory: activeProjectPath });

    const headers = new Headers(renameCall?.init?.headers);
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
});

const jsonResponse = (json: string) => new Response(json, {
  headers: { 'Content-Type': 'application/json' },
});

// Two OpenCode ids whose frontmatter shares the display name `deploy`.
const deployWeb = {
  id: 'deploy-web',
  name: 'deploy',
  path: `${activeProjectPath}/.agents/skills/deploy-web/SKILL.md`,
  scope: 'project',
  source: 'agents',
  renamable: true,
  sources: { md: { description: 'Web' } },
};
const deployApi = {
  id: 'deploy-api',
  name: 'deploy',
  path: '/shared/skills/deploy-api/SKILL.md',
  scope: 'user',
  source: 'opencode',
  renamable: false,
  sources: { md: { description: 'API' } },
};

describe('useSkillsStore skill identity', () => {
  beforeEach(() => {
    runtimeFetchCalls = [];
    getDirectoryImpl = () => undefined;
    runtimeFetchImpl = async () => jsonResponse(JSON.stringify({ skills: [deployWeb, deployApi] }));
    invalidateSkillsLoadCache(activeProjectPath);
    useSkillsStore.setState({
      selectedSkillId: null,
      skills: [],
      skillsByDirectory: {},
      isLoading: false,
      skillDraft: null,
    });
  });

  test('two ids sharing a display name stay two rows through full and partial loads', async () => {
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(useSkillsStore.getState().skills.map((skill) => skill.id)).toEqual(['deploy-web', 'deploy-api']);

    // OpenCode's list failed and the disk scan found only one of them. The
    // other id is not on a managed root, so it is carried over, not dropped
    // because its display name matches.
    runtimeFetchImpl = async () => jsonResponse(JSON.stringify({ skills: [deployWeb], openCodeSkillsUnavailable: true }));
    invalidateSkillsLoadCache();
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(useSkillsStore.getState().skills.map((skill) => skill.id)).toEqual(['deploy-web', 'deploy-api']);
    expect(useSkillsStore.getState().getSkillById('deploy-api')?.path).toBe(deployApi.path);
  });

  test('an entry without an id keeps the id its folder gives it', async () => {
    runtimeFetchImpl = async () => jsonResponse(JSON.stringify({
      skills: [{ name: 'Display Name', path: `${activeProjectPath}/.opencode/skills/folder-id/SKILL.md` }],
    }));
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(useSkillsStore.getState().skills.map((skill) => [skill.id, skill.name])).toEqual([['folder-id', 'Display Name']]);
  });

  test('source copies of one id stay one row, the .agents copy winning', async () => {
    runtimeFetchImpl = async () => jsonResponse(JSON.stringify({
      skills: [
        { id: 'dup', name: 'dup', path: `${activeProjectPath}/.claude/skills/dup/SKILL.md` },
        { id: 'dup', name: 'dup', path: `${activeProjectPath}/.agents/skills/dup/SKILL.md` },
      ],
      externalSkills: { claudeDisabled: false, allDisabled: false },
    }));
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    const skills = useSkillsStore.getState().skills;
    expect(skills).toHaveLength(1);
    expect(skills[0]?.path).toContain('/.agents/');
  });

  test('each of two ids sharing a display name is read and changed through its own id', async () => {
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    // A server that honours the `id` selector answers for exactly that skill.
    const byId = new Map([[deployWeb.id, deployWeb], [deployApi.id, deployApi]]);
    const isListCall = (url: string) => url.startsWith('/api/config/skills?');
    runtimeFetchImpl = async (url, init) => {
      if (isListCall(url)) return jsonResponse(JSON.stringify({ skills: [deployWeb, deployApi] }));
      const query = init?.query instanceof URLSearchParams ? null : init?.query;
      const target = byId.get(String(query?.id));
      if (!target) return new Response(null, { status: 404 });
      if (url.includes('/files/')) return jsonResponse(JSON.stringify({ content: `notes of ${target.id}` }));
      if (init?.method) return jsonResponse(JSON.stringify({ success: true, requiresReload: false }));
      return jsonResponse(JSON.stringify({
        name: target.name,
        sources: { md: { exists: true, path: target.path, dir: null, fields: [], supportingFiles: [] } },
      }));
    };
    const store = useSkillsStore.getState();

    for (const listed of [deployWeb, deployApi]) {
      const skill = store.getSkillById(listed.id);
      if (!skill) throw new Error(`${listed.id} not loaded`);
      runtimeFetchCalls = [];

      expect((await store.getSkillDetail(skill))?.sources.md.path).toBe(listed.path);
      expect(await store.readSupportingFile(skill, 'notes.md')).toBe(`notes of ${listed.id}`);
      expect(await store.writeSupportingFile(skill, 'notes.md', 'text')).toBe(true);
      expect(await store.deleteSupportingFile(skill, 'notes.md')).toBe(true);
      expect(await store.updateSkill(skill, { description: 'Edited' })).toBe(true);
      expect((await store.renameSkill(skill, `${listed.id}-renamed`)).ok).toBe(true);
      expect(await store.deleteSkill(skill)).toBe(true);

      // Every call keeps the display name in the path and selects by id.
      const skillCalls = runtimeFetchCalls.filter((call) => !isListCall(call.url));
      expect(skillCalls).toHaveLength(7);
      for (const call of skillCalls) {
        expect(call.url.startsWith('/api/config/skills/deploy')).toBe(true);
        expect(call.init?.query).toEqual({ id: listed.id, directory: activeProjectPath });
      }
      const patch = skillCalls.find((call) => call.init?.method === 'PATCH' && String(call.init.body).includes('description'));
      expect(JSON.parse(String(patch?.init?.body)).targetPath).toBe(listed.path);
    }
  });

  test('deleting the selected skill clears the selection', async () => {
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    runtimeFetchImpl = async (_url, init) => jsonResponse(JSON.stringify(init?.method
      ? { success: true, requiresReload: false }
      : { skills: [deployWeb] }));
    useSkillsStore.getState().setSelectedSkill(deployApi.id);
    expect(await useSkillsStore.getState().deleteSkill(deployApi)).toBe(true);
    expect(useSkillsStore.getState().selectedSkillId).toBe(null);
  });

  test('a located delete names the scope and source beside the id', async () => {
    runtimeFetchImpl = async (_url, init) => jsonResponse(JSON.stringify(init?.method
      ? { success: true, requiresReload: false }
      : { skills: [deployWeb] }));
    runtimeFetchCalls.length = 0;

    expect(await useSkillsStore.getState().deleteSkill(deployApi, undefined, { scope: 'user', source: 'opencode' })).toBe(true);

    const call = runtimeFetchCalls.find((entry) => entry.init?.method === 'DELETE');
    expect(call?.init?.query).toEqual({ id: deployApi.id, directory: activeProjectPath, scope: 'user', source: 'opencode' });
  });

  test('a lower-priority copy of a deleted id comes back from the refreshed list', async () => {
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    // Delete removed the effective `.agents` copy; the `.claude` copy of the
    // same id is what OpenCode loads now.
    const remainingCopy = { ...deployWeb, path: `${activeProjectPath}/.claude/skills/deploy-web/SKILL.md`, source: 'claude' };
    runtimeFetchImpl = async (_url, init) => jsonResponse(JSON.stringify(init?.method
      ? { success: true, requiresReload: false }
      : { skills: [remainingCopy, deployApi] }));
    useSkillsStore.getState().setSelectedSkill(deployWeb.id);

    expect(await useSkillsStore.getState().deleteSkill(deployWeb)).toBe(true);
    expect(useSkillsStore.getState().getSkillById(deployWeb.id)?.path).toBe(remainingCopy.path);
    expect(useSkillsStore.getState().selectedSkillId).toBe(deployWeb.id);
  });

  test('a detail answer for another file is dropped', async () => {
    const skill = {
      id: 'folder-id',
      name: 'display',
      path: `${activeProjectPath}/.opencode/skills/folder-id/SKILL.md`,
    };
    runtimeFetchImpl = async () => jsonResponse(JSON.stringify({ skills: [skill] }));
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);

    const detailFor = (path: string) => jsonResponse(JSON.stringify({
      name: 'display',
      sources: { md: { exists: true, path, dir: null, fields: [], supportingFiles: [] } },
    }));
    runtimeFetchImpl = async () => detailFor(`${activeProjectPath}/.opencode/skills/display/SKILL.md`);
    expect(await useSkillsStore.getState().getSkillDetail(skill)).toBe(null);

    runtimeFetchImpl = async () => detailFor(skill.path);
    expect((await useSkillsStore.getState().getSkillDetail(skill))?.sources.md.path).toBe(skill.path);
  });
});

const enabledEntry: SkillPolicyEntry = {
  disabledIn: { global: false, project: false },
  effective: 'enabled',
  decidedBy: null,
};
const offGlobally: SkillPolicyEntry = {
  disabledIn: { global: true, project: false },
  effective: 'disabled',
  decidedBy: { path: '/config/opencode.json', resource: 'skill:deploy-api', effect: 'deny', scope: 'global', owned: true },
};
/** A `skillPolicy` as the server sends it: entries listed with their id. */
const policyState = (skills: Record<string, SkillPolicyEntry>) => ({
  version: '2.0.29',
  location: 'policies',
  writable: true,
  effectiveAvailable: true,
  scopes: {
    global: { path: '/config/opencode.json', error: null },
    project: { path: `${activeProjectPath}/.opencode/opencode.json`, error: null },
  },
  skills: Object.entries(skills).map(([id, entry]) => ({ id, ...entry })),
});
const listWithPolicy = (skillPolicy: ReturnType<typeof policyState> | { error: string }) => JSON.stringify({ skills: [deployWeb, deployApi], skillPolicy });

/** A response the test releases when it chooses, to hold a read in flight. */
const heldResponse = () => {
  let release: (json: string) => void = () => undefined;
  const response = new Promise<Response>((resolve) => {
    release = (json) => resolve(jsonResponse(json));
  });
  return { response, release };
};

describe('useSkillsStore availability and switches', () => {
  beforeEach(() => {
    runtimeFetchCalls = [];
    currentProjectPath = activeProjectPath;
    getDirectoryImpl = () => undefined;
    runtimeFetchImpl = async () => jsonResponse(listWithPolicy(policyState({ 'deploy-web': enabledEntry, 'deploy-api': offGlobally })));
    useSkillsStore.getState().resetForRuntimeSwitch();
    useSkillsStore.setState({ selectedSkillId: null, skillDraft: null });
  });

  test('a switched-off skill stays installed and leaves the available list', async () => {
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    const state = useSkillsStore.getState();
    expect(state.skills.map((skill) => skill.id)).toEqual(['deploy-web', 'deploy-api']);
    expect(state.availableSkills.map((skill) => skill.id)).toEqual(['deploy-web']);
    expect(selectAvailableSkillsForDirectory(state).map((skill) => skill.id)).toEqual(['deploy-web']);
  });

  test('a failed policy read keeps the last known state and says why', async () => {
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    runtimeFetchImpl = async () => jsonResponse(listWithPolicy({ error: 'OpenCode is not running' }));
    invalidateSkillsLoadCache();
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);

    const view = useSkillsStore.getState().policyByDirectory[activeProjectPath];
    expect(view?.error).toBe('OpenCode is not running');
    expect(view?.state?.skills.get('deploy-api')?.effective).toBe('disabled');
    expect(useSkillsStore.getState().availableSkills.map((skill) => skill.id)).toEqual(['deploy-web']);
  });

  test('without any policy read, nothing counts as switched off', async () => {
    // A cold OpenCode can answer an empty list; only the policy says "off".
    runtimeFetchImpl = async () => jsonResponse(JSON.stringify({ skills: [deployWeb, deployApi], openCodeSkillsUnavailable: true }));
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(useSkillsStore.getState().availableSkills.map((skill) => skill.id)).toEqual(['deploy-web', 'deploy-api']);

    runtimeFetchImpl = async () => jsonResponse(listWithPolicy(policyState({ 'deploy-web': { ...enabledEntry, effective: 'unknown' } })));
    invalidateSkillsLoadCache();
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(useSkillsStore.getState().availableSkills.map((skill) => skill.id)).toEqual(['deploy-web', 'deploy-api']);
  });

  test('queued delivery keeps a skill last seen off through an unknown read; Settings and the composer show unknown', async () => {
    const web = { id: 'deploy-web', name: 'deploy-web' };
    const api = { id: 'deploy-api', name: 'deploy-api' };
    const queued = [{ kind: 'instruction' as const, text: buildSkillMentionInstruction(['deploy-web', 'deploy-api']) ?? '', skills: [web, api] }];
    const webOnly = [{ kind: 'instruction', text: buildSkillMentionInstruction(['deploy-web']), skills: [web] }];
    const reload = async (skills: Record<string, SkillPolicyEntry>, directory?: string) => {
      runtimeFetchImpl = async () => jsonResponse(listWithPolicy(policyState(skills)));
      invalidateSkillsLoadCache(directory);
      expect(await useSkillsStore.getState().loadSkills(directory)).toBe(true);
    };
    const unknownEntry: SkillPolicyEntry = { disabledIn: { global: null, project: null }, effective: 'unknown', decidedBy: null };
    const other = '/workspace/other';

    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(withoutSwitchedOffQueuedSkills(queued, activeProjectPath)).toEqual(webOnly);

    await reload({ 'deploy-web': enabledEntry, 'deploy-api': unknownEntry });
    expect(useSkillsStore.getState().policyByDirectory[activeProjectPath]?.state?.skills.get('deploy-api')?.effective).toBe('unknown');
    expect(useSkillsStore.getState().availableSkills.map((skill) => skill.id)).toEqual(['deploy-web', 'deploy-api']);
    expect(withoutSwitchedOffQueuedSkills(queued, activeProjectPath)).toEqual(webOnly);

    // Another directory has its own history: unknown there names the skill.
    await reload({ 'deploy-web': enabledEntry, 'deploy-api': unknownEntry }, other);
    expect(withoutSwitchedOffQueuedSkills(queued, other)).toEqual(queued);

    await reload({ 'deploy-web': enabledEntry, 'deploy-api': enabledEntry });
    expect(withoutSwitchedOffQueuedSkills(queued, activeProjectPath)).toEqual(queued);
    await reload({ 'deploy-web': enabledEntry, 'deploy-api': unknownEntry });
    expect(withoutSwitchedOffQueuedSkills(queued, activeProjectPath)).toEqual(queued);

    useSkillsStore.getState().resetForRuntimeSwitch();
    expect(useSkillsStore.getState().lastDecidedByDirectory).toEqual({});
  });

  test('a skill id that names an Object.prototype key survives the JSON answer', async () => {
    const skill = (id: string) => ({ ...deployWeb, id, name: id, path: `${activeProjectPath}/.agents/skills/${id}/SKILL.md` });
    runtimeFetchImpl = async () => jsonResponse(JSON.stringify({
      skills: [skill('__proto__'), skill('constructor'), skill('toString')],
      skillPolicy: { ...policyState({}), skills: [{ id: '__proto__', ...offGlobally }, { id: 'constructor', ...enabledEntry }] },
    }));
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);

    const state = useSkillsStore.getState();
    const policy = state.policyByDirectory[activeProjectPath]?.state;
    expect([...(policy?.skills.keys() ?? [])]).toEqual(['__proto__', 'constructor']);
    expect(policy?.skills.get('__proto__')?.effective).toBe('disabled');
    expect(policy?.skills.get('toString')).toBeUndefined();
    expect(state.availableSkills.map((entry) => entry.id)).toEqual(['constructor', 'toString']);
    const queued = [{ kind: 'instruction' as const, text: '', skills: [{ id: '__proto__', name: '__proto__' }, { id: 'toString', name: 'toString' }] }];
    expect(withoutSwitchedOffQueuedSkills(queued, activeProjectPath)).toEqual([
      { kind: 'instruction', text: buildSkillMentionInstruction(['toString']), skills: [{ id: 'toString', name: 'toString' }] },
    ]);
  });

  test('a read started before a switch write cannot bring back the old state', async () => {
    runtimeFetchImpl = async () => jsonResponse(listWithPolicy(policyState({ 'deploy-web': enabledEntry, 'deploy-api': enabledEntry })));
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(useSkillsStore.getState().availableSkills).toHaveLength(2);

    // A read goes out while the skill is still on, and answers late.
    const stale = heldResponse();
    let listReads = 0;
    runtimeFetchImpl = async (url) => {
      if (url === '/api/config/skill-policy') {
        return jsonResponse(JSON.stringify({
          ok: true,
          id: 'deploy-api',
          saved: { scope: 'global', path: '/config/opencode.json', disabled: true, changed: true },
          confirmed: true,
          state: policyState({}),
          policy: offGlobally,
        }));
      }
      listReads += 1;
      if (listReads === 1) return stale.response;
      return jsonResponse(listWithPolicy(policyState({ 'deploy-web': enabledEntry, 'deploy-api': offGlobally })));
    };
    invalidateSkillsLoadCache();
    const staleLoad = useSkillsStore.getState().loadSkills();

    const write = await useSkillsStore.getState().setSkillEnabled('deploy-api', 'global', false);
    expect(write.ok).toBe(true);
    expect(useSkillsStore.getState().availableSkills.map((skill) => skill.id)).toEqual(['deploy-web']);

    stale.release(listWithPolicy(policyState({ 'deploy-web': enabledEntry, 'deploy-api': enabledEntry })));
    expect(await staleLoad).toBe(true);
    // The late answer was read again, not committed.
    expect(listReads).toBeGreaterThanOrEqual(2);
    expect(useSkillsStore.getState().availableSkills.map((skill) => skill.id)).toEqual(['deploy-web']);
    expect(useSkillsStore.getState().policyByDirectory[activeProjectPath]?.state?.skills.get('deploy-api')?.effective).toBe('disabled');
  });

  test('a failed write keeps the confirmed state and reports the reason', async () => {
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    runtimeFetchImpl = async () => jsonResponse(JSON.stringify({ ok: false, error: { code: 'opencode_unavailable', message: 'OpenCode is not running' } }));

    const result = await useSkillsStore.getState().setSkillEnabled('deploy-api', 'global', true);
    expect(result).toEqual({ ok: false, code: 'opencode_unavailable', message: 'OpenCode is not running' });
    const state = useSkillsStore.getState();
    expect(state.policyByDirectory[activeProjectPath]?.state?.skills.get('deploy-api')?.effective).toBe('disabled');
    expect(state.availableSkills.map((skill) => skill.id)).toEqual(['deploy-web']);
    expect(state.switchStatus[skillSwitchKey(undefined, 'deploy-api')]).toEqual({ phase: 'failed', scope: 'global', message: 'OpenCode is not running' });
  });

  test('a saved but unconfirmed write says so until a fresh read', async () => {
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    runtimeFetchImpl = async (url) => (url === '/api/config/skill-policy'
      ? jsonResponse(JSON.stringify({
        ok: true,
        id: 'deploy-web',
        saved: { scope: 'project', path: `${activeProjectPath}/.opencode/opencode.json`, disabled: true, changed: true },
        confirmed: false,
        state: policyState({}),
        // OpenCode still applies the old state.
        policy: { ...enabledEntry, disabledIn: { global: false, project: true } },
      }))
      : jsonResponse(listWithPolicy(policyState({ 'deploy-web': enabledEntry, 'deploy-api': offGlobally }))));
    runtimeFetchCalls = [];

    const result = await useSkillsStore.getState().setSkillEnabled('deploy-web', 'project', false);
    expect(result.ok).toBe(true);
    const key = skillSwitchKey(undefined, 'deploy-web');
    expect(useSkillsStore.getState().switchStatus[key]).toEqual({ phase: 'unconfirmed', scope: 'project' });
    // Nothing pretends it is off yet, and nothing is re-read on its own.
    expect(useSkillsStore.getState().availableSkills.map((skill) => skill.id)).toEqual(['deploy-web']);
    expect(runtimeFetchCalls.map((call) => call.url)).toEqual(['/api/config/skill-policy']);

    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(useSkillsStore.getState().switchStatus[key]).toBeUndefined();
  });

  test('one write per skill at a time, and the write names its directory', async () => {
    const write = heldResponse();
    runtimeFetchImpl = async () => write.response;
    const first = useSkillsStore.getState().setSkillEnabled('deploy-web', 'project', false, '/workspace/other');
    const second = await useSkillsStore.getState().setSkillEnabled('deploy-web', 'global', false, '/workspace/other');
    expect(second).toMatchObject({ ok: false, code: 'pending' });
    expect(useSkillsStore.getState().switchStatus[skillSwitchKey('/workspace/other', 'deploy-web')]).toEqual({ phase: 'pending', scope: 'project' });

    write.release(JSON.stringify({ ok: false, error: { code: 'unknown_skill', message: 'No installed skill has that id' } }));
    expect((await first).ok).toBe(false);
    expect(runtimeFetchCalls).toHaveLength(1);
    const [call] = runtimeFetchCalls;
    expect(call?.init?.query).toEqual({ directory: '/workspace/other' });
    expect(new Headers(call?.init?.headers).get('x-opencode-directory')).toBe('/workspace/other');
    expect(JSON.parse(String(call?.init?.body))).toEqual({ id: 'deploy-web', scope: 'project', enabled: false });
    // The app's own project was not touched.
    expect(useSkillsStore.getState().availableSkills).toEqual([]);
  });

  test('the ambient lists follow the project the app is on when a late read lands', async () => {
    const held = heldResponse();
    runtimeFetchImpl = async () => held.response;
    const load = useSkillsStore.getState().loadSkills();
    // The app moves to another project before the read answers.
    currentProjectPath = '/workspace/elsewhere';
    held.release(listWithPolicy(policyState({})));
    expect(await load).toBe(true);

    const state = useSkillsStore.getState();
    expect(state.skillsByDirectory[activeProjectPath]?.map((skill) => skill.id)).toEqual(['deploy-web', 'deploy-api']);
    expect(state.skills).toEqual([]);
    expect(state.availableSkills).toEqual([]);
  });
});

describe('useSkillsStore rename result', () => {
  const target = { id: 'old-skill', name: 'old-skill' };

  beforeEach(() => {
    runtimeFetchCalls = [];
    currentProjectPath = activeProjectPath;
    useSkillsStore.getState().resetForRuntimeSwitch();
  });

  test('a rename that could not remove the old switch rule is done, and names the file', async () => {
    runtimeFetchImpl = async (_url, init) => jsonResponse(JSON.stringify(init?.method === 'PATCH'
      ? {
        success: true,
        name: 'new-skill',
        id: 'new-skill',
        switches: {
          carried: [{ scope: 'global', path: '/config/opencode.json' }],
          oldRuleRemoved: [],
          oldRuleKept: [],
          oldRuleCleanupFailed: [{ scope: 'global', path: '/config/opencode.json', error: 'EACCES: permission denied' }],
        },
      }
      : { skills: [] }));
    expect(await useSkillsStore.getState().renameSkill(target, 'new-skill')).toEqual({
      ok: true,
      id: 'new-skill',
      oldRuleCleanupFailed: [{ scope: 'global', path: '/config/opencode.json' }],
    });
  });

  test('a refused rename is a failure', async () => {
    runtimeFetchImpl = async () => new Response(JSON.stringify({ error: 'Skill new-skill already exists' }), { status: 500 });
    expect(await useSkillsStore.getState().renameSkill(target, 'new-skill')).toEqual({ ok: false });
  });

  test('a list that fails to reload after a done rename does not turn it into a failure', async () => {
    runtimeFetchImpl = async (_url, init) => (init?.method === 'PATCH'
      ? jsonResponse(JSON.stringify({ success: true, id: 'new-skill', switches: null }))
      : new Response('boom', { status: 500 }));
    expect(await useSkillsStore.getState().renameSkill(target, 'new-skill')).toEqual({ ok: true, id: 'new-skill', oldRuleCleanupFailed: [] });
  });
});
