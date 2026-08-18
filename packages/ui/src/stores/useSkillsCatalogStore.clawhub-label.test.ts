import { beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: () => undefined,
  },
}));

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      getActiveProject: () => null,
    }),
  },
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async () => new Response('{}', { status: 500 }),
}));

mock.module('@/stores/useSkillsStore', () => ({
  invalidateSkillsLoadCache: () => undefined,
  refreshSkillsAfterOpenCodeRestart: async () => undefined,
  useSkillsStore: {
    getState: () => ({}),
  },
}));

mock.module('@/lib/configUpdate', () => ({
  startConfigUpdate: () => undefined,
  finishConfigUpdate: () => undefined,
  updateConfigUpdateMessage: () => undefined,
}));

const { useSkillsCatalogStore } = await import('./useSkillsCatalogStore');

describe('skills catalog ClawHub label', () => {
  beforeEach(() => {
    useSkillsCatalogStore.setState({
      sources: useSkillsCatalogStore.getState().sources,
    });
  });

  test('fallback sources label ClawHub correctly', () => {
    const clawhub = useSkillsCatalogStore.getState().sources.find((source) => source.id === 'clawdhub');
    expect(clawhub).toBeDefined();
    expect(clawhub?.label).toBe('ClawHub');
  });
});
