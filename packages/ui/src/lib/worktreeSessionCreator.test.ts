import { describe, expect, mock, test } from 'bun:test';
import { useContextStore } from '@/stores/contextStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useProjectsStore } from '@/stores/useProjectsStore';

let createWorktreeCalls = 0;
let createdWorktree: { path: string; branch: string; label: string; projectDirectory: string } | null = null;
mock.module('@/lib/worktrees/worktreeCreate', () => ({
  createWorktreeWithDefaults: async () => {
    createWorktreeCalls += 1;
    if (createdWorktree) return createdWorktree;
    throw new Error('worktree creation should not run');
  },
}));
mock.module('@/lib/gitApi', () => ({
  checkIsGitRepository: async () => true,
  deleteRemoteBranch: async () => undefined,
  git: {},
  previewGitWorktree: async () => null,
}));
mock.module('@/lib/openchamberConfig', () => ({
  getWorktreeSetupCommands: async () => [],
  getWorktreeSetupWaitEnabled: async () => false,
  substituteCommandVariables: (command: string) => command,
}));
mock.module('@/lib/worktrees/worktreeStatus', () => ({
  getRootBranch: async () => 'main',
  invalidateResolvedProjectRootCache: () => undefined,
  resolveProjectRoot: async (directory: string) => directory,
}));

const {
  applyDefaultAgentAndModelSelection,
  createWorktreeSessionForNewBranch,
  resolveWorktreeSessionSelection,
} = await import('./worktreeSessionCreator');

const createConfigState = (options: {
  settingsDefaultModel?: string;
  currentProviderId?: string;
  currentModelId?: string;
  currentVariant?: string;
  settingsDefaultVariant?: string;
}) => {
  const providers = [
    {
      id: 'current-provider',
      models: [{ id: 'current-model', variants: { high: {} } }],
    },
    {
      id: 'override-provider',
      models: [{ id: 'override-model', variants: { high: {} } }],
    },
  ];

  return {
    providers,
    settingsDefaultAgent: undefined,
    settingsDefaultModel: options.settingsDefaultModel,
    settingsDefaultVariant: options.settingsDefaultVariant,
    currentProviderId: options.currentProviderId ?? 'current-provider',
    currentModelId: options.currentModelId ?? 'current-model',
    currentVariant: options.currentVariant,
    getVisibleAgents: () => [{ name: 'build' }],
    getModelMetadata: (providerID: string, modelID: string) => providers
      .find((provider) => provider.id === providerID)
      ?.models.find((model) => model.id === modelID),
  };
};

describe('resolveWorktreeSessionSelection', () => {
  const cases = [
    {
      name: 'uses a valid settings default',
      config: { settingsDefaultModel: 'override-provider/override-model' },
      expected: { agentName: 'build', providerID: 'override-provider', modelID: 'override-model', variant: undefined },
    },
    {
      name: 'uses the current model after an invalid settings default',
      config: { settingsDefaultModel: 'missing/model' },
      expected: { agentName: 'build', providerID: 'current-provider', modelID: 'current-model', variant: undefined },
    },
    {
      name: 'uses the current model when the settings default is missing',
      config: {},
      expected: { agentName: 'build', providerID: 'current-provider', modelID: 'current-model', variant: undefined },
    },
    {
      name: 'uses a valid current variant when no settings variant is configured',
      config: { currentVariant: 'high' },
      expected: { agentName: 'build', providerID: 'current-provider', modelID: 'current-model', variant: 'high' },
    },
    {
      name: 'uses a valid current variant after an invalid settings variant',
      config: { settingsDefaultVariant: 'missing', currentVariant: 'high' },
      expected: { agentName: 'build', providerID: 'current-provider', modelID: 'current-model', variant: 'high' },
    },
    {
      name: 'uses the last-used model after invalid defaults and current selection',
      config: { settingsDefaultModel: 'missing/model', currentProviderId: 'missing-provider', currentModelId: 'missing-model' },
      lastUsed: { providerID: 'override-provider', modelID: 'override-model' },
      expected: { agentName: 'build', providerID: 'override-provider', modelID: 'override-model', variant: undefined },
    },
    {
      name: 'uses the first valid provider only after defaults, current selection, and last-used selection are invalid',
      config: { settingsDefaultModel: 'missing/model', currentProviderId: 'missing-provider', currentModelId: 'missing-model' },
      lastUsed: { providerID: 'missing-provider', modelID: 'missing-model' },
      expected: { agentName: 'build', providerID: 'current-provider', modelID: 'current-model', variant: undefined },
    },
    {
      name: 'returns null when no provider has a valid model',
      config: { settingsDefaultModel: 'missing/model', currentProviderId: 'missing-provider', currentModelId: 'missing-model' },
      lastUsed: { providerID: 'missing-provider', modelID: 'missing-model' },
      expected: null,
    },
    {
      name: 'keeps a valid explicit model override over every fallback',
      config: { settingsDefaultModel: 'current-provider/current-model' },
      overrides: { providerID: 'override-provider', modelID: 'override-model' },
      lastUsed: { providerID: 'current-provider', modelID: 'current-model' },
      expected: { agentName: 'build', providerID: 'override-provider', modelID: 'override-model', variant: undefined },
    },
    {
      name: 'keeps an explicit empty variant as no variant',
      config: { settingsDefaultVariant: 'high' },
      overrides: { providerID: 'current-provider', modelID: 'current-model', variant: '' },
      expected: { agentName: 'build', providerID: 'current-provider', modelID: 'current-model', variant: undefined },
    },
  ];

  for (const { name, config, overrides, lastUsed, expected } of cases) {
    test(name, () => {
      const configState = createConfigState(config);
      if (name === 'returns null when no provider has a valid model') {
        configState.providers = [{ id: 'empty-provider', models: [] }];
      }
      expect(resolveWorktreeSessionSelection(configState, overrides, lastUsed)).toEqual(expected);
    });
  }
});

describe('worktree session initialization', () => {
  test('does not create worktree resources when no valid selection exists', async () => {
    const previousConfig = useConfigStore.getState();
    let createSessionCalls = 0;
    const previousCreateSession = useSessionUIStore.getState().createSession;
    createWorktreeCalls = 0;

    useConfigStore.setState({
      providers: [],
      settingsDefaultModel: undefined,
      currentProviderId: undefined,
      currentModelId: undefined,
    });
    useSessionUIStore.setState({
      createSession: async () => {
        createSessionCalls += 1;
        return null;
      },
    });

    try {
      expect(await createWorktreeSessionForNewBranch('/unregistered-project', 'new-branch')).toBeNull();
      expect(createWorktreeCalls).toBe(0);
      expect(createSessionCalls).toBe(0);
    } finally {
      useConfigStore.setState(previousConfig, true);
      useSessionUIStore.setState({ createSession: previousCreateSession });
    }
  });

  test('sets the global variant for a resolved non-empty selection', () => {
    const previousConfig = useConfigStore.getState();
    const sessionId = 'worktree-session-global-variant';
    useConfigStore.setState({ currentVariant: undefined, selectionSource: 'auto' });

    try {
      const result = applyDefaultAgentAndModelSelection(
        sessionId,
        useConfigStore.getState(),
        undefined,
        { agentName: 'build', providerID: 'current-provider', modelID: 'current-model', variant: 'high' },
      );

      expect(result).toEqual({ agentName: 'build', providerID: 'current-provider', modelID: 'current-model', variant: 'high' });
      expect(useConfigStore.getState().currentVariant).toBe('high');
    } finally {
      useConfigStore.setState(previousConfig, true);
    }
  });

  test('preserves the global variant while clearing undefined session variants', () => {
    const sessionId = 'worktree-session-selection';
    const previousConfig = useConfigStore.getState();
    const configState = useConfigStore.getState();
    const setCurrentVariantCalls: (string | undefined)[] = [];
    const setCurrentVariant = (variant: string | undefined) => {
      setCurrentVariantCalls.push(variant);
      configState.setCurrentVariant(variant);
    };
    const selectionStore = useSelectionStore.getState();
    const contextStore = useContextStore.getState();
    selectionStore.saveAgentModelVariantForSession(sessionId, 'build', 'current-provider', 'current-model', 'high');
    contextStore.saveAgentModelVariantForSession(sessionId, 'build', 'current-provider', 'current-model', 'high');
    useConfigStore.setState({ currentVariant: 'high', selectionSource: 'auto' });

    try {
      const result = applyDefaultAgentAndModelSelection(
        sessionId,
        { ...configState, setCurrentVariant },
        undefined,
        { agentName: 'build', providerID: 'current-provider', modelID: 'current-model', variant: undefined },
      );

      expect(result).toEqual({ agentName: 'build', providerID: 'current-provider', modelID: 'current-model', variant: undefined });
      expect(setCurrentVariantCalls).toEqual([]);
      expect(useConfigStore.getState().currentVariant).toBe('high');
      expect(useSelectionStore.getState().getSessionAgentSelection(sessionId)).toBe('build');
      expect(useSelectionStore.getState().getSessionModelSelection(sessionId)).toEqual({
        providerId: 'current-provider',
        modelId: 'current-model',
      });
      expect(useSelectionStore.getState().getAgentModelForSession(sessionId, 'build')).toEqual({
        providerId: 'current-provider',
        modelId: 'current-model',
      });
      expect(useSelectionStore.getState().getAgentModelVariantForSession(sessionId, 'build', 'current-provider', 'current-model')).toBe(undefined);
      expect(useContextStore.getState().getSessionAgentSelection(sessionId)).toBe('build');
      expect(useContextStore.getState().getSessionModelSelection(sessionId)).toEqual({
        providerId: 'current-provider',
        modelId: 'current-model',
      });
      expect(useContextStore.getState().getAgentModelVariantForSession(sessionId, 'build', 'current-provider', 'current-model')).toBe(undefined);
    } finally {
      useConfigStore.setState(previousConfig, true);
    }
  });

  test('persists validated execution overrides to both stores before returning the worktree session', async () => {
    const sessionId = 'worktree-session-execution-overrides';
    const previousConfig = useConfigStore.getState();
    const previousProjects = useProjectsStore.getState();
    const previousCreateSession = useSessionUIStore.getState().createSession;
    const configState = createConfigState({});
    createWorktreeCalls = 0;
    createdWorktree = {
      path: '/registered/.worktrees/execution-overrides',
      branch: 'execution-overrides',
      label: 'execution-overrides',
      projectDirectory: '/registered',
    };
    useConfigStore.setState({
      providers: configState.providers as unknown as typeof previousConfig.providers,
      settingsDefaultAgent: configState.settingsDefaultAgent,
      settingsDefaultModel: configState.settingsDefaultModel,
      settingsDefaultVariant: configState.settingsDefaultVariant,
      currentProviderId: configState.currentProviderId,
      currentModelId: configState.currentModelId,
      currentVariant: configState.currentVariant,
      getVisibleAgents: configState.getVisibleAgents as typeof previousConfig.getVisibleAgents,
      getModelMetadata: configState.getModelMetadata as typeof previousConfig.getModelMetadata,
    });
    useProjectsStore.setState({ projects: [{ id: 'registered', path: '/registered' }] });
    useSessionUIStore.setState({
      createSession: async () => ({ id: sessionId } as never),
    });

    try {
      const created = await createWorktreeSessionForNewBranch(
        '/registered',
        'execution-overrides',
        undefined,
        {
          overrides: {
            agentName: 'build',
            providerID: 'override-provider',
            modelID: 'override-model',
            variant: 'high',
          },
        },
      );

      expect(created).toEqual({
        id: sessionId,
        branch: 'execution-overrides',
        path: '/registered/.worktrees/execution-overrides',
        selection: {
          agentName: 'build',
          providerID: 'override-provider',
          modelID: 'override-model',
          variant: 'high',
        },
      });
      expect(createWorktreeCalls).toBe(1);
      expect(useSelectionStore.getState().getSessionModelSelection(sessionId)).toEqual({
        providerId: 'override-provider',
        modelId: 'override-model',
      });
      expect(useSelectionStore.getState().getSessionAgentSelection(sessionId)).toBe('build');
      expect(useSelectionStore.getState().getAgentModelVariantForSession(
        sessionId,
        'build',
        'override-provider',
        'override-model',
      )).toBe('high');
      expect(useContextStore.getState().getSessionModelSelection(sessionId)).toEqual({
        providerId: 'override-provider',
        modelId: 'override-model',
      });
      expect(useContextStore.getState().getSessionAgentSelection(sessionId)).toBe('build');
      expect(useContextStore.getState().getAgentModelForSession(sessionId, 'build')).toEqual({
        providerId: 'override-provider',
        modelId: 'override-model',
      });
      expect(useContextStore.getState().getAgentModelVariantForSession(
        sessionId,
        'build',
        'override-provider',
        'override-model',
      )).toBe('high');
    } finally {
      createdWorktree = null;
      useConfigStore.setState(previousConfig, true);
      useProjectsStore.setState(previousProjects, true);
      useSessionUIStore.setState({ createSession: previousCreateSession });
    }
  });
});
