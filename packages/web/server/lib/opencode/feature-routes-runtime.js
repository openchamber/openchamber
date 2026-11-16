import { registerFsRoutes } from '../fs/routes.js';
import { DEFAULT_PULL_REQUEST_BRANCH_TEMPLATE, branchNameFromTemplate, uniqueBranchName } from '../git/branch-name-template.js';
import { createRipgrepResolver } from '../fs/ripgrep.js';
import { registerEnvironmentRoutes } from '../environment/routes.js';
import { registerQuotaRoutes } from '../quota/routes.js';
import { registerSmallModelRoutes } from '../small-model/routes.js';
import { registerWalkthroughRoutes } from '../walkthrough/routes.js';
import { registerSessionGoalRoutes } from '../session-goal/routes.js';
import { registerSessionWarmingRoutes } from '../session-warming/routes.js';
import { setWarmingDuration, setWarmingEnabled } from './websearch-config.js';
import { registerSourceControlRoutes } from '../source-control/routes.js';
import { registerLinearRoutes } from '../linear/routes.js';
import { registerGuestRoutes } from '../guests/routes.js';
import { registerBuiltInGuests } from '../guests/catalog.js';
import { extensionsPersistPath } from '../guests/persist.js';
import { registerGitRoutes } from '../git/routes.js';
import { registerDevServerRoutes } from '../dev-servers/routes.js';
import { registerMagicPromptRoutes } from '../magic-prompts/routes.js';
import { registerSessionFoldersRoutes } from '../session-folders/routes.js';
import { registerProjectContextRoutes } from '../project-context/routes.js';
import { registerProjectDirectoryRoutes, registerProjectSetupRoutes } from '../projects/routes.js';
import { registerAgentMemoryRoutes } from '../agent-memory/routes.js';
import { registerSessionKnowledgeRoutes } from '../session-knowledge/routes.js';
import { registerMessageSearchRoutes } from '../message-search/routes.js';
import { registerPermissionAutoAcceptRoutes } from '../permission-auto-accept/runtime.js';
import { registerMessageQueueRoutes } from '../message-queue/runtime.js';
import { registerRoutingPromptRewrite, registerRoutingRoutes } from '../routing/routes.js';
import { registerModelRouteRoutes } from '../routing/model-routes.js';
import { registerModelRouteStatsRoutes } from '../routing/model-route-stats.js';
import { registerMessageModelAttributionRoutes } from '../routing/message-model-attribution.js';
import { registerPlanRoutes } from '../routing/plan-routes.js';
import { registerPoolPlanLinkRoutes } from '../routing/pool-plan-links.js';
import { isLocalOpenCode, registerPoolHealthRoutes } from '../routing/pool-health.js';
import { registerRouteRulesRoutes } from '../routing/route-rules-routes.js';
import { createJevClient } from '../routing/jev.js';
import { isEnterpriseMode } from '../enterprise-mode.js';
import { registerConfigEntityRoutes } from './config-entity-routes.js';
import { registerSettingsUtilityRoutes } from './core-routes.js';
import { registerProjectIconRoutes } from './project-icon-routes.js';
import { registerScheduledTaskRoutes } from '../scheduled-tasks/routes.js';
import { createScheduledTaskRunHistory } from '../scheduled-tasks/run-history.js';
import { createTrackedItemsService } from '../tracked-items/service.js';
import { createProviderReadCache } from '../provider-read-cache/index.js';
import { createTrackedItemReaders } from '../tracked-items/readers.js';
import { createTrackedItemsPersistence } from '../tracked-items/persistence.js';
import { registerTrackedItemsRoutes } from '../tracked-items/routes.js';
import { registerOpenChamberSessionRoutes } from '../openchamber-sessions/routes.js';
import { registerOpenChamberControlRoutes } from '../openchamber-control/routes.js';
import { registerDeviceSettingsRoutes } from '../device-settings/routes.js';
import { registerModelChoiceRoutes } from '../model-choices/routes.js';
import { registerMarkdownImageGrantRoutes } from '../markdown-image-grants/routes.js';
import { registerSkillRoutes } from './skill-routes.js';
import { registerPluginRoutes } from './plugin-routes.js';
import { getNpmInfo } from './npm-registry.js';
import { parseNpmSpec, parsePathSpec, isExactSemver } from './plugin-spec.js';
import { registerOpenCodeRoutes } from './routes.js';
import { getProviderSources, removeProviderConfig, upsertProviderConfig } from './providers.js';
import { getAgentSources, getAgentConfig, getAgentPermissions, createAgent, updateAgent, deleteAgent, listDisabledAgents } from './agents.js';
import { getCommandSources, getCommandConfig, createCommand, updateCommand, deleteCommand } from './commands.js';
import { listMcpConfigs, getMcpConfig, createMcpConfig, updateMcpConfig, deleteMcpConfig } from './mcp.js';
import { listSnippets, getSnippet, createSnippet, updateSnippet, deleteSnippet, expandSnippets } from './snippets.js';
import {
  listPluginEntries,
  getPluginEntry,
  createPluginEntry,
  updatePluginEntry,
  deletePluginEntry,
  listPluginDirFiles,
  readPluginDirFile,
  writePluginDirFile,
  deletePluginDirFile,
  encodePluginId,
  decodePluginId,
} from './plugins.js';
import { SKILL_DIR, SKILL_SCOPE, readSkillSupportingFile, writeSkillSupportingFile, deleteSkillSupportingFile, readConfigLayers, readConfigSources, getConfigForPath, writeConfig, CONFIG_FILE } from './shared.js';
import { getSkillSources, discoverSkills, mergeDiscoveredSkills, createSkill, updateSkill, deleteSkill, renameSkill, isManagedSkillPath } from './skills.js';
import { getCuratedSkillsSources } from '../skills-catalog/curated-sources.js';
import { getCacheKey, scanWithCache } from '../skills-catalog/cache.js';
import { parseSkillRepoSource } from '../skills-catalog/source.js';
import { scanSkillsRepository } from '../skills-catalog/scan.js';
import { installSkillsFromRepository } from '../skills-catalog/install.js';
import { fetchGitHubRepoMetas } from '../skills-catalog/github-meta.js';
import crypto from 'node:crypto';
import { getGitHubAuthByAccountId } from '../github/auth.js';
import { getGitHubCliCredential } from '../github/octokit.js';
import { createSourceControlAuthStore } from '../gitlab/auth-storage.js';
import { refreshGitLabAccessToken, resolveGitLabClientId } from '../gitlab/device-flow.js';
import { createGitCredentialResolver, createHttpsCredentialReference, parseGitCredentialReference } from '../git/credential-resolver.js';
import { createGitRepositoryCredentialRuntime } from '../git/repository-credential-runtime.js';
import { managedSshCommand } from '../git/network-operations.js';
import { createNetworkOperations, createTrustedDirectoriesConfig } from '../git/network-operations.js';
import { createManagedSshCredentialStore } from '../git/ssh-credential-storage.js';
import { createManagedSshInventory } from '../git/credentials.js';
import { createContributorProvenanceStore } from '../git/contributor-provenance-storage.js';
import { createGitNetworkOperationStore } from '../git/network-operation-storage.js';
import { readEffectiveGitTransportRevision } from '../git/transport-config.js';
import { completeWorktreeCheckoutHydration, configureRepositoryTransport } from '../git/service.js';
import { createPrivateRepositoryIdentityResolver } from '../source-control/repository-identity.js';
import { createSourceControlAuditStore } from '../source-control/audit-storage.js';

export const createFeatureRoutesRuntime = (dependencies) => {
  const {
    clientReloadDelayMs,
  } = dependencies;
  const gitRuntimeIdentity = Object.freeze({
    id: `server_${crypto.randomUUID()}`,
    platform: process.env.OPENCHAMBER_RUNTIME === 'desktop' ? 'desktop' : 'web',
  });

  let smallModelService = null;
  const getSmallModelService = async () => {
    if (!smallModelService) {
      smallModelService = await import('../small-model/index.js');
    }
    return smallModelService;
  };

  let walkthroughService = null;
  let walkthroughBindingService = null;
  let gitRepositoryCredentialRuntime = null;
  let networkOperations = null;
  let gitWorktreeCreation = null;
  let guestOperations = null;
  let scheduledTaskRunHistory = null;
  let linearOperations = null;
  const getWalkthroughService = async () => {
    if (!walkthroughService) {
      const [service, pullRequest] = await Promise.all([
        import('../walkthrough/index.js'),
        import('../walkthrough/pull-request.js'),
      ]);
      walkthroughService = {
        ...service,
        // Forward only the request options by name: the remaining slots are
        // dependency overrides and must not be reachable from a route.
        getPullRequestDiff: (directory, number, readContext, { allowEmpty, sourceRepo } = {}) => pullRequest.getPullRequestDiff(
          directory,
          number,
          readContext,
          {
            allowEmpty,
            sourceRepo,
            onAccountUnavailable: walkthroughBindingService?.accountUnavailable,
            readGitLabChangeRequestPatch: walkthroughBindingService?.readGitLabChangeRequestPatch,
          },
        ),
        getPullRequestFileContents: (directory, number, readContext, { path, previousPath, status, sourceRepo }) => pullRequest.getPullRequestFileContents(
          directory,
          number,
          readContext,
          {
            path,
            previousPath,
            status,
            sourceRepo,
            onAccountUnavailable: walkthroughBindingService?.accountUnavailable,
            readGitLabChangeRequestFile: walkthroughBindingService?.readGitLabChangeRequestFile,
          },
        ),
      };
    }
    return walkthroughService;
  };

  const hydrateBoundCheckout = async ({ directory, parentDirectory, parentRemoteName }) => {
    if (!(networkOperations?.hydrateBoundCheckout instanceof Function)
      || !(walkthroughBindingService?.get instanceof Function)) {
      throw Object.assign(new Error('Worktree checkout hydration is unavailable'), {
        code: 'RUNTIME_UNSUPPORTED',
      });
    }
    // An unbound repository hydrates through the machine's own Git for every
    // remote, the same way it pushes; its authority is the unbound revision.
    const bindingRead = await walkthroughBindingService.get(parentDirectory);
    const repositoryAuthority = {
      repositoryId: bindingRead.repository.repositoryId,
      bindingRevision: bindingRead.revision,
      configRevision: bindingRead.repository.configRevision,
    };
    return networkOperations.hydrateBoundCheckout({
      directory,
      parentRemoteName,
      repositoryAuthority,
    });
  };

  /**
   * A worktree from a pull or merge request given by number, the same kind
   * the New worktree dialog makes: the server reads the change request with
   * the project's own account and creates the worktree through the Git
   * routes' contributor pipeline. It checks out the request's branch, or with
   * `branchOff` starts a new branch from its head. `branchName` defaults to
   * the head branch, or for a new branch to `branchTemplate` filled with
   * `name` (else the head branch), the number and the head, past any of
   * `existingBranches` that has it; `name` defaults to the branch.
   */
  const createChangeRequestWorktree = async ({
    directory,
    number,
    name,
    branchName,
    branchOff = false,
    branchTemplate = DEFAULT_PULL_REQUEST_BRANCH_TEMPLATE,
    existingBranches = new Set(),
  }) => {
    if (!(gitWorktreeCreation?.createWorktree instanceof Function)
      || !(walkthroughBindingService?.resolveChangeRequestWorktreeSource instanceof Function)) {
      throw Object.assign(new Error('Worktrees from pull requests are unavailable'), {
        code: 'RUNTIME_UNSUPPORTED', status: 501,
      });
    }
    const { headBranch, sourceRequest } = await walkthroughBindingService.resolveChangeRequestWorktreeSource({ directory, number });
    const branch = branchName || (branchOff
      ? uniqueBranchName(branchNameFromTemplate(branchTemplate, { name: name || headBranch, pr: number, head: headBranch }), existingBranches)
      : headBranch);
    return gitWorktreeCreation.createWorktree(directory, {
      mode: branchOff ? 'new' : 'existing',
      branchName: branch,
      worktreeName: name || branch,
      changeRequestSource: sourceRequest,
    });
  };

  const registerRoutes = async (app, routeDependencies) => {
    const {
      messageSearchRuntime,
      sessionWarmingRuntime,
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
      surfaceViewerHeaders,
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
      readSettingsFromDisk,
      readSettingsFromDiskMigrated,
      persistSettings,
      sanitizeProjects,
      sanitizeSkillCatalogs,
      isUnsafeSkillRelativePath,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      getOpenCodePort,
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
      deviceSettingsStore,
      modelChoiceService,
      waitForOpenCodeReady,
      getOpenChamberEventClients,
      writeSseEvent,
      emitSessionCreatedEvent,
      permissionAutoAcceptRuntime,
      worktreeBootstrapStore,
      messageQueueRuntime,
      routingRuntime,
      globalEventHub,
      openchamberVersion,
    } = routeDependencies;

    registerSettingsUtilityRoutes(app, {
      readCustomThemesFromDisk,
      saveImportedTheme,
      deleteImportedTheme,
      refreshOpenCodeAfterConfigChange,
      clientReloadDelayMs,
    });

    registerPermissionAutoAcceptRoutes(app, permissionAutoAcceptRuntime);
    registerMessageQueueRoutes(app, messageQueueRuntime);
    registerRoutingRoutes(app, routingRuntime);
    registerModelRouteRoutes(app, {
      readConfigLayers,
      getConfigForPath,
      writeConfig,
      CONFIG_FILE,
      isEnterpriseMode,
      refreshOpenCodeAfterConfigChange,
      resolveOptionalProjectDirectory,
      readConfigSources,
    });
    registerModelRouteStatsRoutes(app, { isOpenCodeLocal: () => isLocalOpenCode(buildOpenCodeUrl) });
    registerMessageModelAttributionRoutes(app, { isOpenCodeLocal: () => isLocalOpenCode(buildOpenCodeUrl) });
    registerPlanRoutes(app);
    registerPoolPlanLinkRoutes(app, { openchamberDataDir });
    registerPoolHealthRoutes(app, { readConfigLayers, openchamberDataDir, isOpenCodeLocal: () => isLocalOpenCode(buildOpenCodeUrl) });
    registerRouteRulesRoutes(app, { routingRuntime, jev: createJevClient() });
    // Before the generic OpenCode proxy: swallows the `openchamber/auto` model
    // switch and routes the sends that follow it.
    registerRoutingPromptRewrite(app, routingRuntime);

    registerOpenCodeRoutes(app, {
      crypto,
      clientReloadDelayMs,
      getOpenCodeResolutionSnapshot,
      getOpenCodeUpgradeCapability,
      upgradeOpenCodeCli,
      getOpenCodeCompatibility,
      installOpenCodeV2,
      formatSettingsResponse,
      readSettingsFromDiskMigrated,
      persistSettings,
      resolveProjectDirectory,
      getProviderSources,
      removeProviderConfig,
      upsertProviderConfig,
      refreshOpenCodeAfterConfigChange,
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
      createFsSearchRuntime,
      spawn,
      resolveGitBinaryForSpawn,
    });

    if (!scheduledTaskRunHistory) {
      scheduledTaskRunHistory = createScheduledTaskRunHistory({
        filePath: path.join(openchamberDataDir, 'scheduled-task-run-history.jsonl'),
        logger: console,
      });
    }
    registerScheduledTaskRoutes(app, {
      readSettingsFromDiskMigrated,
      sanitizeProjects,
      projectConfigRuntime,
      scheduledTasksRuntime,
      scheduledTaskService,
      scheduledTaskRunHistory,
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
      sessionService: openChamberSessionService,
    });

    registerOpenChamberControlRoutes(app, { controlService: openChamberControlService });
    if (deviceSettingsStore) registerDeviceSettingsRoutes(app, { store: deviceSettingsStore });
    if (modelChoiceService) registerModelChoiceRoutes(app, { modelChoiceService });

    registerMarkdownImageGrantRoutes(app, {
      fsPromises,
      path,
      validateDirectoryPath,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
    });

    registerConfigEntityRoutes(app, {
      resolveProjectDirectory,
      resolveOptionalProjectDirectory,
      refreshOpenCodeAfterConfigChange,
      clientReloadDelayMs,
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
    });

    registerPluginRoutes(app, {
      resolveOptionalProjectDirectory,
      refreshOpenCodeAfterConfigChange,
      clientReloadDelayMs,
      listPluginEntries,
      getPluginEntry,
      createPluginEntry,
      updatePluginEntry,
      deletePluginEntry,
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
    });

    const { getProfiles, getProfile, getGlobalIdentity, resolveRepositoryGitPaths } = await import('../git/index.js');

    registerQuotaRoutes(app);
    registerSmallModelRoutes(app, { getSmallModelService });
    registerSessionGoalRoutes(app);
    const gitBinary = resolveGitBinaryForSpawn();
    const gitlabAuthStore = createSourceControlAuthStore({
      filePath: path.join(openchamberDataDir, 'source-control-auth.json'),
      // GitLab OAuth tokens live two hours; the store renews them before they lapse.
      refreshOAuthToken: async ({ origin, refreshToken }) => refreshGitLabAccessToken({
        origin, refreshToken, clientId: await resolveGitLabClientId(origin, readSettingsFromDisk),
      }),
    });
    // A GitHub account is either one OpenChamber stores or the gh CLI login
    // the user switched to; reads already accept both, so Git transport
    // (fork PR worktrees, clones) must too.
    const resolveSourceControlAccount = async ({ provider, instance, accountId, credentialRevision }) => {
      if (provider !== 'github') return gitlabAuthStore.readAccount(instance, accountId, credentialRevision);
      return await getGitHubAuthByAccountId(accountId, credentialRevision)
        ?? getGitHubCliCredential(accountId, credentialRevision);
    };
    const resolveTransportRepository = createPrivateRepositoryIdentityResolver({
      getTransportRevision: (directory) => readEffectiveGitTransportRevision(directory, { gitBinary }),
    });
    const contributorProvenance = createContributorProvenanceStore({
      filePath: path.join(openchamberDataDir, 'git-contributor-provenance.json'),
      resolveRepositoryIdentity: resolveTransportRepository,
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
    const managedSshInventory = createManagedSshInventory({
      store: sshCredentialStore,
      snapshotRoot: path.join(openchamberDataDir, 'git-ssh-operation-keys'),
      discoveryRoot: path.join(os.homedir(), '.ssh'),
      managedKeyRoot: path.join(openchamberDataDir, 'git-ssh-private-keys'),
      fsImpl: fsPromises,
    });
    // What a repository's own `.git/config` names for pushing and pulling
    // follows its grants: OpenChamber's credential helper for an account, the
    // SSH wrapper with the key for a managed key, nothing for System Git.
    const syncRepositoryTransport = async (directory, read) => {
      if (typeof directory !== 'string' || !directory.trim() || !gitRepositoryCredentialRuntime) return;
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
    // Shared short-lived answers for provider reads; registered before the
    // GitHub, GitLab and Linear routes it fronts.
    const providerReadCache = createProviderReadCache();
    app.use(providerReadCache.middleware);
    walkthroughBindingService = registerSourceControlRoutes(app, {
      onRepositoryTransportChanged: syncRepositoryTransport,
      validateManagedSshCredential: managedSshInventory.assertAvailable,
      readManagedSshCredentialPresentation: managedSshInventory.presentation,
      configRoot: openchamberDataDir,
      resolveTransportRepository,
      auditStore: sourceControlAuditStore,
      runtimeIdentity: gitRuntimeIdentity,
      readTransportAccount: resolveSourceControlAccount,
      resolveCheckoutAuxiliary: async ({ directory, parentEndpoint, parentRemoteName, kind, path: checkoutPath }) => {
        if (!(networkOperations?.inspectCheckoutHydration instanceof Function)) return null;
        const inspection = await networkOperations.inspectCheckoutHydration({
          directory, parentEndpoint, parentRemoteName,
        });
        return inspection.requirements.find((entry) => entry.kind === kind && entry.path === checkoutPath) ?? null;
      },
      github: {
        // A worktree made from a fork PR has no upstream; its provenance says
        // which remote the branch came from, so PR status can find the PR.
        readContributorProvenance: contributorProvenance.read,
      },
      gitlab: {
        configRoot: openchamberDataDir,
        store: gitlabAuthStore,
        readSettings: readSettingsFromDisk,
      },
    });
    registerWalkthroughRoutes(app, {
      getWalkthroughService,
      validateReadContext: walkthroughBindingService.validateReadContext,
    });
    // Live state of the linked pull requests, merge requests and issues the
    // clients show, refreshed here and pushed over the event stream.
    const findEventClient = (connectionId) => {
      for (const client of getOpenChamberEventClients()) {
        if (client.openchamberConnectionId === connectionId) return client;
      }
      return null;
    };
    const trackedItemsService = createTrackedItemsService({
      readers: createTrackedItemReaders({ readGitLabLiveSummaries: walkthroughBindingService.readGitLabLiveSummaries }),
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
    // A finished agent turn may have pushed a branch or opened a pull request.
    // Followed items refresh on the server; clients are told which directory
    // to look at again for branches that had no pull request. Bursts of idle
    // events around a turn boundary are coalesced per directory.
    const TURN_SETTLE_MS = 3000;
    const settlingDirectories = new Map();
    const announceTurnFinished = (directory) => {
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
    // The hub translates v2 wire events into the server's vocabulary once.
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
    const resolveGitIdentity = async (identityId) => {
      if (identityId === 'global') {
        const identity = await getGlobalIdentity();
        return identity?.userName && identity?.userEmail ? { userName: identity.userName, userEmail: identity.userEmail } : null;
      }
      const identity = getProfile(identityId);
      return identity?.userName && identity?.userEmail ? identity : null;
    };
    const validateGitIdentity = async (identityId) => {
      const profile = await resolveGitIdentity(identityId);
      if (!profile) throw new Error('Git identity profile is unavailable');
      return profile;
    };
    const networkOperationStore = createGitNetworkOperationStore({
      filePath: path.join(openchamberDataDir, 'git-network-operations.json'),
      fsImpl: fsPromises,
    });
    const gitCredentialResolver = createGitCredentialResolver({
      readGitHubAccount: (accountId, credentialRevision) => resolveSourceControlAccount({
        provider: 'github', instance: 'github.com', accountId, credentialRevision,
      }),
      readGitLabAccount: (instance, accountId, credentialRevision) => resolveSourceControlAccount({
        provider: 'gitlab', instance, accountId, credentialRevision,
      }),
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
      getOpenCodePort,
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
      readBinding: (directory) => walkthroughBindingService.get(directory),
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
      }),
      spawnImpl: spawn,
      fsImpl: fsPromises,
      pathImpl: path,
      gitBinary,
      validateGitIdentity,
      resolveGitIdentity,
      trustedDirectoriesConfig: createTrustedDirectoriesConfig({ gitBinary }),
    });
    await registerBuiltInGuests({ persistPath: extensionsPersistPath(openchamberDataDir), root: routeDependencies.builtInExtensionsDir });
    guestOperations = registerGuestRoutes(app, { openchamberDataDir, openchamberVersion, resolveGitBinaryForSpawn, resolveOptionalProjectDirectory, getSmallModelService, onGuestDeactivated, surfaceViewerHeaders });
    gitWorktreeCreation = registerGitRoutes(app, {
      // Identities for accounts connected before identities carried one are
      // made the first time identities are listed: a moment someone asked for,
      // not startup, where a development restart can kill a process holding a
      // provider store's lock.
      backfillIdentities: walkthroughBindingService.backfillConnectedIdentities,
      managedSshInventory,
      networkOperations,
      contributorProvenance,
      resolveChangeRequestSource: walkthroughBindingService.resolveChangeRequestSource,
      createHttpsCredentialReference,
      getSourceControlBinding: walkthroughBindingService.get,
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
    linearOperations = registerLinearRoutes(app);
    registerDevServerRoutes(app, { scanner: devServerScanner, getOwnPorts });
    registerMagicPromptRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir,
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
    registerSessionWarmingRoutes(app, {
      sessionWarmingRuntime,
      setGlobalWarming: setWarmingEnabled,
      setGlobalWarmingDuration: setWarmingDuration,
    });

    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir,
      // Folders are shared by every client of this server; each one reads
      // them again when told they changed.
      onChanged: (updatedAt) => {
        const clients = getOpenChamberEventClients();
        for (const client of clients) {
          try {
            writeSseEvent(client, { type: 'openchamber:session-folders-changed', properties: { updatedAt } });
          } catch {
            clients.delete(client);
          }
        }
      },
    });
    // Content search looks for ripgrep on the same PATH user commands get, so
    // a desktop app launched from the Dock still finds a Homebrew install.
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
    });
    registerEnvironmentRoutes(app, { store: environmentStore, runtime: environmentRuntime, listProjects: listConfiguredProjects });
  };

  return {
    registerRoutes,
    hydrateBoundCheckout,
    createChangeRequestWorktree,
    /**
     * The integration operations the routes use, for the `openchamber` agent
     * tool; null until the routes are registered.
     */
    getIntegrationOperations: () => (walkthroughBindingService && guestOperations && linearOperations
      ? {
          github: walkthroughBindingService.accountOperations.github,
          gitlab: walkthroughBindingService.accountOperations.gitlab,
          bindings: walkthroughBindingService.bindingOperations,
          linear: linearOperations,
          extensions: guestOperations,
        }
      : null),
    /** Writes the Git credential helper's endpoint file; a no-op until the Git routes are registered. */
    publishRepositoryCredentialEndpoint: async () => { await gitRepositoryCredentialRuntime?.publish(); },
    /** Records one scheduled-task run event into the durable run history (#2174 Gap 1); a no-op until the routes are registered. */
    recordScheduledTaskRun: (event) => { scheduledTaskRunHistory?.recordEvent(event); },
  };
};
