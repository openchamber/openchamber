import { installOpenCodeV2, supportsOpenCodeV2Install } from './lib/opencode/v2-install.js';
import { describeOpenCodeCompatibility, readOpenCodeCliVersion, readExternalOpenCodeVersion } from './lib/opencode/compatibility.js';
import 'reflect-metadata';
import express from 'express';
import { buildRestartNotification } from './lib/notifications/restart-notification.js';
import compression from 'compression';
import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import { webPackagePaths } from './lib/web-package-paths.js';
import { fileURLToPath } from 'url';
import os from 'os';
import crypto from 'crypto';
import http2 from 'node:http2';
import { createUiAuth, getBearerTokenFromRequest } from './lib/ui-auth/ui-auth.js';
import { createTunnelAuth } from './lib/tunnels/tunnel-auth.js';
import { createManagedTunnelConfigRuntime } from './lib/tunnels/managed-config.js';
import { createTunnelProviderRegistry } from './lib/tunnels/registry.js';
import { createCloudflareTunnelProvider } from './lib/tunnels/providers/cloudflare.js';
import { createNgrokTunnelProvider } from './lib/tunnels/providers/ngrok.js';
import { createTailscaleTunnelProvider } from './lib/tunnels/providers/tailscale.js';
import { allowsLocalDevOrigins, buildFrameAncestorsPolicy, createRequestSecurityRuntime, resolveClientCorsHeaders } from './lib/security/request-security.js';
import {
  getUnauthenticatedLanErrorMessage,
  isLoopbackBindHost,
  isNetworkExposedBindHost,
  isUnsafeUnauthenticatedLanAllowed,
  readAdvertisedLanUrl,
} from './lib/security/bind-host.js';
import { isEnterpriseMode, isNetworkAccessBlocked, NETWORK_ACCESS_BLOCKED_ERROR, readEnterprisePolicy, watchEnterprisePolicy } from './lib/enterprise-mode.js';
import {
  TUNNEL_MODE_MANAGED_LOCAL,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TunnelServiceError,
  isSupportedTunnelMode,
  normalizeOptionalPath,
  normalizeTunnelStartRequest,
  normalizeTunnelMode,
  normalizeTunnelProvider,
} from './lib/tunnels/types.js';
import { prepareNotificationLastMessage } from './lib/notifications/index.js';
import { registerTtsRoutes } from './lib/tts/routes.js';
import { detectSayTtsCapability } from './lib/tts/capability-runtime.js';
import { createTerminalRuntime } from './lib/terminal/runtime.js';
import { createDictationRuntime } from './lib/dictation/runtime.js';
import {
  createGlobalUiEventBroadcaster,
  translateWireEvent,
  createGlobalMessageStreamHub,
  createMessageStreamWsRuntime,
  resolveDeltaCoalesceWindowMs,
  DEFAULT_UPSTREAM_STALL_TIMEOUT_MS,
  UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS,
} from './lib/event-stream/index.js';
import { createFsSearchRuntime as createFsSearchRuntimeFactory } from './lib/fs/search.js';
import { createOpenCodeLifecycleRuntime, type OpenCodeLifecycleState } from './lib/opencode/lifecycle.js';
import { createOpenCodeEnvRuntime, type OpenCodeEnvState } from './lib/opencode/env-runtime.js';
import { providedLoginShellEnvSnapshot } from './lib/opencode/login-shell-env.js';
import { resolveOpenCodeEnvConfig, resolveProxyRequestTimeoutMs } from './lib/opencode/env-config.js';
import { createHmrStateRuntime } from './lib/opencode/hmr-state-runtime.js';
import { createOpenCodeNetworkRuntime } from './lib/opencode/network-runtime.js';
import { createOpenCodeAuthStateRuntime } from './lib/opencode/auth-state-runtime.js';
import { createProjectDirectoryRuntime } from './lib/projects/project-directory-runtime.js';
import { createServerCanonicalPaths } from './lib/settings/canonical-paths.js';
import { createSettingsNormalizationRuntime } from './lib/settings/settings-normalization-runtime.js';
import { createSettingsHelpers, isMessageSearchEnabled } from './lib/settings/settings-helpers.js';
import { createThemeRuntime } from './lib/appearance/theme-runtime.js';
import { createFeatureRoutesRuntime } from './lib/server-frame/feature-routes-runtime.js';
import { createPluginSwitchStore } from './lib/opencode/plugin-switches.js';
import { parseServeCliOptions } from './lib/server-frame/cli-options.js';
import {
  isRequestAuthorized,
  registerAuthAndAccessRoutes,
  registerCommonRequestMiddleware,
  registerServerStatusRoutes,
} from './lib/server-frame/core-routes.js';
import { registerOpenChamberRoutes } from './lib/self-update/openchamber-routes.js';
import { createServerUtilsRuntime } from './lib/server-frame/server-utils-runtime.js';
import { createMcpOAuthSignIn } from './lib/opencode/mcp-oauth.js';
import { getMcpConfig, listMcpConfigs, updateMcpConfig } from './lib/opencode/mcp.js';
import { createOpenCodeTrust } from './lib/opencode-trust/index.js';
import { registerSessionProjectRoutes } from './lib/projects/session-directory.js';
import { guardOpenCodeFetch } from './lib/opencode-trust/fetch-guard.js';
import { createStaticRoutesRuntime } from './lib/server-frame/static-routes-runtime.js';
import { createSettingsRuntime } from './lib/settings/settings-runtime.js';
import { createOpenCodeResolutionRuntime } from './lib/opencode/opencode-resolution-runtime.js';
import { runOpenCodeCliUpgrade } from './lib/opencode/cli-upgrade.js';
import { resolveOpenCodeUpgradeCapability } from './lib/opencode/upgrade-capability.js';
import { createBootstrapRuntime } from './lib/server-frame/bootstrap-runtime.js';
import { createSessionRuntime } from './lib/opencode/session-runtime.js';
import { configureOpenCodeRuntimeProviders, resetOpenCodeRuntimeProviders } from './lib/small-model/client.js';
import { configureOpenCodeCredentials, openCodeCredentialSource } from './lib/opencode/auth.js';
import { configureProjectStartCommandSource, openCodeProjectStartCommandSource } from './lib/opencode/project-start-command.js';
import { createOpenCodeWatcherRuntime } from './lib/opencode/watcher.js';
import { createTurnStartReader } from './lib/opencode/turn-start.js';
import { createSessionActivityProbe } from './lib/opencode/session-activity.js';
import { collectDesktopUpdateIdle, createDesktopUpdateActiveSessionReadiness } from './lib/desktop-update-idle-status.js';
import { createSessionAssistRuntime } from './lib/session-assist/runtime.js';
import { createSessionGoalRuntime } from './lib/session-goal/runtime.js';
import { createGoalPersistence } from './lib/session-goal/interruption.js';
import { createContextObligatoryRuntime } from './lib/context-obligatory/runtime.js';
import { createSessionWarmingRuntime } from './lib/session-warming/runtime.js';
import { createSessionTodosRuntime } from './lib/session-todos/runtime.js';
import { isSpaceDirectory } from './lib/spaces/dispatcher.js';
import { createTrackerRegistry } from './lib/trackers/registry.js';
import { createTrackerSessionStatus } from './lib/trackers/session-status.js';
import { sourceControlProviderDescriptors } from './lib/source-control/provider-descriptors.js';
import { measureMemoryIndex } from './lib/session-knowledge/runtime.js';
import { createManagedSessionKnowledgeRuntime } from './lib/session-knowledge/managed-runtime.js';
import { createSessionLeadServer } from './lib/session-lead/server.js';
import { createMemoryDreaming } from './lib/agent-memory/dreaming.js';
import { isAutoModel, JEV_BACKGROUND_TIMEOUT_MS } from './lib/routing/defaults.js';
import { createMessageSearchRuntime } from './lib/message-search/runtime.js';
import { applyOwnedArchiveState } from './lib/opencode/proxy.js';
import { createScheduledTasksRuntime } from './lib/scheduled-tasks/runtime.js';
import { createReadSessionDefaults, resolveSessionDefaults } from './lib/scheduled-tasks/session-defaults.js';
import { createChatsScope } from './lib/scheduled-tasks/chats-scope.js';
import { createChatDirectoryCleanupRuntime } from './lib/chat-directories/runtime.js';
import { createUnregisteredScheduledWorktreeBridge } from './lib/scheduled-tasks/worktree-bridge.js';
import { createServerStartupRuntime } from './lib/server-frame/server-startup-runtime.js';
import { createTunnelWiringRuntime, type TunnelWiringDependencies } from './lib/tunnels/tunnel-wiring-runtime.js';
import { createStartupPipelineRuntime } from './lib/server-frame/startup-pipeline-runtime.js';
import { createHiddenSessionRegistry } from './lib/opencode/hidden-sessions.js';
import { createQuietCompaction } from './lib/event-stream/quiet-compaction.js';
import { runCliEntryIfMain } from './lib/server-frame/cli-entry-runtime.js';
import { registerNotificationRoutes } from './lib/notifications/routes.js';
import { createNotificationEmitterRuntime } from './lib/notifications/emitter-runtime.js';
import { createNotificationTriggerRuntime } from './lib/notifications/runtime.js';
import { createPushRuntime } from './lib/notifications/push-runtime.js';
import { createApnsRuntime } from './lib/notifications/apns-runtime.js';
import { createNotificationTemplateRuntime } from './lib/notifications/template-runtime.js';
import { createPermissionAutoAcceptRuntime } from './lib/permission-auto-accept/runtime.js';
import { createMessageQueueRuntime } from './lib/message-queue/runtime.js';
import { createAutoReviewRuntime } from './lib/auto-review/runtime.js';
import { createDispatchResultsRuntime } from './lib/dispatch-results/runtime.js';
import { createPrWatchRuntime } from './lib/pr-watch/runtime.js';
import { createExtensionWaitsRuntime } from './lib/extension-waits/runtime.js';
import { createLaterPages } from './lib/openchamber-control/later-pages.js';
import { createMergeFollowRuntime } from './lib/github/merge-follow.js';
import { createWorkflowAgentSessions } from './lib/workflows/agent-session.js';
import { createWorkflowRuntime, lightenWorkflowRun } from './lib/workflows/runtime.js';
import { createWorkflowRunStore } from './lib/workflows/store.js';
import { createSharePagesRuntime } from './lib/share-pages/runtime.js';
import { createSharePageStore } from './lib/share-pages/store.js';
import {
  createRelayShareSigner,
  createShareRelayClient,
  createShareViewerClient,
  isRelayBaseAllowed,
  isSharingAvailable,
  resolveShareRelayBase,
} from './lib/share-pages/relay-client.js';
import { allowedReceiveBases } from './lib/share-pages/received-link.js';
import { createReceivedPagesRuntime } from './lib/share-pages/received-runtime.js';
import { createReceivedPageStore } from './lib/share-pages/received-store.js';
import { registerReceivedPageRoutes, registerSharePageRoutes } from './lib/share-pages/routes.js';
import { createRoutingRuntime } from './lib/routing/runtime.js';
import { createJevClient } from './lib/routing/jev.js';
import { createSessionWorkRuntime } from './lib/session-work/runtime.js';
import { createSessionLineage } from './lib/session-lineage.js';
import { createGracefulShutdownRuntime } from './lib/server-frame/shutdown-runtime.js';
import { beginGuestServiceHost, beginGuestServiceShutdown, getServiceStatus, holdGuestService, onGuestServiceEnded, proxyGuestServiceRequest, stopAllGuestServices } from './lib/guests/service.js';
import { guestMarks } from './lib/guests/marks.js';
import { guestServiceRegistryDir } from './lib/guests/service-registry.js';
import { findInstalledGuest, listInstalledGuests, setGuestConfigurationNote } from './lib/guests/catalog.js';
import { createExtensionSessionEvents } from './lib/guests/session-events.js';
import { createGuestAgentContext } from './lib/guests/agent-context.js';
import { getGuestAuth, guestAuthPersistPath } from './lib/guests/auth-store.js';
import { createGuestInstructions } from './lib/guests/instructions.js';
import { createServiceHostApi } from './lib/guests/service-host-api.js';
import { createServiceLifetime } from './lib/guests/service-lifetime.js';
import { extensionsPersistPath } from './lib/guests/persist.js';
import { createGuestSurfaceRuntime } from './lib/guests/surface.js';
import { BROWSER_PROVIDER_IDLE_MS, NOTIFICATIONS_OUTBOUND_PATH } from '@openchamber/sdk';
import { setHostCallbackRoute } from './lib/guests/host-callback.js';
import { createOutboundHandles } from './lib/source-control/outbound-handles.js';
import { createNotificationChannelAccounts, notificationChannelsPersistPath } from './lib/notifications/channel-accounts.js';
import { createExtensionNotificationChannels } from './lib/notifications/extension-channels.js';
import { createProjectConfigRuntime } from './lib/projects/project-config.js';
import { ensureChatsDir, migrateLegacyUserDirs } from './lib/data-dir-migration.js';
import { createProjectContextRuntime } from './lib/project-context/runtime.js';
import { createAgentMemoryRuntime } from './lib/agent-memory/runtime.js';
import { createAgentMemoryActions } from './lib/agent-memory/actions.js';
import { createMemoryProjectResolver } from './lib/agent-memory/project-resolution.js';
import { createSpacesHost } from './lib/spaces/host.js';
import { createSpaceArchive } from './lib/spaces/space-archive.js';
import { readIdleStopSetting, startIdleStop } from './lib/spaces/idle-stop.js';
import { permissionDefaultOf, readSpacePermissionDefault } from './lib/spaces/space-permission-default.js';
import { createInsideSpaceTaskNaming, SPACE_TASK_TITLE_ROUTE } from './lib/spaces/task-title.js';
import { dockerHostOf } from './lib/spaces/places/ssh-host.js';
import { SPACE_IDLE_EXIT_CODE } from './lib/spaces/layout.js';
import { createSwitchController, registerSpaceRoutes } from './lib/spaces/routes.js';
import { getCheckedOutBranch, getWorktreeBootstrapGateStatus, getWorktrees, isWorktreeDirectoryPinned, readRenameableGeneratedBranch, renameGeneratedWorktreeBranch, resolvePrimaryWorktreeRoot } from './lib/git/service.js';
import { followRenamedSession, setLinkedTaskTitle } from './lib/git/task-title-session.js';
import { createEnvironmentStore } from './lib/environment/store.js';
import { configureIntegrateSessions, readProjectPaths } from './lib/git/integrate-sessions.js';
import { composeEnvironmentRuntime } from './lib/environment/composition.js';
import { readOpenCodeServiceEnv } from './lib/environment/opencode-service-env.js';
import { OPENCODE_CONFIG_DIR } from './lib/opencode/config-files.js';
import { createWorktreeBootstrapStore } from './lib/git/worktree-bootstrap-storage.js';
import { createRemoteClientAuthRuntime } from './lib/client-auth/remote-clients.js';
import { createClientPushAccess } from './lib/notifications/client-push-access.js';
import { createClientPairingRuntime } from './lib/client-auth/pairing.js';
import { attachRealtimeProxy } from './lib/realtime-proxy.js';
import { createRelayService, relayBlockedByEnterprise } from './lib/relay/service.js';
import { createRelayHostLock } from './lib/relay/host-lock.js';
import { createRelayKeyStore } from './lib/relay/key-store.js';
import { createAgentToolRuntime } from './lib/agent-tool/runtime.js';
import { createBrowserControlBroker } from './lib/browser-control/broker.js';
import { createBrowserClientEvents } from './lib/browser-control/client-events.js';
import { createBrowserControlRouter, type BrowserProviderReset } from './lib/browser-control/provider.js';
import { createDevServerScanner } from './lib/dev-servers/routes.js';
import { createDevTunnelRuntime } from './lib/dev-tunnel/runtime.js';
import { registerBrowserControlRoutes } from './lib/browser-control/routes.js';
import { createUploadStore, registerUploadRoute } from './lib/browser-control/uploads.js';
import { createManagedConfigRuntime, retireClaudePlugin } from './lib/opencode/managed-config-file.js';
import { createSharedOpenCodeServiceConnector, resolveServiceCliBinary } from './lib/opencode/shared-service.js';
import { createAdaptivePluginSwitchStore, createGlobalConfigPluginSwitchStore } from './lib/opencode/global-plugin-switches.js';
import { openCodePluginDelivery } from './lib/guests/opencode-plugin.js';
import { createSessionDirectoryCanonicalizer, relocateSessionsFromDriveTargets } from './lib/opencode/directory-canonicalization.js';
import { createLimitFailoverRuntime } from './lib/limit-failover/runtime.js';
import { prepareInstanceDir } from './lib/opencode/instance-dir.js';
import { createOpenChamberSessionService, type SessionCreatedEvent } from './lib/openchamber-sessions/routes.js';
import { createSessionMetadataStore, createOpenCodeSessionMetadata, type MetadataDecider, type MetadataReadOptions, type SessionMetadata } from './lib/openchamber-sessions/session-metadata-store.js';
import { createUnreadBaseline } from './lib/openchamber-sessions/unread-baseline.js';
import { createTurnDurationRecorder } from './lib/openchamber-sessions/turn-duration.js';
import { createOpenCodeClient } from './lib/openchamber-sessions/opencode-client.js';
import { createScheduledTaskService } from './lib/scheduled-tasks/service.js';
import { createModelCatalogReader } from './lib/scheduled-tasks/model-catalog.js';
import { createOpenChamberControlService, type ControlOptions, type SessionActionResult } from './lib/openchamber-control/service.js';
import { createSessionFoldersStore } from './lib/session-folders/store.js';
import { createPluginNotificationEmitter } from './lib/notifications/emit-route.js';
import { OpenChamberControlError } from './lib/openchamber-control/error.js';
import { createSessionLinker } from './lib/openchamber-sessions/session-link.js';
import { createFileOpenRequester } from './lib/openchamber-control/file-open.js';
import { createSavedSecrets, createSecretFiles } from './lib/openchamber-control/secret-request.js';
import { applyConnectAttemptTimeout } from './lib/network-defaults.js';
import { applyOutboundProxyFromEnv } from './lib/outbound-proxy.js';
import { applySystemCertificates } from './lib/system-ca.js';
import { readOpenCodeLoad } from './lib/diagnostics/opencode-load.js';
import type { Request, Response } from './lib/shared/http-contracts.js';
import type { StreamSocket } from './lib/event-stream/contracts.js';
import type { ScheduledTaskEventClient } from './lib/scheduled-tasks/routes.js';
import { isBoolean, isRecord, isString } from './lib/shared/object-guards.js';
import type { JsonValue } from './lib/shared/json-values.js';
import type { ForwardEventPayload } from './lib/event-stream/contracts.js';
import type { TranslatedEvent } from './lib/event-stream/translate-v2.js';
import type { MemoryChangedEvent } from './lib/agent-memory/contracts.js';
import type { ControlInput, SessionReadAction, SessionReadResults } from './lib/openchamber-control/contracts.js';

type BootstrapResult = ReturnType<ReturnType<typeof createBootstrapRuntime>['setupBaseRoutes']>;
type StartupPipelineInput = Parameters<ReturnType<typeof createStartupPipelineRuntime>['run']>[0];
type StartupPipelineResult = Awaited<ReturnType<ReturnType<typeof createStartupPipelineRuntime>['run']>>;
type BootstrapInput = Parameters<ReturnType<typeof createBootstrapRuntime>['setupBaseRoutes']>[1];

interface ScheduledTaskRanProperties {
  projectId: string;
  taskId: string;
  ranAt: number;
  status: string;
  sessionId?: string;
}

interface SessionCreatedProperties {
  sessionId: string;
  directory: string;
  createdAt: number;
  promptDispatched: boolean;
  dispatchedAsCommand: boolean;
  projectId?: string;
  title?: string;
}

interface WebUiServerOptions {
  port?: number | undefined;
  host?: string | undefined;
  uiPassword?: string | null | undefined;
  tryCfTunnel?: boolean | undefined;
  apiOnly?: boolean | undefined;
  tunnelMode?: string | undefined;
  tunnelProvider?: string | undefined;
  tunnelConfigPath?: string | null | undefined;
  tunnelToken?: string | undefined;
  tunnelHostname?: string | undefined;
  attachSignals?: boolean | undefined;
  exitOnShutdown?: boolean | undefined;
  onTunnelReady?: StartupPipelineInput['onTunnelReady'] | undefined;
  onDesktopNotification?: Parameters<ReturnType<typeof createNotificationEmitterRuntime>['setOnDesktopNotification']>[0] | undefined;
  getIsWindowFocused?: Parameters<ReturnType<typeof createNotificationTriggerRuntime>['setGetIsWindowFocused']>[0] | undefined;
  getDesktopRuntimeConfig?: Parameters<typeof attachRealtimeProxy>[0]['getDesktopRuntimeConfig'] | undefined;
  desktopUpdater?: BootstrapInput['desktopUpdater'] | undefined;
  builtInExtensionsDir?: string | undefined;
}

applyConnectAttemptTimeout();
applySystemCertificates();
applyOutboundProxyFromEnv();

const DEFAULT_PORT = 3000;
const DESKTOP_NOTIFY_PREFIX = '[OpenChamberDesktopNotify] ';
const uiNotificationClients = new Set<Response>();
const uiNotificationWsClients = new Set<StreamSocket>();
const uiOpenChamberEventClients = new Set<ScheduledTaskEventClient>();
const HEALTH_CHECK_INTERVAL = 15000;
const SHUTDOWN_TIMEOUT = 10000;
const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const MODELS_METADATA_CACHE_TTL = 5 * 60 * 1000;
const CLIENT_RELOAD_DELAY_MS = 800;
const OPEN_CODE_READY_GRACE_MS = 12000;
const LONG_REQUEST_TIMEOUT_MS = resolveProxyRequestTimeoutMs(process.env, console);
const TUNNEL_BOOTSTRAP_TTL_DEFAULT_MS = 30 * 60 * 1000;
const TUNNEL_BOOTSTRAP_TTL_MIN_MS = 60 * 1000;
const TUNNEL_BOOTSTRAP_TTL_MAX_MS = 24 * 60 * 60 * 1000;
const TUNNEL_SESSION_TTL_DEFAULT_MS = 8 * 60 * 60 * 1000;
const TUNNEL_SESSION_TTL_MIN_MS = 5 * 60 * 1000;
const TUNNEL_SESSION_TTL_MAX_MS = 30 * 24 * 60 * 60 * 1000;

const isNumber = (value: unknown): value is number => typeof value === 'number';
const isCallback = <Callback extends (...args: never[]) => void>(value: Callback | null | undefined): value is Callback => typeof value === 'function';

function headerIncludesEventStream(value: string | number | readonly string[] | undefined) {
  if (isString(value)) {
    return value.toLowerCase().includes('text/event-stream');
  }

  if (Array.isArray(value)) {
    return value.some((entry) => isString(entry) && entry.toLowerCase().includes('text/event-stream'));
  }

  return false;
}

const SSE_PATH_PREFIXES = [
  '/api/event',
  '/api/global/event',
  '/api/notifications/stream',
  '/api/openchamber/events',
  '/api/openchamber/realtime-proxy/sse',
];

function shouldSkipCompression(req: Request, res: Response) {
  if (process.env.OPENCHAMBER_RUNTIME === 'desktop') {
    return true;
  }

  if (headerIncludesEventStream(req.headers.accept)) {
    return true;
  }

  const pathname = req.path || req.url || '';
  if ((pathname === '/api' || pathname.startsWith('/api/')) && shouldSkipApiCompression()) {
    return true;
  }

  for (const prefix of SSE_PATH_PREFIXES) {
    if (pathname === prefix) {
      return true;
    }
  }

  return headerIncludesEventStream(res.getHeader('Content-Type'));
}

const OPENCHAMBER_VERSION = (() => {
  try {
    const packagePath = webPackagePaths.packageJson;
    const raw = fs.readFileSync(packagePath, 'utf8');
    const pkg: unknown = JSON.parse(raw);
    if (isRecord(pkg) && isString(pkg.version) && pkg.version.trim().length > 0) {
      return pkg.version.trim();
    }
  } catch {
    return 'unknown';
  }
  return 'unknown';
})();

const isEnvFlagEnabled = (value: string | boolean | number | undefined) => {
  if (value === true || value === 1) return true;
  if (!isString(value)) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
};

const isEnvFlagDisabled = (value: string | boolean | number | undefined) => {
  if (value === false || value === 0) return true;
  if (!isString(value)) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '0' || normalized === 'false';
};

const shouldSkipApiCompression = () => {
  if (isEnvFlagEnabled(process.env.OPENCHAMBER_SKIP_API_COMPRESSION)) return true;
  if (isEnvFlagEnabled(process.env.OPENCHAMBER_COMPRESS_API)) return false;
  if (isEnvFlagDisabled(process.env.OPENCHAMBER_COMPRESS_API)) return true;
  return process.env.OPENCHAMBER_RUNTIME === 'desktop';
};

const OPENCHAMBER_VERBOSE_REQUEST_LOGS = isEnvFlagEnabled(process.env.OPENCHAMBER_VERBOSE_REQUEST_LOGS);

const fsPromises = fs.promises;

const settingsNormalizationRuntime = createSettingsNormalizationRuntime({
  os,
  path,
  processLike: process,
  canonicalPaths: createServerCanonicalPaths(),
  tunnelBootstrapTtlDefaultMs: TUNNEL_BOOTSTRAP_TTL_DEFAULT_MS,
  tunnelBootstrapTtlMinMs: TUNNEL_BOOTSTRAP_TTL_MIN_MS,
  tunnelBootstrapTtlMaxMs: TUNNEL_BOOTSTRAP_TTL_MAX_MS,
  tunnelSessionTtlDefaultMs: TUNNEL_SESSION_TTL_DEFAULT_MS,
  tunnelSessionTtlMinMs: TUNNEL_SESSION_TTL_MIN_MS,
  tunnelSessionTtlMaxMs: TUNNEL_SESSION_TTL_MAX_MS,
});

const normalizeDirectoryPath: typeof settingsNormalizationRuntime.normalizeDirectoryPath = (...args) => settingsNormalizationRuntime.normalizeDirectoryPath(...args);
const normalizePathForPersistence: typeof settingsNormalizationRuntime.normalizePathForPersistence = (...args) => settingsNormalizationRuntime.normalizePathForPersistence(...args);
const normalizeSettingsPaths: typeof settingsNormalizationRuntime.normalizeSettingsPaths = (...args) => settingsNormalizationRuntime.normalizeSettingsPaths(...args);
const normalizeTunnelBootstrapTtlMs: typeof settingsNormalizationRuntime.normalizeTunnelBootstrapTtlMs = (...args) => settingsNormalizationRuntime.normalizeTunnelBootstrapTtlMs(...args);
const normalizeTunnelSessionTtlMs: typeof settingsNormalizationRuntime.normalizeTunnelSessionTtlMs = (...args) => settingsNormalizationRuntime.normalizeTunnelSessionTtlMs(...args);
const normalizeManagedRemoteTunnelHostname: typeof settingsNormalizationRuntime.normalizeManagedRemoteTunnelHostname = (...args) =>
  settingsNormalizationRuntime.normalizeManagedRemoteTunnelHostname(...args);
const normalizeManagedRemoteTunnelPresets: typeof settingsNormalizationRuntime.normalizeManagedRemoteTunnelPresets = (...args) =>
  settingsNormalizationRuntime.normalizeManagedRemoteTunnelPresets(...args);
const normalizeManagedRemoteTunnelPresetTokens: typeof settingsNormalizationRuntime.normalizeManagedRemoteTunnelPresetTokens = (...args) =>
  settingsNormalizationRuntime.normalizeManagedRemoteTunnelPresetTokens(...args);
const isUnsafeSkillRelativePath: typeof settingsNormalizationRuntime.isUnsafeSkillRelativePath = (...args) => settingsNormalizationRuntime.isUnsafeSkillRelativePath(...args);
const normalizeStringArray: typeof settingsNormalizationRuntime.normalizeStringArray = (...args) => settingsNormalizationRuntime.normalizeStringArray(...args);
const sanitizeModelRefs: typeof settingsNormalizationRuntime.sanitizeModelRefs = (...args) => settingsNormalizationRuntime.sanitizeModelRefs(...args);
const sanitizeSkillCatalogs: typeof settingsNormalizationRuntime.sanitizeSkillCatalogs = (...args) => settingsNormalizationRuntime.sanitizeSkillCatalogs(...args);
const sanitizeProjects: typeof settingsNormalizationRuntime.sanitizeProjects = (...args) => settingsNormalizationRuntime.sanitizeProjects(...args);
const sanitizeProjectList = (projects: Parameters<typeof sanitizeProjects>[0]) => sanitizeProjects(projects) ?? [];

const OPENCHAMBER_DEFAULT_CONFIG_ROOT = path.join(os.homedir(), '.config', 'openchamber');
const OPENCHAMBER_USER_CONFIG_ROOT = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : OPENCHAMBER_DEFAULT_CONFIG_ROOT;
const OPENCHAMBER_USER_THEMES_DIR = path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'themes');
const OPENCHAMBER_PROJECTS_CONFIG_DIR = path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'projects');
const OPENCHAMBER_CHATS_DIR = process.env.OPENCHAMBER_CHATS_DIR && process.env.OPENCHAMBER_CHATS_DIR.trim()
  ? path.resolve(process.env.OPENCHAMBER_CHATS_DIR.trim())
  : path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'chats');

const MAX_THEME_JSON_BYTES = 512 * 1024;


const themeRuntime = createThemeRuntime({
  fsPromises,
  path,
  themesDir: OPENCHAMBER_USER_THEMES_DIR,
  maxThemeJsonBytes: MAX_THEME_JSON_BYTES,
  logger: console,
});

const readCustomThemesFromDisk: typeof themeRuntime.readCustomThemesFromDisk = (...args) => themeRuntime.readCustomThemesFromDisk(...args);
const saveImportedTheme: typeof themeRuntime.saveImportedTheme = (...args) => themeRuntime.saveImportedTheme(...args);
const deleteImportedTheme: typeof themeRuntime.deleteImportedTheme = (...args) => themeRuntime.deleteImportedTheme(...args);

let agentToolRuntime: ReturnType<typeof createAgentToolRuntime> | null = null;
let limitFailoverRuntime: ReturnType<typeof createLimitFailoverRuntime> | null = null;
let managedConfigRuntime: ReturnType<typeof createManagedConfigRuntime> | null = null;
let stopEnterprisePolicyWatch = () => {};

const resolveNotificationTemplate: typeof notificationTemplateRuntime.resolveNotificationTemplate = (...args) => notificationTemplateRuntime.resolveNotificationTemplate(...args);
const shouldApplyResolvedTemplateMessage: typeof notificationTemplateRuntime.shouldApplyResolvedTemplateMessage = (...args) => notificationTemplateRuntime.shouldApplyResolvedTemplateMessage(...args);
const fetchFreeZenModels: typeof notificationTemplateRuntime.fetchFreeZenModels = (...args) => notificationTemplateRuntime.fetchFreeZenModels(...args);
const extractLastMessageText: typeof notificationTemplateRuntime.extractLastMessageText = (...args) => notificationTemplateRuntime.extractLastMessageText(...args);
const fetchLastAssistantMessageText: typeof notificationTemplateRuntime.fetchLastAssistantMessageText = (...args) => notificationTemplateRuntime.fetchLastAssistantMessageText(...args);
const maybeCacheSessionInfoFromEvent: typeof notificationTemplateRuntime.maybeCacheSessionInfoFromEvent = (...args) => notificationTemplateRuntime.maybeCacheSessionInfoFromEvent(...args);
const buildTemplateVariables: typeof notificationTemplateRuntime.buildTemplateVariables = (...args) => notificationTemplateRuntime.buildTemplateVariables(...args);
const getCachedZenModels: typeof notificationTemplateRuntime.getCachedZenModels = (...args) => notificationTemplateRuntime.getCachedZenModels(...args);

const OPENCHAMBER_DATA_DIR = OPENCHAMBER_USER_CONFIG_ROOT;
const SETTINGS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'settings.json');
const pluginSwitchStore = createPluginSwitchStore({ filePath: path.join(OPENCHAMBER_DATA_DIR, 'plugin-switches.json') });
const PUSH_SUBSCRIPTIONS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'push-subscriptions.json');
const APNS_TOKENS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'apns-tokens.json');
const PUSH_OPEN_TAGS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'push-open-tags.json');
const openCodeTrust = createOpenCodeTrust({
  storePath: path.join(OPENCHAMBER_DATA_DIR, 'opencode-trust.json'),
  listKnownDirectories: async () => {
    const settings = await readSettingsFromDiskMigrated();
    return (sanitizeProjects(settings?.projects || []) ?? []).map((project) => project.path);
  },
});
globalThis.fetch = guardOpenCodeFetch({
  fetchImpl: globalThis.fetch,
  openCodeTrust,
  buildOpenCodeUrl: (...args) => buildOpenCodeUrl(...args),
  getOpenCodeAuthHeaders: (...args) => getOpenCodeAuthHeaders(...args),
});
const REMOTE_CLIENTS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'remote-clients.json');
const CLIENT_PAIRING_SESSIONS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'client-pairing-sessions.json');
const CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'cloudflare-managed-remote-tunnels.json');
const CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'cloudflare-named-tunnels.json');
const CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION = 1;
const worktreeBootstrapStore = createWorktreeBootstrapStore({
  filePath: path.join(OPENCHAMBER_DATA_DIR, 'git-worktree-bootstrap.json'),
  fsImpl: fsPromises,
});

const managedTunnelConfigRuntime = createManagedTunnelConfigRuntime({
  fsPromises,
  path,
  normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteTunnelPresets,
  constants: {
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH,
    CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH,
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
  },
});

const readManagedRemoteTunnelConfigFromDisk: typeof managedTunnelConfigRuntime.readManagedRemoteTunnelConfigFromDisk = (...args) => managedTunnelConfigRuntime.readManagedRemoteTunnelConfigFromDisk(...args);
const syncManagedRemoteTunnelConfigWithPresets: typeof managedTunnelConfigRuntime.syncManagedRemoteTunnelConfigWithPresets = (...args) => managedTunnelConfigRuntime.syncManagedRemoteTunnelConfigWithPresets(...args);
const upsertManagedRemoteTunnelToken: typeof managedTunnelConfigRuntime.upsertManagedRemoteTunnelToken = (...args) => managedTunnelConfigRuntime.upsertManagedRemoteTunnelToken(...args);
const resolveManagedRemoteTunnelToken: typeof managedTunnelConfigRuntime.resolveManagedRemoteTunnelToken = (...args) => managedTunnelConfigRuntime.resolveManagedRemoteTunnelToken(...args);

const settingsHelpers = createSettingsHelpers({
  normalizePathForPersistence,
  normalizeDirectoryPath,
  normalizeTunnelBootstrapTtlMs,
  normalizeTunnelSessionTtlMs,
  normalizeTunnelProvider,
  normalizeTunnelMode,
  normalizeOptionalPath,
  normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteTunnelPresets,
  normalizeManagedRemoteTunnelPresetTokens,
  normalizeStringArray,
  sanitizeModelRefs,
  sanitizeSkillCatalogs,
  sanitizeProjects,
});

const normalizePwaAppName: typeof settingsHelpers.normalizePwaAppName = (...args) => settingsHelpers.normalizePwaAppName(...args);
const normalizePwaOrientation: typeof settingsHelpers.normalizePwaOrientation = (...args) => settingsHelpers.normalizePwaOrientation(...args);
const sanitizeSettingsUpdate: typeof settingsHelpers.sanitizeSettingsUpdate = (...args) => settingsHelpers.sanitizeSettingsUpdate(...args);
const mergePersistedSettings: typeof settingsHelpers.mergePersistedSettings = (...args) => settingsHelpers.mergePersistedSettings(...args);
const formatSettingsResponse: typeof settingsHelpers.formatSettingsResponse = (...args) => settingsHelpers.formatSettingsResponse(...args);

const projectDirectoryRuntime = createProjectDirectoryRuntime({
  fsPromises,
  path,
  normalizeDirectoryPath,
  getReadSettingsFromDiskMigrated: () => readSettingsFromDiskMigrated,
  sanitizeProjects,
  refuseDirectory: (candidate) => spacesHost?.refuseDirectory(candidate) ?? null,
});

const resolveDirectoryCandidate: typeof projectDirectoryRuntime.resolveDirectoryCandidate = (...args) => projectDirectoryRuntime.resolveDirectoryCandidate(...args);
const validateDirectoryPath: typeof projectDirectoryRuntime.validateDirectoryPath = (...args) => projectDirectoryRuntime.validateDirectoryPath(...args);
const resolveProjectDirectory: typeof projectDirectoryRuntime.resolveProjectDirectory = (...args) => projectDirectoryRuntime.resolveProjectDirectory(...args);
const resolveOptionalProjectDirectory: typeof projectDirectoryRuntime.resolveOptionalProjectDirectory = (...args) => projectDirectoryRuntime.resolveOptionalProjectDirectory(...args);

const settingsRuntime = createSettingsRuntime({
  fsPromises,
  path,
  crypto,
  SETTINGS_FILE_PATH,
  sanitizeProjects,
  sanitizeSettingsUpdate,
  mergePersistedSettings,
  normalizeSettingsPaths, refreshCanonicalPaths: settingsNormalizationRuntime.refreshCanonicalPaths,
  normalizeStringArray,
  formatSettingsResponse,
  resolveDirectoryCandidate,
  normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteTunnelPresets,
  normalizeManagedRemoteTunnelPresetTokens,
  syncManagedRemoteTunnelConfigWithPresets,
  upsertManagedRemoteTunnelToken,
  chatRoots: [path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'chats'), OPENCHAMBER_CHATS_DIR],
  onManagedPluginSettingsChanged: () => managedConfigRuntime?.refreshManagedConfigFile(),
  onMessageSearchEnabledChanged: (enabled) => messageSearchRuntime.setEnabled(enabled),
  onMessageSearchReasoningChanged: (enabled) => messageSearchRuntime.setReasoningEnabled(enabled),
  onPermissionDefaultModeChanged: (mode) => {
    void spacesHost?.journey.changePermissionDefault(mode).catch((error) => {
      console.warn(`[spaces] the default permission mode did not reach the running spaces: ${error?.code ?? error?.message ?? error}`);
    });
  },
  onLastDirectoryChanged: (directory) => {
    if (!isString(directory)) return;
    void openCodeLifecycleRuntime.noteCurrentDirectory(directory, openCodeTrust.isTrusted).catch(() => {});
  },
});

const readSettingsFromDiskMigrated: typeof settingsRuntime.readSettingsFromDiskMigrated = (...args) => settingsRuntime.readSettingsFromDiskMigrated(...args);
const readSettingsFromDisk: typeof settingsRuntime.readSettingsFromDisk = (...args) => settingsRuntime.readSettingsFromDisk(...args);
const readSettingsFromDiskStrict: typeof settingsRuntime.readSettingsFromDiskStrict = (...args) => settingsRuntime.readSettingsFromDiskStrict(...args);
const writeSettingsToDisk: typeof settingsRuntime.writeSettingsToDisk = (...args) => settingsRuntime.writeSettingsToDisk(...args);
const persistSettings: typeof settingsRuntime.persistSettings = (...args) => settingsRuntime.persistSettings(...args);

const requestSecurityRuntime = createRequestSecurityRuntime({
  readSettingsFromDiskMigrated,
  allowLocalDevOrigins: allowsLocalDevOrigins(process.env),
});

const getUiSessionTokenFromRequest: typeof requestSecurityRuntime.getUiSessionTokenFromRequest = (...args) => requestSecurityRuntime.getUiSessionTokenFromRequest(...args);

const pushRuntime = createPushRuntime({
  fsPromises,
  path,
  loadWebPush: () => import('web-push').then((module) => module.default),
  PUSH_SUBSCRIPTIONS_FILE_PATH,
  readSettingsFromDiskMigrated,
  updateSettingsFromDisk: settingsRuntime.updateSettingsFromDisk,
  getInvalidSessionKeys: () => clientPushAccess.invalidSessionKeys(),
});

const getOrCreateVapidKeys: typeof pushRuntime.getOrCreateVapidKeys = (...args) => pushRuntime.getOrCreateVapidKeys(...args);
const addOrUpdatePushSubscription: typeof pushRuntime.addOrUpdatePushSubscription = (...args) => pushRuntime.addOrUpdatePushSubscription(...args);
const removePushSubscription: typeof pushRuntime.removePushSubscription = (...args) => pushRuntime.removePushSubscription(...args);
const sendPushToAllUiSessions: typeof pushRuntime.sendPushToAllUiSessions = (...args) => pushRuntime.sendPushToAllUiSessions(...args);
let clearPendingPushBadge = () => {};
const updateUiVisibility = (token: string, visible: boolean, platform?: string) => {
  if (visible === true) clearPendingPushBadge();
  return pushRuntime.updateUiVisibility(token, visible, platform);
};
const isAnyUiVisible: typeof pushRuntime.isAnyUiVisible = (...args) => pushRuntime.isAnyUiVisible(...args);
const isAnyInteractiveClientVisible: typeof pushRuntime.isAnyInteractiveClientVisible = (...args) => pushRuntime.isAnyInteractiveClientVisible(...args);
const isUiVisible: typeof pushRuntime.isUiVisible = (...args) => pushRuntime.isUiVisible(...args);
const ensurePushInitialized: typeof pushRuntime.ensurePushInitialized = (...args) => pushRuntime.ensurePushInitialized(...args);
const setPushInitialized: typeof pushRuntime.setPushInitialized = (...args) => pushRuntime.setPushInitialized(...args);

const relayKeyStore = createRelayKeyStore({
  fsPromises,
  path,
  dataDir: OPENCHAMBER_DATA_DIR,
  readSettingsFromDiskMigrated,
  readSettingsStrict: readSettingsFromDiskStrict,
  writeSettingsToDisk,
});

const apnsRuntime = createApnsRuntime({
  fsPromises,
  path,
  crypto,
  http2,
  APNS_TOKENS_FILE_PATH,
  readSettingsFromDiskMigrated,
  relayKeyStore,
  getInvalidSessionKeys: () => clientPushAccess.invalidSessionKeys(),
});

const addOrUpdateApnsToken: typeof apnsRuntime.addOrUpdateApnsToken = (...args) => apnsRuntime.addOrUpdateApnsToken(...args);
const removeApnsToken: typeof apnsRuntime.removeApnsToken = (...args) => apnsRuntime.removeApnsToken(...args);
const sendApnsToAllUiSessions: typeof apnsRuntime.sendApnsToAllUiSessions = (...args) => apnsRuntime.sendApnsToAllUiSessions(...args);
const clearApnsNotifications: typeof apnsRuntime.clearApnsNotifications = (...args) => apnsRuntime.clearApnsNotifications(...args);

const TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW = 128;
const TERMINAL_INPUT_WS_REBIND_WINDOW_MS = 60 * 1000;
const TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS = 15 * 1000;

const rejectWebSocketUpgrade: typeof requestSecurityRuntime.rejectWebSocketUpgrade = (...args) => requestSecurityRuntime.rejectWebSocketUpgrade(...args);


const isRequestOriginAllowed: typeof requestSecurityRuntime.isRequestOriginAllowed = (...args) => requestSecurityRuntime.isRequestOriginAllowed(...args);

const notificationEmitterRuntime = createNotificationEmitterRuntime({
  process,
  getDesktopNotifyEnabled: () => ENV_DESKTOP_NOTIFY,
  desktopNotifyPrefix: DESKTOP_NOTIFY_PREFIX,
  getUiNotificationClients: () => uiNotificationClients,
  getOpenChamberEventClients: () => uiOpenChamberEventClients,
  getBroadcastGlobalUiEvent: () => broadcastGlobalUiEvent,
});

const writeSseEvent: typeof notificationEmitterRuntime.writeSseEvent = (...args) => notificationEmitterRuntime.writeSseEvent(...args);
const emitDesktopNotification: typeof notificationEmitterRuntime.emitDesktopNotification = (...args) => notificationEmitterRuntime.emitDesktopNotification(...args);
const broadcastGlobalUiEvent = createGlobalUiEventBroadcaster({
  sseClients: uiNotificationClients,
  wsClients: uiNotificationWsClients,
  writeSseEvent,
});
const broadcastUiNotification: typeof notificationEmitterRuntime.broadcastUiNotification = (...args) => notificationEmitterRuntime.broadcastUiNotification(...args);

const broadcastOpenChamberUiEvent = createGlobalUiEventBroadcaster({
  sseClients: uiOpenChamberEventClients,
  wsClients: uiNotificationWsClients,
  writeSseEvent,
});

const broadcastControlSseEvent = createGlobalUiEventBroadcaster({
  sseClients: uiOpenChamberEventClients,
  wsClients: new Set(),
  writeSseEvent,
});
const broadcastPermissionUiEvent = <Payload>(payload: Payload) => {
  broadcastControlSseEvent(payload);
  broadcastGlobalUiEvent(payload);
};

const sessionMetadataStore = createSessionMetadataStore({
  dataDir: OPENCHAMBER_DATA_DIR,
  openCode: {
    read: (...args) => createOpenCodeSessionMetadata({ buildOpenCodeUrl, getOpenCodeAuthHeaders }).read(...args),
    write: (sessionID, metadata, options) => createOpenCodeSessionMetadata({ buildOpenCodeUrl, getOpenCodeAuthHeaders }).write(sessionID, metadata, options).then(() => {
      if (sessionLineage.noteMetadata(sessionID, metadata)) permissionAutoAcceptRuntime.forgetSession(sessionID);
    }),
  },
});

const readStoredSessionMetadata = (sessionID: string | null, options?: MetadataReadOptions) => sessionMetadataStore.get(sessionID, options);

const persistSessionMetadataPatch = async (sessionID: string, patch: SessionMetadata, { directory = '' }: { directory?: string | undefined } = {}) => {
  const metadata = await sessionMetadataStore.setSessionMetadata(sessionID, patch, { directory });
  broadcastOpenChamberUiEvent({
    type: 'openchamber:session-metadata',
    properties: { sessionID, metadata },
  });
  if (isRecord(patch.openchamber) && 'goal' in patch.openchamber) {
    void Promise.resolve(sessionGoalRuntime.notifyGoalChanged(sessionID, directory, metadata))
      .catch((error) => console.warn('[session-goal] could not arm after a goal change:', error?.message ?? error));
  }
  return metadata;
};

const updateSessionMetadataWith = async (sessionID: string, decide: MetadataDecider, { directory = '' }: { directory?: string | undefined } = {}) => {
  const result = await sessionMetadataStore.updateSessionMetadata(sessionID, decide, { directory });
  if (result.changed) {
    broadcastOpenChamberUiEvent({
      type: 'openchamber:session-metadata',
      properties: { sessionID, metadata: result.metadata },
    });
  }
  return result;
};

const sessionRuntime = createSessionRuntime({
  writeSseEvent,
  getNotificationClients: () => uiNotificationClients,
  broadcastEvent: broadcastGlobalUiEvent,
  readTurnStart: (sessionId) => createTurnStartReader({ buildOpenCodeUrl, getOpenCodeAuthHeaders }).readTurnStart(sessionId),
  buildOpenCodeUrl: (...args) => buildOpenCodeUrl(...args),
  getOpenCodeAuthHeaders: () => getOpenCodeAuthHeaders(),
});

const getActiveSessionCount = () => sessionRuntime.getActiveSessionCount();

const getUpstreamStallTimeoutMs = () => (
  getActiveSessionCount() > 1
    ? UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS
    : DEFAULT_UPSTREAM_STALL_TIMEOUT_MS
);

const movedUserDirs = await migrateLegacyUserDirs({
  fsPromises,
  path,
  dataDir: OPENCHAMBER_USER_CONFIG_ROOT,
  legacyRoot: OPENCHAMBER_DEFAULT_CONFIG_ROOT,
  warn: (message) => console.warn(`[data-dir] ${message}`),
});
if (movedUserDirs.length > 0) {
  console.log(`[data-dir] Copied ${movedUserDirs.join(', ')} into ${OPENCHAMBER_USER_CONFIG_ROOT}`);
}

const projectConfigRuntime = createProjectConfigRuntime({
  fsPromises,
  path,
  projectsDirPath: OPENCHAMBER_PROJECTS_CONFIG_DIR,
  switchNotesTodosStorage: (projectId, change) => projectContextRuntime.switchNotesTodosStorage(projectId, change),
});

const projectContextRuntime = createProjectContextRuntime({
  fsPromises,
  path,
  projectsDirPath: OPENCHAMBER_PROJECTS_CONFIG_DIR,
  resolveSharedPlansDir: (projectId) => projectConfigRuntime.resolveSharedPlansDir(projectId),
  resolveNotesTodosFile: (projectId) => projectConfigRuntime.resolveNotesTodosFile(projectId),
  onChanged: (projectId) => broadcastOpenChamberUiEvent({
    type: 'openchamber:project-context-changed',
    properties: { projectId },
  }),
});

const agentMemoryRuntime = createAgentMemoryRuntime({
  fsPromises,
  path,
  projectsDirPath: OPENCHAMBER_PROJECTS_CONFIG_DIR,
  userConfigRoot: OPENCHAMBER_USER_CONFIG_ROOT,
});

const isAgentMemoryEnabled = async () => {
  const settings = await readSettingsFromDiskMigrated().catch(() => null);
  return settings?.agentMemoryToolEnabled === true;
};

const hmrStateRuntime = createHmrStateRuntime({
  globalThisLike: globalThis,
  os,
  processLike: process,
  stateKey: '__openchamberHmrState',
});
const hmrState = hmrStateRuntime.getOrCreateHmrState();
hmrStateRuntime.ensureUserProvidedOpenCodePassword(hmrState);

let healthCheckInterval: OpenCodeLifecycleState['healthCheckInterval'] = null;
let server: http.Server | null = null;
let expressApp: OpenCodeLifecycleState['expressApp'] = null;
let currentRestartPromise: OpenCodeLifecycleState['currentRestartPromise'] = null;
let isRestartingOpenCode = false;
let openCodeApiPrefix = '';
let openCodeApiPrefixDetected = true;
let openCodeApiDetectionTimer: OpenCodeLifecycleState['openCodeApiDetectionTimer'] = null;
let lastOpenCodeError: OpenCodeLifecycleState['lastOpenCodeError'] = null;
let lastOpenCodeLaunchDiagnostics: OpenCodeLifecycleState['lastOpenCodeLaunchDiagnostics'] = null;
let lastOpenCodeHealthFailure: OpenCodeLifecycleState['lastOpenCodeHealthFailure'] = null;
let lastManagedOpenCodeProcess: OpenCodeLifecycleState['lastManagedOpenCodeProcess'] = null;
let lastOpenCodeRestartDiagnostics: OpenCodeLifecycleState['lastOpenCodeRestartDiagnostics'] = null;
let isOpenCodeReady = false;
let openCodeNotReadySince = 0;
let isExternalOpenCode = false;
let exitOnShutdown = true;
let uiAuthController: BootstrapResult['uiAuthController'] | null = null;
let spacesHost: Awaited<ReturnType<typeof createSpacesHost>> | null = null;
let activeTunnelController: ReturnType<TunnelWiringDependencies['getActiveTunnelController']> = null;
let globalWatcherStartPromise: ReturnType<typeof openCodeWatcherRuntime.start> | null = null;
const tunnelProviderRegistry = createTunnelProviderRegistry([
  createCloudflareTunnelProvider(),
  createNgrokTunnelProvider(),
  createTailscaleTunnelProvider(),
]);
tunnelProviderRegistry.seal();
const tunnelAuthController = createTunnelAuth();
let runtimeManagedRemoteTunnelToken = '';
let runtimeManagedRemoteTunnelHostname: string | undefined = '';
let terminalRuntime: StartupPipelineResult['terminalRuntime'] | null = null;
let dictationRuntime: StartupPipelineResult['dictationRuntime'] | null = null;
let guestSurfaceRuntime: ReturnType<typeof createGuestSurfaceRuntime> | null = null;
let realtimeProxyRuntime: ReturnType<typeof attachRealtimeProxy> | null = null;
let relayServiceInstance: ReturnType<typeof createRelayService> | null = null;
let relayReconcileTimer: ReturnType<typeof setInterval> | null = null;
let messageStreamRuntime: StartupPipelineResult['messageStreamRuntime'] | null = null;
const userProvidedOpenCodePassword = hmrStateRuntime.getUserProvidedOpenCodePassword(hmrState);
const initialOpenCodeAuthState = hmrStateRuntime.resolveOpenCodeAuthFromState({
  hmrState,
  userProvidedOpenCodePassword,
});
let openCodeAuthPassword = initialOpenCodeAuthState.openCodeAuthPassword;
let openCodeAuthSource = initialOpenCodeAuthState.openCodeAuthSource;

const syncToHmrState = () => {
  hmrStateRuntime.syncStateFromRuntime(hmrState, {
    openCodeProcess,
    openCodePort,
    openCodeBaseUrl,
    isShuttingDown,
    signalsAttached,
    openCodeWorkingDirectory,
    openCodeAuthPassword,
    openCodeAuthSource,
  });
};

const syncFromHmrState = () => {
  const restored = hmrStateRuntime.restoreRuntimeFromState({
    hmrState,
    userProvidedOpenCodePassword,
  });
  openCodeProcess = restored.openCodeProcess;
  openCodePort = restored.openCodePort;
  openCodeBaseUrl = restored.openCodeBaseUrl;
  isShuttingDown = restored.isShuttingDown;
  signalsAttached = restored.signalsAttached;
  openCodeWorkingDirectory = restored.openCodeWorkingDirectory;
  openCodeAuthPassword = restored.openCodeAuthPassword;
  openCodeAuthSource = restored.openCodeAuthSource;
};

let openCodeProcess = hmrState.openCodeProcess;
let openCodePort = hmrState.openCodePort;
let openCodeBaseUrl = hmrState.openCodeBaseUrl ?? null;
let isShuttingDown = hmrState.isShuttingDown;
let signalsAttached = hmrState.signalsAttached;
let openCodeWorkingDirectory = hmrState.openCodeWorkingDirectory;

const {
  configuredOpenCodePort: ENV_CONFIGURED_OPENCODE_PORT,
  configuredOpenCodeHost: ENV_CONFIGURED_OPENCODE_HOST,
  effectivePort: ENV_EFFECTIVE_PORT,
  configuredOpenCodeHostname: ENV_CONFIGURED_OPENCODE_HOSTNAME,
} = resolveOpenCodeEnvConfig({
  env: process.env,
  logger: console,
});

const ENV_SKIP_OPENCODE_START = process.env.OPENCODE_SKIP_START === 'true' ||
                                    process.env.OPENCHAMBER_SKIP_OPENCODE_START === 'true';
const ENV_DESKTOP_NOTIFY = (() => {
  if (process.env.OPENCHAMBER_DESKTOP_NOTIFY === 'true') {
    return true;
  }

  if (process.env.OPENCHAMBER_RUNTIME === 'desktop') {
    return true;
  }

  const argv0 = isString(process.argv?.[0]) ? process.argv[0] : '';
  const argv1 = isString(process.argv?.[1]) ? process.argv[1] : '';
  return /openchamber-server/i.test(argv0) || /openchamber-server/i.test(argv1);
})();
const openCodeAuthStateRuntime = createOpenCodeAuthStateRuntime({
  crypto,
  process,
  getAuthPassword: () => openCodeAuthPassword,
  setAuthPassword: (value) => {
    openCodeAuthPassword = value;
  },
  getAuthSource: () => openCodeAuthSource,
  setAuthSource: (value) => {
    openCodeAuthSource = value;
  },
  getUserProvidedPassword: () => userProvidedOpenCodePassword,
  syncToHmrState,
});

const getOpenCodeAuthHeaders: typeof openCodeAuthStateRuntime.getOpenCodeAuthHeaders = (...args) => openCodeAuthStateRuntime.getOpenCodeAuthHeaders(...args);
const isOpenCodeConnectionSecure: typeof openCodeAuthStateRuntime.isOpenCodeConnectionSecure = (...args) => openCodeAuthStateRuntime.isOpenCodeConnectionSecure(...args);
const ensureLocalOpenCodeServerPassword: typeof openCodeAuthStateRuntime.ensureLocalOpenCodeServerPassword = (...args) => openCodeAuthStateRuntime.ensureLocalOpenCodeServerPassword(...args);

const openCodeNetworkState = {
  get openCodePort() { return openCodePort; },
  set openCodePort(value: typeof openCodePort) { openCodePort = value; },
  get openCodeBaseUrl() { return openCodeBaseUrl; },
  set openCodeBaseUrl(value: typeof openCodeBaseUrl) { openCodeBaseUrl = value; },
  get openCodeApiPrefix() { return openCodeApiPrefix; },
  set openCodeApiPrefix(value: typeof openCodeApiPrefix) { openCodeApiPrefix = value; },
  get openCodeApiPrefixDetected() { return openCodeApiPrefixDetected; },
  set openCodeApiPrefixDetected(value: typeof openCodeApiPrefixDetected) { openCodeApiPrefixDetected = value; },
  get openCodeApiDetectionTimer() { return openCodeApiDetectionTimer; },
  set openCodeApiDetectionTimer(value: typeof openCodeApiDetectionTimer) { openCodeApiDetectionTimer = value; },
};

const openCodeNetworkRuntime = createOpenCodeNetworkRuntime({
  state: openCodeNetworkState,
  getOpenCodeAuthHeaders,
  configuredOpenCodeHostname: ENV_CONFIGURED_OPENCODE_HOSTNAME,
});

const waitForReady: typeof openCodeNetworkRuntime.waitForReady = (...args) => openCodeNetworkRuntime.waitForReady(...args);
const normalizeApiPrefix: typeof openCodeNetworkRuntime.normalizeApiPrefix = (...args) => openCodeNetworkRuntime.normalizeApiPrefix(...args);
const setDetectedOpenCodeApiPrefix: typeof openCodeNetworkRuntime.setDetectedOpenCodeApiPrefix = (...args) => openCodeNetworkRuntime.setDetectedOpenCodeApiPrefix(...args);
const buildOpenCodeUrl: typeof openCodeNetworkRuntime.buildOpenCodeUrl = (...args) => openCodeNetworkRuntime.buildOpenCodeUrl(...args);
const ensureOpenCodeApiPrefix: typeof openCodeNetworkRuntime.ensureOpenCodeApiPrefix = (...args) => openCodeNetworkRuntime.ensureOpenCodeApiPrefix(...args);
const scheduleOpenCodeApiDetection: typeof openCodeNetworkRuntime.scheduleOpenCodeApiDetection = (...args) => openCodeNetworkRuntime.scheduleOpenCodeApiDetection(...args);

configureOpenCodeRuntimeProviders({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getDefaultDirectory: () => openCodeLifecycleRuntime.getDefaultOpenCodeDirectory(),
});

const ENV_CONFIGURED_API_PREFIX = normalizeApiPrefix(
  process.env.OPENCODE_API_PREFIX || process.env.OPENCHAMBER_API_PREFIX || ''
);

  if (ENV_CONFIGURED_API_PREFIX && ENV_CONFIGURED_API_PREFIX !== '') {
  console.warn('Ignoring configured OpenCode API prefix; API runs at root.');
}

let cachedLoginShellEnvSnapshot: OpenCodeEnvState['cachedLoginShellEnvSnapshot'];
let resolvedOpencodeBinary: Exclude<OpenCodeEnvState['resolvedOpencodeBinary'], undefined> = null;
let resolvedOpencodeBinarySource: OpenCodeEnvState['resolvedOpencodeBinarySource'] = null;
let resolvedNodeBinary: Exclude<OpenCodeEnvState['resolvedNodeBinary'], undefined> = null;
let resolvedBunBinary: Exclude<OpenCodeEnvState['resolvedBunBinary'], undefined> = null;
let resolvedGitBinary: Exclude<OpenCodeEnvState['resolvedGitBinary'], undefined> = null;
let useWslForOpencode: Exclude<OpenCodeEnvState['useWslForOpencode'], undefined> = false;
let resolvedWslBinary: Exclude<OpenCodeEnvState['resolvedWslBinary'], undefined> = null;
let resolvedWslOpencodePath: Exclude<OpenCodeEnvState['resolvedWslOpencodePath'], undefined> = null;
let resolvedWslDistro: Exclude<OpenCodeEnvState['resolvedWslDistro'], undefined> = null;

const openCodeEnvState = {
  get cachedLoginShellEnvSnapshot() { return cachedLoginShellEnvSnapshot; },
  set cachedLoginShellEnvSnapshot(value: typeof cachedLoginShellEnvSnapshot) { cachedLoginShellEnvSnapshot = value; },
  get resolvedOpencodeBinary() { return resolvedOpencodeBinary; },
  set resolvedOpencodeBinary(value: typeof resolvedOpencodeBinary) { resolvedOpencodeBinary = value; },
  get resolvedOpencodeBinarySource() { return resolvedOpencodeBinarySource; },
  set resolvedOpencodeBinarySource(value: typeof resolvedOpencodeBinarySource) { resolvedOpencodeBinarySource = value; },
  get resolvedNodeBinary() { return resolvedNodeBinary; },
  set resolvedNodeBinary(value: typeof resolvedNodeBinary) { resolvedNodeBinary = value; },
  get resolvedBunBinary() { return resolvedBunBinary; },
  set resolvedBunBinary(value: typeof resolvedBunBinary) { resolvedBunBinary = value; },
  get resolvedGitBinary() { return resolvedGitBinary; },
  set resolvedGitBinary(value: typeof resolvedGitBinary) { resolvedGitBinary = value; },
  get useWslForOpencode() { return useWslForOpencode; },
  set useWslForOpencode(value: typeof useWslForOpencode) { useWslForOpencode = value; },
  get resolvedWslBinary() { return resolvedWslBinary; },
  set resolvedWslBinary(value: typeof resolvedWslBinary) { resolvedWslBinary = value; },
  get resolvedWslOpencodePath() { return resolvedWslOpencodePath; },
  set resolvedWslOpencodePath(value: typeof resolvedWslOpencodePath) { resolvedWslOpencodePath = value; },
  get resolvedWslDistro() { return resolvedWslDistro; },
  set resolvedWslDistro(value: typeof resolvedWslDistro) { resolvedWslDistro = value; },
};

const openCodeEnvRuntime = createOpenCodeEnvRuntime({
  state: openCodeEnvState,
  normalizeDirectoryPath,
  readSettingsFromDiskMigrated,
  providedLoginShellEnvSnapshot,
});

const applyLoginShellEnvSnapshot: typeof openCodeEnvRuntime.applyLoginShellEnvSnapshot = (...args) => openCodeEnvRuntime.applyLoginShellEnvSnapshot(...args);
const getLoginShellEnvSnapshot: typeof openCodeEnvRuntime.getLoginShellEnvSnapshot = (...args) => openCodeEnvRuntime.getLoginShellEnvSnapshot(...args);
const ensureOpencodeCliEnv: typeof openCodeEnvRuntime.ensureOpencodeCliEnv = (...args) => openCodeEnvRuntime.ensureOpencodeCliEnv(...args);
const applyOpencodeBinaryFromSettings: typeof openCodeEnvRuntime.applyOpencodeBinaryFromSettings = (...args) => openCodeEnvRuntime.applyOpencodeBinaryFromSettings(...args);
const resolveOpencodeCliPath: typeof openCodeEnvRuntime.resolveOpencodeCliPath = (...args) => openCodeEnvRuntime.resolveOpencodeCliPath(...args);
const isBundledOpenCodePath: typeof openCodeEnvRuntime.isBundledOpenCodePath = (...args) => openCodeEnvRuntime.isBundledOpenCodePath(...args);
const isExecutable: typeof openCodeEnvRuntime.isExecutable = (...args) => openCodeEnvRuntime.isExecutable(...args);
const searchPathFor: typeof openCodeEnvRuntime.searchPathFor = (...args) => openCodeEnvRuntime.searchPathFor(...args);
const resolveGitBinaryForSpawn: typeof openCodeEnvRuntime.resolveGitBinaryForSpawn = (...args) => openCodeEnvRuntime.resolveGitBinaryForSpawn(...args);
const resolveManagedOpenCodeLaunchSpec: typeof openCodeEnvRuntime.resolveManagedOpenCodeLaunchSpec = (...args) => openCodeEnvRuntime.resolveManagedOpenCodeLaunchSpec(...args);
const clearResolvedOpenCodeBinary: typeof openCodeEnvRuntime.clearResolvedOpenCodeBinary = (...args) => openCodeEnvRuntime.clearResolvedOpenCodeBinary(...args);
const openCodeResolutionRuntime = createOpenCodeResolutionRuntime({
  path,
  resolveOpencodeCliPath,
  applyOpencodeBinaryFromSettings,
  ensureOpencodeCliEnv,
  resolveManagedOpenCodeLaunchSpec,
  getResolvedState: () => ({
    resolvedOpencodeBinary,
    resolvedOpencodeBinarySource,
    useWslForOpencode,
    resolvedWslBinary,
    resolvedWslOpencodePath,
    resolvedWslDistro,
    resolvedNodeBinary,
    resolvedBunBinary,
  }),
  setResolvedOpencodeBinarySource: (value) => {
    resolvedOpencodeBinarySource = value;
  },
});
const getOpenCodeResolutionSnapshot: typeof openCodeResolutionRuntime.getOpenCodeResolutionSnapshot = (...args) =>
  openCodeResolutionRuntime.getOpenCodeResolutionSnapshot(...args);

applyLoginShellEnvSnapshot();

const notificationTemplateRuntime = createNotificationTemplateRuntime({
  readSettingsFromDisk,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  resolveGitBinaryForSpawn,
  resolvePrimaryWorktreeRoot,
  chatRoots: [path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'chats'), OPENCHAMBER_CHATS_DIR],
});

const notificationChannelHandles = createOutboundHandles();
setHostCallbackRoute(NOTIFICATIONS_OUTBOUND_PATH, {
  refusal: notificationChannelHandles.refusal,
  serve: notificationChannelHandles.serve,
});
const extensionNotificationChannels = createExtensionNotificationChannels({
  listGuests: () => listInstalledGuests({ persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR) }),
  proxyServiceRequest: proxyGuestServiceRequest,
  persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR),
  accounts: createNotificationChannelAccounts({ persistPath: notificationChannelsPersistPath(OPENCHAMBER_DATA_DIR) }),
  handles: notificationChannelHandles,
  isAnyUiVisible,
});

const notificationTriggerRuntime = createNotificationTriggerRuntime({
  readSettingsFromDisk,
  prepareNotificationLastMessage,
  buildTemplateVariables,
  extractLastMessageText,
  fetchLastAssistantMessageText,
  resolveNotificationTemplate,
  shouldApplyResolvedTemplateMessage,
  emitDesktopNotification,
  broadcastUiNotification,
  sendPushToAllUiSessions,
  sendApnsToAllUiSessions,
  clearApnsNotifications,
  openPushTagsStore: {
    read: async () => {
      try {
        const saved: JsonValue = JSON.parse(await fsPromises.readFile(PUSH_OPEN_TAGS_FILE_PATH, 'utf8'));
        return saved;
      } catch (error) {
        if (isRecord(error) && error.code === 'ENOENT') return null;
        throw error;
      }
    },
    write: async (state) => {
      await fsPromises.mkdir(path.dirname(PUSH_OPEN_TAGS_FILE_PATH), { recursive: true });
      await fsPromises.writeFile(PUSH_OPEN_TAGS_FILE_PATH, JSON.stringify({ version: 1, ...state }), { encoding: 'utf8', mode: 0o600 });
    },
  },
  isAnyInteractiveClientVisible,
  isAnyUiVisible,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readSessionMetadata: readStoredSessionMetadata,
  getSpacesHost: () => spacesHost,
  isInAutoReview: (sessionId, turnEndedAt) => autoReviewRuntime.speaksFor(sessionId, turnEndedAt),
  deliverToExtensionChannels: (delivery) => extensionNotificationChannels.deliver(delivery),
});

const maybeSendPushForTrigger: typeof notificationTriggerRuntime.maybeSendPushForTrigger = (...args) => notificationTriggerRuntime.maybeSendPushForTrigger(...args);
const setAutoAcceptSession = (sessionId: string, enabled: boolean) => permissionAutoAcceptRuntime.setSessionPolicy(sessionId, enabled);
clearPendingPushBadge = () => notificationTriggerRuntime.clearPendingPushBadge();

const sessionLineage = createSessionLineage();

const unreadBaseline = createUnreadBaseline({ dataDir: OPENCHAMBER_DATA_DIR });
void unreadBaseline.get();

const turnDurationRecorder = createTurnDurationRecorder({
  persistSessionMetadataPatch: (...args) => persistSessionMetadataPatch(...args),
  isChildSession: (sessionID) => sessionLineage.isChild(sessionID),
});

const sessionAssistRuntime = createSessionAssistRuntime({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getSmallModelService: async () => import('./lib/small-model/index.js'),
  persistSessionAssist: (sessionID, directory, assist) =>
    persistSessionMetadataPatch(sessionID, { openchamber: { assist } }, { directory }),
  isSessionArchived: (sessionID) => openChamberSessionService.sessionArchive.isArchived(sessionID),
  evaluateTurn: (input) => sessionWorkRuntime.evaluateTurnEnd(input),
  lineage: sessionLineage,
  onPendingChange: ({ sessionId, directory, pending }) => broadcastOpenChamberUiEvent({
    type: 'openchamber:session-assist',
    properties: { sessionID: sessionId, directory: directory || null, pending },
  }),
});

const sessionGoalRuntime = createSessionGoalRuntime({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getSmallModelService: async () => import('./lib/small-model/index.js'),
  classifierEndpoint: () => routingRuntime.classifierEndpoint(),
  jev: createJevClient({ timeoutMs: JEV_BACKGROUND_TIMEOUT_MS }),
  readSessionMetadata: readStoredSessionMetadata,
  persistSessionGoal: createGoalPersistence(persistSessionMetadataPatch, updateSessionMetadataWith),
  emitGoalNotification: async ({ sessionId, directory, status, goal }) => {
    const settings = await readSettingsFromDisk();
    if (settings.notifyOnCompletion === false) {
      return;
    }
    const title = status === 'complete'
      ? 'Goal complete'
      : (status === 'budgetLimited' ? 'Goal reached its token budget' : 'Goal blocked');
    const detail = goal?.statusReason && goal.statusReason !== 'verified by audit' && goal.statusReason !== 'reported by agent'
      ? goal.statusReason
      : '';
    const objective = isString(goal?.objective) ? goal.objective.slice(0, 140) : '';
    const notificationPayload = {
      title,
      body: [objective, detail].filter(Boolean).join(' — ').slice(0, 240),
      tag: `goal-${sessionId}`,
      kind: 'goal',
      sessionId,
      directory,
    };
    const desktopNotificationDelivered = emitDesktopNotification(notificationPayload);
    broadcastUiNotification(notificationPayload, { desktopNotificationDelivered });
    void notificationTriggerRuntime.sendGoalSettlePush({
      sessionId,
      directory,
      status,
      title,
      body: notificationPayload.body,
    }).catch((error) => {
      console.warn('[session-goal] push fanout failed:', error?.message || error);
    });
  },
});

const openCodeSessionClient = (directory?: string) => createOpenCodeClient({
  baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''), headers: getOpenCodeAuthHeaders(), directory,
});
configureIntegrateSessions({ client: () => openCodeSessionClient(), listProjects: readProjectPaths(() => readSettingsFromDiskMigrated()) });
const quietCompaction = createQuietCompaction({ client: () => openCodeSessionClient(), unreadSince: () => unreadBaseline.get(), onSettled: (sessionID) => messageQueueRuntime.release(sessionID) });

const guestInstructions = createGuestInstructions({ dataDir: OPENCHAMBER_DATA_DIR });
const guestAgentContext = createGuestAgentContext({
  persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR),
  instructions: guestInstructions,
});

const sessionLead = createSessionLeadServer({
  dataDir: OPENCHAMBER_DATA_DIR,
  readSessionMetadata: (sessionID, options) => readStoredSessionMetadata(sessionID, options),
  updateMetadata: (sessionID, decide, directory) => updateSessionMetadataWith(sessionID, decide, { directory }),
  resolveSessionDirectory: (sessionID) => openChamberControlService.resolveSessionDirectory(sessionID),
  syncBriefEntry: (sessionID, directory, brief) => sessionKnowledgeRuntime.syncLeadBrief(sessionID, directory, brief),
  executeControl: (...args) => openChamberControlService.execute(...args),
  readWorkflowSettings: () => readWorkflowSettings(),
  createError: (message, status) => new OpenChamberControlError(message, status),
  buildOpenCodeUrl: (route, directory) => buildOpenCodeUrl(route, directory), getOpenCodeAuthHeaders: () => getOpenCodeAuthHeaders(), quiet: quietCompaction,
  isSessionWarm: (sessionID, cacheLifetimeMs) => sessionWarmingRuntime.isSessionWarm(sessionID, cacheLifetimeMs),
  registerResult: (entry) => dispatchResultsRuntime.register(entry),
});

const sessionKnowledgeRuntime = createManagedSessionKnowledgeRuntime({
  hasProjectActions: (directory) => agentToolRuntime?.hasProjectActions(directory) ?? Promise.resolve(false),
  isManagedOpenCode: () => !isExternalOpenCode && !ENV_SKIP_OPENCODE_START, readExternalBridgeToken: () => managedConfigRuntime?.readExternalBridgeToken() ?? null,
  readSettings: () => readSettingsFromDiskMigrated(),
  readExtensionInstructions: guestAgentContext.instructionText,
  readLeadBrief: sessionLead.readBriefForEntry,
  projectContextRuntime,
  agentMemoryRuntime,
  resolveProjectId: (directory) => resolveMemoryProjectId(directory),
  isAgentMemoryEnabled,
  isWorkflowToolEnabled: () => isWorkflowToolEnabled(),
  readCheckoutBranch: getCheckedOutBranch,
  listWorktrees: getWorktrees,
  readPlaceholderBranch: readRenameableGeneratedBranch,
  readSessionMetadata: readStoredSessionMetadata,
  persistSessionMetadata: (sessionID, directory, patch) => persistSessionMetadataPatch(sessionID, patch, { directory }),
  openCodeSessionClient,
});

const contextObligatoryRuntime = createContextObligatoryRuntime({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readSessionMetadata: readStoredSessionMetadata,
  persistContextCursor: (sessionID, directory, patch) => persistSessionMetadataPatch(sessionID, patch, { directory }),
});

const sessionWarmingRuntime = createSessionWarmingRuntime({
  dataDir: OPENCHAMBER_DATA_DIR,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  broadcast: broadcastOpenChamberUiEvent,
});
sessionWarmingRuntime.start();

const trackerRegistry = createTrackerRegistry(undefined, {
  foreignIds: sourceControlProviderDescriptors.list().map((descriptor) => descriptor.id),
});
const trackerSessionStatus = createTrackerSessionStatus({ registry: trackerRegistry });
const extensionSessionEvents = createExtensionSessionEvents({
  listGuests: () => listInstalledGuests({ persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR) }),
  proxyServiceRequest: proxyGuestServiceRequest,
  persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR),
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchLastAssistantMessageText,
  readSessionMetadata: readStoredSessionMetadata,
  isSessionAutoAccepting: (sessionId, directory, requestId) => permissionAutoAcceptRuntime.isPermissionAutoAnswered(sessionId, directory, requestId),
  isInAutoReview: (sessionId, turnEndedAt) => autoReviewRuntime.speaksFor(sessionId, turnEndedAt),
});

const extensionServiceLifetime = createServiceLifetime({
  listGuests: () => listInstalledGuests({ persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR) }),
  proxyServiceRequest: proxyGuestServiceRequest,
  holdService: holdGuestService,
  serviceStatus: getServiceStatus,
  persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR),
});

const hiddenSessions = createHiddenSessionRegistry();

const globalMessageStreamHub = createGlobalMessageStreamHub({
  isHiddenPayload: hiddenSessions.isHiddenPayload, admitPayload: quietCompaction.admit,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  upstreamStallTimeoutMs: getUpstreamStallTimeoutMs,
  deltaCoalesceWindowMs: resolveDeltaCoalesceWindowMs(),
});

const routingRuntime = createRoutingRuntime({
  dataDir: OPENCHAMBER_DATA_DIR,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  broadcastGlobalUiEvent: broadcastOpenChamberUiEvent,
  isSessionWarm: (sessionId, cacheLifetimeMs) => sessionWarmingRuntime.isSessionWarm(sessionId, cacheLifetimeMs),
});

const sessionWorkRuntime = createSessionWorkRuntime({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  classifierEndpoint: () => routingRuntime.classifierEndpoint(),
  jev: createJevClient({ timeoutMs: JEV_BACKGROUND_TIMEOUT_MS }),
  readMetadata: (sessionID, directory) => sessionMetadataStore.get(sessionID, { directory }),
  updateMetadata: updateSessionMetadataWith,
  isSessionArchived: (sessionID) => openChamberSessionService.sessionArchive.isArchived(sessionID),
  isWorktreePinned: isWorktreeDirectoryPinned,
  chatRoots: [path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'chats'), OPENCHAMBER_CHATS_DIR],
  lineage: sessionLineage,
  activityProbe: createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs: 2_000 }),
});

const spacePermissionDefaultFile = process.env.OPENCHAMBER_SPACE_PERMISSION_DEFAULT_FILE;
const permissionAutoAcceptRuntime = createPermissionAutoAcceptRuntime({
  globalEventHub: globalMessageStreamHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readSettingsFromDiskMigrated,
  persistSettings,
  broadcastGlobalUiEvent: broadcastPermissionUiEvent,
  evaluatePermission: (permission, directory) => routingRuntime.evaluatePermission(permission, directory),
  onPermissionReplied: (permissionId) => routingRuntime.forgetPermission(permissionId),
  resolveLegacyEnabledMode: async () => ((await routingRuntime.legacySafetyNetEnabled()) ? 'safety' : 'auto'),
  readDefaultMode: spacePermissionDefaultFile
    ? () => readSpacePermissionDefault(spacePermissionDefaultFile)
    : undefined,
});
permissionAutoAcceptRuntime.start();
notificationTriggerRuntime.setGetIsSessionAutoAccepting(
  (sessionId, directory, permissionId) => permissionAutoAcceptRuntime.isPermissionAutoAnswered(sessionId, directory, permissionId),
);

const autoReviewRuntime = createAutoReviewRuntime({
  globalEventHub: globalMessageStreamHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  sessionKnowledgeRuntime,
  broadcastUiEvent: broadcastOpenChamberUiEvent,
  onRunSettled: (sessionId) => messageQueueRuntime.release(sessionId),
  onRunEnded: (ended) => notificationTriggerRuntime.notifyAutoReviewEnded(ended),
  routeSend: ({ sessionId, directory, text }) => (
    routingRuntime.isAutoSession(sessionId) ? routingRuntime.routeSend({ sessionId, directory, body: { text } }) : null
  ),
  dataDir: OPENCHAMBER_DATA_DIR,
});
autoReviewRuntime.start();

const messageQueueRuntime = createMessageQueueRuntime({
  globalEventHub: globalMessageStreamHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  sessionKnowledgeRuntime,
  broadcastGlobalUiEvent: broadcastOpenChamberUiEvent,
  resolveAutoSelection: (send) => routingRuntime.resolveAutoSelection(send),
  persistSessionGoal: (sessionID, directory, goal) =>
    persistSessionMetadataPatch(sessionID, { openchamber: { goal } }, { directory }),
  isDeliveryHeld: (sessionId) => autoReviewRuntime.holdsDelivery(sessionId),
  deliveryHoldReady: autoReviewRuntime.startupLoad,
  beforeScheduledTaskSend: (...args) => scheduledTasksRuntime.beforeScheduledTaskSend(...args),
  validateScheduledTaskTarget: (...args) => scheduledTasksRuntime.validateTarget(...args),
  onScheduledTaskResult: (...args) => scheduledTasksRuntime.onScheduledTaskResult(...args),
  dataDir: OPENCHAMBER_DATA_DIR,
});
messageQueueRuntime.start();

const dispatchResultsRuntime = createDispatchResultsRuntime({
  globalEventHub: globalMessageStreamHub,
  buildOpenCodeUrl, getOpenCodeAuthHeaders,
  ownWorkSources: () => ({ extensionWaits: extensionWaitsRuntime, prWatch: prWatchRuntime, workflows: workflowRuntime, waitsOnAnswer: (sessionID) => sessionRuntime.getPendingBlockingRequestsSnapshot()[sessionID] !== undefined }),
  dataDir: OPENCHAMBER_DATA_DIR,
  isSessionArchived: (sessionID) => openChamberSessionService.sessionArchive.isArchived(sessionID),
});
dispatchResultsRuntime.start();

const prWatchRuntime = createPrWatchRuntime({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  broadcastUiEvent: broadcastOpenChamberUiEvent,
  dataDir: OPENCHAMBER_DATA_DIR,
  readCleanupOnMerge: async () => (await readSettingsFromDiskMigrated())?.mergedWorktreeCleanupEnabled === true,
  isSessionArchived: (sessionID) => openChamberSessionService.sessionArchive.isArchived(sessionID),
  insideSpace: Boolean(process.env.OPENCHAMBER_SPACE_IDLE_STOP_FILE),
});
prWatchRuntime.start(globalMessageStreamHub);
const extensionWaitsRuntime = createExtensionWaitsRuntime({
  listGuests: () => listInstalledGuests({ persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR) }),
  proxyServiceRequest: proxyGuestServiceRequest,
  persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR),
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  dataDir: OPENCHAMBER_DATA_DIR,
  broadcastUiEvent: broadcastOpenChamberUiEvent,
  isSessionArchived: (sessionID) => openChamberSessionService.sessionArchive.isArchived(sessionID),
  insideSpace: Boolean(process.env.OPENCHAMBER_SPACE_IDLE_STOP_FILE),
});
extensionWaitsRuntime.start(globalMessageStreamHub);
const laterPagesRuntime = createLaterPages({
  dataDir: OPENCHAMBER_DATA_DIR,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  broadcastUiEvent: broadcastOpenChamberUiEvent,
  readArchiveState: (sessionID, options) => openChamberSessionService.sessionArchive.archiveState(sessionID, options),
});
laterPagesRuntime.start(globalMessageStreamHub);
const mergeFollowRuntime = createMergeFollowRuntime({
  dataDir: OPENCHAMBER_DATA_DIR,
  notify: (notification) => notificationTriggerRuntime.notifyPullRequest(notification),
});

const getSessionDirectoryCanonicalizer = createSessionDirectoryCanonicalizer({ sharesFilesystem: () => openCodePluginDelivery({ external: isExternalOpenCode || ENV_SKIP_OPENCODE_START, origin: ENV_CONFIGURED_OPENCODE_HOST?.origin || openCodeBaseUrl || null, ownsConfigFile: true }) !== 'remote' });
const readWorkflowSettings = () => readSettingsFromDiskMigrated().catch(() => null);
const isWorkflowToolEnabled = async () => (await readWorkflowSettings())?.agentWorkflowToolEnabled === true;
const workflowAgentSessions = createWorkflowAgentSessions({
  getSessionDirectoryCanonicalizer,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  waitForOpenCodeReady: (...args) => waitForOpenCodeReady(...args),
  globalEventHub: globalMessageStreamHub,
});
const workflowRuntime = createWorkflowRuntime({
  store: createWorkflowRunStore({ fsPromises, path, dataDir: OPENCHAMBER_DATA_DIR, lighten: lightenWorkflowRun }),
  agentSessions: workflowAgentSessions,
  postSynthetic: workflowAgentSessions.postSynthetic,
  broadcast: (event) => broadcastOpenChamberUiEvent(event),
  isEnabled: isWorkflowToolEnabled,
  startsWithoutApproval: (sessionID) => sessionLead.startsWorkflowWithoutApproval(sessionID),
  fsPromises,
  path,
});
void workflowRuntime.start().catch((error) => {
  console.warn('[workflows] failed to restore runs:', error?.message ?? error);
});
const sharePagesRuntime = createSharePagesRuntime({
  crypto,
  store: createSharePageStore({ fsPromises, path, dataDir: OPENCHAMBER_DATA_DIR }),
  relay: createShareRelayClient({ getSigner: createRelayShareSigner({ crypto, relayKeyStore }) }),
  postSynthetic: workflowAgentSessions.postSynthetic,
  onAnswerDelivered: (answer) => notificationTriggerRuntime.notifyShareAnswer(answer),
  broadcast: (event) => broadcastOpenChamberUiEvent(event),
  isAvailable: isSharingAvailable,
  isRelayBaseAllowed,
  resolveRelayBase: async () => resolveShareRelayBase(await readSettingsFromDiskMigrated().catch(() => null)),
});
void sharePagesRuntime.start().catch((error) => {
  console.warn('[share-pages] failed to start:', error?.message ?? error);
});
const receivedPagesRuntime = createReceivedPagesRuntime({
  crypto,
  store: createReceivedPageStore({ fsPromises, path, dataDir: OPENCHAMBER_DATA_DIR }),
  relay: createShareViewerClient(),
  isAvailable: isSharingAvailable,
  isEnterpriseMode: () => isEnterpriseMode(),
  allowedBases: async () => allowedReceiveBases(await readSettingsFromDiskMigrated().catch(() => null)),
  broadcast: (event) => broadcastOpenChamberUiEvent(event),
});
globalMessageStreamHub.subscribeStatus((status) => {
  if (status?.type !== 'connect') return;
  void workflowRuntime.deliverPending();
  void sharePagesRuntime.poll();
});

const messageSearchRuntime = createMessageSearchRuntime({
  dataDir: OPENCHAMBER_DATA_DIR,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  globalEventHub: globalMessageStreamHub,
  getArchivedSessions: () => openChamberSessionService.archiveStore.getAll(),
  applyOwnedArchiveState,
  readSettings: async () => {
    const settings = await readSettingsFromDisk();
    return { enabled: isMessageSearchEnabled(settings), reasoning: settings.messageSearchReasoningEnabled === true };
  },
});

const sessionTodosRuntime = createSessionTodosRuntime({
  dataDir: OPENCHAMBER_DATA_DIR,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  globalEventHub: globalMessageStreamHub,
  getFlagOverrides: () => openCodeLifecycleRuntime.getManagedOpenCodeProcessEnv()?.OPENCODE_FLAGS,
  isSpaceDirectory,
  broadcast: (event) => broadcastOpenChamberUiEvent(event),
});
void sessionTodosRuntime.start().catch((error) => {
  console.warn('[session-todos] failed to start:', error?.message ?? error);
});

const chatDirectoryCleanupRuntime = createChatDirectoryCleanupRuntime({
  roots: [OPENCHAMBER_CHATS_DIR, path.join(OPENCHAMBER_DEFAULT_CONFIG_ROOT, 'chats')],
  createClient: () => openCodeSessionClient(''),
  getOwner: () => ENV_SKIP_OPENCODE_START || isExternalOpenCode || isShuttingDown ? null : openCodeProcess,
});

const desktopUpdateSessions = createDesktopUpdateActiveSessionReadiness({
  readStatuses: () => createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders }).fetchActiveSessionStatuses(),
  isConnected: () => globalMessageStreamHub.isConnected(),
  adoptRunning: (ids, readAt) => sessionRuntime.adoptRunningSessions(ids.filter((id) => !quietCompaction.isQuiet(id)), readAt),
});
const openCodeWatcherRuntime = createOpenCodeWatcherRuntime({
  waitForOpenCodePort: (...args) => waitForOpenCodePort(...args),
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  globalEventHub: globalMessageStreamHub,
  onWirePayload: (payload, { spaceId }) => {
    if (!spaceId) chatDirectoryCleanupRuntime.observeWirePayload(payload);
  },
  onDisconnect: () => { desktopUpdateSessions.disconnect(); chatDirectoryCleanupRuntime.onDisconnected(); },
  onPayload: (payload, { spaceId }) => {
    if (!spaceId) void chatDirectoryCleanupRuntime.processPayload(payload);
    maybeCacheSessionInfoFromEvent(payload, { spaceId });
    void maybeSendPushForTrigger(payload, { spaceId });
    sessionRuntime.processOpenCodeSsePayload(payload, { spaceId });
  },
  onConnect: () => { void chatDirectoryCleanupRuntime.onConnected(); return desktopUpdateSessions.connect(); },
});

globalMessageStreamHub.subscribeEvent((event) => {
  const payload = event?.payload;
  if (!isRecord(payload) || payload.type !== 'location.shutdown') return;
  const directory = (isRecord(payload.location) ? payload.location.directory : undefined) ?? event.directory;
  if (isString(directory) && directory && directory !== 'global') void openCodeTrust.forget(directory);
});
globalMessageStreamHub.subscribeStatus((status) => {
  if (status?.type === 'connect') {
    openCodeTrust.followLocations(true);
    quietCompaction.reset();
    void sessionGoalRuntime.recoverActiveGoals();
    void sessionLead.resumeSleep();
    void hiddenSessions.seed(async (cursor): Promise<JsonValue> => {
      const query = cursor ? `?limit=200&cursor=${encodeURIComponent(cursor)}` : '?limit=200';
      const response = await fetch(buildOpenCodeUrl(`/api/session${query}`, ''), { headers: getOpenCodeAuthHeaders() });
      return response.ok ? response.json() : null;
    }).catch(() => {});
  } else if (status?.type === 'disconnect' || status?.type === 'error') openCodeTrust.followLocations(false);
});

console.log('[session-assist] listening for session events');
globalMessageStreamHub.subscribeEvent((event) => {
  const directory = isString(event?.directory) && event.directory && event.directory !== 'global' ? event.directory : '';
  for (const payload of event?.translated?.() ?? []) {
    followRenamedSession(payload, (sessionID) => openCodeSessionClient().session.get({ sessionID }));
    agentToolRuntime?.processSessionEvent(payload);
    sessionLineage.observe(payload);
    turnDurationRecorder.processPayload(payload, directory || payload.properties?.directory || '');
    sessionAssistRuntime.processPayload(payload, directory || payload.properties?.directory || '');
    sessionWorkRuntime.processPayload(payload, directory || payload.properties?.directory || '');
    sessionGoalRuntime.processPayload(payload, directory || payload.properties?.directory || '');
    contextObligatoryRuntime.processPayload(payload, directory || payload.properties?.directory || '');
    sessionWarmingRuntime.processPayload(payload);
    sessionLead.processPayload(payload, directory || payload.properties?.directory || '');
    trackerSessionStatus.processPayload(payload, { spaceId: event?.spaceId ?? null });
    extensionSessionEvents.processPayload(payload, directory || payload.properties?.directory || '');
  }
});

const processForwardedEventPayload: ForwardEventPayload = (payload, emitSyntheticEvent, { spaceId = null } = { spaceId: null }) => {
  if ((!isRecord(payload) && !Array.isArray(payload)) || !isCallback(emitSyntheticEvent)) {
    return;
  }

  for (const translated of translateWireEvent(payload)) {
    processForwardedServerEvent(translated, emitSyntheticEvent, spaceId);
  }
};

const processForwardedServerEvent = (payload: TranslatedEvent, emitSyntheticEvent: Parameters<ForwardEventPayload>[1], spaceId: string | null = null) => {
  maybeCacheSessionInfoFromEvent(payload, { spaceId });

  if (payload.type !== 'session.status') {
    return;
  }

  const { properties } = payload;
  const statusInfo = properties.status ?? {};
  const sessionId = isString(properties.sessionID) ? properties.sessionID.trim() : '';
  const status = isString(statusInfo.type) ? statusInfo.type.trim() : '';

  if (!sessionId || !status) {
    return;
  }

  const running = status === 'busy' || status === 'retry';
  emitSyntheticEvent({
    type: 'openchamber:session-status',
    properties: {
      sessionID: sessionId,
      status,
      timestamp: Date.now(),
      turnStartedAt: running ? (properties.turnStartedAt ?? sessionRuntime.getRunningTurnStart(sessionId) ?? undefined) : undefined,
      metadata: {
        attempt: isNumber(statusInfo.attempt) ? statusInfo.attempt : undefined,
        message: isString(statusInfo.message) ? statusInfo.message : undefined,
        next: isNumber(statusInfo.next) ? statusInfo.next : undefined,
      },
    },
  });

  emitSyntheticEvent({
    type: 'openchamber:session-activity',
    properties: {
      sessionId,
      phase: running ? 'busy' : 'idle',
    },
  });
};


const mcpOAuthSignIn = createMcpOAuthSignIn({
  storePath: path.join(OPENCHAMBER_DATA_DIR, 'mcp-oauth-assignments.json'),
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  resolveProjectDirectory,
  getMcpConfig,
  listMcpConfigs,
  updateMcpConfig,
});

const serverUtilsRuntime = createServerUtilsRuntime({
  getArchivedSessions: () => openChamberSessionService.archiveStore.getAll(),
  getUnreadBaseline: () => unreadBaseline.get(),
  getStoredSessionMetadata: () => sessionMetadataStore.listUnmigrated(),
  getMergeSpaceSessionList: () => (spacesHost ? (payload) => {
    if (!spacesHost) throw new TypeError("Cannot read properties of null (reading 'mergeSessionList')");
    return spacesHost.mergeSessionList(payload);
  } : null),
  getSpaceEventHub: () => (spacesHost ? globalMessageStreamHub : null),
  hiddenSessions,
  openCodeTrust,
  mcpOAuthSignIn,
  readWorktreeBootstrapStatus: (directory) => getWorktreeBootstrapGateStatus(directory, { bootstrapStore: worktreeBootstrapStore }),
  chatsRoot: OPENCHAMBER_CHATS_DIR,
  getSessionDirectoryCanonicalizer,
  fs,
  os,
  path,
  process,
  openCodeReadyGraceMs: OPEN_CODE_READY_GRACE_MS,
  longRequestTimeoutMs: LONG_REQUEST_TIMEOUT_MS,
  getRuntime: () => ({
    openCodePort,
    openCodeBaseUrl,
    openCodeNotReadySince,
    isOpenCodeReady,
    isRestartingOpenCode,
  }),
  getOpenCodeAuthHeaders,
  buildOpenCodeUrl,
  ensureOpenCodeApiPrefix,
  getUpstreamStallTimeoutMs,
  getUiNotificationClients: () => uiNotificationClients,
  getOpenCodePort: () => openCodePort,
  setOpenCodePortState: (value) => {
    openCodePort = value;
  },
  syncToHmrState,
  markOpenCodeNotReady: () => {
    isOpenCodeReady = false;
  },
  setOpenCodeNotReadySince: (value) => {
    openCodeNotReadySince = value;
  },
  clearLastOpenCodeError: () => {
    lastOpenCodeError = null;
  },
  getLoginShellPath: () => {
    const snapshot = getLoginShellEnvSnapshot();
    if (!snapshot || !isString(snapshot.PATH) || snapshot.PATH.length === 0) {
      return null;
    }
    return snapshot.PATH;
  },
});

const setOpenCodePort: typeof serverUtilsRuntime.setOpenCodePort = (...args) => serverUtilsRuntime.setOpenCodePort(...args);
const waitForOpenCodePort: typeof serverUtilsRuntime.waitForOpenCodePort = (...args) => serverUtilsRuntime.waitForOpenCodePort(...args);
const buildAugmentedPath: typeof serverUtilsRuntime.buildAugmentedPath = (...args) => serverUtilsRuntime.buildAugmentedPath(...args);
const buildManagedOpenCodePath: typeof serverUtilsRuntime.buildManagedOpenCodePath = (...args) => serverUtilsRuntime.buildManagedOpenCodePath(...args);

const savesSecrets = !process.env.OPENCHAMBER_SPACE_IDLE_STOP_FILE;
const environmentStore = createEnvironmentStore({ filePath: path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'environment.json'), savesSecrets });
const listConfiguredProjects = async () => {
  const settings = await readSettingsFromDiskMigrated();
  return sanitizeProjects(settings?.projects || []) ?? [];
};
const environmentRuntime = composeEnvironmentRuntime({
  store: environmentStore,
  listProjects: listConfiguredProjects,
  spawn,
  commandBaseEnv: () => ({ ...process.env, PATH: buildAugmentedPath() }),
  readOpenCodeServiceEnv: () => readOpenCodeServiceEnv(OPENCODE_CONFIG_DIR),
  isEnterpriseMode: () => isEnterpriseMode(),
});
const staticRoutesRuntime = createStaticRoutesRuntime({
  fs,
  path,
  process,
  express,
  resolveProjectDirectory,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readSettingsFromDiskMigrated,
  normalizePwaAppName,
  normalizePwaOrientation,
  isRequestAuthorized: (req, res) => isRequestAuthorized(req, res, { tunnelAuthController, uiAuthController }),
});
const remoteClientAuthRuntime = createRemoteClientAuthRuntime({
  fsPromises,
  path,
  crypto,
  storePath: REMOTE_CLIENTS_FILE_PATH,
});
const clientPushAccess = createClientPushAccess({
  listClients: remoteClientAuthRuntime.listClients,
  authenticateBearerClient: async (req) => {
    const token = getBearerTokenFromRequest(req);
    return token ? (await remoteClientAuthRuntime.authenticateBearerToken(token, req))?.client ?? null : null;
  },
  removeDevicesOfSessions: [apnsRuntime.removeApnsDevicesOfSessions, pushRuntime.removePushDevicesOfSessions],
});
const clientPairingRuntime = createClientPairingRuntime({
  fsPromises,
  path,
  crypto,
  storePath: CLIENT_PAIRING_SESSIONS_FILE_PATH,
  remoteClientAuthRuntime,
});
const featureRoutesRuntime = createFeatureRoutesRuntime({
  clientReloadDelayMs: CLIENT_RELOAD_DELAY_MS,
  trackers: trackerRegistry,
  trackerSessionStatus,
  pluginSwitchStore: createAdaptivePluginSwitchStore({ managedStore: pluginSwitchStore, globalStore: createGlobalConfigPluginSwitchStore(), isGlobalMode: () => isExternalOpenCode || ENV_SKIP_OPENCODE_START }),
  isPluginSwitchAvailable: () => openCodePluginDelivery({ external: isExternalOpenCode || ENV_SKIP_OPENCODE_START, origin: ENV_CONFIGURED_OPENCODE_HOST?.origin || openCodeBaseUrl || null, ownsConfigFile: managedConfigRuntime?.ownsConfigFile() ?? true }) !== 'remote',
  refreshPluginSwitches: async () => ((isExternalOpenCode || ENV_SKIP_OPENCODE_START) ? { updated: true } : (managedConfigRuntime ? managedConfigRuntime.refreshManagedConfigFile() : { updated: false, reason: 'no-managed-opencode' })),
});
const bootstrapRuntime = createBootstrapRuntime({
  createUiAuth,
  registerServerStatusRoutes,
  registerCommonRequestMiddleware,
  registerAuthAndAccessRoutes,
  registerTtsRoutes,
  registerNotificationRoutes,
  registerOpenChamberRoutes,
  registerAgentToolRoutes: (app, options) => {
    options.agentToolRuntime.registerRoutes(app, options.express);
    sessionLead.registerRoutes(app, options.express, options.agentToolRuntime.authorizeRequest);
  },
  express,
});
const tunnelWiringRuntime = createTunnelWiringRuntime({
  crypto,
  URL,
  tunnelProviderRegistry,
  tunnelAuthController,
  readSettingsFromDiskMigrated,
  readManagedRemoteTunnelConfigFromDisk,
  normalizeTunnelProvider,
  normalizeTunnelMode,
  normalizeOptionalPath,
  normalizeManagedRemoteTunnelHostname,
  normalizeTunnelBootstrapTtlMs,
  normalizeTunnelSessionTtlMs,
  isSupportedTunnelMode,
  upsertManagedRemoteTunnelToken,
  resolveManagedRemoteTunnelToken,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TunnelServiceError,
  getActiveTunnelController: () => activeTunnelController,
  setActiveTunnelController: (value) => {
    activeTunnelController = value;
  },
  getRuntimeManagedRemoteTunnelHostname: () => runtimeManagedRemoteTunnelHostname,
  setRuntimeManagedRemoteTunnelHostname: (value) => {
    runtimeManagedRemoteTunnelHostname = value;
  },
  getRuntimeManagedRemoteTunnelToken: () => runtimeManagedRemoteTunnelToken,
  setRuntimeManagedRemoteTunnelToken: (value) => {
    runtimeManagedRemoteTunnelToken = value;
  },
});
const startupPipelineRuntime = createStartupPipelineRuntime({
  createTerminalRuntime,
  createDictationRuntime,
  createMessageStreamWsRuntime,
  createServerStartupRuntime,
});

const openCodeLifecycleState = {
  get openCodeProcess() { return openCodeProcess; },
  set openCodeProcess(value: typeof openCodeProcess) { openCodeProcess = value; },
  get openCodePort() { return openCodePort; },
  set openCodePort(value: typeof openCodePort) { openCodePort = value; },
  get openCodeBaseUrl() { return openCodeBaseUrl; },
  set openCodeBaseUrl(value: typeof openCodeBaseUrl) { openCodeBaseUrl = value; },
  get openCodeWorkingDirectory() { return openCodeWorkingDirectory; },
  set openCodeWorkingDirectory(value: typeof openCodeWorkingDirectory) { openCodeWorkingDirectory = value; },
  get currentRestartPromise() { return currentRestartPromise; },
  set currentRestartPromise(value: typeof currentRestartPromise) { currentRestartPromise = value; },
  get isRestartingOpenCode() { return isRestartingOpenCode; },
  set isRestartingOpenCode(value: typeof isRestartingOpenCode) { isRestartingOpenCode = value; },
  get openCodeApiPrefix() { return openCodeApiPrefix; },
  set openCodeApiPrefix(value: typeof openCodeApiPrefix) { openCodeApiPrefix = value; },
  get openCodeApiPrefixDetected() { return openCodeApiPrefixDetected; },
  set openCodeApiPrefixDetected(value: typeof openCodeApiPrefixDetected) { openCodeApiPrefixDetected = value; },
  get openCodeApiDetectionTimer() { return openCodeApiDetectionTimer; },
  set openCodeApiDetectionTimer(value: typeof openCodeApiDetectionTimer) { openCodeApiDetectionTimer = value; },
  get lastOpenCodeError() { return lastOpenCodeError; },
  set lastOpenCodeError(value: typeof lastOpenCodeError) { lastOpenCodeError = value; },
  get lastOpenCodeLaunchDiagnostics() { return lastOpenCodeLaunchDiagnostics; },
  set lastOpenCodeLaunchDiagnostics(value: typeof lastOpenCodeLaunchDiagnostics) { lastOpenCodeLaunchDiagnostics = value; },
  get lastOpenCodeHealthFailure() { return lastOpenCodeHealthFailure; },
  set lastOpenCodeHealthFailure(value: typeof lastOpenCodeHealthFailure) { lastOpenCodeHealthFailure = value; },
  get lastManagedOpenCodeProcess() { return lastManagedOpenCodeProcess; },
  set lastManagedOpenCodeProcess(value: typeof lastManagedOpenCodeProcess) { lastManagedOpenCodeProcess = value; },
  get lastOpenCodeRestartDiagnostics() { return lastOpenCodeRestartDiagnostics; },
  set lastOpenCodeRestartDiagnostics(value: typeof lastOpenCodeRestartDiagnostics) { lastOpenCodeRestartDiagnostics = value; },
  get isOpenCodeReady() { return isOpenCodeReady; },
  set isOpenCodeReady(value: typeof isOpenCodeReady) { isOpenCodeReady = value; },
  get openCodeNotReadySince() { return openCodeNotReadySince; },
  set openCodeNotReadySince(value: typeof openCodeNotReadySince) { openCodeNotReadySince = value; },
  get isExternalOpenCode() { return isExternalOpenCode; },
  set isExternalOpenCode(value: typeof isExternalOpenCode) { if (isExternalOpenCode !== value) { isExternalOpenCode = value; void managedConfigRuntime?.syncExternalBridge().catch(() => {}); } },
  get isShuttingDown() { return isShuttingDown; },
  set isShuttingDown(value: typeof isShuttingDown) { isShuttingDown = value; },
  get healthCheckInterval() { return healthCheckInterval; },
  set healthCheckInterval(value: typeof healthCheckInterval) { healthCheckInterval = value; },
  get expressApp() { return expressApp; },
  set expressApp(value: typeof expressApp) { expressApp = value; },
  get useWslForOpencode() { return useWslForOpencode; },
  set useWslForOpencode(value: typeof useWslForOpencode) { useWslForOpencode = value; },
  get resolvedWslBinary() { return resolvedWslBinary; },
  set resolvedWslBinary(value: typeof resolvedWslBinary) { resolvedWslBinary = value; },
  get resolvedWslOpencodePath() { return resolvedWslOpencodePath; },
  set resolvedWslOpencodePath(value: typeof resolvedWslOpencodePath) { resolvedWslOpencodePath = value; },
  get resolvedWslDistro() { return resolvedWslDistro; },
  set resolvedWslDistro(value: typeof resolvedWslDistro) { resolvedWslDistro = value; },
};

const openCodeLifecycleRuntime = createOpenCodeLifecycleRuntime({
  state: openCodeLifecycleState,
  env: {
    ENV_CONFIGURED_OPENCODE_PORT,
    ENV_CONFIGURED_OPENCODE_HOST,
    ENV_EFFECTIVE_PORT,
    ENV_CONFIGURED_OPENCODE_HOSTNAME,
    ENV_SKIP_OPENCODE_START,
  },
  syncToHmrState,
  syncFromHmrState,
  getOpenCodeAuthHeaders,
  buildOpenCodeUrl,
  waitForReady,
  normalizeApiPrefix,
  applyOpencodeBinaryFromSettings,
  ensureOpencodeCliEnv,
  ensureLocalOpenCodeServerPassword,
  resolveManagedOpenCodeLaunchSpec,
  setOpenCodePort,
  setDetectedOpenCodeApiPrefix,
  setupProxy: (...args) => setupProxy(...args),
  ensureOpenCodeApiPrefix,
  clearResolvedOpenCodeBinary,
  buildAugmentedPath,
  buildManagedOpenCodePath,
  getManagedOpenCodeShellEnvSnapshot: getLoginShellEnvSnapshot,
  getActiveSessionCount,
  getWarmupDirectories: async () => {
    const settings = await readSettingsFromDiskMigrated().catch(() => null);
    if (!settings) return [];
    const directories = [];
    if (isString(settings.lastDirectory) && settings.lastDirectory) {
      directories.push(settings.lastDirectory);
    }
    const projects = Array.isArray(settings.projects) ? [...settings.projects] : [];
    projects.sort((a, b) => (b?.lastOpenedAt ?? 0) - (a?.lastOpenedAt ?? 0));
    for (const project of projects) {
      if (isString(project?.path) && project.path) {
        directories.push(project.path);
      }
    }
    const existing = await Promise.all([...new Set(directories)].map(async (directory) => (
      await openCodeTrust.isTrusted(directory).catch(() => false)
        && (await fs.promises.stat(directory).catch(() => null))?.isDirectory()
        ? directory
        : null
    )));
    return existing.filter(Boolean);
  },
  noProjectDirectory: OPENCHAMBER_CHATS_DIR,
  // external: #2638 A managed restart can change the upstream port, so event readers reconnect to the current endpoint.
  onOpenCodeRestarted: () => {
    resetOpenCodeRuntimeProviders(); if (!isExternalOpenCode && !healthCheckInterval) startHealthMonitoring();
    try {
      messageStreamRuntime?.rebindUpstream();
    } catch (error) {
      console.warn('Failed to rebind message stream after OpenCode restart:', isRecord(error) ? error.message ?? error : error);
    }
    try {
      const recovery = sessionRuntime.interruptBusySessionsAfterRestart();
      const notification = buildRestartNotification(recovery);
      if (notification) broadcastUiNotification(notification);
    } catch (error) {
      console.warn('Failed to reconcile sessions after OpenCode restart:', isRecord(error) ? error.message ?? error : error);
    }
  },
  getManagedOpenCodeEnv: async () => (retireClaudePlugin({ buildOpenCodeUrl, getOpenCodeAuthHeaders, directory: await openCodeLifecycleRuntime.getDefaultOpenCodeDirectory(), notify: (payload) => broadcastUiNotification(payload) }), managedConfigRuntime ? managedConfigRuntime.buildManagedChildEnv() : {}),
  getUserEnvironment: () => environmentRuntime.forOpenCode(),
  sharedService: createSharedOpenCodeServiceConnector({ readSettings: () => readSettingsFromDiskMigrated(), resolveBinary: () => ensureOpencodeCliEnv(), buildEnv: () => ({ ...getLoginShellEnvSnapshot(), ...process.env, PATH: buildManagedOpenCodePath() }), setAuthPassword: (password, source) => openCodeAuthStateRuntime.setOpenCodeAuthState(password, source), resolveLaunch: (binary) => resolveManagedOpenCodeLaunchSpec(binary) }),
});

configureOpenCodeCredentials(openCodeCredentialSource({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getLaunchEnvironment: () => openCodeLifecycleRuntime.getManagedOpenCodeProcessEnv(),
  getDefaultDirectory: () => openCodeLifecycleRuntime.getDefaultOpenCodeDirectory(),
}));
configureProjectStartCommandSource(openCodeProjectStartCommandSource({ buildOpenCodeUrl, getOpenCodeAuthHeaders }));

const getOpenCodeCompatibility = async () => {
  if (isExternalOpenCode || ENV_SKIP_OPENCODE_START) {
    const base = ENV_CONFIGURED_OPENCODE_HOST?.origin || openCodeBaseUrl || `http://127.0.0.1:${openCodePort || ENV_EFFECTIVE_PORT}`;
    const version = await readExternalOpenCodeVersion(base, getOpenCodeAuthHeaders()).catch(() => null);
    return describeOpenCodeCompatibility(version, 'external', false);
  }
  const binary = ensureOpencodeCliEnv();
  const installation = isBundledOpenCodePath(binary) ? 'bundled' : 'managed';
  const version = await readOpenCodeCliVersion(resolveManagedOpenCodeLaunchSpec(binary)).catch(() => null);
  const pinnedByPolicy = Boolean(readEnterprisePolicy().opencodeBinary);
  return describeOpenCodeCompatibility(version, installation, supportsOpenCodeV2Install() && !pinnedByPolicy, binary || null);
};

const getSharedServiceCliBinary = () => (openCodeLifecycleRuntime.isConnectedViaSharedService() && !isEnterpriseMode() ? resolveServiceCliBinary(ensureOpencodeCliEnv(), { ...getLoginShellEnvSnapshot(), ...process.env, PATH: buildManagedOpenCodePath() }) : null);
const getOpenCodeUpgradeCapability = () => {
  const activeBinary = lastOpenCodeLaunchDiagnostics?.sourceBinary
    || lastOpenCodeLaunchDiagnostics?.binary
    || resolvedOpencodeBinary;
  return resolveOpenCodeUpgradeCapability({
    isExternal: isExternalOpenCode,
    isSharedService: getSharedServiceCliBinary() !== null,
    hasManagedProcess: Boolean(openCodeProcess),
    activeBinary,
    isBundledBinary: isBundledOpenCodePath,
    pinnedByPolicy: Boolean(readEnterprisePolicy().opencodeBinary),
  });
};

const restartOpenCode = async (...args: Parameters<typeof openCodeLifecycleRuntime.restartOpenCode>): Promise<void> => { await openCodeLifecycleRuntime.restartOpenCode(...args); };
const waitForOpenCodeReady: typeof openCodeLifecycleRuntime.waitForOpenCodeReady = (...args) => openCodeLifecycleRuntime.waitForOpenCodeReady(...args);
const refreshOpenCodeAfterConfigChange: typeof openCodeLifecycleRuntime.refreshOpenCodeAfterConfigChange = (...args) => openCodeLifecycleRuntime.refreshOpenCodeAfterConfigChange(...args);
const startHealthMonitoring = () => openCodeLifecycleRuntime.startHealthMonitoring(HEALTH_CHECK_INTERVAL);
const triggerHealthCheck = () => openCodeLifecycleRuntime.triggerHealthCheck();
const scheduledChatsScope = createChatsScope(OPENCHAMBER_CHATS_DIR);
const scheduledWorktreeBridge = createUnregisteredScheduledWorktreeBridge();
const scheduledTasksRuntime = createScheduledTasksRuntime({
  projectConfigRuntime,
  chatsScope: scheduledChatsScope,
  readSessionMetadata: readStoredSessionMetadata,
  messageQueueRuntime,
  resolvePrimaryWorktreeRoot,
  isSessionArchived: (sessionID) => openChamberSessionService.sessionArchive.isArchived(sessionID),
  createTaskWorktree: (input) => {
    const create = scheduledWorktreeBridge.create;
    if (!create) {
      return Promise.reject(new Error('worktree creation is unavailable'));
    }
    return create(input);
  },
  removeTaskWorktree: (input) => scheduledWorktreeBridge.remove(input),
  isGitRepository: (projectDirectory) => scheduledWorktreeBridge.isGitRepository(projectDirectory),
  readSessionDefaults: createReadSessionDefaults({
    readSettings: readSettingsFromDiskMigrated,
    sanitizeProjects,
    chatsScopeID: scheduledChatsScope.id,
  }),
  resolveAutoSelection: (input) => routingRuntime.resolveAutoSelection(input),
  listProjects: async () => {
    const settings = await readSettingsFromDiskMigrated();
    return sanitizeProjects(settings?.projects || []) ?? [];
  },
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  waitForOpenCodeReady,
  sessionKnowledgeRuntime,
  persistSessionGoal: (sessionID, directory, goal) =>
    persistSessionMetadataPatch(sessionID, { openchamber: { goal } }, { directory }),
  setSessionAutoAccept: (sessionId, enabled, directory) => permissionAutoAcceptRuntime.setSessionPolicy(sessionId, enabled, directory),
  emitTaskRunEvent: (event) => {
    for (const client of uiOpenChamberEventClients) {
      try {
        const properties: ScheduledTaskRanProperties = {
          projectId: scheduledChatsScope.toPublicID(event.projectID),
          taskId: event.taskID,
          ranAt: event.ranAt,
          status: event.status,
        };
        if (event.sessionID) properties.sessionId = event.sessionID;
        writeSseEvent(client, { type: 'openchamber:scheduled-task-ran', properties });
      } catch {
        uiOpenChamberEventClients.delete(client);
      }
    }
  },
  logger: console,
});
const emitSessionCreatedEvent = (event: SessionCreatedEvent) => {
  for (const client of uiOpenChamberEventClients) {
    try {
      const properties: SessionCreatedProperties = {
        sessionId: event.sessionID,
        directory: event.directory,
        createdAt: event.createdAt,
        promptDispatched: event.promptDispatched === true,
        dispatchedAsCommand: event.dispatchedAsCommand === true,
      };
      if (event.projectID) properties.projectId = event.projectID;
      if (event.title) properties.title = event.title;
      writeSseEvent(client, { type: 'openchamber:session-created', properties });
    } catch {
      uiOpenChamberEventClients.delete(client);
    }
  }
};
const resolveMemoryProjectId = createMemoryProjectResolver({
  listProjectPaths: async () => {
    const settings = await readSettingsFromDiskMigrated().catch(() => null);
    return (sanitizeProjects(settings?.projects || []) ?? []).map((project) => project.path);
  },
  resolvePrimaryWorktreeRoot,
  managedProjectRoots: [...new Set([path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'chats'), OPENCHAMBER_CHATS_DIR])],
});

const emitAgentMemoryChangedEvent = (event: MemoryChangedEvent) => {
  for (const client of uiOpenChamberEventClients) {
    try {
      const properties: MemoryChangedEvent = { scope: event.scope };
      if (event.projectId) properties.projectId = event.projectId;
      writeSseEvent(client, { type: 'openchamber:agent-memory-changed', properties });
    } catch {
      uiOpenChamberEventClients.delete(client);
    }
  }
};

const memoryDreaming = createMemoryDreaming({
  agentMemoryRuntime,
  readSettings: () => readSettingsFromDiskMigrated(),
  resolveProjectId: (directory) => resolveMemoryProjectId(directory),
  measureIndex: measureMemoryIndex,
  hiddenSessions,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  emitMemoryChanged: emitAgentMemoryChangedEvent,
  isDirectoryTrusted: (directory) => openCodeTrust.isTrusted(directory).catch(() => false),
  resolveSessionDefaults,
  isAutoModel,
});
const readModelCatalog = createModelCatalogReader({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  isOpenCodeDirectoryTrusted: (directory) => openCodeTrust.isTrusted(directory),
});
const scheduledTaskService = createScheduledTaskService({
  readSettingsFromDiskMigrated,
  sanitizeProjects: sanitizeProjectList,
  projectConfigRuntime,
  scheduledTasksRuntime,
  chatsScope: scheduledChatsScope,
  resolvePrimaryWorktreeRoot,
  readModelCatalog,
});
const openChamberSessionService = createOpenChamberSessionService({
  getSessionDirectoryCanonicalizer,
  onSessionArchived: (sessionID, archivedAt) => extensionSessionEvents.processPayload({
    type: 'openchamber:session-archived',
    properties: { sessionID, archivedAt },
  }),
  chatsScope: scheduledChatsScope,
  readSettingsFromDiskMigrated,
  sanitizeProjects: sanitizeProjectList,
  validateDirectoryPath,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  waitForOpenCodeReady,
  emitSessionCreatedEvent,
  sessionKnowledgeRuntime,
  worktreeBootstrapStore,
  hydrateWorktreeCheckout: featureRoutesRuntime.hydrateBoundCheckout,
  createChangeRequestWorktree: featureRoutesRuntime.createChangeRequestWorktree,
  dataDir: OPENCHAMBER_DATA_DIR,
  sessionMetadataStore,
  persistSessionMetadata: persistSessionMetadataPatch,
  updateSessionMetadata: updateSessionMetadataWith,
  broadcastGlobalUiEvent: broadcastOpenChamberUiEvent,
  resolveAutoSelection: (input) => routingRuntime.resolveAutoSelection(input),
  isAutoReady: async () => (await routingRuntime.describe()).autoReady,
  readProjectSetup: (projectID) => projectConfigRuntime.readProjectSetup(projectID),
});
const browserClientEvents = createBrowserClientEvents({ clients: uiOpenChamberEventClients, writeEvent: writeSseEvent });
const browserControlBroker = createBrowserControlBroker({
  createId: () => `browser-${crypto.randomUUID()}`,
  emitRequest: browserClientEvents.emitRequest,
});

const emitBrowserProviderResetEvent = ({ guestId, guestName }: BrowserProviderReset) => {
  for (const client of uiOpenChamberEventClients) {
    try {
      writeSseEvent(client, {
        type: 'openchamber:browser-provider-reset',
        properties: { guestId, guestName },
      });
    } catch {
      uiOpenChamberEventClients.delete(client);
    }
  }
};
const browserControlRouter = createBrowserControlRouter({
  broker: browserControlBroker,
  readSettings: () => readSettingsFromDiskMigrated(),
  persistSettings: (changes) => persistSettings(changes),
  findGuest: (id) => findInstalledGuest(id, extensionsPersistPath(OPENCHAMBER_DATA_DIR)),
  persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR),
  emitProviderReset: emitBrowserProviderResetEvent,
  createId: () => `browser-${crypto.randomUUID()}`,
  surfaceControl: {
    userControls: (guestId) => guestSurfaceRuntime?.userControls(guestId) ?? false,
    noteAgentActivity: (guestId) => guestSurfaceRuntime?.noteAgentActivity(guestId),
  },
});

const fileOpenRequester = createFileOpenRequester({
  emit: (request) => {
    let delivered = 0;
    for (const client of uiOpenChamberEventClients) {
      try {
        writeSseEvent(client, { type: 'openchamber:file-open-request', properties: request });
        delivered += 1;
      } catch {
        uiOpenChamberEventClients.delete(client);
      }
    }
    return delivered;
  },
});

const pluginNotificationEmitter = createPluginNotificationEmitter({
  readSettingsFromDiskMigrated, emitDesktopNotification, broadcastUiNotification,
  pushPluginNotification: notificationTriggerRuntime.pushPluginNotification,
});

const secretFiles = createSecretFiles({ directory: path.join(OPENCHAMBER_DATA_DIR, 'secrets') });
void secretFiles.sweep();
setInterval(() => { void secretFiles.sweep(); }, 60 * 60 * 1000).unref();

const insideSpaceTaskNaming = process.env.OPENCHAMBER_SPACE_TASK_TITLE_FILE && process.env.OPENCHAMBER_SPACE_USER_TASK_TITLE_FILE
  ? createInsideSpaceTaskNaming({
    agentFile: process.env.OPENCHAMBER_SPACE_TASK_TITLE_FILE,
    userFile: process.env.OPENCHAMBER_SPACE_USER_TASK_TITLE_FILE,
    announce: broadcastOpenChamberUiEvent,
  }) : null;

const announceGuestMarksChanged = () => broadcastOpenChamberUiEvent({ type: 'openchamber:guest-marks-changed', properties: {} });
onGuestServiceEnded((guestId) => {
  if (guestMarks.dropEnded(guestId)) announceGuestMarksChanged();
});

const serviceHostApi = createServiceHostApi({
  listGuests: () => listInstalledGuests({ persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR) }),
  control: {
    execute: executeServiceControl,
    resolveSessionDirectory: (sessionID) => openChamberControlService.resolveSessionDirectory(sessionID),
    stopSession: (sessionID) => openChamberControlService.stopSession(sessionID),
    answerPermission: (input) => openChamberControlService.answerPermission(input),
    answerForm: (input) => openChamberControlService.answerForm(input),
    dismissOpenForms: (sessionID) => openChamberControlService.dismissOpenForms(sessionID),
  },
  instructions: guestInstructions,
  readSettings: async (guest) => (await getGuestAuth(guest.id, guestAuthPersistPath(OPENCHAMBER_DATA_DIR)))?.settings ?? {},
  emitToFrames: (guestId, topic, data) => broadcastOpenChamberUiEvent({
    type: 'openchamber:guest-service-event',
    properties: { guestId, topic, data },
  }),
  setConfigurationNote: (guestId, message) => {
    if (setGuestConfigurationNote(guestId, message)) broadcastOpenChamberUiEvent({ type: 'openchamber:guests-changed', properties: {} });
  },
  marks: {
    set: (...args) => {
      const outcome = guestMarks.set(...args);
      if (outcome === 'changed') announceGuestMarksChanged();
      return outcome;
    },
  },
});
serviceHostApi.register();

function executeServiceControl(action: 'session.create' | 'session.send', input?: ControlInput, contextDirectory?: ControlInput['directory'], options?: ControlOptions): Promise<SessionActionResult>;
function executeServiceControl<Action extends SessionReadAction>(action: Action, input?: ControlInput, contextDirectory?: ControlInput['directory'], options?: ControlOptions): Promise<SessionReadResults[Action]>;
function executeServiceControl(action: string, input?: ControlInput, contextDirectory?: ControlInput['directory'], options?: ControlOptions) {
  return openChamberControlService.execute(action, input, contextDirectory, options);
}

const browserUploadStore = createUploadStore();
const sessionFoldersStore = createSessionFoldersStore({ fsPromises, path, openchamberDataDir: OPENCHAMBER_DATA_DIR, onChanged: (updatedAt) => broadcastOpenChamberUiEvent({ type: 'openchamber:session-folders-changed', properties: { updatedAt } }) });
const openChamberControlService = createOpenChamberControlService({
  sessionFoldersStore,
  isHiddenSession: (sessionID, record) => hiddenSessions.has(sessionID, record),
  chatsScope: scheduledChatsScope,
  chatRoots: [path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'chats'), OPENCHAMBER_CHATS_DIR],
  updateSessionMetadata: updateSessionMetadataWith,
  isWorktreePinned: isWorktreeDirectoryPinned,
  readPendingRequests: () => sessionRuntime.getPendingBlockingRequestsSnapshot(),
  isPermissionAutoAnswered: (sessionId, directory, permissionId) => permissionAutoAcceptRuntime.isPermissionAutoAnswered(sessionId, directory, permissionId),
  readSettingsFromDiskMigrated,
  sanitizeProjects: sanitizeProjectList,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  waitForOpenCodeReady,
  isOpenCodeDirectoryTrusted: (directory) => openCodeTrust.isTrusted(directory),
  sessionService: openChamberSessionService,
  scheduledTaskService,
  browserControl: browserControlRouter,
  browserUploads: browserUploadStore,
  fileOpen: fileOpenRequester,
  projectContextRuntime,
  resolveProjectContextId: resolveMemoryProjectId,
  showPlan: (request) => {
    let delivered = 0;
    for (const client of uiOpenChamberEventClients) {
      try {
        writeSseEvent(client, { type: 'openchamber:plan-open-request', properties: request });
        delivered += 1;
      } catch {
        uiOpenChamberEventClients.delete(client);
      }
    }
    return delivered;
  },
  isKnowledgeToolEnabled: async () => (await readSettingsFromDiskMigrated().catch(() => null))?.agentKnowledgeToolEnabled !== false,
  isRenderToolEnabled: async () => (await readSettingsFromDiskMigrated().catch(() => null))?.agentRenderToolEnabled !== false,
  isSecretToolEnabled: async () => (await readSettingsFromDiskMigrated().catch(() => null))?.agentSecretToolEnabled !== false,
  secretFiles, savedSecrets: savesSecrets ? createSavedSecrets({ store: environmentStore, projectIdFor: environmentRuntime.projectIdFor }) : null,
  onPageWaitChange: (change) => {
    sessionRuntime.trackWaitingPage(change);
    if (change.type === 'waiting') {
      const payload = {
        type: 'openchamber:page-waiting',
        properties: { sessionID: change.sessionId, directory: change.directory, page: { id: change.callId, title: change.title } },
      };
      broadcastOpenChamberUiEvent(payload);
      void maybeSendPushForTrigger(payload);
      extensionSessionEvents.processPayload(payload, change.directory ?? undefined);
      return;
    }
    const settled = {
      type: 'openchamber:page-settled',
      properties: { sessionID: change.sessionId, pageID: change.callId },
    };
    broadcastOpenChamberUiEvent(settled);
    void maybeSendPushForTrigger(settled);
    extensionSessionEvents.processPayload(settled);
  },
  notifyUser: async (input) => {
    const settings = await readSettingsFromDiskMigrated().catch(() => null);
    if (settings?.agentNotifyToolEnabled !== true) {
      return { status: 403, body: { error: 'The notify tool is turned off in OpenChamber settings' } };
    }
    return pluginNotificationEmitter.emit(input);
  },
  agentMemoryActions: createAgentMemoryActions({
    agentMemoryRuntime,
    createError: (message, status) => new OpenChamberControlError(message, status),
    onMemoryChanged: emitAgentMemoryChangedEvent,
    isAgentMemoryEnabled,
    resolveProjectId: resolveMemoryProjectId,
  }),
  sessionLinks: createSessionLinker({
    trackers: trackerRegistry,
    updateMetadata: updateSessionMetadataWith,
    createError: (message, status) => new OpenChamberControlError(message, status),
  }),
  workNaming: {
    nameSpaceTask: (directory, title) => insideSpaceTaskNaming?.name(directory, title) ?? null,
    listWorktrees: getWorktrees,
    setWorktreeTaskTitle: setLinkedTaskTitle,
    readPlaceholderBranch: (directory) => readRenameableGeneratedBranch(directory),
    renamePlaceholderBranch: renameGeneratedWorktreeBranch,
  },
  dispatchResults: dispatchResultsRuntime,
  prWatch: prWatchRuntime,
  extensionWaits: extensionWaitsRuntime,
  laterPages: process.env.OPENCHAMBER_SPACE_IDLE_STOP_FILE ? null : laterPagesRuntime,
  workflowRuntime,
  leadActions: sessionLead.actions,
  sharePages: sharePagesRuntime,
  archiveStore: openChamberSessionService.archiveStore,
  loadQuota: () => import('./lib/quota/index.js'),
  getTerminalRuntime: () => terminalRuntime,
});

const ensureGlobalWatcherStarted = async () => {
  if (globalWatcherStartPromise) {
    return globalWatcherStartPromise;
  }

  globalWatcherStartPromise = openCodeWatcherRuntime.start().catch((error) => {
    globalWatcherStartPromise = null;
    throw error;
  });

  return globalWatcherStartPromise;
};
const bootstrapOpenCodeAtStartup = async (...args: Parameters<typeof openCodeLifecycleRuntime.bootstrapOpenCodeAtStartup>) => {
  await openCodeLifecycleRuntime.bootstrapOpenCodeAtStartup(...args);
  if (openCodeLifecycleRuntime.scheduleBootstrapRetry(bootstrapOpenCodeAtStartup, finishOpenCodeBootstrap)) return;
  finishOpenCodeBootstrap();
};
const finishOpenCodeBootstrap = () => {
  scheduleOpenCodeApiDetection();
  if (openCodeLifecycleState.openCodeProcess && !openCodeLifecycleState.isExternalOpenCode) {
    startHealthMonitoring();
  }
  void ensureGlobalWatcherStarted().catch((error) => {
    console.warn(`Global event watcher startup failed: ${error?.message || error}`);
  });
  for (const [name, migrate] of [
    ['session metadata migration', () => sessionMetadataStore.migrateLegacy()],
    ['session archive migration', () => openChamberSessionService.sessionArchive.migrateLegacy()],
    ['mapped drive session repair', async () => getSessionDirectoryCanonicalizer() && relocateSessionsFromDriveTargets({ projects: await readProjectPaths(() => readSettingsFromDiskMigrated())(), client: openCodeSessionClient() })],
  ] as const) void waitForOpenCodeReady().then(migrate).catch((error) => console.warn(`[openchamber-sessions] ${name} failed:`, error?.message ?? error));
};
const killProcessOnPort: typeof openCodeLifecycleRuntime.killProcessOnPort = (...args) => openCodeLifecycleRuntime.killProcessOnPort(...args);
const waitForPortRelease: typeof openCodeLifecycleRuntime.waitForPortRelease = (...args) => openCodeLifecycleRuntime.waitForPortRelease(...args);

const setupProxy: typeof serverUtilsRuntime.setupProxy = (...args) => serverUtilsRuntime.setupProxy(...args);
const gracefulShutdownRuntime = createGracefulShutdownRuntime({
  process,
  shutdownTimeoutMs: SHUTDOWN_TIMEOUT,
  getExitOnShutdown: () => exitOnShutdown,
  getIsShuttingDown: () => isShuttingDown,
  setIsShuttingDown: (value) => {
    isShuttingDown = value;
  },
  syncToHmrState,
  openCodeWatcherRuntime,
  chatDirectoryCleanupRuntime,
  sessionAssistRuntime,
  sessionWorkRuntime,
  sessionGoalRuntime,
  contextObligatoryRuntime,
  sessionWarmingRuntime,
  sessionTodosRuntime,
  autoReviewRuntime,
  prWatchRuntime,
  extensionWaitsRuntime,
  messageQueueRuntime,
  mergeFollowRuntime,
  dispatchResultsRuntime,
  workflowRuntime,
  messageSearchRuntime,
  sessionRuntime,
  getHealthCheckInterval: () => healthCheckInterval,
  clearHealthCheckInterval: (value) => clearInterval(value),
  getTerminalRuntime: () => terminalRuntime,
  setTerminalRuntime: (value) => {
    terminalRuntime = value;
  },
  getMessageStreamRuntime: () => messageStreamRuntime,
  setMessageStreamRuntime: (value) => {
    messageStreamRuntime = value;
  },
  shouldSkipOpenCodeStop: () => ENV_SKIP_OPENCODE_START || isExternalOpenCode,
  getOpenCodePort: () => openCodePort,
  getOpenCodeProcess: () => openCodeProcess,
  setOpenCodeProcess: (value) => {
    openCodeProcess = value;
  },
  killProcessOnPort,
  waitForPortRelease,
  getServer: () => server,
  getUiAuthController: () => uiAuthController,
  setUiAuthController: (value) => {
    uiAuthController = value;
  },
  getActiveTunnelController: () => activeTunnelController,
  setActiveTunnelController: (value) => {
    activeTunnelController = value;
  },
  tunnelAuthController,
  scheduledTasksRuntime,
  beginGuestServiceShutdown,
  stopAllGuestServices,
  extensionSessionEvents,
  extensionServiceLifetime,
  getGuestSurfaceRuntime: () => guestSurfaceRuntime,
  getRealtimeProxyRuntime: () => realtimeProxyRuntime,
  getDictationRuntime: () => dictationRuntime,
  getRelayService: () => relayServiceInstance,
  getRelayReconcileTimer: () => relayReconcileTimer,
  getSpacesHost: () => spacesHost,
  stopFolderWatches: async () => { stopEnterprisePolicyWatch(); featureRoutesRuntime.stopFolderWatches(); await managedConfigRuntime?.cleanupExternalBridge(); },
});

const gracefulShutdown: typeof gracefulShutdownRuntime.gracefulShutdown = (...args) => gracefulShutdownRuntime.gracefulShutdown(...args);

async function main(options: WebUiServerOptions = {}) {
  beginGuestServiceHost({ registryDir: guestServiceRegistryDir(OPENCHAMBER_DATA_DIR) });
  applyOutboundProxyFromEnv();
  const port = isNumber(options.port) && Number.isFinite(options.port) && options.port >= 0 ? Math.trunc(options.port) : DEFAULT_PORT;
  const host = isString(options.host) && options.host.length > 0 ? options.host : undefined;
  const effectiveBindHost = host
    || (isString(process.env.OPENCHAMBER_HOST) && process.env.OPENCHAMBER_HOST.trim().length > 0
      ? process.env.OPENCHAMBER_HOST.trim()
      : '127.0.0.1');
  const instanceDir = await prepareInstanceDir({ fsPromises, path, dataDir: OPENCHAMBER_DATA_DIR });
  agentToolRuntime = createAgentToolRuntime({
    crypto,
    fsPromises,
    path,
    instanceDir,
    env: process.env,
    executeAction: (...args) => openChamberControlService.execute(...args),
    resolveSessionDirectory: (sessionID) => openChamberControlService.resolveSessionDirectory(sessionID),
    releaseAnswerWaits: (sessionID) => openChamberControlService.releaseAnswerWaits(sessionID),
    projectActions: { readSettings: readSettingsFromDiskMigrated, getTerminalRuntime: () => terminalRuntime,
      projectPathFor: openChamberSessionService.projectPathFor, readProjectSetup: projectConfigRuntime.readProjectSetup },
    getActivePort: () => {
      const address = server?.address?.();
      return address && !isString(address) ? address.port : null;
    },
    getActiveHost: () => {
      const address = server?.address?.();
      return address && !isString(address) ? address.address : null;
    },
  });
  limitFailoverRuntime = createLimitFailoverRuntime({
    fsPromises,
    path,
    instanceDir,
    readSettings: () => readSettingsFromDiskMigrated(),
    authorizeRequest: (req) => {
      if (!agentToolRuntime) throw new TypeError("Cannot read properties of null (reading 'authorizeRequest')");
      return agentToolRuntime.authorizeRequest(req);
    },
    broadcastUiEvent: (event) => broadcastOpenChamberUiEvent(event),
  });
  const getOpenCodePluginDelivery = () => openCodePluginDelivery({ external: isExternalOpenCode || ENV_SKIP_OPENCODE_START, origin: ENV_CONFIGURED_OPENCODE_HOST?.origin || openCodeBaseUrl || null, ownsConfigFile: managedConfigRuntime?.ownsConfigFile() ?? true });
  managedConfigRuntime = createManagedConfigRuntime({
    fsPromises,
    path,
    instanceDir,
    dataDir: OPENCHAMBER_DATA_DIR,
    env: process.env,
    agentToolRuntime,
    limitFailoverRuntime,
    readSettings: () => readSettingsFromDiskMigrated(),
    listExtensionSkillDirectories: guestAgentContext.skillDirectories,
    listExtensionPluginDirectories: guestAgentContext.pluginDirectories,
    openchamberVersion: OPENCHAMBER_VERSION,
    readPluginDenials: () => pluginSwitchStore.denials(),
    getOpenCodePluginDelivery,
  });
  stopEnterprisePolicyWatch = watchEnterprisePolicy({
    onChange: () => {
      if (!managedConfigRuntime) throw new TypeError("Cannot read properties of null (reading 'refreshManagedConfigFile')");
      managedConfigRuntime.refreshManagedConfigFile().catch((error) => {
        console.warn('Failed to rewrite the managed OpenCode config after a policy change:', error?.message ?? error);
      });
      broadcastOpenChamberUiEvent({ type: 'openchamber:guests-changed' });
    },
  });
  await ensureChatsDir({ fsPromises, chatsDir: OPENCHAMBER_CHATS_DIR, warn: (message) => console.warn(`[data-dir] ${message}`) });
  await scheduledChatsScope.refreshRealRoot();

  const requestReachedLanAddress = (req: Request) => {
    const raw = isString(req?.socket?.localAddress) ? req.socket.localAddress : '';
    const address = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) return null;
    if (address.startsWith('127.')) return null;
    return address;
  };
  const advertisedLanUrl = readAdvertisedLanUrl();
  const resolvePairingTransports = (req: Request) => {
    const activePort = tunnelRuntimeContext.getActivePort() || port;
    const local = `http://127.0.0.1:${activePort}`;
    if (advertisedLanUrl) {
      return { local, lan: advertisedLanUrl, relayAvailable: !relayBlockedByEnterprise() };
    }
    let lanHost: string | null = null;
    if (isNetworkExposedBindHost(effectiveBindHost)) {
      lanHost = requestReachedLanAddress(req);
      try {
        if (!lanHost) {
          for (const list of Object.values(os.networkInterfaces())) {
            for (const entry of (list || [])) {
              if (entry.family === 'IPv4' && !entry.internal) { lanHost = entry.address; break; }
            }
            if (lanHost) break;
          }
        }
      } catch {
        lanHost = null;
      }
    } else {
      const h = String(effectiveBindHost || '').toLowerCase();
      if (h && h !== '127.0.0.1' && h !== 'localhost' && h !== '::1') lanHost = effectiveBindHost;
    }
    const lan = lanHost ? `http://${lanHost.includes(':') ? `[${lanHost}]` : lanHost}:${activePort}` : null;
    return { local, lan, relayAvailable: !relayBlockedByEnterprise() };
  };
  const resolveDirectLanUrls = (req: Request) => {
    if (advertisedLanUrl) return [advertisedLanUrl];
    const activePort = tunnelRuntimeContext.getActivePort() || port;
    const urls: string[] = [];
    const push = (host: string | null | undefined) => {
      if (!isString(host) || !host) return;
      const url = `http://${host.includes(':') ? `[${host}]` : host}:${activePort}`;
      if (!urls.includes(url)) urls.push(url);
    };
    if (isNetworkExposedBindHost(effectiveBindHost)) {
      push(requestReachedLanAddress(req));
      try {
        for (const list of Object.values(os.networkInterfaces())) {
          for (const entry of (list || [])) {
            if (entry.family === 'IPv4' && !entry.internal) push(entry.address);
          }
        }
      } catch {
        return urls;
      }
    } else {
      const h = String(effectiveBindHost || '').toLowerCase();
      if (h && h !== '127.0.0.1' && h !== 'localhost' && h !== '::1') push(effectiveBindHost);
    }
    return urls;
  };
  const uiPassword = isString(options.uiPassword)
    ? options.uiPassword
    : (isString(process.env.OPENCHAMBER_UI_PASSWORD) ? process.env.OPENCHAMBER_UI_PASSWORD : null);
  if (
    isNetworkExposedBindHost(effectiveBindHost)
    && !(isString(uiPassword) && uiPassword.trim().length > 0)
    && !isUnsafeUnauthenticatedLanAllowed(process.env)
  ) {
    throw new Error(getUnauthenticatedLanErrorMessage(effectiveBindHost));
  }
  if (isNetworkExposedBindHost(effectiveBindHost) && isNetworkAccessBlocked()) {
    throw new Error(NETWORK_ACCESS_BLOCKED_ERROR);
  }
  const tryCfTunnel = options.tryCfTunnel === true;
  const apiOnly = options.apiOnly === true || isEnvFlagEnabled(process.env.OPENCHAMBER_API_ONLY);
  const shouldUseCanonicalTunnelConfig = isString(options.tunnelMode)
    || isString(options.tunnelProvider)
    || options.tunnelConfigPath === null
    || isString(options.tunnelConfigPath)
    || isString(options.tunnelToken)
    || isString(options.tunnelHostname);
  const startupTunnelRequest = shouldUseCanonicalTunnelConfig
    ? normalizeTunnelStartRequest({
        provider: normalizeTunnelProvider(options.tunnelProvider),
        mode: options.tunnelMode,
        configPath: normalizeOptionalPath(options.tunnelConfigPath),
        token: isString(options.tunnelToken) ? options.tunnelToken.trim() : '',
        hostname: normalizeManagedRemoteTunnelHostname(options.tunnelHostname),
      })
    : (tryCfTunnel
      ? {
          provider: TUNNEL_PROVIDER_CLOUDFLARE,
          mode: TUNNEL_MODE_QUICK,
          configPath: undefined,
          token: '',
          hostname: undefined,
        }
      : null);
  const attachSignals = options.attachSignals !== false;
  const onTunnelReady = isCallback(options.onTunnelReady) ? options.onTunnelReady : null;
  if (isBoolean(options.exitOnShutdown)) {
    exitOnShutdown = options.exitOnShutdown;
  }
  if (isCallback(options.onDesktopNotification)) {
    notificationEmitterRuntime.setOnDesktopNotification(options.onDesktopNotification);
  }
  if (isCallback(options.getIsWindowFocused)) {
    notificationTriggerRuntime.setGetIsWindowFocused(options.getIsWindowFocused);
  }
  const getDesktopRuntimeConfig = isCallback(options.getDesktopRuntimeConfig)
    ? options.getDesktopRuntimeConfig
    : null;
  const desktopUpdater = options.desktopUpdater
    && isCallback(options.desktopUpdater.check)
    && isCallback(options.desktopUpdater.install)
    && isCallback(options.desktopUpdater.restart)
    ? options.desktopUpdater
    : null;

  console.log(`Starting OpenChamber on port ${port === 0 ? 'auto' : port}`);

  const sayTTSCapability = detectSayTtsCapability(process);

  const hostOpenCodeClient = () => createOpenCodeClient({
    baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
    headers: getOpenCodeAuthHeaders(),
  });
  const spaceArchive = createSpaceArchive({
    dataDir: OPENCHAMBER_DATA_DIR,
    hostOpenCode: {
      importChat: (chat) => hostOpenCodeClient().experimental.session.import(chat),
      removeChat: (sessionID) => hostOpenCodeClient().session.remove({ sessionID }),
    },
  });

  const readSshHostSetting = async () => {
    const sshHost = (await readSettingsFromDiskMigrated().catch(() => null))?.isolatedSpacesSshHost;
    return isString(sshHost) ? sshHost : undefined;
  };
  const buildSpacesHost = async () => createSpacesHost({
    dataDir: OPENCHAMBER_DATA_DIR,
    dockerPath: searchPathFor('docker', buildAugmentedPath()) ?? 'docker',
    sshDockerHost: dockerHostOf(await readSshHostSetting()),
    colimaPath: searchPathFor('colima', buildAugmentedPath()),
    findProgram: (name) => searchPathFor(name, buildAugmentedPath()) ?? null,
    gitPath: searchPathFor('git', buildAugmentedPath()) ?? 'git',
    hostEnvironment: { ...process.env, PATH: buildAugmentedPath() },
    listProjectDirectories: async () => {
      const settings = await readSettingsFromDiskMigrated();
      return (sanitizeProjects(settings?.projects || []) ?? []).map((project) => project.path);
    },
    readIdleStop: async () => readIdleStopSetting((await readSettingsFromDiskMigrated())?.isolatedSpacesIdleStop),
    saveIdleStop: (setting) => persistSettings({ isolatedSpacesIdleStop: setting }),
    readPermissionDefault: async () => permissionDefaultOf((await readSettingsFromDiskMigrated())?.permissionDefaultMode),
    archive: spaceArchive,
    userAgent: `OpenChamber/${OPENCHAMBER_VERSION}`,
  });
  const startupSettings = await readSettingsFromDiskMigrated().catch(() => null);
  if (startupSettings?.isolatedSpacesEnabled === true) {
    try {
      spacesHost = await buildSpacesHost();
    } catch (error) {
      console.error(`[spaces] isolated spaces are unavailable this start: ${isRecord(error) ? error.code ?? '' : ''} ${isRecord(error) ? error.message ?? error : error}`.trim());
      spacesHost = null;
    }
  }

  const app = express();
  const serverStartedAt = new Date().toISOString();
  const allowLocalDevOrigins = allowsLocalDevOrigins(process.env);
  const frameAncestorsPolicy = buildFrameAncestorsPolicy({
    allowLocalDevOrigins,
    extra: process.env.OPENCHAMBER_FRAME_ANCESTORS,
  });
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use((req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (!req.path.startsWith('/api/preview/proxy/')) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'same-origin');
      res.setHeader('Content-Security-Policy', frameAncestorsPolicy);
    }
    next();
  });
  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /\n');
  });
  app.use((req, res, next) => {
    const corsHeaders = resolveClientCorsHeaders(req, { allowLocalDevOrigins });
    if (corsHeaders) {
      for (const [name, value] of Object.entries(corsHeaders)) res.setHeader(name, value);
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }
    return spacesHost ? spacesHost.dispatcher.validateDirectoryHeaders(req, res, next) : next();
  });
  app.use(compression({
    filter: (req: Request, res: Response) => {
      if (shouldSkipCompression(req, res)) return false;
      return compression.filter(req, res);
    },
    threshold: 1024,
  }));
  expressApp = app;
  server = http.createServer(app);
  server.keepAliveTimeout = 125_000;
  server.headersTimeout = 126_000;
  gracefulShutdownRuntime.trackServerConnections(server);
  if (isNetworkExposedBindHost(effectiveBindHost)) {
    server.on('connection', (socket) => {
      if (!isLoopbackBindHost(socket.remoteAddress ?? '') && isNetworkAccessBlocked()) socket.destroy();
    });
  }
  let tunnelRuntimeContextHolder: ReturnType<typeof tunnelWiringRuntime.initialize> | null = null;

  const bootstrapResult = bootstrapRuntime.setupBaseRoutes(app, {
    process,
    openchamberVersion: OPENCHAMBER_VERSION,
    runtimeName: process.env.OPENCHAMBER_RUNTIME || 'web',
    serverStartedAt,
    gracefulShutdown,
    readOpenCodeLoad: () => readOpenCodeLoad({ buildOpenCodeUrl, getOpenCodeAuthHeaders }),
    getHealthSnapshot: () => {
      const launchSpec = resolvedOpencodeBinary && !useWslForOpencode && !isExternalOpenCode
        ? resolveManagedOpenCodeLaunchSpec(resolvedOpencodeBinary)
        : null;
      return {
        openCodePort,
        openCodeRunning: Boolean(openCodePort && isOpenCodeReady && !isRestartingOpenCode),
        openCodeSecureConnection: isOpenCodeConnectionSecure(),
        openCodeAuthSource: openCodeAuthSource || null,
        openCodeApiPrefix: '',
        openCodeApiPrefixDetected: true,
        isOpenCodeReady,
        lastOpenCodeError,
        lastOpenCodeLaunchDiagnostics,
        lastOpenCodeHealthFailure,
        lastManagedOpenCodeProcess,
        lastOpenCodeRestartDiagnostics,
        opencodeBinaryResolved: resolvedOpencodeBinary || null,
        opencodeBinarySource: isExternalOpenCode ? (openCodeLifecycleRuntime.isConnectedViaSharedService() ? 'shared-service' : 'external') : resolvedOpencodeBinarySource || null,
        opencodeLaunchBinary: launchSpec?.binary || null,
        opencodeLaunchArgs: launchSpec?.args || [],
        opencodeLaunchWrapperType: launchSpec?.wrapperType || null,
        opencodeViaWsl: useWslForOpencode,
        opencodeWslBinary: resolvedWslBinary || null,
        opencodeWslPath: resolvedWslOpencodePath || null,
        opencodeWslDistro: resolvedWslDistro || null,
        nodeBinaryResolved: resolvedNodeBinary || null,
        bunBinaryResolved: resolvedBunBinary || null,
        desktopNotifyEnabled: ENV_DESKTOP_NOTIFY,
        apiOnly,
      };
    },
    getServerPort: () => {
      const activePort = tunnelRuntimeContextHolder?.getActivePort?.();
      if (isNumber(activePort) && Number.isFinite(activePort) && activePort > 0) return activePort;
      return Number.isFinite(port) && port > 0 ? port : null;
    },
    getTunnelUrl: () => tunnelRuntimeContextHolder?.tunnelService?.getPublicUrl?.() ?? null,
    verboseRequestLogs: OPENCHAMBER_VERBOSE_REQUEST_LOGS,
    uiPassword,
    tunnelAuthController,
    remoteClientAuthRuntime,
    clientPairingRuntime,
    getRelayPairingCandidate: (options) => {
      if (!relayServiceInstance) return null;
      return options?.ensureEnabled
        ? relayServiceInstance.ensureEnabledForPairing()
        : relayServiceInstance.getPairingCandidate();
    },
    reconcileRelay: () => (relayServiceInstance ? relayServiceInstance.reconcile() : Promise.resolve()),
    removeClientPushDevices: clientPushAccess.removeDevicesOfClients,
    getPairingTransports: resolvePairingTransports,
    getDirectCandidateUrls: resolveDirectLanUrls,
    getServerId: () => (relayServiceInstance ? relayServiceInstance.getServerId() : Promise.resolve(null)),
    getServerLabel: () => {
      try {
        const name = os.hostname();
        return isString(name) && name.trim().length > 0 ? name.trim() : 'OpenChamber';
      } catch {
        return 'OpenChamber';
      }
    },
    readSettingsFromDiskMigrated,
    normalizeTunnelSessionTtlMs,
    sayTTSCapability,
    ensurePushInitialized,
    ensureGlobalWatcherStarted,
    getOrCreateVapidKeys,
    getUiSessionTokenFromRequest,
    updateSettingsFromDisk: settingsRuntime.updateSettingsFromDisk,
    addOrUpdatePushSubscription,
    removePushSubscription,
    addOrUpdateApnsToken,
    removeApnsToken,
    updateUiVisibility,
    clearPendingPushBadge: () => clearPendingPushBadge(),
    clearSessionPushNotifications: notificationTriggerRuntime.clearSessionPushNotifications,
    isUiVisible,
    getUiNotificationClients: () => uiNotificationClients,
    writeSseEvent,
    pluginNotificationEmitter,
    sessionRuntime,
    setPushInitialized,
    fs,
    os,
    path,
    server,
    cliEntry: fileURLToPath(new URL('../bin/cli.js', import.meta.url)),
    openchamberDataDir: OPENCHAMBER_DATA_DIR,
    modelsDevApiUrl: MODELS_DEV_API_URL,
    modelsMetadataCacheTtl: MODELS_METADATA_CACHE_TTL,
    fetchFreeZenModels,
    getCachedZenModels,
    setAutoAcceptSession,
    isLocalOnlyPushRequest: (req, uiSessionToken) => clientPushAccess.isLocalOnlyRequest(req, uiSessionToken),
    agentToolRuntime,
    limitFailoverRuntime,
    registerExternalBridgeRoutes: (expressApp) => managedConfigRuntime?.registerExternalBridgeRoutes(expressApp, sessionKnowledgeRuntime.isToolHost),
    desktopUpdater,
    getOpenCodeCompatibility,
    skipBodyParsing: (req) => spacesHost?.skipsBodyParsing(req) === true,
  });
  uiAuthController = bootstrapResult.uiAuthController;
  app.use(spaceArchive.guard);
  app.use((req, res, next) => (spacesHost ? spacesHost.middleware(req, res, next) : next()));
  server.prependListener('upgrade', (...args) => { spacesHost?.upgradeHandler(...args); });
  const startSpacesHost = (host: NonNullable<typeof spacesHost>) => {
    host.prepareUpgrades({ uiAuthController, isRequestOriginAllowed });
    void host.startEvents(globalMessageStreamHub, { broadcastUiEvent: broadcastOpenChamberUiEvent, broadcastGlobalUiEvent: broadcastPermissionUiEvent }).catch((error) => {
      console.warn(`[spaces] could not follow the spaces: ${error?.message ?? error}`);
    });
  };
  if (spacesHost) startSpacesHost(spacesHost);
  const spacesSwitch = createSwitchController({
    getHost: () => spacesHost,
    setHost: (host) => { spacesHost = host; },
    buildHost: buildSpacesHost,
    startHost: startSpacesHost,
    persist: (enabled) => persistSettings({ isolatedSpacesEnabled: enabled }),
    persistMachine: (machine) => persistSettings({ isolatedSpacesSshHost: machine }),
  });
  registerSpaceRoutes(app, {
    getJourney: () => spacesHost?.journey ?? null,
    getPlaces: () => spacesHost?.places() ?? [],
    getDockerSetup: () => (spacesHost ? { placeId: spacesHost.localPlaceId, setup: spacesHost.dockerSetup } : null),
    readSwitch: spacesSwitch.readSwitch,
    setSwitch: spacesSwitch.setSwitch,
    setMachine: spacesSwitch.setMachine,
    getArchive: () => spaceArchive,
  });
  app.get(SPACE_TASK_TITLE_ROUTE, async (_req, res) => {
    if (!insideSpaceTaskNaming) return res.status(404).json({ error: 'This server is not inside an isolated space.' });
    res.json(await insideSpaceTaskNaming.read());
  });
  realtimeProxyRuntime = attachRealtimeProxy({
    app,
    server,
    getDesktopRuntimeConfig,
    getUiAuthController: () => uiAuthController,
    isRequestOriginAllowed,
  });

  const tunnelRuntimeContext = tunnelWiringRuntime.initialize(app, port, Boolean(uiPassword?.trim()));
  const { tunnelService, startTunnelWithNormalizedRequest } = tunnelRuntimeContext;
  tunnelRuntimeContextHolder = tunnelRuntimeContext;

  const relayService = createRelayService({
    crypto,
    readSettingsFromDiskMigrated,
    updateSettingsFromDisk: settingsRuntime.updateSettingsFromDisk,
    relayKeyStore,
    getLocalPort: () => tunnelRuntimeContext.getActivePort(),
    hostLock: createRelayHostLock({
      lockFilePath: path.join(OPENCHAMBER_DATA_DIR, 'relay-host.lock'),
      fs,
      process,
    }),
    onShareState: (shareId) => {
      void sharePagesRuntime.handleShareState(shareId).catch(() => undefined);
    },
    allowPassiveHost: process.env.OPENCHAMBER_RELAY_HOST === 'on'
      || (process.env.OPENCHAMBER_RELAY_HOST !== 'off' && process.env.OPENCHAMBER_ELECTRON_DEV !== '1'),
    hasRelayDemand: async () => {
      const [pendingRelay, deviceRelay] = await Promise.allSettled([
        clientPairingRuntime.hasActiveRelaySession(),
        remoteClientAuthRuntime.hasActiveRelayClients(),
      ]);
      if (pendingRelay.status === 'fulfilled' && pendingRelay.value) return true;
      if (deviceRelay.status === 'fulfilled' && deviceRelay.value) return true;
      if (pendingRelay.status === 'rejected') throw pendingRelay.reason;
      if (deviceRelay.status === 'rejected') throw deviceRelay.reason;
      return false;
    },
  });
  relayServiceInstance = relayService;
  relayService.registerRoutes(app, server);
  registerSharePageRoutes(app, sharePagesRuntime);
  registerReceivedPageRoutes(app, receivedPagesRuntime);

  registerBrowserControlRoutes(app, { express, broker: browserControlBroker, preferredClient: browserClientEvents.preferredClient });
  registerUploadRoute(app, { store: browserUploadStore });

  const devServerScanner = createDevServerScanner({ spawn, platform: process.platform });
  const listDevServers = () => devServerScanner.discover({
    ownPorts: [port, openCodePort].filter((value): value is number => isNumber(value) && Number.isInteger(value) && value > 0),
  });

  createDevTunnelRuntime({
    server,
    discoverDevServers: listDevServers,
    uiAuthController,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
    logger: console,
  });

  quietCompaction.registerRoutes(app);
  registerSessionProjectRoutes(app, {
    validateDirectoryPath,
    openCodeTrust,
    registerSessionProject: settingsRuntime.registerSessionProject,
    resolveSessionDirectory: async (sessionID) => (await openCodeSessionClient().session.get({ sessionID })).location.directory,
    moveSession: (sessionID, directory) => openCodeSessionClient().session.move({ sessionID, directory }),
    emitWorktreeChanged: ({ directories, at }) => {
      for (const client of uiOpenChamberEventClients) {
        try {
          writeSseEvent(client, { type: 'openchamber:worktree-changed', properties: { directories, at } });
        } catch {
          uiOpenChamberEventClients.delete(client);
        }
      }
    },
  });
  await featureRoutesRuntime.registerRoutes(app, {
    settingsRuntime,
    environmentStore,
    environmentRuntime,
    listConfiguredProjects,
    messageSearchRuntime,
    sessionWarmingRuntime,
    sessionTodosRuntime,
    scheduledWorktreeBridge,
    crypto,
    fs,
    os,
    path,
    fsPromises,
    spawn,
    resolveGitBinaryForSpawn,
    createFsSearchRuntime: createFsSearchRuntimeFactory,
    openchamberDataDir: OPENCHAMBER_DATA_DIR,
    sessionFoldersStore,
    openchamberVersion: OPENCHAMBER_VERSION,
    onGuestDeactivated: async (event) => {
      guestSurfaceRuntime?.endForGuest(event.guestId);
      setGuestConfigurationNote(event.guestId, null);
      if (guestMarks.clearGuest(event.guestId)) announceGuestMarksChanged();
      if (event.removed) await guestInstructions.remove(event.guestId);
      return browserControlRouter.handleGuestDeactivated(event);
    },
    onExtensionSessionEventsChanged: async () => {
      await Promise.all([
        extensionSessionEvents.reconcile(),
        extensionServiceLifetime.reconcile(),
        managedConfigRuntime?.refreshManagedConfigFile(),
      ]);
    },
    onExtensionWaitsChanged: () => extensionWaitsRuntime.reconcile(),
    getOpenCodePluginDelivery,
    extensionNotificationChannels,
    surfaceViewerHeaders: (guestId, viewerId) => guestSurfaceRuntime?.viewerHeaders(guestId, viewerId) ?? null,
    builtInExtensionsDir: options.builtInExtensionsDir,
    openchamberUserConfigRoot: OPENCHAMBER_USER_CONFIG_ROOT,
    managedChatsRoot: OPENCHAMBER_CHATS_DIR,
    normalizeDirectoryPath,
    resolveProjectDirectory,
    resolveOptionalProjectDirectory,
    validateDirectoryPath,
    customThemesDir: OPENCHAMBER_USER_THEMES_DIR,
    readCustomThemesFromDisk,
    saveImportedTheme,
    deleteImportedTheme,
    refreshOpenCodeAfterConfigChange,
    getOpenCodeResolutionSnapshot,
    getOpenCodeUpgradeCapability,
    getOpenCodeCompatibility,
    installOpenCodeV2: async () => {
      const binary = await installOpenCodeV2({
        env: { ...getLoginShellEnvSnapshot(), ...process.env, PATH: buildManagedOpenCodePath() },
      });
      await persistSettings({ opencodeBinary: binary });
      await refreshOpenCodeAfterConfigChange('OpenCode v2 installation');
      await waitForOpenCodeReady();
    },
    upgradeOpenCodeCli: () => {
      const sharedServiceCli = getSharedServiceCliBinary();
      const launch = resolveManagedOpenCodeLaunchSpec(sharedServiceCli || lastOpenCodeLaunchDiagnostics?.sourceBinary || resolvedOpencodeBinary);
      const upgrade = () => runOpenCodeCliUpgrade(launch, { env: { ...getLoginShellEnvSnapshot(), ...process.env, PATH: buildManagedOpenCodePath() }, cwd: os.homedir() });
      // external: https://learn.microsoft.com/en-us/windows/win32/fileio/creating-and-opening-files Windows cannot replace the running executable; the managed process stops during installation.
      if (sharedServiceCli || process.platform !== 'win32') return upgrade();
      return restartOpenCode('opencode-upgrade', { whileStopped: upgrade });
    },
    formatSettingsResponse,
    sanitizeProjects: sanitizeProjectList,
    sanitizeSkillCatalogs,
    isUnsafeSkillRelativePath,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    getOpenCodePort: () => openCodePort, getManagedOpenCodeProcessEnv: () => openCodeLifecycleRuntime.getManagedOpenCodeProcessEnv(),
    getOwnPorts: () => [port, openCodePort].filter((value): value is number => isNumber(value) && Number.isInteger(value) && value > 0),
    getActivePort: () => {
      const address = server?.address?.();
      return address && !isString(address) && Number.isInteger(address.port) ? address.port : null;
    },
    getActiveHost: () => {
      const address = server?.address?.();
      return address && !isString(address) ? address.address : null;
    },
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
    emitSessionCreatedEvent,
    getOpenChamberEventClients: () => uiOpenChamberEventClients,
    writeSseEvent,
    globalEventHub: globalMessageStreamHub,
    permissionAutoAcceptRuntime,
    worktreeBootstrapStore,
    messageQueueRuntime,
    autoReviewRuntime,
    prWatchRuntime,
    extensionWaitsRuntime,
    laterPagesRuntime,
    routingRuntime,
    mergeFollowRuntime,
    workflowRuntime,
  });
  void extensionServiceLifetime.reconcile();

  guestSurfaceRuntime = createGuestSurfaceRuntime({
    server,
    uiAuthController,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
    persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR),
    findGuest: (id) => findInstalledGuest(id, extensionsPersistPath(OPENCHAMBER_DATA_DIR)),
    idleStopMs: BROWSER_PROVIDER_IDLE_MS,
  });

  const startupPipelineResult = await startupPipelineRuntime.run({
    app,
    server,
    express,
    fs,
    path,
    uiAuthController,
    buildAugmentedPath,
    searchPathFor,
    isExecutable,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    globalEventHub: globalMessageStreamHub,
    processForwardedEventPayload,
    messageStreamWsClients: uiNotificationWsClients,
    upstreamStallTimeoutMs: getUpstreamStallTimeoutMs,
    terminalHeartbeatIntervalMs: TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS,
    terminalRebindWindowMs: TERMINAL_INPUT_WS_REBIND_WINDOW_MS,
    terminalMaxRebindsPerWindow: TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW,
    environmentRuntime,
    broadcastUiEvent: broadcastOpenChamberUiEvent,
    setupProxy,
    scheduleOpenCodeApiDetection,
    bootstrapOpenCodeAtStartup,
    onListenerReady: async () => {
      try { await featureRoutesRuntime.publishRepositoryCredentialEndpoint(); }
      catch (error) { console.warn('Git credential helper endpoint was not published:', error instanceof Error ? error.message : String(error)); }
    },
    triggerHealthCheck,
    staticRoutesRuntime,
    process,
    crypto,
    normalizeTunnelBootstrapTtlMs,
    readSettingsFromDiskMigrated,
    tunnelAuthController,
    startTunnelWithNormalizedRequest,
    gracefulShutdown,
    getSignalsAttached: () => signalsAttached,
    setSignalsAttached: (value) => {
      signalsAttached = value;
    },
    syncToHmrState,
    TUNNEL_MODE_QUICK,
    TUNNEL_MODE_MANAGED_LOCAL,
    TUNNEL_MODE_MANAGED_REMOTE,
    host,
    port,
    startupTunnelRequest,
    onTunnelReady,
    tunnelRuntimeContext,
    attachSignals,
    apiOnly,
    dictationModelsDir: path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'speech-models'),
  });
  terminalRuntime = startupPipelineResult.terminalRuntime;
  dictationRuntime = startupPipelineResult.dictationRuntime;
  messageStreamRuntime = startupPipelineResult.messageStreamRuntime;
  await managedConfigRuntime.syncExternalBridge().catch((error) => console.warn('[ExternalOpenCodePlugin] Failed to sync runtime bridge:', (isRecord(error) && error.message) || error));

  try {
    await scheduledTasksRuntime.start();
  } catch (error) {
    console.warn('[ScheduledTasks] Failed to start runtime:', (isRecord(error) && error.message) || error);
  }
  memoryDreaming.start();

  void relayService.reconcile();

  relayReconcileTimer = setInterval(() => {
    void relayService.reconcile();
  }, 60_000);
  relayReconcileTimer.unref?.();

  const spaceIdleStopFile = process.env.OPENCHAMBER_SPACE_IDLE_STOP_FILE;
  if (spaceIdleStopFile) {
    startIdleStop({
      settingsPath: spaceIdleStopFile,
      readSessionStates: () => sessionRuntime.getSessionStateSnapshot(),
      readPendingRequests: () => sessionRuntime.getPendingBlockingRequestsSnapshot(),
      stopSpace: async () => {
        await gracefulShutdown({ exitProcess: false }).catch(() => {});
        process.exit(SPACE_IDLE_EXIT_CODE);
      },
    });
  }

  return {
    expressApp: app,
    httpServer: server,
    getPort: () => tunnelRuntimeContext.getActivePort(),
    getOpenCodePort: () => openCodePort,
    getTunnelUrl: () => tunnelService.getPublicUrl(),
    getQuitRiskStatus: () => ({
      tunnel: { active: Boolean(tunnelService.getPublicUrl()) },
      scheduledTasks: scheduledTasksRuntime.getStatus(),
    }),
    getUpdateIdleStatus: () => collectDesktopUpdateIdle({ canReadSessions: () => isOpenCodeReady && !isRestartingOpenCode && globalMessageStreamHub.isConnected() ? desktopUpdateSessions.ensureReady() : false, sessionRuntime, readBackgroundJobs: () => createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders }).fetchAllRunningBackgroundJobs(), terminalRuntime, messageQueueRuntime, scheduledTasksRuntime, workflowRuntime, sessionGoalRuntime, sessionAssistRuntime, autoReviewRuntime }),
    isReady: () => isOpenCodeReady,
    getManagedOpenCodePreflight: () => openCodeLifecycleRuntime.getManagedOpenCodePreflight(),
    restartOpenCode: () => restartOpenCode(),
    getOpenCodeProcessInfo: () => {
      const managed = Boolean((openCodeProcess || openCodePort) && !ENV_SKIP_OPENCODE_START && !isExternalOpenCode);
      return {
        managed,
        pid: managed && isNumber(openCodeProcess?.pid) ? openCodeProcess.pid : null,
        port: managed ? openCodePort : null,
      };
    },
    stop: (shutdownOptions: { exitProcess?: boolean } = {}) => gracefulShutdown({ exitProcess: shutdownOptions.exitProcess ?? false }),
  };
}

runCliEntryIfMain({
  process,
  currentFilename: fileURLToPath(new URL('./index.js', import.meta.url)),
  parseServeCliOptions,
  defaultPort: DEFAULT_PORT,
  cloudflareProvider: TUNNEL_PROVIDER_CLOUDFLARE,
  managedLocalMode: TUNNEL_MODE_MANAGED_LOCAL,
  setExitOnShutdown: (value) => {
    exitOnShutdown = value;
  },
  startServer: main,
});
export {
  gracefulShutdown,
  setupProxy,
  restartOpenCode,
  main as startWebUiServer,
  parseServeCliOptions as parseArgs,
};
