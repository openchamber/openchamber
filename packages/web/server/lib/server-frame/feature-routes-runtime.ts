import { registerFsRoutes } from '../fs/routes.js';
import { createRipgrepResolver } from '../fs/ripgrep.js';
import { registerEnvironmentRoutes } from '../environment/routes.js';
import { registerQuotaRoutes } from '../quota/routes.js';
import { createExtensionQuotaProviders } from '../quota/extension-quotas.js';
import { registerSmallModelRoutes } from '../small-model/routes.js';
import { registerWalkthroughRoutes } from '../walkthrough/routes.js';
import { registerSessionGoalRoutes } from '../session-goal/routes.js';
import { registerSessionWarmingRoutes } from '../session-warming/routes.js';
import { registerSessionTodosRoutes } from '../session-todos/routes.js';
import { setWarmingDuration, setWarmingEnabled } from '../opencode/websearch-config.js';
import { registerSourceControlRoutes } from '../source-control/routes.js';
import { registerLinearRoutes } from '../linear/routes.js';
import { registerTrackerRoutes } from '../trackers/routes.js';
import { createExtensionTrackers } from '../trackers/extension-trackers.js';
import { createTrackerAccounts, trackerAccountsPersistPath } from '../trackers/extension-accounts.js';
import { createTrackerOAuth } from '../trackers/extension-oauth.js';
import { registerGuestRoutes, settleGuestDeactivationListeners } from '../guests/routes.js';
import { listInstalledGuests, registerBuiltInGuests } from '../guests/catalog.js';
import { setHostCallbackRoute } from '../guests/host-callback.js';
import { createGuestOpenCodeProvider } from '../guests/opencode-provider/index.js';
import { configureGuestOpenCodeProvider } from '../guests/service.js';
import { registerNotificationChannelRoutes } from '../notifications/channel-routes.js';
import { createOutboundHandles } from '../source-control/outbound-handles.js';
import { createExtensionProviders } from '../source-control/extension-providers.js';
import { SOURCE_CONTROL_OUTBOUND_PATH, TRACKER_OUTBOUND_PATH } from '@openchamber/sdk';
import { extensionsPersistPath } from '../guests/persist.js';
import { createWorktreeInstanceDisposer, registerGitRoutes } from '../git/routes.js';
import { registerDevServerRoutes } from '../dev-servers/routes.js';
import { registerMagicPromptRoutes } from '../magic-prompts/routes.js';
import { registerSessionFoldersRoutes } from '../session-folders/routes.js';
import type { SessionFoldersStore } from '../session-folders/store.js';
import { registerSessionDraftRoutes } from '../session-drafts/routes.js';
import { registerProjectContextRoutes } from '../project-context/routes.js';
import { registerProjectDirectoryRoutes, registerProjectSetupRoutes } from '../projects/routes.js';
import { registerAgentMemoryRoutes } from '../agent-memory/routes.js';
import { registerSessionKnowledgeRoutes } from '../session-knowledge/routes.js';
import { registerMessageSearchRoutes } from '../message-search/routes.js';
import { registerPermissionAutoAcceptRoutes } from '../permission-auto-accept/runtime.js';
import { registerMessageQueueRoutes } from '../message-queue/runtime.js';
import { registerAutoReviewRoutes } from '../auto-review/runtime.js';
import { registerPrWatchRoutes } from '../pr-watch/runtime.js';
import { registerExtensionWaitsRoutes } from '../extension-waits/runtime.js';
import { registerWorkflowRoutes } from '../workflows/routes.js';
import { registerRoutingPromptRewrite, registerRoutingRoutes } from '../routing/routes.js';
import { registerConfigEntityRoutes } from '../opencode/config-entity-routes.js';
import { createFeatureFolderWatches } from './feature-folder-watches.js';
import { registerSettingsUtilityRoutes } from './core-routes.js';
import { registerProjectIconRoutes } from '../appearance/project-icon-routes.js';
import { registerProviderLogoRoutes } from '../appearance/provider-logo-routes.js';
import { registerScheduledTaskRoutes } from '../scheduled-tasks/routes.js';
import { fillScheduledWorktreeBridge } from '../scheduled-tasks/worktree-bridge.js';
import { createTrackedItemsService } from '../tracked-items/service.js';
import { createProviderReadCache } from '../provider-read-cache/index.js';
import { createTrackedItemReaders } from '../tracked-items/readers.js';
import { createTrackedItemsPersistence } from '../tracked-items/persistence.js';
import { registerTrackedItemsRoutes } from '../tracked-items/routes.js';
import { registerOpenChamberSessionRoutes } from '../openchamber-sessions/routes.js';
import { registerOpenChamberControlRoutes } from '../openchamber-control/routes.js';
import { registerMarkdownImageGrantRoutes } from '../markdown-image-grants/routes.js';
import { registerSkillRoutes } from '../opencode/skill-routes.js';
import { registerPluginRoutes } from '../opencode/plugin-routes.js';
import { getNpmInfo } from '../npm/npm-registry.js';
import { parseNpmSpec, parsePathSpec, isExactSemver } from '../opencode/plugin-spec.js';
import { registerOpenCodeRoutes } from '../opencode/routes.js';
import { getProviderSources, removeProviderConfig, upsertProviderConfig } from '../opencode/providers.js';
import { getAgentSources, getAgentConfig, getAgentPermissions, createAgent, updateAgent, deleteAgent, listDisabledAgents } from '../opencode/agents.js';
import { getCommandSources, getCommandConfig, createCommand, updateCommand, deleteCommand } from '../opencode/commands.js';
import { listMcpConfigs, getMcpConfig, createMcpConfig, updateMcpConfig, deleteMcpConfig } from '../opencode/mcp.js';
import { listSnippets, getSnippet, createSnippet, updateSnippet, deleteSnippet, expandSnippets, previewSnippet } from '../snippets/snippets.js';
import {
  listPluginEntries,
  getPluginEntry,
  readGlobalPluginEntries,
  addGlobalPluginEntry,
  createPluginEntry,
  updatePluginEntry,
  deletePluginEntry,
  setPluginEntryEnabled,
  setPluginFileEnabled,
  listPluginDirFiles,
  readPluginDirFile,
  writePluginDirFile,
  deletePluginDirFile,
  encodePluginId,
  decodePluginId,
} from '../opencode/plugins.js';
import { SKILL_DIR, SKILL_SCOPE } from '../opencode/config-files.js';
import { readSkillSupportingFile, writeSkillSupportingFile, deleteSkillSupportingFile } from '../opencode/skill-files.js';
import { getSkillSources, discoverSkills, mergeDiscoveredSkills, createSkill, updateSkill, deleteSkill, renameSkill, isManagedSkillPath } from '../opencode/skills.js';
import { getCuratedSkillsSources } from '../skills-catalog/curated-sources.js';
import { getCacheKey, scanWithCache } from '../skills-catalog/cache.js';
import { parseSkillRepoSource } from '../skills-catalog/source.js';
import { scanSkillsRepository } from '../skills-catalog/scan.js';
import { installSkillsFromRepository } from '../skills-catalog/install.js';
import { fetchGitHubRepoMetas } from '../skills-catalog/github-meta.js';
import crypto from 'node:crypto';
import { createSourceControlAuthStore } from '../source-control/auth-storage.js';
import { createSourceControlProviders } from '../source-control/provider-registry.js';
import { createGitCredentialResolver, createHttpsCredentialReference, parseGitCredentialReference } from '../git/credential-resolver.js';
import { createGitRepositoryCredentialRuntime } from '../git/repository-credential-runtime.js';
import { managedSshCommand } from '../git/network-operations.js';
import { createNetworkOperations, createTrustedDirectoriesConfig } from '../git/network-operations.js';
import { createManagedSshCredentialStore } from '../git/ssh-credential-storage.js';
import { createManagedSshInventory } from '../git/credentials.js';
import { createSshPassphraseStore } from '../git/ssh-passphrases.js';
import { openCodeCredentialSource } from '../opencode/auth.js';
import { createContributorProvenanceStore } from '../git/contributor-provenance-storage.js';
import { createGitNetworkOperationStore } from '../git/network-operation-storage.js';
import { createWithPlannedRemote, hydrateFollowingPlannedRemotes } from '../git/planned-remotes.js';
import { readEffectiveGitTransportRevision } from '../git/transport-config.js';
import { completeWorktreeCheckoutHydration, configureRepositoryTransport, deleteBranch as deleteBranchService, isGitRepository as isGitRepositoryService, removeWorktree as removeWorktreeService, resolvePrimaryWorktreeRoot, resolveWorktreeTopLevel } from '../git/service.js';
import { createPrivateRepositoryIdentityResolver, resolveRepositoryId } from '../source-control/repository-identity.js';
import { createSourceControlAuditStore } from '../source-control/audit-storage.js';
import type { Application } from '../shared/http-contracts.js';
import type { WalkthroughRouteService, PullRequestOptions } from '../walkthrough/routes.js';
import type { createTrackerRegistry } from '../trackers/registry.js';
import type { createTrackerSessionStatus } from '../trackers/session-status.js';
import type { createNotificationEmitterRuntime } from '../notifications/emitter-runtime.js';
import type { SseWriter } from '../notifications/contracts.js';
import type { GlobalMessageStreamHub } from '../event-stream/global-hub.js';
import type { createSettingsRuntime } from '../settings/settings-runtime.js';
import type { SettingsFileChange } from '../settings/settings-file-state.js';
import type { createSettingsHelpers } from '../settings/settings-helpers.js';
import type { createProjectDirectoryRuntime } from '../projects/project-directory-runtime.js';
import type { createOpenCodeNetworkRuntime } from '../opencode/network-runtime.js';
import type { createExtensionNotificationChannels } from '../notifications/extension-channels.js';
import type { createWorktreeBootstrapStore } from '../git/worktree-bootstrap-storage.js';
import type { HydrationRequirement, ProviderAccount, TransportAuthority } from '../git/network-plan-contracts.js';
import { isString } from '../shared/object-guards.js';
import type { createMergeFollowRuntime } from '../github/merge-follow.js';

type PluginRouteOptions = Parameters<typeof registerPluginRoutes>[1];
type FeatureRuntimeDependencies = Required<Pick<PluginRouteOptions, 'pluginSwitchStore' | 'isPluginSwitchAvailable' | 'refreshPluginSwitches'>> & {
  clientReloadDelayMs: number;
  trackers: ReturnType<typeof createTrackerRegistry>;
  trackerSessionStatus: Pick<ReturnType<typeof createTrackerSessionStatus>, 'forget'> | null;
};

type FsOptions = Parameters<typeof registerFsRoutes>[1];
type IconOptions = Parameters<typeof registerProjectIconRoutes>[1];
type SessionOptions = Parameters<typeof registerOpenChamberSessionRoutes>[1];
type GuestOptions = Parameters<typeof registerGuestRoutes>[1];
type SettingsRuntime = ReturnType<typeof createSettingsRuntime>;
interface ChangeRequestWorktreeInput<Source> {
  mode: 'existing';
  branchName: string;
  worktreeName: string;
  changeRequestSource: Source;
  startCommand?: string;
  createCommand?: string;
}
type ScheduledTaskOptions = Parameters<typeof registerScheduledTaskRoutes>[1];
type EventClient = ReturnType<ScheduledTaskOptions['getOpenChamberEventClients']> extends Set<infer Client> ? Client & SseWriter & { openchamberConnectionId?: string } : never;
type RouteDependencies =
  & Pick<FsOptions, 'os' | 'path' | 'fsPromises' | 'spawn' | 'normalizeDirectoryPath' | 'buildAugmentedPath' | 'resolveGitBinaryForSpawn' | 'openchamberUserConfigRoot'>
  & Required<Pick<FsOptions, 'managedChatsRoot'>>
  & Pick<IconOptions, 'createFsSearchRuntime' | 'openchamberDataDir'>
  & Required<Pick<SessionOptions, 'validateDirectoryPath' | 'waitForOpenCodeReady' | 'emitSessionCreatedEvent'>>
  & Required<Pick<GuestOptions, 'onGuestDeactivated' | 'surfaceViewerHeaders' | 'openchamberVersion'>>
  & Pick<ReturnType<typeof createProjectDirectoryRuntime>, 'resolveProjectDirectory' | 'resolveOptionalProjectDirectory'>
  & Pick<Parameters<typeof registerSettingsUtilityRoutes>[1], 'readCustomThemesFromDisk' | 'saveImportedTheme' | 'deleteImportedTheme' | 'refreshOpenCodeAfterConfigChange'>
  & Pick<Parameters<typeof registerOpenCodeRoutes>[1], 'crypto' | 'getOpenCodeResolutionSnapshot' | 'getOpenCodeUpgradeCapability' | 'upgradeOpenCodeCli' | 'getOpenCodeCompatibility' | 'installOpenCodeV2'>
  & Pick<ScheduledTaskOptions, 'projectConfigRuntime' | 'scheduledTasksRuntime' | 'sanitizeProjects'>
  & Required<Pick<ScheduledTaskOptions, 'scheduledTaskService'>>
  & Pick<Parameters<typeof registerSkillRoutes>[1], 'sanitizeSkillCatalogs' | 'isUnsafeSkillRelativePath' | 'getOpenCodePort' | 'getManagedOpenCodeProcessEnv'>
  & {
    settingsRuntime: Pick<SettingsRuntime, 'readSettingsFromDisk' | 'readSettingsFromDiskMigrated' | 'persistSettings' | 'persistResolvedSettings' | 'watchSettingsFiles' | 'reconcileExternalSettings' | 'subscribeTakenInSettings' | 'takeSetAsideSettingsFiles'>;
    fs: typeof import('node:fs');
    formatSettingsResponse: ReturnType<typeof createSettingsHelpers>['formatSettingsResponse'];
    buildOpenCodeUrl: ReturnType<typeof createOpenCodeNetworkRuntime>['buildOpenCodeUrl'];
    getOpenCodeAuthHeaders: () => Record<string, string>;
    messageSearchRuntime: Parameters<typeof registerMessageSearchRoutes>[1]['messageSearchRuntime'];
    sessionWarmingRuntime: Parameters<typeof registerSessionWarmingRoutes>[1]['sessionWarmingRuntime'];
    sessionTodosRuntime: Parameters<typeof registerSessionTodosRoutes>[1]['sessionTodosRuntime'];
    onExtensionSessionEventsChanged?: () => void | Promise<void>;
    onExtensionWaitsChanged?: () => void | Promise<void>;
    extensionNotificationChannels?: ReturnType<typeof createExtensionNotificationChannels> | null;
    getOpenCodePluginDelivery?: NonNullable<NonNullable<GuestOptions['opencodePlugins']>['delivery']>;
    builtInExtensionsDir?: string | undefined;
    customThemesDir?: string | null;
    getOwnPorts: Parameters<typeof registerDevServerRoutes>[1]['getOwnPorts'];
    getActivePort?: () => number | null;
    getActiveHost?: () => string | null;
    devServerScanner: Parameters<typeof registerDevServerRoutes>[1]['scanner'];
    environmentStore: Parameters<typeof registerEnvironmentRoutes>[1]['store'];
    environmentRuntime: NonNullable<FsOptions['environmentRuntime']>;
    listConfiguredProjects: Parameters<typeof registerEnvironmentRoutes>[1]['listProjects'];
    projectContextRuntime: Parameters<typeof registerProjectContextRoutes>[1]['projectContextRuntime'];
    agentMemoryRuntime: Parameters<typeof registerAgentMemoryRoutes>[1]['agentMemoryRuntime'];
    isAgentMemoryEnabled: NonNullable<Parameters<typeof registerAgentMemoryRoutes>[1]['isAgentMemoryEnabled']>;
    sessionKnowledgeRuntime: Parameters<typeof registerSessionKnowledgeRoutes>[1]['sessionKnowledgeRuntime'];
    openChamberSessionService: NonNullable<SessionOptions['sessionService']>;
    openChamberControlService: Parameters<typeof registerOpenChamberControlRoutes>[1]['controlService'];
    sessionFoldersStore?: SessionFoldersStore;
    getOpenChamberEventClients: () => Set<EventClient>;
    writeSseEvent: ReturnType<typeof createNotificationEmitterRuntime>['writeSseEvent'];
    permissionAutoAcceptRuntime: Parameters<typeof registerPermissionAutoAcceptRoutes>[1];
    worktreeBootstrapStore: ReturnType<typeof createWorktreeBootstrapStore>;
    scheduledWorktreeBridge: Parameters<typeof fillScheduledWorktreeBridge>[0];
    messageQueueRuntime: Parameters<typeof registerMessageQueueRoutes>[1];
    autoReviewRuntime: Parameters<typeof registerAutoReviewRoutes>[1];
    prWatchRuntime?: Parameters<typeof registerPrWatchRoutes>[1] | null;
    extensionWaitsRuntime?: Parameters<typeof registerExtensionWaitsRoutes>[1] | null;
    laterPagesRuntime?: Parameters<typeof registerOpenChamberControlRoutes>[1]['laterPages'];
    mergeFollowRuntime?: ReturnType<typeof createMergeFollowRuntime> | null;
    routingRuntime: Parameters<typeof registerRoutingRoutes>[1];
    globalEventHub: GlobalMessageStreamHub | null;
    workflowRuntime?: Parameters<typeof registerWorkflowRoutes>[1] | null;
  };

export const createFeatureRoutesRuntime = (dependencies: FeatureRuntimeDependencies) => {
  const {
    clientReloadDelayMs,
    trackers,
    trackerSessionStatus,
    pluginSwitchStore,
    isPluginSwitchAvailable,
    refreshPluginSwitches,
  } = dependencies;
  const gitRuntimeIdentity = Object.freeze({
    id: `server_${crypto.randomUUID()}`,
    platform: process.env.OPENCHAMBER_RUNTIME === 'desktop' ? 'desktop' : 'web',
  });
  const folderWatches = createFeatureFolderWatches();
  let stopGuestPackageWatch: () => void = () => {};
  let quotaProviders: typeof import('../quota/index.js') | null = null;
  const getQuotaProviders = async () => {
    if (!quotaProviders) {
      quotaProviders = await import('../quota/index.js');
    }
    return quotaProviders;
  };

  let smallModelService: typeof import('../small-model/index.js') | null = null;
  const getSmallModelService = async () => {
    if (!smallModelService) {
      smallModelService = await import('../small-model/index.js');
    }
    return smallModelService;
  };

  let walkthroughService: WalkthroughRouteService | null = null;
  let walkthroughBindingService: ReturnType<typeof registerSourceControlRoutes> | null = null;
  let magicPrompts: ReturnType<typeof registerMagicPromptRoutes> | null = null;
  let gitRepositoryCredentialRuntime: ReturnType<typeof createGitRepositoryCredentialRuntime> | null = null;
  let networkOperations: ReturnType<typeof createNetworkOperations> | null = null;
  let gitWorktreeCreation: ReturnType<typeof registerGitRoutes> | null = null;
  const getWalkthroughService = async () => {
    if (!walkthroughService) {
      const [service, pullRequest] = await Promise.all([
        import('../walkthrough/index.js'),
        import('../walkthrough/pull-request.js'),
      ]);
      walkthroughService = {
        ...service,
        readWalkthroughInstructions: async (directory) => (
          magicPrompts ? (await magicPrompts.overridesForDirectory(directory))['walkthrough.instructions'] ?? '' : ''
        ),
        getPullRequestDiff: (directory, number, readContext, { allowEmpty, sourceRepo, revision }: Partial<PullRequestOptions> = {}) => pullRequest.getPullRequestDiff(
          directory,
          number,
          readContext,
          { allowEmpty, sourceRepo, revision, readChangeRequestPatch: walkthroughBindingService?.readChangeRequestPatch },
        ),
        getPullRequestFileContents: (directory, number, readContext, { path, previousPath, status, sourceRepo, revision, binary }) => pullRequest.getPullRequestFileContents(
          directory,
          number,
          readContext,
          { path, previousPath, status, sourceRepo, revision, binary, readChangeRequestFile: walkthroughBindingService?.readChangeRequestFile },
        ),
      };
    }
    return walkthroughService;
  };

  const hydrateBoundCheckout = async ({ directory, parentDirectory, parentRemoteName }: { directory: string; parentDirectory: string; parentRemoteName: string }) => {
    if (!(networkOperations?.hydrateBoundCheckout instanceof Function)
      || !(walkthroughBindingService?.get instanceof Function)) {
      throw Object.assign(new Error('Worktree checkout hydration is unavailable'), {
        code: 'RUNTIME_UNSUPPORTED',
      });
    }
    const { get: readBinding } = walkthroughBindingService;
    const { hydrateBoundCheckout: hydrate } = networkOperations;
    return createWithPlannedRemote({
      directory: parentDirectory, remote: undefined, serialize: false, readBinding,
      create: (pinned) => hydrateFollowingPlannedRemotes(pinned, (repositoryAuthority) => hydrate({ directory, parentRemoteName, repositoryAuthority })),
    });
  };

  const createChangeRequestWorktree = async ({ directory, number, name, branchName, startCommand, createCommand }: {
    directory: string; number: number; name?: string; branchName?: string; startCommand?: string; createCommand?: string;
  }) => {
    if (!(gitWorktreeCreation?.createWorktree instanceof Function)
      || !(walkthroughBindingService?.resolveChangeRequestWorktreeSource instanceof Function)) {
      throw Object.assign(new Error('Worktrees from pull requests are unavailable'), {
        code: 'RUNTIME_UNSUPPORTED', status: 501,
      });
    }
    const { headBranch, sourceRequest } = await walkthroughBindingService.resolveChangeRequestWorktreeSource({ directory, number });
    const branch = branchName || headBranch;
    const input: ChangeRequestWorktreeInput<typeof sourceRequest> = {
      mode: 'existing',
      branchName: branch,
      worktreeName: name || branch,
      changeRequestSource: sourceRequest,
    };
    if (startCommand) input.startCommand = startCommand;
    if (createCommand) input.createCommand = createCommand;
    return gitWorktreeCreation.createWorktree(directory, input);
  };

  const registerRoutes = async (app: Application, routeDependencies: RouteDependencies) => {
    const {
      messageSearchRuntime,
      sessionWarmingRuntime,
      sessionTodosRuntime,
      sessionFoldersStore,
      crypto,
      fs,
      os,
      path,
      fsPromises,
      spawn,
      resolveGitBinaryForSpawn,
      createFsSearchRuntime,
      openchamberDataDir,
      onGuestDeactivated,
      onExtensionSessionEventsChanged = () => {},
      onExtensionWaitsChanged = () => {},
      extensionNotificationChannels = null,
      surfaceViewerHeaders,
      getOpenCodePluginDelivery = () => 'file',
      openchamberUserConfigRoot,
      managedChatsRoot,
      normalizeDirectoryPath,
      resolveProjectDirectory,
      resolveOptionalProjectDirectory,
      validateDirectoryPath,
      readCustomThemesFromDisk,
      saveImportedTheme,
      deleteImportedTheme,
      refreshOpenCodeAfterConfigChange,
      getOpenCodeResolutionSnapshot,
      getOpenCodeUpgradeCapability,
      upgradeOpenCodeCli,
      getOpenCodeCompatibility,
      installOpenCodeV2,
      formatSettingsResponse,
      settingsRuntime,
      sanitizeProjects,
      sanitizeSkillCatalogs,
      isUnsafeSkillRelativePath,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      getOpenCodePort, getManagedOpenCodeProcessEnv,
      getOwnPorts,
      devServerScanner,
      buildAugmentedPath,
      environmentStore,
      environmentRuntime,
      listConfiguredProjects,
      projectConfigRuntime,
      projectContextRuntime,
      agentMemoryRuntime,
      isAgentMemoryEnabled,
      sessionKnowledgeRuntime,
      scheduledTasksRuntime,
      scheduledTaskService,
      openChamberSessionService,
      openChamberControlService,
      waitForOpenCodeReady,
      getOpenChamberEventClients,
      writeSseEvent,
      emitSessionCreatedEvent,
      permissionAutoAcceptRuntime,
      worktreeBootstrapStore,
      messageQueueRuntime,
      autoReviewRuntime,
      prWatchRuntime = null,
      extensionWaitsRuntime = null,
      laterPagesRuntime = null,
      mergeFollowRuntime = null,
      routingRuntime,
      globalEventHub,
      openchamberVersion,
      workflowRuntime = null,
    } = routeDependencies;
    const { readSettingsFromDisk, readSettingsFromDiskMigrated, persistSettings, persistResolvedSettings, takeSetAsideSettingsFiles } = settingsRuntime;

    registerSettingsUtilityRoutes(app, {
      readCustomThemesFromDisk,
      saveImportedTheme,
      deleteImportedTheme,
      refreshOpenCodeAfterConfigChange,
      clientReloadDelayMs,
    });

    registerPermissionAutoAcceptRoutes(app, permissionAutoAcceptRuntime);
    registerMessageQueueRoutes(app, messageQueueRuntime);
    registerAutoReviewRoutes(app, autoReviewRuntime);
    if (prWatchRuntime) registerPrWatchRoutes(app, prWatchRuntime);
    if (extensionWaitsRuntime) registerExtensionWaitsRoutes(app, extensionWaitsRuntime);
    registerRoutingRoutes(app, routingRuntime);
    registerRoutingPromptRewrite(app, routingRuntime);

    registerOpenCodeRoutes(app, {
      crypto,
      getOpenCodeResolutionSnapshot,
      getOpenCodeUpgradeCapability,
      upgradeOpenCodeCli,
      getOpenCodeCompatibility,
      installOpenCodeV2,
      formatSettingsResponse,
      readSettingsFromDiskMigrated, takeSetAsideSettingsFiles,
      persistSettings,
      resolveProjectDirectory,
      getProviderSources,
      removeProviderConfig,
      upsertProviderConfig,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
    });

    registerProjectIconRoutes(app, {
      fsPromises,
      path,
      crypto,
      openchamberDataDir,
      sanitizeProjects,
      readSettingsFromDiskMigrated,
      persistSettings,
      persistResolvedSettings,
      createFsSearchRuntime,
      spawn,
      resolveGitBinaryForSpawn,
    });

    registerProviderLogoRoutes(app, {
      fsPromises,
      path,
      crypto,
      openchamberDataDir,
      readSettingsFromDiskMigrated,
      persistResolvedSettings,
    });

    registerScheduledTaskRoutes(app, {
      readSettingsFromDiskMigrated,
      sanitizeProjects,
      projectConfigRuntime,
      scheduledTasksRuntime,
      scheduledTaskService,
      getOpenChamberEventClients,
      writeSseEvent,
    });

    registerOpenChamberSessionRoutes(app, {
      readSettingsFromDiskMigrated,
      sanitizeProjects,
      validateDirectoryPath,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      waitForOpenCodeReady,
      emitSessionCreatedEvent,
      worktreeBootstrapStore,
      hydrateWorktreeCheckout: hydrateBoundCheckout,
      sessionService: openChamberSessionService,
    });

    registerOpenChamberControlRoutes(app, { controlService: openChamberControlService, laterPages: laterPagesRuntime });
    if (workflowRuntime) registerWorkflowRoutes(app, workflowRuntime);

    registerMarkdownImageGrantRoutes(app, {
      fsPromises,
      path,
      crypto,
      validateDirectoryPath,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
    });

    registerConfigEntityRoutes(app, {
      resolveProjectDirectory,
      resolveOptionalProjectDirectory,
      getAgentSources,
      getAgentConfig,
      getAgentPermissions,
      listDisabledAgents,
      createAgent,
      updateAgent,
      deleteAgent,
      getCommandSources,
      getCommandConfig,
      createCommand,
      updateCommand,
      deleteCommand,
      listMcpConfigs,
      getMcpConfig,
      createMcpConfig,
      updateMcpConfig,
      deleteMcpConfig,
      listSnippets,
      getSnippet,
      createSnippet,
      updateSnippet,
      deleteSnippet,
      expandSnippets,
      previewSnippet,
    });

    registerPluginRoutes(app, {
      resolveOptionalProjectDirectory,
      listPluginEntries,
      getPluginEntry,
      createPluginEntry,
      updatePluginEntry,
      deletePluginEntry,
      setPluginEntryEnabled,
      setPluginFileEnabled,
      listPluginDirFiles,
      readPluginDirFile,
      writePluginDirFile,
      deletePluginDirFile,
      encodePluginId,
      decodePluginId,
      getNpmInfo,
      parseNpmSpec,
      parsePathSpec,
      isExactSemver,
      pluginSwitchStore,
      isPluginSwitchAvailable,
      refreshPluginSwitches,
    });

    const { getProfiles, getProfile, getGlobalIdentity, resolveRepositoryGitPaths, spawnOutsideProjects } = await import('../git/index.js');

    registerQuotaRoutes(app, { getQuotaProviders });
    registerSmallModelRoutes(app, { getSmallModelService });
    registerSessionGoalRoutes(app);
    const gitBinary = resolveGitBinaryForSpawn();
    const sourceControlAuthStore = createSourceControlAuthStore({
      filePath: path.join(openchamberDataDir, 'source-control-auth.json'),
      refreshOAuthToken: async ({ provider, origin, refreshToken }) => {
        const impl = await sourceControlProviders.implementation(provider);
        if (!(impl?.auth.refreshOAuthToken instanceof Function)) throw new Error('Source control OAuth renewal is unavailable');
        return impl.auth.refreshOAuthToken({ instance: origin, refreshToken });
      },
    });
    const sourceControlOutboundHandles = createOutboundHandles();
    setHostCallbackRoute(SOURCE_CONTROL_OUTBOUND_PATH, {
      refusal: sourceControlOutboundHandles.refusal,
      serve: sourceControlOutboundHandles.serve,
    });
    const sourceControlProviders = createSourceControlProviders({
      authStore: sourceControlAuthStore,
      extensionServices: {
        handles: sourceControlOutboundHandles,
        persistPath: extensionsPersistPath(openchamberDataDir),
        currentGuest: async (guestId) => (await listInstalledGuests({ persistPath: extensionsPersistPath(openchamberDataDir) }))
          .find((guest) => guest.id === guestId) ?? null,
        reconcile: () => extensionSourceControlProviders.reconcile(),
      },
      readSettings: readSettingsFromDisk,
      configRoot: openchamberDataDir,
      hostServices: {
        github: {
          readContributorProvenance: (directory: string) => contributorProvenance.read(directory),
        },
      },
    });
    const resolveSourceControlAccount = ({ provider, instance, accountId, credentialRevision }: ProviderAccount & { credentialRevision?: number }) => sourceControlProviders
      .readTransportCredential({ provider, instance, credentialId: accountId, credentialRevision });
    const resolveTransportRepository = createPrivateRepositoryIdentityResolver({
      getTransportRevision: (directory) => readEffectiveGitTransportRevision(directory, { gitBinary }),
    });
    const contributorProvenance = createContributorProvenanceStore({
      filePath: path.join(openchamberDataDir, 'git-contributor-provenance.json'),
      resolveRepositoryIdentity: resolveRepositoryId,
      resolveGitPaths: resolveRepositoryGitPaths,
      fsImpl: fsPromises,
    });
    const sourceControlAuditStore = createSourceControlAuditStore({
      filePath: path.join(openchamberDataDir, 'source-control-audit.json'),
      fsImpl: fsPromises,
    });
    const sshCredentialStore = createManagedSshCredentialStore({
      filePath: path.join(openchamberDataDir, 'git-ssh-credentials.json'),
      fsImpl: fsPromises,
    });
    const sshPassphrases = createSshPassphraseStore(openCodeCredentialSource({ buildOpenCodeUrl, getOpenCodeAuthHeaders }));
    const managedSshInventory = createManagedSshInventory({
      passphrases: sshPassphrases,
      store: sshCredentialStore,
      snapshotRoot: path.join(openchamberDataDir, 'git-ssh-operation-keys'),
      discoveryRoot: path.join(os.homedir(), '.ssh'),
      managedKeyRoot: path.join(openchamberDataDir, 'git-ssh-private-keys'),
      fsImpl: fsPromises,
    });
    const syncRepositoryTransport = async (directory: import('../source-control/binding-service-contracts.js').BindingIntentRequest['directory'], read: Awaited<ReturnType<ReturnType<typeof import('../source-control/binding-service.js').createBindingService>['get']>>) => {
      if (!isString(directory) || !directory.trim() || !gitRepositoryCredentialRuntime) return;
      const grants = (read?.binding?.remotes ?? []).filter((grant) => grant.readiness === 'ready' && grant.mode === 'managed' && grant.credentialId);
      let credentialHelper = null;
      let sshCommand = null;
      for (const grant of grants) {
        let reference;
        try { reference = parseGitCredentialReference(grant.credentialId); } catch { continue; }
        if (reference.transport === 'https') credentialHelper = gitRepositoryCredentialRuntime.helperCommand();
        if (reference.transport === 'ssh' && !sshCommand) {
          const key = await sshCredentialStore.lookup(reference.keyId);
          if (key?.privateKeyPath) sshCommand = managedSshCommand(key.privateKeyPath);
        }
      }
      await configureRepositoryTransport(directory, { credentialHelper, sshCommand });
    };
    let trackedItemsService: ReturnType<typeof createTrackedItemsService> | null = null;
    const providerReadCache = createProviderReadCache({
      sourceControlProviderIds: sourceControlProviders.list().map((descriptor) => descriptor.id),
      trackerIds: () => trackers.list(),
      onChange: (provider) => trackedItemsService?.refreshProvider(provider),
      onItemRefresh: (provider, item) => trackedItemsService?.refreshItem(provider, item),
    });
    app.use((req, res, next) => { providerReadCache.middleware(req, res, next); });
    walkthroughBindingService = registerSourceControlRoutes(app, {
      onMutationSucceeded: (mutation: Parameters<NonNullable<RouteDependencies['mergeFollowRuntime']>['onMutationSucceeded']>[0]) => mergeFollowRuntime?.onMutationSucceeded(mutation),
      onMutationStarting: (mutation: Parameters<NonNullable<RouteDependencies['mergeFollowRuntime']>['onMutationStarting']>[0]) => mergeFollowRuntime?.onMutationStarting(mutation) ?? null,
      onRepositoryTransportChanged: syncRepositoryTransport,
      validateManagedSshCredential: managedSshInventory.assertAvailable,
      readManagedSshCredentialPresentation: managedSshInventory.presentation,
      configRoot: openchamberDataDir,
      resolveTransportRepository,
      auditStore: sourceControlAuditStore,
      runtimeIdentity: gitRuntimeIdentity,
      providers: sourceControlProviders,
      readTransportAccount: resolveSourceControlAccount,
      resolveCheckoutAuxiliary: async ({ directory, parentEndpoint, parentRemoteName, kind, path: checkoutPath }: Pick<HydrationRequirement, 'kind' | 'path'> & {
        directory: string;
        parentEndpoint: TransportAuthority['endpoint'];
        parentRemoteName: string;
      }) => {
        if (!(networkOperations?.inspectCheckoutAuxiliary instanceof Function)) return null;
        return networkOperations.inspectCheckoutAuxiliary({
          directory, parentEndpoint, parentRemoteName, kind, path: checkoutPath,
        });
      },
    });
    registerWalkthroughRoutes(app, {
      getWalkthroughService,
      validateReadContext: walkthroughBindingService.validateReadContext,
    });
    const findEventClient = (connectionId: string) => {
      for (const client of getOpenChamberEventClients()) {
        if (client.openchamberConnectionId === connectionId) return client;
      }
      return null;
    };
    const trackedItemReaders = createTrackedItemReaders({ readLiveSummaries: walkthroughBindingService.readLiveSummaries, trackers });
    trackedItemsService = createTrackedItemsService({
      readers: trackedItemReaders,
      persistence: createTrackedItemsPersistence({ dataDir: openchamberDataDir }),
      isConnectionOpen: (connectionId) => findEventClient(connectionId) !== null,
      send: (connectionId, event) => {
        const client = findEventClient(connectionId);
        if (!client) return false;
        try {
          writeSseEvent(client, event);
          return true;
        } catch {
          getOpenChamberEventClients().delete(client);
          return false;
        }
      },
    });
    const TURN_SETTLE_MS = 3000;
    const settlingDirectories = new Map<string, ReturnType<typeof setTimeout>>();
    const announceTurnFinished = (directory: string) => {
      if (settlingDirectories.has(directory)) return;
      settlingDirectories.set(directory, setTimeout(() => {
        settlingDirectories.delete(directory);
        const clients = getOpenChamberEventClients();
        for (const client of clients) {
          try {
            writeSseEvent(client, { type: 'openchamber:source-control.activity', properties: { directory } });
          } catch {
            clients.delete(client);
          }
        }
      }, TURN_SETTLE_MS));
    };
    globalEventHub?.subscribeEvent((event) => {
      for (const payload of event?.translated?.() ?? []) {
        if (payload?.type === 'session.idle' || (payload?.type === 'session.status' && payload.properties?.status?.type === 'idle')) {
          trackedItemsService.noteTurnFinished();
          providerReadCache.clear();
          if (event.directory && event.directory !== 'global') announceTurnFinished(event.directory);
          return;
        }
      }
    });
    registerTrackedItemsRoutes(app, { service: trackedItemsService });
    prWatchRuntime?.attach({ trackedItems: trackedItemsService, readers: trackedItemReaders });
    void mergeFollowRuntime?.attach(trackedItemsService).catch((error) => console.warn('[merge-follow] attach failed:', error.message));
    const resolveGitIdentity = async (identityId: string) => {
      if (identityId === 'global') {
        const identity = await getGlobalIdentity();
        return identity?.userName && identity?.userEmail ? { userName: identity.userName, userEmail: identity.userEmail } : null;
      }
      const identity = getProfile(identityId);
      return identity?.userName && identity?.userEmail ? identity : null;
    };
    const validateGitIdentity = async (identityId: string) => {
      const profile = await resolveGitIdentity(identityId);
      if (!profile) throw new Error('Git identity profile is unavailable');
      return profile;
    };
    const networkOperationStore = createGitNetworkOperationStore({
      filePath: path.join(openchamberDataDir, 'git-network-operations.json'),
      fsImpl: fsPromises,
    });
    const gitCredentialResolver = createGitCredentialResolver({
      passphrases: sshPassphrases,
      readTransportCredential: sourceControlProviders.readTransportCredential,
      describeProvider: sourceControlProviders.describe,
      lookupManagedSshKey: sshCredentialStore.lookup,
      fsImpl: fsPromises,
      snapshotRoot: path.join(openchamberDataDir, 'git-ssh-operation-keys'),
    });
    registerSkillRoutes(app, {
      fs,
      path,
      os,
      resolveProjectDirectory,
      resolveOptionalProjectDirectory,
      readSettingsFromDisk,
      sanitizeSkillCatalogs,
      isUnsafeSkillRelativePath,
      refreshOpenCodeAfterConfigChange,
      clientReloadDelayMs,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      getOpenCodePort, getManagedOpenCodeProcessEnv,
      getSkillSources,
      discoverSkills,
      mergeDiscoveredSkills,
      createSkill,
      updateSkill,
      deleteSkill,
      renameSkill,
      isManagedSkillPath,
      readSkillSupportingFile,
      writeSkillSupportingFile,
      deleteSkillSupportingFile,
      SKILL_SCOPE,
      SKILL_DIR,
      getCuratedSkillsSources,
      getCacheKey,
      scanWithCache,
      parseSkillRepoSource,
      scanSkillsRepository,
      installSkillsFromRepository,
      fetchGitHubRepoMetas,
      getProfiles,
      getProfile,
      createHttpsCredentialReference,
      resolveSourceControlAccount,
      credentialResolver: gitCredentialResolver,
    });
    gitRepositoryCredentialRuntime = createGitRepositoryCredentialRuntime({
      readBinding: walkthroughBindingService.get,
      credentialResolver: gitCredentialResolver,
      dataDir: openchamberDataDir,
      fsPromises,
      getActivePort: routeDependencies.getActivePort ?? (() => null),
      getActiveHost: routeDependencies.getActiveHost ?? (() => null),
    });
    gitRepositoryCredentialRuntime.registerRoutes(app);
    networkOperations = createNetworkOperations({
      validateManagedSshCredential: managedSshInventory.assertAvailable,
      resolveSourceControlAccount,
      sourceControlProviders: sourceControlProviders.descriptors,
      bindClonedRepository: walkthroughBindingService.bindClonedRepository,
      validateGitTransportContext: walkthroughBindingService.validateGitTransportContext,
      validateGitAuxiliaryContext: walkthroughBindingService.validateGitAuxiliaryContext,
      contributorProvenance,
      resolveChangeRequestSource: walkthroughBindingService.resolveChangeRequestSource,
      credentialResolver: gitCredentialResolver,
      runtimeIdentity: gitRuntimeIdentity,
      auditStore: sourceControlAuditStore,
      operationStore: networkOperationStore,
      onCheckoutHydrated: (directory) => completeWorktreeCheckoutHydration(directory, {
        bootstrapStore: worktreeBootstrapStore,
        disposeInstance: createWorktreeInstanceDisposer({ buildOpenCodeUrl, getOpenCodeAuthHeaders }),
      }),
      spawnImpl: spawnOutsideProjects(gitBinary, spawn),
      fsImpl: fsPromises,
      pathImpl: path,
      gitBinary,
      validateGitIdentity,
      resolveGitIdentity,
      trustedDirectoriesConfig: createTrustedDirectoriesConfig({ gitBinary }),
    });
    await registerBuiltInGuests({ persistPath: extensionsPersistPath(openchamberDataDir), root: routeDependencies.builtInExtensionsDir });
    const announceChange = (type: string, properties: SettingsFileChange | Record<string, never> = {}) => {
      const clients = getOpenChamberEventClients();
      for (const client of clients) {
        try {
          writeSseEvent(client, { type, properties });
        } catch {
          clients.delete(client);
        }
      }
    };
    await folderWatches.start(routeDependencies, announceChange);
    const extensionSourceControlProviders = createExtensionProviders({
      listGuests: () => listInstalledGuests({ persistPath: extensionsPersistPath(openchamberDataDir) }),
      register: walkthroughBindingService.registerExtensionProvider,
      unregister: walkthroughBindingService.unregisterExtensionProvider,
      dropSection: (id) => sourceControlAuthStore.dropSection(id),
      emitChanged: () => announceChange('openchamber:source-control-providers-changed'),
    });
    const trackerOutboundHandles = createOutboundHandles();
    setHostCallbackRoute(TRACKER_OUTBOUND_PATH, {
      refusal: trackerOutboundHandles.refusal,
      serve: trackerOutboundHandles.serve,
    });
    const extensionTrackers = createExtensionTrackers({
      listGuests: () => listInstalledGuests({ persistPath: extensionsPersistPath(openchamberDataDir) }),
      currentGuest: async (guestId) => (await listInstalledGuests({ persistPath: extensionsPersistPath(openchamberDataDir) }))
        .find((guest) => guest.id === guestId) ?? null,
      registry: trackers,
      accounts: createTrackerAccounts({ persistPath: trackerAccountsPersistPath(openchamberDataDir) }),
      handles: trackerOutboundHandles,
      oauth: createTrackerOAuth(),
      sessionStatus: trackerSessionStatus ?? { forget: () => {} },
      persistPath: extensionsPersistPath(openchamberDataDir),
      emitChanged: () => announceChange('openchamber:tracker-providers-changed'),
    });
    const extensionQuotaProviders = createExtensionQuotaProviders({
      listGuests: () => listInstalledGuests({ persistPath: extensionsPersistPath(openchamberDataDir) }),
      currentGuest: async (guestId) => (await listInstalledGuests({ persistPath: extensionsPersistPath(openchamberDataDir) }))
        .find((guest) => guest.id === guestId) ?? null,
      loadRegistry: getQuotaProviders,
      persistPath: extensionsPersistPath(openchamberDataDir),
      emitChanged: () => announceChange('openchamber:quota-providers-changed'),
    });
    configureGuestOpenCodeProvider(createGuestOpenCodeProvider({
      currentGuest: async (guestId) => (await listInstalledGuests({ persistPath: extensionsPersistPath(openchamberDataDir) }))
        .find((guest) => guest.id === guestId) ?? null,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
    }));
    stopGuestPackageWatch();
    ({ stopPackageWatch: stopGuestPackageWatch } = registerGuestRoutes(app, {
      openchamberDataDir, openchamberVersion, resolveGitBinaryForSpawn, resolveOptionalProjectDirectory, getSmallModelService,
      onGuestDeactivated: settleGuestDeactivationListeners([
        { name: 'hand back an extension role', listener: onGuestDeactivated },
        { name: 'withdraw an extension Git host', listener: (event) => extensionSourceControlProviders.deactivated(event) },
        { name: 'drop an extension\'s session event subscription', listener: () => onExtensionSessionEventsChanged() },
        { name: 'end an extension\'s waits', listener: () => onExtensionWaitsChanged() },
        { name: 'withdraw an extension notification channel', listener: (event) => extensionNotificationChannels?.deactivated(event) },
        { name: 'withdraw an extension tracker', listener: (event) => extensionTrackers.deactivated(event) },
        { name: 'withdraw an extension usage provider', listener: () => extensionQuotaProviders.deactivated() },
      ]),
      onGuestActivated: async () => {
        const results = await Promise.allSettled([
          extensionSourceControlProviders.reconcile(),
          onExtensionSessionEventsChanged(),
          onExtensionWaitsChanged(),
          extensionNotificationChannels?.reconcile(),
          extensionTrackers.reconcile(),
          extensionQuotaProviders.reconcile(),
        ]);
        const failed = results.find((result) => result.status === 'rejected');
        if (failed) throw failed.reason;
      },
      onGuestsChanged: () => announceChange('openchamber:guests-changed'),
      watchFolderInstalls: true,
      surfaceViewerHeaders, trackers, gitAccounts: { readAccount: resolveSourceControlAccount, credentialResolver: gitCredentialResolver },
      opencodePlugins: { delivery: getOpenCodePluginDelivery, readGlobalEntries: readGlobalPluginEntries, addGlobalEntry: addGlobalPluginEntry },
    }));
    await extensionSourceControlProviders.reconcile().catch((error) => {
      console.warn('Failed to load extension Git hosts:', error?.message ?? error);
    });
    await extensionTrackers.reconcile().catch((error) => {
      console.warn('Failed to load extension trackers:', error?.message ?? error);
    });
    await extensionQuotaProviders.reconcile().catch((error) => {
      console.warn('Failed to load extension usage providers:', error?.message ?? error);
    });
    if (extensionNotificationChannels) {
      registerNotificationChannelRoutes(app, { channels: extensionNotificationChannels });
      await extensionNotificationChannels.reconcile().catch((error) => {
        console.warn('Failed to load extension notification channels:', error?.message ?? error);
      });
    }
    gitWorktreeCreation = registerGitRoutes(app, {
      backfillIdentities: walkthroughBindingService.backfillConnectedIdentities,
      managedSshInventory,
      networkOperations,
      contributorProvenance,
      resolveChangeRequestSource: walkthroughBindingService.resolveChangeRequestSource,
      createHttpsCredentialReference,
      getSourceControlBinding: walkthroughBindingService.get,
      onBranchRewritten: walkthroughBindingService.invalidateBranchStatus,
      resolveSourceControlAccount,
      errorRedactionSecrets: [openchamberDataDir],
      worktreeBootstrapStore,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      emitWorktreeChanged: ({ directories, at }) => {
        const clients = getOpenChamberEventClients();
        for (const client of clients) {
          try {
            writeSseEvent(client, {
              type: 'openchamber:worktree-changed',
              properties: { directories, at },
            });
          } catch {
            clients.delete(client);
          }
        }
      },
    });
    registerTrackerRoutes(app, { registry: trackers });
    registerLinearRoutes(app);
    fillScheduledWorktreeBridge(routeDependencies.scheduledWorktreeBridge, {
      createWorktree: gitWorktreeCreation?.createWorktree,
      createWorktreeInstanceDisposer: gitWorktreeCreation?.createWorktreeInstanceDisposer,
      removeWorktree: removeWorktreeService,
      deleteBranch: deleteBranchService,
      isGitRepository: isGitRepositoryService,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      bootstrapStore: worktreeBootstrapStore,
    });
    registerDevServerRoutes(app, { scanner: devServerScanner, getOwnPorts });
    magicPrompts = registerMagicPromptRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir,
      projectConfigRuntime,
      readSettingsFromDisk,
      sanitizeProjects,
      resolvePrimaryWorktreeRoot,
      resolveWorktreeTopLevel,
    });
    registerProjectContextRoutes(app, { projectContextRuntime });
    registerProjectDirectoryRoutes(app, {
      fsPromises,
      validateDirectoryPath,
      readSettingsFromDisk,
      sanitizeProjects,
      persistSettings,
    });
    registerProjectSetupRoutes(app, { projectConfigRuntime });
    registerAgentMemoryRoutes(app, { agentMemoryRuntime, isAgentMemoryEnabled });
    registerSessionKnowledgeRoutes(app, { sessionKnowledgeRuntime });
    registerMessageSearchRoutes(app, { messageSearchRuntime });
    registerSessionTodosRoutes(app, { sessionTodosRuntime });
    registerSessionWarmingRoutes(app, {
      sessionWarmingRuntime,
      setGlobalWarming: setWarmingEnabled,
      setGlobalWarmingDuration: setWarmingDuration,
    });

    registerSessionFoldersRoutes(app, sessionFoldersStore ? { store: sessionFoldersStore } : { fsPromises, path, openchamberDataDir });
    registerSessionDraftRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir,
      onChanged: (updatedAt) => {
        const clients = getOpenChamberEventClients();
        for (const client of clients) {
          try {
            writeSseEvent(client, { type: 'openchamber:session-drafts-changed', properties: { updatedAt } });
          } catch {
            clients.delete(client);
          }
        }
      },
    });
    const { resolveRipgrepBinary } = createRipgrepResolver({ fs, path, buildSearchPath: buildAugmentedPath });
    registerFsRoutes(app, {
      os,
      path,
      fsPromises,
      spawn,
      crypto,
      normalizeDirectoryPath,
      resolveProjectDirectory,
      buildAugmentedPath,
      resolveGitBinaryForSpawn,
      resolveRipgrepBinary,
      openchamberUserConfigRoot,
      cloneRepository: networkOperations.cloneRepository,
      managedChatsRoot,
      environmentRuntime,
      projectRealpath: (target) => new Promise((resolve, reject) => {
        fs.realpath(target, (error, resolved) => (error ? reject(error) : resolve(resolved)));
      }),
    });
    registerEnvironmentRoutes(app, { store: environmentStore, runtime: environmentRuntime, listProjects: listConfiguredProjects, readClaudeConfigDir: () => environmentRuntime.forClaudeQuota().CLAUDE_CONFIG_DIR, onClaudeConfigChanged: () => announceChange('openchamber:quota-credentials-changed') });
  };

  return {
    registerRoutes,
    hydrateBoundCheckout,
    createChangeRequestWorktree,
    publishRepositoryCredentialEndpoint: async () => { await gitRepositoryCredentialRuntime?.publish(); },
    stopFolderWatches: () => {
      folderWatches.stop();
      stopGuestPackageWatch();
      stopGuestPackageWatch = () => {};
    },
  };
};
