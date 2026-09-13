import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';

import { emitConfigChange } from '@/lib/configSync';
import { resolveComposerAgentDirectory } from '@/lib/composerAgentDirectory';
import { opencodeClient } from '@/lib/opencode/client';
import type { AgentWithExtras } from './useAgentsStore';

// `loadAgents` tags each agent through its config route; these tests only
// exercise the directory list, so the route is a local no-op. Mutation tests
// swap the implementation to drive the `requiresReload` path.
let runtimeFetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = async () =>
  new Response(JSON.stringify({}), {
    headers: { 'Content-Type': 'application/json' },
  });

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (input: string | URL | Request, init?: RequestInit) => runtimeFetchImpl(input, init),
}));
import {
  refreshLoadedAgentDirectories,
  resolveAvailableAgentForDirectory,
  selectLoadedAgentsForDirectory,
  useAgentsStore,
} from './useAgentsStore';

/**
 * The per-directory agent list must distinguish three states for every reader:
 * a loaded list (even empty), a never-loaded directory, and a failed load.
 * The send guard and the picker both depend on that distinction, so these
 * tests pin the write/no-write behavior of `loadAgents` and the adapter's
 * lookup semantics.
 */

const originalListAgents = opencodeClient.listAgents;

const agent = (name: string): AgentWithExtras => ({
  name,
  mode: 'subagent',
  permission: [],
  options: {},
});

const resetAgentsState = () => {
  useAgentsStore.setState({ agentsByDirectory: {}, agents: [], isLoading: false });
};

describe('useAgentsStore directory loads', () => {
  let listAgentsCalls: Array<string | null | undefined>;

  beforeEach(() => {
    listAgentsCalls = [];
    resetAgentsState();
    opencodeClient.listAgents = async (directory) => {
      listAgentsCalls.push(directory);
      return [];
    };
  });

  afterEach(() => {
    opencodeClient.listAgents = originalListAgents;
  });

  test('a successful empty first load persists an empty list for its directory', async () => {
    const directory = '/projects/empty-first-load';

    const loaded = await useAgentsStore.getState().loadAgents(directory);

    expect(loaded).toBe(true);
    expect(listAgentsCalls).toEqual([directory]);
    // `[]` is a loaded answer, not a missing one: the guard can now report
    // `missing` instead of failing open for a project that defines no agents.
    expect(selectLoadedAgentsForDirectory(useAgentsStore.getState(), directory)).toEqual([]);
  });

  test('a failed fetch writes nothing and does not masquerade as an empty success', async () => {
    const directory = '/projects/fetch-fails';
    opencodeClient.listAgents = async (requestedDirectory) => {
      listAgentsCalls.push(requestedDirectory);
      throw new Error('network down');
    };

    const loaded = await useAgentsStore.getState().loadAgents(directory);

    expect(loaded).toBe(false);
    // Bounded retry, but no cache entry and no timestamp that would make the
    // next caller believe this directory loaded successfully.
    expect(listAgentsCalls).toEqual([directory, directory, directory]);
    expect(selectLoadedAgentsForDirectory(useAgentsStore.getState(), directory)).toBeUndefined();
    expect(useAgentsStore.getState().agentsByDirectory).toEqual({});
  });

  test('a present empty entry is TTL-cached, so remounts do not refetch', async () => {
    const directory = '/projects/empty-cached';

    await useAgentsStore.getState().loadAgents(directory);
    expect(listAgentsCalls).toEqual([directory]);

    const secondLoad = await useAgentsStore.getState().loadAgents(directory);

    expect(secondLoad).toBe(true);
    expect(listAgentsCalls).toEqual([directory]);
  });
});

describe('resolveAvailableAgentForDirectory', () => {
  beforeEach(() => {
    resetAgentsState();
  });

  test('reports a name the loaded directory list contains as available', () => {
    useAgentsStore.setState({
      agentsByDirectory: { '/projects/alpha': [agent('build')] },
    });

    expect(resolveAvailableAgentForDirectory('/projects/alpha', 'build')).toEqual({
      agent: 'build',
      reason: 'available',
    });
  });

  test('reports a name the loaded directory list lacks as missing', () => {
    useAgentsStore.setState({
      agentsByDirectory: { '/projects/alpha': [agent('build')] },
    });

    expect(resolveAvailableAgentForDirectory('/projects/alpha', 'ghost')).toEqual({ reason: 'missing' });
  });

  test('reports a loaded-but-empty directory as missing, matching the persisted empty load', () => {
    useAgentsStore.setState({
      agentsByDirectory: { '/projects/empty': [] },
    });

    expect(resolveAvailableAgentForDirectory('/projects/empty', 'build')).toEqual({ reason: 'missing' });
  });

  test('keeps the request while the directory list has never loaded', () => {
    expect(resolveAvailableAgentForDirectory('/projects/unloaded', 'build')).toEqual({
      agent: 'build',
      reason: 'unknown',
    });
  });

  test('keeps the request when the scope itself is unknown', () => {
    expect(resolveAvailableAgentForDirectory(undefined, 'build')).toEqual({
      agent: 'build',
      reason: 'unknown',
    });
  });

  test('normalizes the lookup directory before matching the stored key', () => {
    useAgentsStore.setState({
      agentsByDirectory: { '/projects/alpha': [agent('build')] },
    });

    expect(resolveAvailableAgentForDirectory('/projects/alpha/', 'build')).toEqual({
      agent: 'build',
      reason: 'available',
    });
  });
});

describe('chat draft agent scope (B1 regression)', () => {
  const PREPARED_CHAT_DIRECTORY = '/home/user/.openchamber/chats/draft-1';
  let listAgentsCalls: Array<string | null | undefined>;

  beforeEach(() => {
    listAgentsCalls = [];
    resetAgentsState();
    // Pre-fix, the chat draft scope resolved to null and `loadAgents(null)`
    // fetched the client's current project into the `__default__` slot.
    opencodeClient.listAgents = async (directory) => {
      listAgentsCalls.push(directory);
      if (directory === null || directory === undefined) return [agent('ambient-project-agent')];
      if (directory === PREPARED_CHAT_DIRECTORY) return [agent('scratch-build')];
      return [];
    };
  });

  afterEach(() => {
    opencodeClient.listAgents = originalListAgents;
  });

  test('reads the prepared chat directory list, never the ambient __default__ fetch', async () => {
    await useAgentsStore.getState().loadAgents(null);
    await useAgentsStore.getState().loadAgents(PREPARED_CHAT_DIRECTORY);

    const scope = resolveComposerAgentDirectory({
      sessionId: null,
      sessionDirectory: null,
      sessionIsKnown: false,
      draft: { open: true, preparedChatDirectory: PREPARED_CHAT_DIRECTORY },
    });

    expect(scope).toBe(PREPARED_CHAT_DIRECTORY);
    expect(listAgentsCalls).toEqual([null, PREPARED_CHAT_DIRECTORY]);
    expect(
      selectLoadedAgentsForDirectory(useAgentsStore.getState(), scope)?.map((entry) => entry.name),
    ).toEqual(['scratch-build']);
    // An agent only the ambient project defines is dropped, not resolved
    // against the `__default__` entry the ambient fetch left behind.
    expect(resolveAvailableAgentForDirectory(scope, 'ambient-project-agent')).toEqual({ reason: 'missing' });
    expect(resolveAvailableAgentForDirectory(scope, 'scratch-build')).toEqual({
      agent: 'scratch-build',
      reason: 'available',
    });
  });
});

describe('stale per-directory lists after an agent change', () => {
  const DIRECTORY_A = '/projects/refresh-a';
  const DIRECTORY_B = '/projects/refresh-b';
  let listAgentsCalls: Array<string | null | undefined>;
  let gate: { promise: Promise<void>; release: () => void } | null;
  let listsByDirectory: Map<string | null, AgentWithExtras[]>;

  const createGate = () => {
    let release: () => void = () => {};
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release: () => release() };
  };

  const settleDeferredWork = async () => {
    // Flush the fire-and-forget refresh a mutation schedules, or the trailing
    // timer the config-change subscription schedules. The subscription
    // refresh first fires its macrotask timer; two turns cover that plus the
    // microtask chain once the mocked list resolves.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  beforeEach(() => {
    listAgentsCalls = [];
    gate = null;
    listsByDirectory = new Map();
    runtimeFetchImpl = async () => new Response(JSON.stringify({}), {
      headers: { 'Content-Type': 'application/json' },
    });
    resetAgentsState();
    opencodeClient.listAgents = async (directory) => {
      listAgentsCalls.push(directory);
      if (gate) await gate.promise;
      return listsByDirectory.get(directory ?? null) ?? [];
    };
  });

  afterEach(() => {
    opencodeClient.listAgents = originalListAgents;
  });

  test('refreshLoadedAgentDirectories clears every loaded list and refetches each', async () => {
    listsByDirectory.set(DIRECTORY_A, [agent('alpha'), agent('victim')]);
    listsByDirectory.set(DIRECTORY_B, [agent('beta')]);
    await useAgentsStore.getState().loadAgents(DIRECTORY_A);
    await useAgentsStore.getState().loadAgents(DIRECTORY_B);

    listsByDirectory.set(DIRECTORY_A, [agent('alpha'), agent('newcomer')]);
    listsByDirectory.set(DIRECTORY_B, [agent('beta')]);
    gate = createGate();

    const refresh = refreshLoadedAgentDirectories();

    // In flight: both entries are gone, so the guard reports unknown instead of
    // the stale available/missing answers.
    expect(resolveAvailableAgentForDirectory(DIRECTORY_A, 'victim')).toEqual({
      agent: 'victim',
      reason: 'unknown',
    });
    expect(resolveAvailableAgentForDirectory(DIRECTORY_A, 'newcomer')).toEqual({
      agent: 'newcomer',
      reason: 'unknown',
    });
    expect(resolveAvailableAgentForDirectory(DIRECTORY_B, 'beta')).toEqual({
      agent: 'beta',
      reason: 'unknown',
    });

    gate.release();
    expect(await refresh).toBe(true);

    expect(
      selectLoadedAgentsForDirectory(useAgentsStore.getState(), DIRECTORY_A)?.map((entry) => entry.name),
    ).toEqual(['alpha', 'newcomer']);
    expect(resolveAvailableAgentForDirectory(DIRECTORY_A, 'victim')).toEqual({ reason: 'missing' });
    expect(resolveAvailableAgentForDirectory(DIRECTORY_A, 'newcomer')).toEqual({
      agent: 'newcomer',
      reason: 'available',
    });
  });

  test('a pre-change load completion is discarded without restoring the list or its TTL', async () => {
    const RACE_DIRECTORY = '/projects/race-stale-completion';
    const preChange = [agent('alpha'), agent('victim')];
    const postChange = [agent('alpha'), agent('newcomer')];
    // A present entry with no timestamp stands for a loaded directory whose TTL
    // has run out: the next load fetches while the entry still exists.
    useAgentsStore.setState({ agentsByDirectory: { [RACE_DIRECTORY]: preChange } });

    let releaseStale: () => void = () => {};
    let releaseFresh: () => void = () => {};
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
    const freshGate = new Promise<void>((resolve) => { releaseFresh = resolve; });
    let fetches = 0;
    opencodeClient.listAgents = async (directory) => {
      listAgentsCalls.push(directory);
      if (directory === RACE_DIRECTORY) {
        fetches += 1;
        if (fetches === 1) {
          await staleGate;
          // The response the server formed before the change.
          return preChange;
        }
        await freshGate;
        return postChange;
      }
      return listsByDirectory.get(directory ?? null) ?? [];
    };

    const staleLoad = useAgentsStore.getState().loadAgents(RACE_DIRECTORY);
    expect(fetches).toBe(1);

    // The effective change lands while the first fetch is still in flight.
    listsByDirectory.set(RACE_DIRECTORY, postChange);
    const refresh = refreshLoadedAgentDirectories();
    // The refresh started its own fetch instead of joining the older request.
    expect(fetches).toBe(2);

    releaseStale();
    expect(await staleLoad).toBe(false);
    // Discarded as a whole: the deleted entry is not restored, so the guard
    // still fails open rather than trusting the pre-change list.
    expect(selectLoadedAgentsForDirectory(useAgentsStore.getState(), RACE_DIRECTORY)).toBeUndefined();
    expect(resolveAvailableAgentForDirectory(RACE_DIRECTORY, 'victim')).toEqual({
      agent: 'victim',
      reason: 'unknown',
    });

    // The stale request's cleanup must not delete the newer request's slot:
    // this load shares the refresh's fetch instead of starting a third.
    const callsBeforeJoin = listAgentsCalls.length;
    const joinedLoad = useAgentsStore.getState().loadAgents(RACE_DIRECTORY);
    expect(listAgentsCalls).toHaveLength(callsBeforeJoin);

    releaseFresh();
    expect(await joinedLoad).toBe(true);
    expect(await refresh).toBe(true);

    // The post-change list landed, and the stale response never replaced it.
    expect(
      selectLoadedAgentsForDirectory(useAgentsStore.getState(), RACE_DIRECTORY)?.map((entry) => entry.name),
    ).toEqual(['alpha', 'newcomer']);
    expect(resolveAvailableAgentForDirectory(RACE_DIRECTORY, 'victim')).toEqual({ reason: 'missing' });
    expect(resolveAvailableAgentForDirectory(RACE_DIRECTORY, 'newcomer')).toEqual({
      agent: 'newcomer',
      reason: 'available',
    });
    expect(useAgentsStore.getState().isLoading).toBe(false);

    // The fresh completion owns the TTL, so a cached read serves the
    // post-change list without another fetch.
    const callsBeforeCachedRead = listAgentsCalls.length;
    expect(await useAgentsStore.getState().loadAgents(RACE_DIRECTORY)).toBe(true);
    expect(listAgentsCalls).toHaveLength(callsBeforeCachedRead);
  });

  test('a refresh does not join an older in-flight load for a bumped key', async () => {
    const RACE_DIRECTORY = '/projects/race-not-joined';
    const preChange = [agent('alpha'), agent('victim')];
    const postChange = [agent('alpha'), agent('newcomer')];
    useAgentsStore.setState({ agentsByDirectory: { [RACE_DIRECTORY]: preChange } });

    let releaseStale: () => void = () => {};
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
    let fetches = 0;
    opencodeClient.listAgents = async (directory) => {
      listAgentsCalls.push(directory);
      if (directory === RACE_DIRECTORY) {
        fetches += 1;
        if (fetches === 1) {
          await staleGate;
          return preChange;
        }
      }
      return listsByDirectory.get(directory ?? null) ?? [];
    };

    const staleLoad = useAgentsStore.getState().loadAgents(RACE_DIRECTORY);
    listsByDirectory.set(RACE_DIRECTORY, postChange);

    const refresh = refreshLoadedAgentDirectories();
    // The refresh's own fetch starts even though the older one is in flight.
    expect(fetches).toBe(2);

    // It lands while the older request is still held.
    expect(await refresh).toBe(true);
    expect(resolveAvailableAgentForDirectory(RACE_DIRECTORY, 'newcomer')).toEqual({
      agent: 'newcomer',
      reason: 'available',
    });

    // Releasing the pre-change response cannot overwrite the newer list.
    releaseStale();
    expect(await staleLoad).toBe(false);
    expect(fetches).toBe(2);
    expect(
      selectLoadedAgentsForDirectory(useAgentsStore.getState(), RACE_DIRECTORY)?.map((entry) => entry.name),
    ).toEqual(['alpha', 'newcomer']);
    expect(resolveAvailableAgentForDirectory(RACE_DIRECTORY, 'victim')).toEqual({ reason: 'missing' });
    expect(useAgentsStore.getState().isLoading).toBe(false);
  });

  test('a second refresh supersedes a first refresh whose replacement fetch is still in flight', async () => {
    const RACE_DIRECTORY = '/projects/race-overlapping-refreshes';
    const preChange = [agent('alpha'), agent('victim')];
    const afterFirstChange = [agent('alpha'), agent('newcomer')];
    const afterSecondChange = [agent('alpha'), agent('final')];
    // A present entry with no timestamp stands for a loaded directory whose TTL
    // has run out: the next load fetches while the entry still exists.
    useAgentsStore.setState({ agentsByDirectory: { [RACE_DIRECTORY]: preChange } });
    listsByDirectory.set(RACE_DIRECTORY, preChange);

    // Each request captures the list the server had when it started and holds
    // its response until released, so a response formed before a later change
    // stays pre-change even after the map is updated.
    const releaseByFetch: Array<() => void> = [];
    let raceFetches = 0;
    opencodeClient.listAgents = async (directory) => {
      listAgentsCalls.push(directory);
      if (directory !== RACE_DIRECTORY) {
        return listsByDirectory.get(directory ?? null) ?? [];
      }
      const snapshot = listsByDirectory.get(directory) ?? [];
      raceFetches += 1;
      await new Promise<void>((resolve) => {
        releaseByFetch.push(resolve);
      });
      return snapshot;
    };

    // A load for the directory is in flight when the first change lands.
    const staleLoad = useAgentsStore.getState().loadAgents(RACE_DIRECTORY);
    expect(raceFetches).toBe(1);

    // The first refresh does not join that load: it clears the entry, bumps
    // the generation, and starts its own fetch, also held.
    listsByDirectory.set(RACE_DIRECTORY, afterFirstChange);
    const refresh1 = refreshLoadedAgentDirectories();
    expect(raceFetches).toBe(2);

    // The second change lands while the entry is absent and the first
    // refresh's replacement fetch is still pending, so the key is only visible
    // through the in-flight map now.
    listsByDirectory.set(RACE_DIRECTORY, afterSecondChange);
    const refresh2 = refreshLoadedAgentDirectories();
    // The second refresh must bump the key and start a third fetch. Without
    // that, the second fetch's pre-change response would still be the current
    // generation and land with a fresh TTL.
    expect(raceFetches).toBe(3);

    // Releasing both pre-change responses changes nothing: the first response
    // predates refresh 1 and the second predates refresh 2.
    releaseByFetch[0]();
    expect(await staleLoad).toBe(false);
    releaseByFetch[1]();
    expect(await refresh1).toBe(false);
    await settleDeferredWork();
    expect(selectLoadedAgentsForDirectory(useAgentsStore.getState(), RACE_DIRECTORY)).toBeUndefined();
    expect(resolveAvailableAgentForDirectory(RACE_DIRECTORY, 'victim')).toEqual({
      agent: 'victim',
      reason: 'unknown',
    });
    expect(resolveAvailableAgentForDirectory(RACE_DIRECTORY, 'newcomer')).toEqual({
      agent: 'newcomer',
      reason: 'unknown',
    });

    // The second refresh's fetch is the current generation, so this load joins
    // it instead of starting a fourth request.
    const joinedLoad = useAgentsStore.getState().loadAgents(RACE_DIRECTORY);
    expect(raceFetches).toBe(3);

    releaseByFetch[2]();
    expect(await joinedLoad).toBe(true);
    expect(await refresh2).toBe(true);
    expect(
      selectLoadedAgentsForDirectory(useAgentsStore.getState(), RACE_DIRECTORY)?.map((entry) => entry.name),
    ).toEqual(['alpha', 'final']);
    expect(resolveAvailableAgentForDirectory(RACE_DIRECTORY, 'victim')).toEqual({ reason: 'missing' });
    expect(resolveAvailableAgentForDirectory(RACE_DIRECTORY, 'newcomer')).toEqual({ reason: 'missing' });
    expect(resolveAvailableAgentForDirectory(RACE_DIRECTORY, 'final')).toEqual({
      agent: 'final',
      reason: 'available',
    });
    expect(useAgentsStore.getState().isLoading).toBe(false);

    // The second refresh's completion owns a fresh TTL: a cached read serves
    // the post-change list without another fetch.
    const callsBeforeCachedRead = listAgentsCalls.length;
    expect(await useAgentsStore.getState().loadAgents(RACE_DIRECTORY)).toBe(true);
    expect(listAgentsCalls).toHaveLength(callsBeforeCachedRead);
  });

  test('a successful agent mutation refetches every loaded directory, not only the target', async () => {
    listsByDirectory.set(DIRECTORY_A, [agent('alpha'), agent('victim')]);
    listsByDirectory.set(DIRECTORY_B, [agent('beta'), agent('stale-b')]);
    await useAgentsStore.getState().loadAgents(DIRECTORY_A);
    await useAgentsStore.getState().loadAgents(DIRECTORY_B);

    listsByDirectory.set(DIRECTORY_A, [agent('alpha')]);
    listsByDirectory.set(DIRECTORY_B, [agent('beta')]);
    runtimeFetchImpl = async () => new Response(JSON.stringify({ requiresReload: false }), {
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await useAgentsStore.getState().deleteAgent('victim');

    expect(result.ok).toBe(true);
    await useAgentsStore.getState().loadAgents(DIRECTORY_A);
    await useAgentsStore.getState().loadAgents(DIRECTORY_B);
    expect(resolveAvailableAgentForDirectory(DIRECTORY_A, 'victim')).toEqual({ reason: 'missing' });
    expect(resolveAvailableAgentForDirectory(DIRECTORY_B, 'stale-b')).toEqual({ reason: 'missing' });
    expect(resolveAvailableAgentForDirectory(DIRECTORY_B, 'beta')).toEqual({ agent: 'beta', reason: 'available' });
  });

  test('an external agents config change refetches every loaded directory and fails open in between', async () => {
    listsByDirectory.set(DIRECTORY_A, [agent('alpha'), agent('victim')]);
    listsByDirectory.set(DIRECTORY_B, [agent('beta')]);
    await useAgentsStore.getState().loadAgents(DIRECTORY_A);
    await useAgentsStore.getState().loadAgents(DIRECTORY_B);

    listsByDirectory.set(DIRECTORY_A, [agent('alpha')]);
    listsByDirectory.set(DIRECTORY_B, [agent('beta'), agent('newcomer')]);
    gate = createGate();

    emitConfigChange('agents', { source: 'external-config-change-test' });
    // The subscription coalesces the event into a trailing refresh; wait for
    // its timer to run before asserting the in-flight state.
    await settleDeferredWork();

    // The refresh clears both entries before its fetches start, so the guard
    // fails open instead of trusting the pre-change lists.
    expect(selectLoadedAgentsForDirectory(useAgentsStore.getState(), DIRECTORY_A)).toBeUndefined();
    expect(selectLoadedAgentsForDirectory(useAgentsStore.getState(), DIRECTORY_B)).toBeUndefined();
    expect(resolveAvailableAgentForDirectory(DIRECTORY_A, 'victim')).toEqual({
      agent: 'victim',
      reason: 'unknown',
    });

    gate.release();
    await useAgentsStore.getState().loadAgents(DIRECTORY_A);
    await useAgentsStore.getState().loadAgents(DIRECTORY_B);

    expect(resolveAvailableAgentForDirectory(DIRECTORY_A, 'victim')).toEqual({ reason: 'missing' });
    expect(resolveAvailableAgentForDirectory(DIRECTORY_B, 'newcomer')).toEqual({
      agent: 'newcomer',
      reason: 'available',
    });
  });

  /**
   * OpenCode reload can emit several `agents` config events in a burst. Every
   * refresh refetches each loaded directory plus one config request per agent,
   * so the subscription must collapse a burst into one trailing refresh while
   * a lone event still refreshes on the next macrotask.
   */
  test('a burst of external agents config changes coalesces into one refresh', async () => {
    // A stable known-directory set lets an explicit immediate refresh serve as
    // the call-count baseline: the coalesced refresh must fan out over the same
    // directories, and the trailing refresh below is the only extra fan-out.
    await refreshLoadedAgentDirectories();
    listAgentsCalls.length = 0;
    await refreshLoadedAgentDirectories();
    const callsPerRefresh = listAgentsCalls.length;
    expect(callsPerRefresh).toBeGreaterThan(0);

    jest.useFakeTimers();
    try {
      listAgentsCalls.length = 0;
      emitConfigChange('agents', { source: 'external-burst-test' });
      emitConfigChange('agents', { source: 'external-burst-test' });

      // Both events arrived before the trailing timer ran: still no refresh.
      expect(listAgentsCalls).toHaveLength(0);

      jest.advanceTimersByTime(0);
      expect(listAgentsCalls).toHaveLength(callsPerRefresh);

      // A later event is a new burst and schedules one more refresh.
      emitConfigChange('agents', { source: 'external-burst-test' });
      expect(listAgentsCalls).toHaveLength(callsPerRefresh);
      jest.advanceTimersByTime(0);
      expect(listAgentsCalls).toHaveLength(callsPerRefresh * 2);
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * A response that defers the restart means the server still lists the
   * pre-change state. The optimistic overlay (`agents` and, for delete, the
   * local removal) is the truth until OpenCode reloads, so those responses must
   * not clear or refetch the per-directory lists: the refetch would replace the
   * overlay with server truth that cannot include the change yet. Effective
   * responses must still refresh every loaded directory.
   */
  test('a create that requires a manual restart keeps the optimistic agent and never refetches', async () => {
    listsByDirectory.set(DIRECTORY_A, [agent('alpha')]);
    await useAgentsStore.getState().loadAgents(DIRECTORY_A);
    const loadedBeforeMutation = selectLoadedAgentsForDirectory(useAgentsStore.getState(), DIRECTORY_A);
    const callsBeforeMutation = listAgentsCalls.length;
    listsByDirectory.set(DIRECTORY_A, [agent('alpha'), agent('server-only')]);
    runtimeFetchImpl = async () => new Response(JSON.stringify({ requiresManualRestart: true }), {
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await useAgentsStore.getState().createAgent(
      { name: 'newcomer', mode: 'subagent' },
      DIRECTORY_A,
    );

    expect(result).toEqual({ ok: true, requiresManualRestart: true });
    await settleDeferredWork();

    // No clear/refetch ran: the loaded list is the same array and the
    // optimistic agent is still in the mirror.
    expect(listAgentsCalls).toHaveLength(callsBeforeMutation);
    expect(selectLoadedAgentsForDirectory(useAgentsStore.getState(), DIRECTORY_A)).toBe(loadedBeforeMutation);
    expect(useAgentsStore.getState().agents.map((entry) => entry.name)).toContain('newcomer');
  });

  test('a create deferred to the restart keeps the optimistic agent and never refetches', async () => {
    listsByDirectory.set(DIRECTORY_A, [agent('alpha')]);
    await useAgentsStore.getState().loadAgents(DIRECTORY_A);
    const loadedBeforeMutation = selectLoadedAgentsForDirectory(useAgentsStore.getState(), DIRECTORY_A);
    listsByDirectory.set(DIRECTORY_A, [agent('alpha'), agent('server-only')]);
    runtimeFetchImpl = async () => new Response(JSON.stringify({ restartDeferred: true }), {
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await useAgentsStore.getState().createAgent(
      { name: 'newcomer', mode: 'subagent' },
      DIRECTORY_A,
    );

    expect(result).toEqual({ ok: true, restartDeferred: true });
    await settleDeferredWork();

    // The deferred branch emits a config change; the agents store ignores its
    // own source, so nothing may replace the overlay or the loaded list.
    expect(selectLoadedAgentsForDirectory(useAgentsStore.getState(), DIRECTORY_A)).toBe(loadedBeforeMutation);
    expect(useAgentsStore.getState().agents.map((entry) => entry.name)).toContain('newcomer');
  });

  test('an update deferred to the restart keeps the optimistic edit and never refetches', async () => {
    useAgentsStore.setState({ agents: [agent('build')] });
    listsByDirectory.set(DIRECTORY_A, [agent('alpha')]);
    await useAgentsStore.getState().loadAgents(DIRECTORY_A);
    const loadedBeforeMutation = selectLoadedAgentsForDirectory(useAgentsStore.getState(), DIRECTORY_A);
    listsByDirectory.set(DIRECTORY_A, [agent('alpha'), agent('server-only')]);
    runtimeFetchImpl = async () => new Response(JSON.stringify({ restartDeferred: true }), {
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await useAgentsStore.getState().updateAgent('build', { description: 'deferred edit' }, DIRECTORY_A);

    expect(result).toEqual({ ok: true, restartDeferred: true });
    await settleDeferredWork();

    expect(selectLoadedAgentsForDirectory(useAgentsStore.getState(), DIRECTORY_A)).toBe(loadedBeforeMutation);
    expect(useAgentsStore.getState().agents.find((entry) => entry.name === 'build')?.description).toBe('deferred edit');
  });

  test('a delete deferred to the restart keeps the local removal and never refetches', async () => {
    useAgentsStore.setState({ agents: [agent('build'), agent('other')] });
    listsByDirectory.set(DIRECTORY_A, [agent('build'), agent('other')]);
    await useAgentsStore.getState().loadAgents(DIRECTORY_A);
    const loadedBeforeMutation = selectLoadedAgentsForDirectory(useAgentsStore.getState(), DIRECTORY_A);
    listsByDirectory.set(DIRECTORY_A, [agent('build'), agent('other'), agent('server-only')]);
    runtimeFetchImpl = async () => new Response(JSON.stringify({ restartDeferred: true }), {
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await useAgentsStore.getState().deleteAgent('build', undefined, DIRECTORY_A);

    expect(result).toEqual({ ok: true, restartDeferred: true });
    await settleDeferredWork();

    // The local removal must not be undone by a refetch of pre-restart truth,
    // which still contains the deleted agent.
    expect(selectLoadedAgentsForDirectory(useAgentsStore.getState(), DIRECTORY_A)).toBe(loadedBeforeMutation);
    expect(useAgentsStore.getState().agents.map((entry) => entry.name)).toEqual(['other']);
  });

  test('an effective create still refreshes loaded directories other than its target', async () => {
    listsByDirectory.set(DIRECTORY_A, [agent('alpha')]);
    listsByDirectory.set(DIRECTORY_B, [agent('beta'), agent('stale-b')]);
    await useAgentsStore.getState().loadAgents(DIRECTORY_A);
    await useAgentsStore.getState().loadAgents(DIRECTORY_B);
    listsByDirectory.set(DIRECTORY_A, [agent('alpha'), agent('newcomer')]);
    listsByDirectory.set(DIRECTORY_B, [agent('beta')]);
    runtimeFetchImpl = async () => new Response(JSON.stringify({ requiresReload: false }), {
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await useAgentsStore.getState().createAgent(
      { name: 'newcomer', mode: 'subagent' },
      DIRECTORY_A,
    );

    expect(result.ok).toBe(true);
    // The mutation loads only its own directory, so a fresh answer for B proves
    // the effective path refreshed every loaded directory.
    await useAgentsStore.getState().loadAgents(DIRECTORY_B);
    expect(resolveAvailableAgentForDirectory(DIRECTORY_B, 'stale-b')).toEqual({ reason: 'missing' });
    expect(resolveAvailableAgentForDirectory(DIRECTORY_B, 'beta')).toEqual({ agent: 'beta', reason: 'available' });
  });

  test('an effective update still refreshes loaded directories other than its target', async () => {
    listsByDirectory.set(DIRECTORY_A, [agent('alpha')]);
    listsByDirectory.set(DIRECTORY_B, [agent('beta'), agent('stale-b')]);
    await useAgentsStore.getState().loadAgents(DIRECTORY_A);
    await useAgentsStore.getState().loadAgents(DIRECTORY_B);
    listsByDirectory.set(DIRECTORY_A, [agent('alpha')]);
    listsByDirectory.set(DIRECTORY_B, [agent('beta')]);
    runtimeFetchImpl = async () => new Response(JSON.stringify({ requiresReload: false }), {
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await useAgentsStore.getState().updateAgent('alpha', { description: 'edited' }, DIRECTORY_A);

    expect(result.ok).toBe(true);
    await useAgentsStore.getState().loadAgents(DIRECTORY_B);
    expect(resolveAvailableAgentForDirectory(DIRECTORY_B, 'stale-b')).toEqual({ reason: 'missing' });
    expect(resolveAvailableAgentForDirectory(DIRECTORY_B, 'beta')).toEqual({ agent: 'beta', reason: 'available' });
  });
});
