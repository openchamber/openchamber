import { registerNotificationEmitRoutes } from '../notifications/emit-route.js';
import { registerHttpResponseDiagnostics } from './core-routes.js';
import type {
  AuthAndAccessDependencies,
  CommonRequestDependencies,
  ServerStatusDependencies,
  registerAuthAndAccessRoutes,
  registerCommonRequestMiddleware,
  registerServerStatusRoutes,
} from './core-routes.js';
import type { Application, ExpressFactory } from '../shared/http-contracts.js';
import type { createAgentToolRuntime } from '../agent-tool/runtime.js';
import type { createLimitFailoverRuntime } from '../limit-failover/runtime.js';
import type { registerNotificationRoutes } from '../notifications/routes.js';
import type { OpenChamberRouteDependencies, registerOpenChamberRoutes } from '../self-update/openchamber-routes.js';
import type { SayTtsCapability } from '../tts/capability-runtime.js';
import type { createUiAuth } from '../ui-auth/ui-auth.js';

type AgentTool = Pick<ReturnType<typeof createAgentToolRuntime>, 'authorizeRequest' | 'registerRoutes'>;
type Notifications = Parameters<typeof registerNotificationRoutes>[1];
type SessionSnapshots = Pick<Notifications, 'getSessionActivitySnapshot' | 'getSessionStateSnapshot' |
  'getPendingBlockingRequestsSnapshot' | 'getSessionContextSnapshot' | 'getSessionState'>;
type SayTtsDependencies = { sayTTSCapability: Promise<SayTtsCapability> };

interface BootstrapDependencies {
  createUiAuth: typeof createUiAuth;
  registerServerStatusRoutes: typeof registerServerStatusRoutes;
  registerCommonRequestMiddleware: typeof registerCommonRequestMiddleware;
  registerAuthAndAccessRoutes: typeof registerAuthAndAccessRoutes;
  registerTtsRoutes: (app: Application, dependencies: SayTtsDependencies) => void;
  registerNotificationRoutes: typeof registerNotificationRoutes;
  registerOpenChamberRoutes: typeof registerOpenChamberRoutes;
  registerAgentToolRoutes?: (app: Application, dependencies: { express: ExpressFactory; agentToolRuntime: AgentTool }) => void;
  express: ExpressFactory;
}

type BaseRoutesOptions =
  & Required<Omit<ServerStatusDependencies, 'express' | 'uiAuthController' | 'tunnelAuthController'>>
  & Required<Omit<AuthAndAccessDependencies, 'express' | 'uiAuthController'>>
  & Required<Omit<CommonRequestDependencies, 'express'>>
  & Required<Omit<Notifications, 'uiAuthController' | keyof SessionSnapshots>>
  & Required<Omit<OpenChamberRouteDependencies, 'desktopUpdater'>>
  & { desktopUpdater: OpenChamberRouteDependencies['desktopUpdater'] }
  & SayTtsDependencies
  & {
    uiPassword: string | null;
    sessionRuntime: Required<SessionSnapshots>;
    agentToolRuntime: AgentTool;
    limitFailoverRuntime: Pick<ReturnType<typeof createLimitFailoverRuntime>, 'registerRoutes'> | null;
    pluginNotificationEmitter: Parameters<typeof registerNotificationEmitRoutes>[1]['emitter'];
  };

export const createBootstrapRuntime = (dependencies: BootstrapDependencies) => {
  const {
    createUiAuth,
    registerServerStatusRoutes,
    registerCommonRequestMiddleware,
    registerAuthAndAccessRoutes,
    registerTtsRoutes,
    registerNotificationRoutes,
    registerOpenChamberRoutes,
    registerAgentToolRoutes = () => {},
    express,
  } = dependencies;

  const setupBaseRoutes = (app: Application, options: BaseRoutesOptions) => {
    const {
      process,
      openchamberVersion,
      runtimeName,
      serverStartedAt,
      gracefulShutdown,
      getHealthSnapshot,
      readOpenCodeLoad,
      getServerPort,
      getTunnelUrl,
      verboseRequestLogs,
      uiPassword,
      tunnelAuthController,
      remoteClientAuthRuntime,
      clientPairingRuntime,
      getRelayPairingCandidate,
      reconcileRelay,
      removeClientPushDevices,
      getPairingTransports,
      getDirectCandidateUrls,
      getServerId,
      getServerLabel,
      readSettingsFromDiskMigrated,
      normalizeTunnelSessionTtlMs,
      sayTTSCapability,
      ensurePushInitialized,
      ensureGlobalWatcherStarted,
      getOrCreateVapidKeys,
      getUiSessionTokenFromRequest,
      writeSettingsToDisk,
      addOrUpdatePushSubscription,
      removePushSubscription,
      addOrUpdateApnsToken,
      removeApnsToken,
      updateUiVisibility,
      clearPendingPushBadge,
      clearSessionPushNotifications,
      isUiVisible,
      getUiNotificationClients,
      writeSseEvent,
      sessionRuntime,
      setPushInitialized,
      fs,
      os,
      path,
      server,
      cliEntry,
      openchamberDataDir,
      modelsDevApiUrl,
      modelsMetadataCacheTtl,
      fetchFreeZenModels,
      getCachedZenModels,
      setAutoAcceptSession,
      isLocalOnlyPushRequest,
      agentToolRuntime,
      limitFailoverRuntime,
      pluginNotificationEmitter,
      desktopUpdater,
      getOpenCodeCompatibility,
      skipBodyParsing,
    } = options;

    registerHttpResponseDiagnostics(app);

    const uiAuthController = createUiAuth({
      password: uiPassword,
      readSettingsFromDiskMigrated,
      clientAuthController: remoteClientAuthRuntime,
    });
    if (uiAuthController.enabled) {
      console.log('UI password protection enabled for browser sessions');
    }

    registerServerStatusRoutes(app, {
      express,
      process,
      openchamberVersion,
      runtimeName,
      serverStartedAt,
      gracefulShutdown,
      getHealthSnapshot,
      getServerId,
      getServerPort,
      getTunnelUrl,
      tunnelAuthController,
      uiAuthController,
      readOpenCodeLoad,
    });

    registerCommonRequestMiddleware(app, { express, verboseRequestLogs, skipBodyParsing });

    registerAgentToolRoutes(app, { express, agentToolRuntime });
    limitFailoverRuntime?.registerRoutes(app, express);

    const notificationEmitRoutes = registerNotificationEmitRoutes(app, {
      express,
      isAgentToolRequestAuthorized: (req) => agentToolRuntime?.authorizeRequest?.(req) === true,
      emitter: pluginNotificationEmitter,
    });
    notificationEmitRoutes.registerPluginRoute();

    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController,
      uiAuthController,
      remoteClientAuthRuntime,
      clientPairingRuntime,
      getRelayPairingCandidate,
      reconcileRelay,
      removeClientPushDevices,
      getPairingTransports,
      getDirectCandidateUrls,
      getServerId,
      getServerLabel,
      readSettingsFromDiskMigrated,
      normalizeTunnelSessionTtlMs,
    });

    notificationEmitRoutes.registerApiRoute();

    registerTtsRoutes(app, { sayTTSCapability });

    registerNotificationRoutes(app, {
      uiAuthController,
      ensurePushInitialized,
      ensureGlobalWatcherStarted,
      getOrCreateVapidKeys,
      getUiSessionTokenFromRequest,
      readSettingsFromDiskMigrated,
      writeSettingsToDisk,
      addOrUpdatePushSubscription,
      removePushSubscription,
      addOrUpdateApnsToken,
      removeApnsToken,
      updateUiVisibility,
      clearPendingPushBadge,
      clearSessionPushNotifications,
      isUiVisible,
      getUiNotificationClients,
      writeSseEvent,
      getSessionActivitySnapshot: sessionRuntime.getSessionActivitySnapshot,
      getSessionStateSnapshot: sessionRuntime.getSessionStateSnapshot,
      getPendingBlockingRequestsSnapshot: sessionRuntime.getPendingBlockingRequestsSnapshot,
      getSessionContextSnapshot: sessionRuntime.getSessionContextSnapshot,
      getSessionState: sessionRuntime.getSessionState,
      setPushInitialized,
      setAutoAcceptSession,
      isLocalOnlyPushRequest,
    });

    registerOpenChamberRoutes(app, {
      fs,
      os,
      path,
      process,
      server,
      cliEntry,
      openchamberDataDir,
      modelsDevApiUrl,
      modelsMetadataCacheTtl,
      readSettingsFromDiskMigrated,
      fetchFreeZenModels,
      getCachedZenModels,
      desktopUpdater,
      getOpenCodeCompatibility,
    });

    return {
      uiAuthController,
    };
  };

  return {
    setupBaseRoutes,
  };
};
