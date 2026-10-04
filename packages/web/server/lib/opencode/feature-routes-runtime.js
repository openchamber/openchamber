import { registerFsRoutes } from '../fs/routes.js';
import { registerQuotaRoutes } from '../quota/routes.js';
import { registerSmallModelRoutes } from '../small-model/routes.js';
import { registerWalkthroughRoutes } from '../walkthrough/routes.js';
import { registerSessionGoalRoutes } from '../session-goal/routes.js';
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
import { registerConfigEntityRoutes } from './config-entity-routes.js';
import { registerSettingsUtilityRoutes } from './core-routes.js';
import { registerProjectIconRoutes } from './project-icon-routes.js';
import { registerScheduledTaskRoutes } from '../scheduled-tasks/routes.js';
import { createTrackedItemsService } from '../tracked-items/service.js';
import { createProviderReadCache } from '../provider-read-cache/index.js';
import { createTrackedItemReaders } from '../tracked-items/readers.js';
import { createTrackedItemsPersistence } from '../tracked-items/persistence.js';
import { registerTrackedItemsRoutes } from '../tracked-items/routes.js';
import { registerOpenChamberSessionRoutes } from '../openchamber-sessions/routes.js';
import { registerOpenChamberControlRoutes } from '../openchamber-control/routes.js';
import { registerMarkdownImageGrantRoutes } from '../markdown-image-grants/routes.js';
import { registerSkillRoutes } from './skill-routes.js';
import { registerPluginRoutes } from './plugin-routes.js';
import { getNpmInfo, clearCache as clearNpmCache } from './npm-registry.js';
import { parseNpmSpec, parsePathSpec, isExactSemver } from './plugin-spec.js';
import { registerOpenCodeRoutes } from './routes.js';
import { getProviderSources, removeProviderConfig, upsertProviderConfig } from './providers.js';
import { getAgentSources, getAgentConfig, getAgentPermissions, createAgent, updateAgent, deleteAgent } from './agents.js';
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
import { SKILL_DIR, SKILL_SCOPE, readSkillSupportingFile, writeSkillSupportingFile, deleteSkillSupportingFile } from './shared.js';
import { getSkillSources, discoverSkills, mergeDiscoveredSkills, createSkill, updateSkill, deleteSkill, renameSkill, isManagedSkillPath } from './skills.js';
import { getCuratedSkillsSources } from '../skills-catalog/curated-sources.js';
import { getCacheKey, scanWithCache } from '../skills-catalog/cache.js';
import { parseSkillRepoSource } from '../skills-catalog/source.js';
import { scanSkillsRepository } from '../skills-catalog/scan.js';
import { installSkillsFromRepository } from '../skills-catalog/install.js';
import { fetchGitHubRepoMetas } from '../skills-catalog/github-meta.js';
import crypto from 'node:crypto';
import { getGitHubAuthByAccountId } from '../github/auth.js';
import { createSourceControlAuthStore } from '../gitlab/auth-storage.js';
import { refreshGitLabAccessToken, resolveGitLabClientId } from '../gitlab/device-flow.js';
import { createGitCredentialResolver, createHttpsCredentialReference, parseGitCredentialReference } from '../git/credential-resolver.js';
import { createGitRepositoryCredentialRuntime } from '../git/repository-credential-runtime.js';
import { managedSshCommand } from '../git/network-operations.js';
import { createNetworkOperations } from '../git/network-operations.js';
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

  let quotaProviders = null;
  const getQuotaProviders = async () => {
    if (!quotaProviders) {
      quotaProviders = await import('../quota/index.js');
    }
    return quotaProviders;
  };

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

  const registerRoutes = async (app, routeDependencies) => {
    const {
      messageSearchRuntime,
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
      sessionService: openChamberSessionService,
    });

    registerOpenChamberControlRoutes(app, { controlService: openChamberControlService });

    registerMarkdownImageGrantRoutes(app, {
      fsPromises,
      path,
      os,
      crypto,
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
    });

    registerQuotaRoutes(app, { getQuotaProviders });
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
    const resolveSourceControlAccount = ({ provider, instance, accountId, credentialRevision }) => provider === 'github'
      ? getGitHubAuthByAccountId(accountId, credentialRevision)
      : gitlabAuthStore.readAccount(instance, accountId, credentialRevision);
    const resolveTransportRepository = createPrivateRepositoryIdentityResolver({
      getTransportRevision: (directory) => readEffectiveGitTransportRevision(directory, { gitBinary }),
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
    const contributorProvenance = createContributorProvenanceStore({
      filePath: path.join(openchamberDataDir, 'git-contributor-provenance.json'),
      resolveRepositoryIdentity: resolveTransportRepository,
      resolveGitPaths: resolveRepositoryGitPaths,
      fsImpl: fsPromises,
    });
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
    });
    await registerBuiltInGuests({ persistPath: extensionsPersistPath(openchamberDataDir), root: routeDependencies.builtInExtensionsDir });
    registerGuestRoutes(app, { openchamberDataDir, openchamberVersion, resolveGitBinaryForSpawn, resolveOptionalProjectDirectory, getSmallModelService, onGuestDeactivated, surfaceViewerHeaders });
    registerGitRoutes(app, {
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
    registerLinearRoutes(app);
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

    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir,
    });
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
      openchamberUserConfigRoot,
      cloneRepository: networkOperations.cloneRepository,
      managedChatsRoot,
    });
  };

  return {
    registerRoutes,
    hydrateBoundCheckout,
    /** Writes the Git credential helper's endpoint file; a no-op until the Git routes are registered. */
    publishRepositoryCredentialEndpoint: async () => { await gitRepositoryCredentialRuntime?.publish(); },
  };
};
