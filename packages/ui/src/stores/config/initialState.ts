import { type ConfigSlice } from './types';
import { resolveInitialDirectoryKey } from './directories';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { type ModelMetadata } from '@/types';
import { DEFAULT_AUTO_CREATE_WORKTREE, DEFAULT_WORKTREE_START_FROM } from '@/lib/worktrees/worktreeStartSource';
import { DEFAULT_PULL_REQUEST_BRANCH_TEMPLATE, DEFAULT_WORKTREE_BRANCH_TEMPLATE } from '@/lib/worktrees/branchNameTemplate';

export const createInitialConfigState: ConfigSlice<
    | 'activeDirectoryKey'
    | 'directoryScoped'
    | 'configRuntimeKey'
    | 'catalogReloadRevision'
    | 'providers'
    | 'agents'
    | 'providersLoaded'
    | 'agentsLoaded'
    | 'currentProviderId'
    | 'currentModelId'
    | 'currentVariant'
    | 'currentVariantSelection'
    | 'currentAgentName'
    | 'selectedProviderId'
    | 'agentModelSelections'
    | 'defaultProviders'
    | 'selectionSource'
    | 'agentSelectionSource'
    | 'isConnected'
    | 'hasEverConnected'
    | 'connectionPhase'
    | 'lastDisconnectReason'
    | 'lastInitFailure'
    | 'projectConfigErrors'
    | 'settingsOnlyProviders'
    | 'isInitialized'
    | 'modelsMetadata'
    | 'settingsDefaultModel'
    | 'settingsDefaultsLoaded'
    | 'settingsDefaultVariant'
    | 'settingsDefaultAgent'
    | 'chatsDefaultModel'
    | 'chatsDefaultVariant'
    | 'chatsDefaultAgent'
    | 'opencodeDefaultAgent'
    | 'opencodeDefaultModel'
    | 'settingsAutoCreateWorktree'
    | 'settingsWorktreeStartFrom'
    | 'settingsWorktreeStartFromOverrides'
    | 'settingsPullRequestWorktree'
    | 'settingsWorktreeBranchTemplate'
    | 'settingsPullRequestBranchTemplate'
    | 'settingsGitmojiEnabled'
    | 'settingsDefaultFileViewerPreview'
    | 'settingsZenModel'
    | 'settingsMessageStreamTransport'
> = () => ({
    activeDirectoryKey: resolveInitialDirectoryKey(),
    directoryScoped: {},
    configRuntimeKey: getRuntimeKey(),
    catalogReloadRevision: 0,

    providers: [],
    agents: [],
    providersLoaded: false,
    agentsLoaded: false,
    currentProviderId: "",
    currentModelId: "",
    currentVariant: undefined,
    currentVariantSelection: { override: undefined, inherited: undefined },
    currentAgentName: undefined,
    selectedProviderId: "",
    agentModelSelections: {},
    defaultProviders: {},
    selectionSource: "auto",
    agentSelectionSource: "auto",
    isConnected: false,
    hasEverConnected: false,
    connectionPhase: "connecting",
    lastDisconnectReason: null,
    lastInitFailure: null,
    projectConfigErrors: {},
    settingsOnlyProviders: {},
    isInitialized: false,
    modelsMetadata: new Map<string, ModelMetadata>(),
    settingsDefaultModel: undefined,
    settingsDefaultsLoaded: false,
    settingsDefaultVariant: undefined,
    settingsDefaultAgent: undefined,
    chatsDefaultModel: undefined,
    chatsDefaultVariant: undefined,
    chatsDefaultAgent: undefined,
    opencodeDefaultAgent: undefined,
    opencodeDefaultModel: undefined,
    settingsAutoCreateWorktree: DEFAULT_AUTO_CREATE_WORKTREE,
    settingsWorktreeStartFrom: DEFAULT_WORKTREE_START_FROM,
    settingsWorktreeStartFromOverrides: {},
    settingsPullRequestWorktree: 'check-out',
    settingsWorktreeBranchTemplate: DEFAULT_WORKTREE_BRANCH_TEMPLATE,
    settingsPullRequestBranchTemplate: DEFAULT_PULL_REQUEST_BRANCH_TEMPLATE,
    settingsGitmojiEnabled: false,
    settingsDefaultFileViewerPreview: true,
    settingsZenModel: undefined,
    settingsMessageStreamTransport: 'auto',
});
