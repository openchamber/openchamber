import { beforeEach, describe, expect, mock, test } from 'bun:test';

const originalFetch = globalThis.fetch;

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: () => '/test/project',
  },
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

mock.module('@/lib/configSync', () => ({
  emitConfigChange: () => {},
  scopeMatches: () => false,
  subscribeToConfigChanges: () => () => {},
}));

mock.module('@/lib/configUpdate', () => ({
  startConfigUpdate: () => {},
  finishConfigUpdate: () => {},
  updateConfigUpdateMessage: () => {},
}));

mock.module('@/stores/useAgentsStore', () => ({
  refreshAfterOpenCodeRestart: async () => {},
}));

const { useSkillsStore } = await import('./useSkillsStore');

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

describe('useSkillsStore — excludeSources', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
    useSkillsStore.setState({ excludeSources: [], skills: [] });
  });

  describe('loadExcludeSources', () => {
    test('populates excludeSources from API response', async () => {
      globalThis.fetch = mock(() =>
        json({ excludeSources: ['claude', 'agents'] }),
      ) as unknown as typeof fetch;

      await useSkillsStore.getState().loadExcludeSources();
      expect(useSkillsStore.getState().excludeSources).toEqual(['claude', 'agents']);
    });

    test('defaults to empty array on API error', async () => {
      globalThis.fetch = mock(() => Promise.resolve(new Response('error', { status: 500 }))) as unknown as typeof fetch;

      await useSkillsStore.getState().loadExcludeSources();
      expect(useSkillsStore.getState().excludeSources).toEqual([]);
    });

    test('does not throw on network failure', async () => {
      globalThis.fetch = mock(() => Promise.reject(new Error('network'))) as unknown as typeof fetch;

      await useSkillsStore.getState().loadExcludeSources();
      expect(useSkillsStore.getState().excludeSources).toEqual([]);
    });
  });

  describe('setExcludeSources — optimistic update', () => {
    test('updates state immediately before API responds', async () => {
      let resolvePut: (value: Response) => void = () => {};
      const putPromise = new Promise<Response>((resolve) => {
        resolvePut = resolve;
      });
      globalThis.fetch = mock(() => putPromise) as unknown as typeof fetch;

      const setPromise = useSkillsStore.getState().setExcludeSources(['claude']);

      // State should be updated optimistically before API resolves
      expect(useSkillsStore.getState().excludeSources).toEqual(['claude']);

      resolvePut(
        new Response(JSON.stringify({ success: true, excludeSources: ['claude'] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      // loadSkills will fire after PUT — mock it
      globalThis.fetch = mock(() =>
        json({ skills: [] }),
      ) as unknown as typeof fetch;

      const result = await setPromise;
      expect(result).toBe(true);
      expect(useSkillsStore.getState().excludeSources).toEqual(['claude']);
    });

    test('reverts to previous state on API failure', async () => {
      useSkillsStore.setState({ excludeSources: ['agents'] });

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('server error', { status: 500 })),
      ) as unknown as typeof fetch;

      const result = await useSkillsStore.getState().setExcludeSources(['agents', 'claude']);

      expect(result).toBe(false);
      expect(useSkillsStore.getState().excludeSources).toEqual(['agents']);
    });

    test('reverts to previous state on network error', async () => {
      useSkillsStore.setState({ excludeSources: ['claude'] });

      globalThis.fetch = mock(() => Promise.reject(new Error('network'))) as unknown as typeof fetch;

      const result = await useSkillsStore.getState().setExcludeSources([]);

      expect(result).toBe(false);
      expect(useSkillsStore.getState().excludeSources).toEqual(['claude']);
    });

    test('returns true on successful update', async () => {
      globalThis.fetch = mock((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('exclude-sources') && !url.includes('skills?')) {
          return json({ success: true, excludeSources: ['claude'] });
        }
        return json({ skills: [] });
      }) as unknown as typeof fetch;

      const result = await useSkillsStore.getState().setExcludeSources(['claude']);
      expect(result).toBe(true);
    });
  });

  describe('toggle behavior simulation', () => {
    test('adding a source to exclusion list', async () => {
      useSkillsStore.setState({ excludeSources: [] });

      globalThis.fetch = mock((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('exclude-sources') && !url.includes('skills?')) {
          return json({ success: true, excludeSources: ['claude'] });
        }
        return json({ skills: [] });
      }) as unknown as typeof fetch;

      const current = useSkillsStore.getState().excludeSources;
      const next = [...current, 'claude' as const];
      await useSkillsStore.getState().setExcludeSources(next);

      expect(useSkillsStore.getState().excludeSources).toEqual(['claude']);
    });

    test('removing a source from exclusion list', async () => {
      useSkillsStore.setState({ excludeSources: ['claude', 'agents'] });

      globalThis.fetch = mock((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('exclude-sources') && !url.includes('skills?')) {
          return json({ success: true, excludeSources: ['agents'] });
        }
        return json({ skills: [] });
      }) as unknown as typeof fetch;

      const current = useSkillsStore.getState().excludeSources;
      const next = current.filter((s) => s !== 'claude');
      await useSkillsStore.getState().setExcludeSources(next);

      expect(useSkillsStore.getState().excludeSources).toEqual(['agents']);
    });
  });
});
