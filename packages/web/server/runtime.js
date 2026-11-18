import { installOpenCodeV2, supportsOpenCodeV2Install } from './lib/opencode/v2-install.js';
import { describeOpenCodeCompatibility, readOpenCodeCliVersion, readExternalOpenCodeVersion } from './lib/opencode/compatibility.js';
import 'reflect-metadata';
import express from 'express';
import { buildRestartNotification } from './lib/notifications/restart-notification.js';
import compression from 'compression';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
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
import { allowsLocalDevOrigins, buildFrameAncestorsPolicy, createRequestSecurityRuntime, isLocalDevClientOrigin } from './lib/security/request-security.js';
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
import { createOpenCodeLifecycleRuntime } from './lib/opencode/lifecycle.js';
import { createOpenCodeEnvRuntime } from './lib/opencode/env-runtime.js';
import { providedLoginShellEnvSnapshot } from './lib/opencode/login-shell-env.js';
import { resolveOpenCodeEnvConfig, resolveProxyRequestTimeoutMs } from './lib/opencode/env-config.js';
import { createHmrStateRuntime } from './lib/opencode/hmr-state-runtime.js';
import { createOpenCodeNetworkRuntime } from './lib/opencode/network-runtime.js';
import { createOpenCodeAuthStateRuntime } from './lib/opencode/auth-state-runtime.js';
import { createProjectDirectoryRuntime } from './lib/projects/project-directory-runtime.js';
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
import { createSessionAssistRuntime } from './lib/session-assist/runtime.js';
import { createSessionGoalRuntime } from './lib/session-goal/runtime.js';
import { createContextObligatoryRuntime } from './lib/context-obligatory/runtime.js';
import { createSessionWarmingRuntime } from './lib/session-warming/runtime.js';
import { createSessionTodosRuntime } from './lib/session-todos/runtime.js';
import { isSpaceDirectory } from './lib/spaces/dispatcher.js';
import { createTrackerRegistry } from './lib/trackers/registry.js';
import { createTrackerSessionStatus } from './lib/trackers/session-status.js';
import { sourceControlProviderDescriptors } from './lib/source-control/provider-descriptors.js';
import { createSessionKnowledgeRuntime, measureMemoryIndex } from './lib/session-knowledge/runtime.js';
import { createMemoryDreaming } from './lib/agent-memory/dreaming.js';
import { isAutoModel, JEV_BACKGROUND_TIMEOUT_MS } from './lib/routing/defaults.js';
import { createMessageSearchRuntime } from './lib/message-search/runtime.js';
import { applyOwnedArchiveState } from './lib/opencode/proxy.js';
import { createScheduledTasksRuntime } from './lib/scheduled-tasks/runtime.js';
import { resolveSessionDefaults } from './lib/scheduled-tasks/session-defaults.js';
import { createChatsScope } from './lib/scheduled-tasks/chats-scope.js';
import { createChatDirectoryCleanupRuntime } from './lib/chat-directories/runtime.js';
import { createUnregisteredScheduledWorktreeBridge } from './lib/scheduled-tasks/worktree-bridge.js';
import { createServerStartupRuntime } from './lib/server-frame/server-startup-runtime.js';
import { createTunnelWiringRuntime } from './lib/tunnels/tunnel-wiring-runtime.js';
import { createStartupPipelineRuntime } from './lib/server-frame/startup-pipeline-runtime.js';
import { createHiddenSessionRegistry } from './lib/opencode/hidden-sessions.js';
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
import { configureGitEnvironment, getCheckedOutBranch, getWorktreeBootstrapGateStatus, getWorktrees, isWorktreeDirectoryPinned, readRenameableGeneratedBranch, renameGeneratedWorktreeBranch, resolvePrimaryWorktreeRoot, setWorktreeTaskTitle } from './lib/git/service.js';
import { createEnvironmentStore } from './lib/environment/store.js';
import { createEnvironmentRuntime } from './lib/environment/runtime.js';
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
import { createBrowserControlRouter } from './lib/browser-control/provider.js';
import { createDevServerScanner } from './lib/dev-servers/routes.js';
import { createDevTunnelRuntime } from './lib/dev-tunnel/runtime.js';
import { registerBrowserControlRoutes } from './lib/browser-control/routes.js';
import { createUploadStore, registerUploadRoute } from './lib/browser-control/uploads.js';
import { createManagedConfigRuntime } from './lib/opencode/managed-config-file.js';
import { openCodePluginDelivery } from './lib/guests/opencode-plugin.js';
import { createLimitFailoverRuntime } from './lib/limit-failover/runtime.js';
import { prepareInstanceDir } from './lib/opencode/instance-dir.js';
import { createOpenChamberSessionService } from './lib/openchamber-sessions/routes.js';
import { createSessionMetadataStore, createOpenCodeSessionMetadata } from './lib/openchamber-sessions/session-metadata-store.js';
import { createUnreadBaseline } from './lib/openchamber-sessions/unread-baseline.js';
import { createTurnDurationRecorder } from './lib/openchamber-sessions/turn-duration.js';
import { createOpenCodeClient } from './lib/openchamber-sessions/opencode-client.js';
import { createScheduledTaskService } from './lib/scheduled-tasks/service.js';
import { createModelCatalogReader } from './lib/scheduled-tasks/model-catalog.js';
import { createOpenChamberControlService } from './lib/openchamber-control/service.js';
import { createPluginNotificationEmitter } from './lib/notifications/emit-route.js';
import { OpenChamberControlError } from './lib/openchamber-control/error.js';
import { createSessionLinker } from './lib/openchamber-sessions/session-link.js';
import { linkedWorktreeOf } from './lib/openchamber-sessions/work-naming.js';
import { createFileOpenRequester } from './lib/openchamber-control/file-open.js';
import { createSecretFiles } from './lib/openchamber-control/secret-request.js';
import { applyConnectAttemptTimeout } from './lib/network-defaults.js';
import { applyOutboundProxyFromEnv } from './lib/outbound-proxy.js';
import { applySystemCertificates } from './lib/system-ca.js';
import { readOpenCodeLoad } from './lib/diagnostics/opencode-load.js';

applyConnectAttemptTimeout();
applySystemCertificates();
applyOutboundProxyFromEnv();

const DEFAULT_PORT = 3000;
const DESKTOP_NOTIFY_PREFIX = '[OpenChamberDesktopNotify] ';
const uiNotificationClients = new Set();
const uiNotificationWsClients = new Set();
const uiOpenChamberEventClients = new Set();
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

function headerIncludesEventStream(value) {
  if (typeof value === 'string') {
    return value.toLowerCase().includes('text/event-stream');
  }

  if (Array.isArray(value)) {
    return value.some((entry) => typeof entry === 'string' && entry.toLowerCase().includes('text/event-stream'));
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

function shouldSkipCompression(req, res) {
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
    const pkg = JSON.parse(raw);
    if (pkg && typeof pkg.version === 'string' && pkg.version.trim().length > 0) {
      return pkg.version.trim();
    }
  } catch {
  }
  return 'unknown';
})();

const isEnvFlagEnabled = (value) => {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
};

const isEnvFlagDisabled = (value) => {
  if (value === false || value === 0) return true;
  if (typeof value !== 'string') return false;
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
  realpathSync: fs.realpathSync,
  readdirSync: fs.readdirSync,
  tunnelBootstrapTtlDefaultMs: TUNNEL_BOOTSTRAP_TTL_DEFAULT_MS,
  tunnelBootstrapTtlMinMs: TUNNEL_BOOTSTRAP_TTL_MIN_MS,
  tunnelBootstrapTtlMaxMs: TUNNEL_BOOTSTRAP_TTL_MAX_MS,
  tunnelSessionTtlDefaultMs: TUNNEL_SESSION_TTL_DEFAULT_MS,
  tunnelSessionTtlMinMs: TUNNEL_SESSION_TTL_MIN_MS,
  tunnelSessionTtlMaxMs: TUNNEL_SESSION_TTL_MAX_MS,
});

const normalizeDirectoryPath = (...args) => settingsNormalizationRuntime.normalizeDirectoryPath(...args);
const normalizePathForPersistence = (...args) => settingsNormalizationRuntime.normalizePathForPersistence(...args);
const normalizeSettingsPaths = (...args) => settingsNormalizationRuntime.normalizeSettingsPaths(...args);
const normalizeTunnelBootstrapTtlMs = (...args) => settingsNormalizationRuntime.normalizeTunnelBootstrapTtlMs(...args);
const normalizeTunnelSessionTtlMs = (...args) => settingsNormalizationRuntime.normalizeTunnelSessionTtlMs(...args);
const normalizeManagedRemoteTunnelHostname = (...args) =>
  settingsNormalizationRuntime.normalizeManagedRemoteTunnelHostname(...args);
const normalizeManagedRemoteTunnelPresets = (...args) =>
  settingsNormalizationRuntime.normalizeManagedRemoteTunnelPresets(...args);
const normalizeManagedRemoteTunnelPresetTokens = (...args) =>
  settingsNormalizationRuntime.normalizeManagedRemoteTunnelPresetTokens(...args);
const isUnsafeSkillRelativePath = (...args) => settingsNormalizationRuntime.isUnsafeSkillRelativePath(...args);
const normalizeStringArray = (...args) => settingsNormalizationRuntime.normalizeStringArray(...args);
const sanitizeModelRefs = (...args) => settingsNormalizationRuntime.sanitizeModelRefs(...args);
const sanitizeSkillCatalogs = (...args) => settingsNormalizationRuntime.sanitizeSkillCatalogs(...args);
const sanitizeProjects = (...args) => settingsNormalizationRuntime.sanitizeProjects(...args);

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

const readCustomThemesFromDisk = (...args) => themeRuntime.readCustomThemesFromDisk(...args);
const saveImportedTheme = (...args) => themeRuntime.saveImportedTheme(...args);
const deleteImportedTheme = (...args) => themeRuntime.deleteImportedTheme(...args);

let notificationTemplateRuntime = null;
let agentToolRuntime = null;
let limitFailoverRuntime = null;
let managedConfigRuntime = null;
let stopEnterprisePolicyWatch = () => {};

const createTimeoutSignal = (...args) => notificationTemplateRuntime.createTimeoutSignal(...args);
const formatProjectLabel = (...args) => notificationTemplateRuntime.formatProjectLabel(...args);
const resolveNotificationTemplate = (...args) => notificationTemplateRuntime.resolveNotificationTemplate(...args);
const shouldApplyResolvedTemplateMessage = (...args) => notificationTemplateRuntime.shouldApplyResolvedTemplateMessage(...args);
const fetchFreeZenModels = (...args) => notificationTemplateRuntime.fetchFreeZenModels(...args);
const extractTextFromParts = (...args) => notificationTemplateRuntime.extractTextFromParts(...args);
const extractLastMessageText = (...args) => notificationTemplateRuntime.extractLastMessageText(...args);
const fetchLastAssistantMessageText = (...args) => notificationTemplateRuntime.fetchLastAssistantMessageText(...args);
const maybeCacheSessionInfoFromEvent = (...args) => notificationTemplateRuntime.maybeCacheSessionInfoFromEvent(...args);
const buildTemplateVariables = (...args) => notificationTemplateRuntime.buildTemplateVariables(...args);
const getCachedZenModels = (...args) => notificationTemplateRuntime.getCachedZenModels(...args);

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
    return sanitizeProjects(settings?.projects || []).map((project) => project.path);
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

const readManagedRemoteTunnelConfigFromDisk = (...args) => managedTunnelConfigRuntime.readManagedRemoteTunnelConfigFromDisk(...args);
const syncManagedRemoteTunnelConfigWithPresets = (...args) => managedTunnelConfigRuntime.syncManagedRemoteTunnelConfigWithPresets(...args);
const upsertManagedRemoteTunnelToken = (...args) => managedTunnelConfigRuntime.upsertManagedRemoteTunnelToken(...args);
const resolveManagedRemoteTunnelToken = (...args) => managedTunnelConfigRuntime.resolveManagedRemoteTunnelToken(...args);

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

const normalizePwaAppName = (...args) => settingsHelpers.normalizePwaAppName(...args);
const normalizePwaOrientation = (...args) => settingsHelpers.normalizePwaOrientation(...args);
const sanitizeSettingsUpdate = (...args) => settingsHelpers.sanitizeSettingsUpdate(...args);
const mergePersistedSettings = (...args) => settingsHelpers.mergePersistedSettings(...args);
const formatSettingsResponse = (...args) => settingsHelpers.formatSettingsResponse(...args);

const projectDirectoryRuntime = createProjectDirectoryRuntime({
  fsPromises,
  path,
  normalizeDirectoryPath,
  getReadSettingsFromDiskMigrated: () => readSettingsFromDiskMigrated,
  sanitizeProjects,
  refuseDirectory: (candidate) => spacesHost?.refuseDirectory(candidate) ?? null,
});

const resolveDirectoryCandidate = (...args) => projectDirectoryRuntime.resolveDirectoryCandidate(...args);
const validateDirectoryPath = (...args) => projectDirectoryRuntime.validateDirectoryPath(...args);
const resolveProjectDirectory = (...args) => projectDirectoryRuntime.resolveProjectDirectory(...args);
const resolveOptionalProjectDirectory = (...args) => projectDirectoryRuntime.resolveOptionalProjectDirectory(...args);

const settingsRuntime = createSettingsRuntime({
  fsPromises,
  path,
  crypto,
  SETTINGS_FILE_PATH,
  sanitizeProjects,
  sanitizeSettingsUpdate,
  mergePersistedSettings,
  normalizeSettingsPaths,
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
    void openCodeTrust.isTrusted(directory).then((trusted) => {
      if (trusted) openCodeLifecycleRuntime.noteCurrentDirectory(directory);
    }, () => {});
  },
});

const readSettingsFromDiskMigrated = (...args) => settingsRuntime.readSettingsFromDiskMigrated(...args);
const readSettingsFromDisk = (...args) => settingsRuntime.readSettingsFromDisk(...args);
const readSettingsFromDiskStrict = (...args) => settingsRuntime.readSettingsFromDiskStrict(...args);
const writeSettingsToDisk = (...args) => settingsRuntime.writeSettingsToDisk(...args);
const persistSettings = (...args) => settingsRuntime.persistSettings(...args);

const requestSecurityRuntime = createRequestSecurityRuntime({
  readSettingsFromDiskMigrated,
  allowLocalDevOrigins: allowsLocalDevOrigins(process.env),
});

const getUiSessionTokenFromRequest = (...args) => requestSecurityRuntime.getUiSessionTokenFromRequest(...args);

const pushRuntime = createPushRuntime({
  fsPromises,
  path,
  loadWebPush: () => import('web-push').then((module) => module.default),
  PUSH_SUBSCRIPTIONS_FILE_PATH,
  readSettingsFromDiskMigrated,
  writeSettingsToDisk,
  getInvalidSessionKeys: () => clientPushAccess.invalidSessionKeys(),
});

const getOrCreateVapidKeys = (...args) => pushRuntime.getOrCreateVapidKeys(...args);
const addOrUpdatePushSubscription = (...args) => pushRuntime.addOrUpdatePushSubscription(...args);
const removePushSubscription = (...args) => pushRuntime.removePushSubscription(...args);
const sendPushToAllUiSessions = (...args) => pushRuntime.sendPushToAllUiSessions(...args);
let clearPendingPushBadge = () => {};
const updateUiVisibility = (token, visible, platform) => {
  if (visible === true) clearPendingPushBadge();
  return pushRuntime.updateUiVisibility(token, visible, platform);
};
const isAnyUiVisible = (...args) => pushRuntime.isAnyUiVisible(...args);
const isAnyInteractiveClientVisible = (...args) => pushRuntime.isAnyInteractiveClientVisible(...args);
const isUiVisible = (...args) => pushRuntime.isUiVisible(...args);
const ensurePushInitialized = (...args) => pushRuntime.ensurePushInitialized(...args);
const setPushInitialized = (...args) => pushRuntime.setPushInitialized(...args);

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

const addOrUpdateApnsToken = (...args) => apnsRuntime.addOrUpdateApnsToken(...args);
const removeApnsToken = (...args) => apnsRuntime.removeApnsToken(...args);
const sendApnsToAllUiSessions = (...args) => apnsRuntime.sendApnsToAllUiSessions(...args);
const clearApnsNotifications = (...args) => apnsRuntime.clearApnsNotifications(...args);

const TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW = 128;
const TERMINAL_INPUT_WS_REBIND_WINDOW_MS = 60 * 1000;
const TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS = 15 * 1000;

const rejectWebSocketUpgrade = (...args) => requestSecurityRuntime.rejectWebSocketUpgrade(...args);


const isRequestOriginAllowed = (...args) => requestSecurityRuntime.isRequestOriginAllowed(...args);

const notificationEmitterRuntime = createNotificationEmitterRuntime({
  process,
  getDesktopNotifyEnabled: () => ENV_DESKTOP_NOTIFY,
  desktopNotifyPrefix: DESKTOP_NOTIFY_PREFIX,
  getUiNotificationClients: () => uiNotificationClients,
  getOpenChamberEventClients: () => uiOpenChamberEventClients,
  getBroadcastGlobalUiEvent: () => broadcastGlobalUiEvent,
});

const writeSseEvent = (...args) => notificationEmitterRuntime.writeSseEvent(...args);
const emitDesktopNotification = (...args) => notificationEmitterRuntime.emitDesktopNotification(...args);
const broadcastGlobalUiEvent = createGlobalUiEventBroadcaster({
  sseClients: uiNotificationClients,
  wsClients: uiNotificationWsClients,
  writeSseEvent,
});
const broadcastUiNotification = (...args) => notificationEmitterRuntime.broadcastUiNotification(...args);

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
const broadcastPermissionUiEvent = (payload) => {
  broadcastControlSseEvent(payload);
  broadcastGlobalUiEvent(payload);
};

const sessionMetadataStore = createSessionMetadataStore({
  dataDir: OPENCHAMBER_DATA_DIR,
  openCode: {
    read: (...args) => createOpenCodeSessionMetadata({ buildOpenCodeUrl, getOpenCodeAuthHeaders }).read(...args),
    write: (sessionID, metadata, options) => createOpenCodeSessionMetadata({ buildOpenCodeUrl, getOpenCodeAuthHeaders }).write(sessionID, metadata, options).then(() => sessionLineage.noteMetadata(sessionID, metadata) && permissionAutoAcceptRuntime.forgetSession(sessionID)),
  },
});

const readStoredSessionMetadata = (sessionID, options) => sessionMetadataStore.get(sessionID, options);

const persistSessionMetadataPatch = async (sessionID, patch, { directory = '' } = {}) => {
  const metadata = await sessionMetadataStore.setSessionMetadata(sessionID, patch, { directory });
  broadcastOpenChamberUiEvent({
    type: 'openchamber:session-metadata',
    properties: { sessionID, metadata },
  });
  if (patch?.openchamber && 'goal' in patch.openchamber) {
    void Promise.resolve(sessionGoalRuntime.notifyGoalChanged(sessionID, directory, metadata))
      .catch((error) => console.warn('[session-goal] could not arm after a goal change:', error?.message ?? error));
  }
  return metadata;
};

const updateSessionMetadataWith = async (sessionID, decide, { directory = '' } = {}) => {
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

let healthCheckInterval = null;
let server = null;
let expressApp = null;
let currentRestartPromise = null;
let isRestartingOpenCode = false;
let openCodeApiPrefix = '';
let openCodeApiPrefixDetected = true;
let openCodeApiDetectionTimer = null;
let lastOpenCodeError = null;
let lastOpenCodeLaunchDiagnostics = null;
let lastOpenCodeHealthFailure = null;
let lastManagedOpenCodeProcess = null;
let lastOpenCodeRestartDiagnostics = null;
let isOpenCodeReady = false;
let openCodeNotReadySince = 0;
let isExternalOpenCode = false;
let exitOnShutdown = true;
let uiAuthController = null;
let spacesHost = null;
let activeTunnelController = null;
let globalWatcherStartPromise = null;
const tunnelProviderRegistry = createTunnelProviderRegistry([
  createCloudflareTunnelProvider(),
  createNgrokTunnelProvider(),
  createTailscaleTunnelProvider(),
]);
tunnelProviderRegistry.seal();
const tunnelAuthController = createTunnelAuth();
let runtimeManagedRemoteTunnelToken = '';
let runtimeManagedRemoteTunnelHostname = '';
let terminalRuntime = null;
let dictationRuntime = null;
let guestSurfaceRuntime = null;
let realtimeProxyRuntime = null;
let relayServiceInstance = null;
let relayReconcileTimer = null;
let messageStreamRuntime = null;
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

  const argv0 = typeof process.argv?.[0] === 'string' ? process.argv[0] : '';
  const argv1 = typeof process.argv?.[1] === 'string' ? process.argv[1] : '';
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

const getOpenCodeAuthHeaders = (...args) => openCodeAuthStateRuntime.getOpenCodeAuthHeaders(...args);
const isOpenCodeConnectionSecure = (...args) => openCodeAuthStateRuntime.isOpenCodeConnectionSecure(...args);
const ensureLocalOpenCodeServerPassword = (...args) => openCodeAuthStateRuntime.ensureLocalOpenCodeServerPassword(...args);

const openCodeNetworkState = {};
Object.defineProperties(openCodeNetworkState, {
  openCodePort: { get: () => openCodePort, set: (value) => { openCodePort = value; } },
  openCodeBaseUrl: { get: () => openCodeBaseUrl, set: (value) => { openCodeBaseUrl = value; } },
  openCodeApiPrefix: { get: () => openCodeApiPrefix, set: (value) => { openCodeApiPrefix = value; } },
  openCodeApiPrefixDetected: { get: () => openCodeApiPrefixDetected, set: (value) => { openCodeApiPrefixDetected = value; } },
  openCodeApiDetectionTimer: { get: () => openCodeApiDetectionTimer, set: (value) => { openCodeApiDetectionTimer = value; } },
});

const openCodeNetworkRuntime = createOpenCodeNetworkRuntime({
  state: openCodeNetworkState,
  getOpenCodeAuthHeaders,
  configuredOpenCodeHostname: ENV_CONFIGURED_OPENCODE_HOSTNAME,
});

const waitForReady = (...args) => openCodeNetworkRuntime.waitForReady(...args);
const normalizeApiPrefix = (...args) => openCodeNetworkRuntime.normalizeApiPrefix(...args);
const setDetectedOpenCodeApiPrefix = (...args) => openCodeNetworkRuntime.setDetectedOpenCodeApiPrefix(...args);
const buildOpenCodeUrl = (...args) => openCodeNetworkRuntime.buildOpenCodeUrl(...args);
const ensureOpenCodeApiPrefix = (...args) => openCodeNetworkRuntime.ensureOpenCodeApiPrefix(...args);
const scheduleOpenCodeApiDetection = (...args) => openCodeNetworkRuntime.scheduleOpenCodeApiDetection(...args);

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

let cachedLoginShellEnvSnapshot;
let resolvedOpencodeBinary = null;
let resolvedOpencodeBinarySource = null;
let resolvedNodeBinary = null;
let resolvedBunBinary = null;
let resolvedGitBinary = null;
let useWslForOpencode = false;
let resolvedWslBinary = null;
let resolvedWslOpencodePath = null;
let resolvedWslDistro = null;

const openCodeEnvState = {};
Object.defineProperties(openCodeEnvState, {
  cachedLoginShellEnvSnapshot: { get: () => cachedLoginShellEnvSnapshot, set: (value) => { cachedLoginShellEnvSnapshot = value; } },
  resolvedOpencodeBinary: { get: () => resolvedOpencodeBinary, set: (value) => { resolvedOpencodeBinary = value; } },
  resolvedOpencodeBinarySource: { get: () => resolvedOpencodeBinarySource, set: (value) => { resolvedOpencodeBinarySource = value; } },
  resolvedNodeBinary: { get: () => resolvedNodeBinary, set: (value) => { resolvedNodeBinary = value; } },
  resolvedBunBinary: { get: () => resolvedBunBinary, set: (value) => { resolvedBunBinary = value; } },
  resolvedGitBinary: { get: () => resolvedGitBinary, set: (value) => { resolvedGitBinary = value; } },
  useWslForOpencode: { get: () => useWslForOpencode, set: (value) => { useWslForOpencode = value; } },
  resolvedWslBinary: { get: () => resolvedWslBinary, set: (value) => { resolvedWslBinary = value; } },
  resolvedWslOpencodePath: { get: () => resolvedWslOpencodePath, set: (value) => { resolvedWslOpencodePath = value; } },
  resolvedWslDistro: { get: () => resolvedWslDistro, set: (value) => { resolvedWslDistro = value; } },
});

const openCodeEnvRuntime = createOpenCodeEnvRuntime({
  state: openCodeEnvState,
  normalizeDirectoryPath,
  readSettingsFromDiskMigrated,
  providedLoginShellEnvSnapshot,
});

const applyLoginShellEnvSnapshot = (...args) => openCodeEnvRuntime.applyLoginShellEnvSnapshot(...args);
const getLoginShellEnvSnapshot = (...args) => openCodeEnvRuntime.getLoginShellEnvSnapshot(...args);
const ensureOpencodeCliEnv = (...args) => openCodeEnvRuntime.ensureOpencodeCliEnv(...args);
const applyOpencodeBinaryFromSettings = (...args) => openCodeEnvRuntime.applyOpencodeBinaryFromSettings(...args);
const resolveOpencodeCliPath = (...args) => openCodeEnvRuntime.resolveOpencodeCliPath(...args);
const isBundledOpenCodePath = (...args) => openCodeEnvRuntime.isBundledOpenCodePath(...args);
const isExecutable = (...args) => openCodeEnvRuntime.isExecutable(...args);
const searchPathFor = (...args) => openCodeEnvRuntime.searchPathFor(...args);
const resolveGitBinaryForSpawn = (...args) => openCodeEnvRuntime.resolveGitBinaryForSpawn(...args);
const resolveManagedOpenCodeLaunchSpec = (...args) => openCodeEnvRuntime.resolveManagedOpenCodeLaunchSpec(...args);
const clearResolvedOpenCodeBinary = (...args) => openCodeEnvRuntime.clearResolvedOpenCodeBinary(...args);
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
const getOpenCodeResolutionSnapshot = (...args) =>
  openCodeResolutionRuntime.getOpenCodeResolutionSnapshot(...args);

applyLoginShellEnvSnapshot();

notificationTemplateRuntime = createNotificationTemplateRuntime({
  readSettingsFromDisk,
  persistSettings,
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
        return JSON.parse(await fsPromises.readFile(PUSH_OPEN_TAGS_FILE_PATH, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
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
  spaceFetchFor: (spaceId) => spacesHost?.openCodeFetchFor(spaceId) ?? null,
  isInAutoReview: (sessionId, turnEndedAt) => autoReviewRuntime.speaksFor(sessionId, turnEndedAt),
  deliverToExtensionChannels: (delivery) => extensionNotificationChannels.deliver(delivery),
});

const maybeSendPushForTrigger = (...args) => notificationTriggerRuntime.maybeSendPushForTrigger(...args);
const setAutoAcceptSession = (sessionId, enabled) => permissionAutoAcceptRuntime.setSessionPolicy(sessionId, enabled);
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
  persistSessionGoal: async (sessionID, directory, goal, canWrite) => {
    if (!canWrite) return persistSessionMetadataPatch(sessionID, { openchamber: { goal } }, { directory });
    const result = await updateSessionMetadataWith(sessionID, (metadata) => (
      canWrite(metadata) ? { openchamber: { goal } } : null
    ), { directory });
    return result.changed;
  },
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
    const objective = typeof goal?.objective === 'string' ? goal.objective.slice(0, 140) : '';
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

const openCodeSessionClient = (directory) => createOpenCodeClient({
  baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
  headers: getOpenCodeAuthHeaders(),
  directory,
});

const guestInstructions = createGuestInstructions({ dataDir: OPENCHAMBER_DATA_DIR });
const guestAgentContext = createGuestAgentContext({
  listGuests: () => listInstalledGuests({ persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR) }),
  instructions: guestInstructions,
});

const sessionKnowledgeRuntime = createSessionKnowledgeRuntime({
  readExtensionInstructions: guestAgentContext.instructionText,
  projectContextRuntime,
  agentMemoryRuntime,
  resolveProjectId: (directory) => resolveMemoryProjectId(directory),
  isAgentMemoryEnabled,
  isMemoryToolAvailable: async () => {
    if (isExternalOpenCode || ENV_SKIP_OPENCODE_START) return false;
    return isAgentMemoryEnabled();
  },
  isSessionLinkingAvailable: async () => {
    if (isExternalOpenCode || ENV_SKIP_OPENCODE_START) return false;
    const settings = await readSettingsFromDiskMigrated().catch(() => null);
    return settings?.agentControlToolEnabled !== false;
  },
  readCheckoutBranch: getCheckedOutBranch,
  isWorkNamingAvailable: async (directory) => {
    if (/^\/spaces\/[0-9a-f]{12}(?:\/|$)/.test(directory)) return true;
    return linkedWorktreeOf(directory, await getWorktrees(directory)) !== null;
  },
  readPlaceholderBranch: readRenameableGeneratedBranch,
  isPageRenderingAvailable: async () => {
    if (isExternalOpenCode || ENV_SKIP_OPENCODE_START) return false;
    const settings = await readSettingsFromDiskMigrated().catch(() => null);
    return settings?.agentRenderToolEnabled !== false;
  },
  isSecretRequestAvailable: async () => {
    if (isExternalOpenCode || ENV_SKIP_OPENCODE_START) return false;
    const settings = await readSettingsFromDiskMigrated().catch(() => null);
    return settings?.agentSecretToolEnabled !== false;
  },
  isWorkflowAvailable: async () => {
    if (isExternalOpenCode || ENV_SKIP_OPENCODE_START) return false;
    return isWorkflowToolEnabled();
  },
  readSessionMetadata: readStoredSessionMetadata,
  persistSessionMetadata: (sessionID, directory, patch) => persistSessionMetadataPatch(sessionID, patch, { directory }),
  instructionEntries: {
    put: (sessionID, directory, key, value) => openCodeSessionClient(directory)
      .experimental.session.instructions.entry.put({ sessionID, key, value }),
    remove: (sessionID, directory, key) => openCodeSessionClient(directory)
      .experimental.session.instructions.entry.remove({ sessionID, key }),
  },
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
  isHiddenPayload: hiddenSessions.isHiddenPayload,
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
  readDefaultMode: process.env.OPENCHAMBER_SPACE_PERMISSION_DEFAULT_FILE
    ? () => readSpacePermissionDefault(process.env.OPENCHAMBER_SPACE_PERMISSION_DEFAULT_FILE)
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
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
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

const readWorkflowSettings = () => readSettingsFromDiskMigrated().catch(() => null);
const isWorkflowToolEnabled = async () => (await readWorkflowSettings())?.agentWorkflowToolEnabled === true;
const workflowAgentSessions = createWorkflowAgentSessions({
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
  startsWithoutApproval: async () => (await readWorkflowSettings())?.agentWorkflowAutoApprove === true,
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

const openCodeWatcherRuntime = createOpenCodeWatcherRuntime({
  waitForOpenCodePort: (...args) => waitForOpenCodePort(...args),
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  parseSseDataPayload: (...args) => parseSseDataPayload(...args),
  globalEventHub: globalMessageStreamHub,
  onWirePayload: (payload, { spaceId }) => {
    if (!spaceId) chatDirectoryCleanupRuntime.observeWirePayload(payload);
  },
  onDisconnect: () => chatDirectoryCleanupRuntime.onDisconnected(),
  onPayload: (payload, { spaceId }) => {
    if (!spaceId) void chatDirectoryCleanupRuntime.processPayload(payload);
    maybeCacheSessionInfoFromEvent(payload, { spaceId });
    void maybeSendPushForTrigger(payload, { spaceId });
    sessionRuntime.processOpenCodeSsePayload(payload, { spaceId });
  },
  onConnect: async () => {
    void chatDirectoryCleanupRuntime.onConnected();
    const readAt = Date.now();
    const statuses = await createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders }).fetchActiveSessionStatuses();
    if (statuses) sessionRuntime.adoptRunningSessions(Object.keys(statuses), readAt);
  },
});

globalMessageStreamHub.subscribeEvent((event) => {
  if (event?.payload?.type !== 'location.shutdown') return;
  const directory = event.payload.location?.directory ?? event.directory;
  if (directory && directory !== 'global') void openCodeTrust.forget(directory);
});
globalMessageStreamHub.subscribeStatus((status) => {
  if (status?.type === 'connect') {
    openCodeTrust.followLocations(true);
    void sessionGoalRuntime.recoverActiveGoals();
    void hiddenSessions.seed(async (cursor) => {
      const query = cursor ? `?limit=200&cursor=${encodeURIComponent(cursor)}` : '?limit=200';
      const response = await fetch(buildOpenCodeUrl(`/api/session${query}`, ''), { headers: getOpenCodeAuthHeaders() });
      return response.ok ? response.json() : null;
    }).catch(() => {});
  } else if (status?.type === 'disconnect' || status?.type === 'error') openCodeTrust.followLocations(false);
});

console.log('[session-assist] listening for session events');
globalMessageStreamHub.subscribeEvent((event) => {
  const directory = typeof event?.directory === 'string' && event.directory && event.directory !== 'global'
    ? event.directory
    : '';
  for (const payload of event?.translated?.() ?? []) {
    // external: https://github.com/anomalyco/opencode OpenCode 2 supplies no plugin abort signal; turn cancellation stops pending OpenChamber actions here.
    if (payload.type === 'session.idle' && payload.properties?.aborted === true) {
      agentToolRuntime?.abortSession?.(payload.properties.sessionID);
    }
    if (payload.type === 'session.idle' || payload.type === 'session.error') {
      openChamberControlService.releaseAnswerWaits(payload.properties?.sessionID);
    }
    sessionLineage.observe(payload);
    turnDurationRecorder.processPayload(payload, directory || payload.properties?.directory || '');
    sessionAssistRuntime.processPayload(payload, directory || payload.properties?.directory || '');
    sessionWorkRuntime.processPayload(payload, directory || payload.properties?.directory || '');
    sessionGoalRuntime.processPayload(payload, directory || payload.properties?.directory || '');
    contextObligatoryRuntime.processPayload(payload, directory || payload.properties?.directory || '');
    sessionWarmingRuntime.processPayload(payload);
    trackerSessionStatus.processPayload(payload, { spaceId: event?.spaceId ?? null });
    extensionSessionEvents.processPayload(payload, directory || payload.properties?.directory || '');
  }
});

const processForwardedEventPayload = (payload, emitSyntheticEvent, { spaceId = null } = {}) => {
  if (!payload || typeof payload !== 'object' || typeof emitSyntheticEvent !== 'function') {
    return;
  }

  for (const translated of translateWireEvent(payload)) {
    processForwardedServerEvent(translated, emitSyntheticEvent, spaceId);
  }
};

const processForwardedServerEvent = (payload, emitSyntheticEvent, spaceId = null) => {
  maybeCacheSessionInfoFromEvent(payload, { spaceId });

  if (payload.type !== 'session.status') {
    return;
  }

  const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
  const statusInfo = properties.status && typeof properties.status === 'object' ? properties.status : {};
  const info = properties.info && typeof properties.info === 'object' ? properties.info : {};
  const sessionId = typeof properties.sessionID === 'string' ? properties.sessionID.trim() : '';
  const status = typeof statusInfo.type === 'string'
    ? statusInfo.type.trim()
    : (typeof info.type === 'string' ? info.type.trim() : '');

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
        attempt: typeof statusInfo.attempt === 'number'
          ? statusInfo.attempt
          : (typeof info.attempt === 'number' ? info.attempt : undefined),
        message: typeof statusInfo.message === 'string'
          ? statusInfo.message
          : (typeof info.message === 'string' ? info.message : undefined),
        next: typeof statusInfo.next === 'number'
          ? statusInfo.next
          : (typeof info.next === 'number' ? info.next : undefined),
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
  getMergeSpaceSessionList: () => (spacesHost ? (payload) => spacesHost.mergeSessionList(payload) : null),
  getSpaceEventHub: () => (spacesHost ? globalMessageStreamHub : null),
  hiddenSessions,
  openCodeTrust,
  mcpOAuthSignIn,
  readWorktreeBootstrapStatus: (directory) => getWorktreeBootstrapGateStatus(directory, { bootstrapStore: worktreeBootstrapStore }),
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
    if (!snapshot || typeof snapshot.PATH !== 'string' || snapshot.PATH.length === 0) {
      return null;
    }
    return snapshot.PATH;
  },
});

const setOpenCodePort = (...args) => serverUtilsRuntime.setOpenCodePort(...args);
const waitForOpenCodePort = (...args) => serverUtilsRuntime.waitForOpenCodePort(...args);
const buildAugmentedPath = (...args) => serverUtilsRuntime.buildAugmentedPath(...args);
const buildManagedOpenCodePath = (...args) => serverUtilsRuntime.buildManagedOpenCodePath(...args);

const environmentStore = createEnvironmentStore({
  filePath: path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'environment.json'),
});
const listConfiguredProjects = async () => {
  const settings = await readSettingsFromDiskMigrated();
  return sanitizeProjects(settings?.projects || []);
};
const environmentRuntime = createEnvironmentRuntime({
  store: environmentStore,
  listProjects: listConfiguredProjects,
  spawn,
  commandBaseEnv: () => ({ ...process.env, PATH: buildAugmentedPath() }),
  readOpenCodeServiceEnv: () => readOpenCodeServiceEnv(OPENCODE_CONFIG_DIR),
  isEnterpriseMode: () => isEnterpriseMode(),
});
configureGitEnvironment(environmentRuntime);
const parseSseDataPayload = (...args) => serverUtilsRuntime.parseSseDataPayload(...args);
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
  pluginSwitchStore,
  isPluginSwitchAvailable: () => !isExternalOpenCode && !ENV_SKIP_OPENCODE_START,
  refreshPluginSwitches: async () => (
    managedConfigRuntime
      ? managedConfigRuntime.refreshManagedConfigFile()
      : { updated: false, reason: 'no-managed-opencode' }
  ),
});
const bootstrapRuntime = createBootstrapRuntime({
  createUiAuth,
  registerServerStatusRoutes,
  registerCommonRequestMiddleware,
  registerAuthAndAccessRoutes,
  registerTtsRoutes,
  registerNotificationRoutes,
  registerOpenChamberRoutes,
  registerAgentToolRoutes: (app, options) => options.agentToolRuntime.registerRoutes(app, options.express),
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

const openCodeLifecycleState = {};
Object.defineProperties(openCodeLifecycleState, {
  openCodeProcess: { get: () => openCodeProcess, set: (value) => { openCodeProcess = value; } },
  openCodePort: { get: () => openCodePort, set: (value) => { openCodePort = value; } },
  openCodeBaseUrl: { get: () => openCodeBaseUrl, set: (value) => { openCodeBaseUrl = value; } },
  openCodeWorkingDirectory: { get: () => openCodeWorkingDirectory, set: (value) => { openCodeWorkingDirectory = value; } },
  currentRestartPromise: { get: () => currentRestartPromise, set: (value) => { currentRestartPromise = value; } },
  isRestartingOpenCode: { get: () => isRestartingOpenCode, set: (value) => { isRestartingOpenCode = value; } },
  openCodeApiPrefix: { get: () => openCodeApiPrefix, set: (value) => { openCodeApiPrefix = value; } },
  openCodeApiPrefixDetected: { get: () => openCodeApiPrefixDetected, set: (value) => { openCodeApiPrefixDetected = value; } },
  openCodeApiDetectionTimer: { get: () => openCodeApiDetectionTimer, set: (value) => { openCodeApiDetectionTimer = value; } },
  lastOpenCodeError: { get: () => lastOpenCodeError, set: (value) => { lastOpenCodeError = value; } },
  lastOpenCodeLaunchDiagnostics: { get: () => lastOpenCodeLaunchDiagnostics, set: (value) => { lastOpenCodeLaunchDiagnostics = value; } },
  lastOpenCodeHealthFailure: { get: () => lastOpenCodeHealthFailure, set: (value) => { lastOpenCodeHealthFailure = value; } },
  lastManagedOpenCodeProcess: { get: () => lastManagedOpenCodeProcess, set: (value) => { lastManagedOpenCodeProcess = value; } },
  lastOpenCodeRestartDiagnostics: { get: () => lastOpenCodeRestartDiagnostics, set: (value) => { lastOpenCodeRestartDiagnostics = value; } },
  isOpenCodeReady: { get: () => isOpenCodeReady, set: (value) => { isOpenCodeReady = value; } },
  openCodeNotReadySince: { get: () => openCodeNotReadySince, set: (value) => { openCodeNotReadySince = value; } },
  isExternalOpenCode: { get: () => isExternalOpenCode, set: (value) => { isExternalOpenCode = value; } },
  isShuttingDown: { get: () => isShuttingDown, set: (value) => { isShuttingDown = value; } },
  healthCheckInterval: { get: () => healthCheckInterval, set: (value) => { healthCheckInterval = value; } },
  expressApp: { get: () => expressApp, set: (value) => { expressApp = value; } },
  useWslForOpencode: { get: () => useWslForOpencode, set: (value) => { useWslForOpencode = value; } },
  resolvedWslBinary: { get: () => resolvedWslBinary, set: (value) => { resolvedWslBinary = value; } },
  resolvedWslOpencodePath: { get: () => resolvedWslOpencodePath, set: (value) => { resolvedWslOpencodePath = value; } },
  resolvedWslDistro: { get: () => resolvedWslDistro, set: (value) => { resolvedWslDistro = value; } },
});

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
    if (typeof settings.lastDirectory === 'string' && settings.lastDirectory) {
      directories.push(settings.lastDirectory);
    }
    const projects = Array.isArray(settings.projects) ? [...settings.projects] : [];
    projects.sort((a, b) => (b?.lastOpenedAt ?? 0) - (a?.lastOpenedAt ?? 0));
    for (const project of projects) {
      if (typeof project?.path === 'string' && project.path) {
        directories.push(project.path);
      }
    }
    const existing = await Promise.all([...new Set(directories)].map(async (directory) => (
      (await fs.promises.stat(directory).catch(() => null))?.isDirectory()
        && await openCodeTrust.isTrusted(directory).catch(() => false)
        ? directory
        : null
    )));
    return existing.filter(Boolean);
  },
  noProjectDirectory: OPENCHAMBER_CHATS_DIR,
  // external: #2638 A managed restart can change the upstream port, so event readers reconnect to the current endpoint.
  onOpenCodeRestarted: () => {
    resetOpenCodeRuntimeProviders();
    try {
      messageStreamRuntime?.rebindUpstream();
    } catch (error) {
      console.warn('Failed to rebind message stream after OpenCode restart:', error?.message ?? error);
    }
    try {
      const recovery = sessionRuntime.interruptBusySessionsAfterRestart();
      const notification = buildRestartNotification(recovery);
      if (notification) broadcastUiNotification(notification);
    } catch (error) {
      console.warn('Failed to reconcile sessions after OpenCode restart:', error?.message ?? error);
    }
  },
  getManagedOpenCodeEnv: async () => (managedConfigRuntime ? managedConfigRuntime.buildManagedChildEnv() : {}),
  getUserEnvironment: () => environmentRuntime.forOpenCode(),
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

const getOpenCodeUpgradeCapability = () => {
  const activeBinary = lastOpenCodeLaunchDiagnostics?.sourceBinary
    || lastOpenCodeLaunchDiagnostics?.binary
    || resolvedOpencodeBinary;
  return resolveOpenCodeUpgradeCapability({
    isExternal: isExternalOpenCode,
    hasManagedProcess: Boolean(openCodeProcess),
    activeBinary,
    isBundledBinary: isBundledOpenCodePath,
    pinnedByPolicy: Boolean(readEnterprisePolicy().opencodeBinary),
  });
};

const restartOpenCode = (...args) => openCodeLifecycleRuntime.restartOpenCode(...args);
const waitForOpenCodeReady = (...args) => openCodeLifecycleRuntime.waitForOpenCodeReady(...args);
const waitForAgentPresence = (...args) => openCodeLifecycleRuntime.waitForAgentPresence(...args);
const refreshOpenCodeAfterConfigChange = (...args) => openCodeLifecycleRuntime.refreshOpenCodeAfterConfigChange(...args);
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
  readSessionDefaults: async (projectID) => {
    const settings = await readSettingsFromDiskMigrated();
    const project = sanitizeProjects(settings?.projects || []).find((entry) => entry.id === projectID) ?? null;
    return resolveSessionDefaults({ settings, project });
  },
  resolveAutoSelection: (input) => routingRuntime.resolveAutoSelection(input),
  listProjects: async () => {
    const settings = await readSettingsFromDiskMigrated();
    return sanitizeProjects(settings?.projects || []);
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
        writeSseEvent(client, {
          type: 'openchamber:scheduled-task-ran',
          properties: {
            projectId: scheduledChatsScope.toPublicID(event.projectID),
            taskId: event.taskID,
            ranAt: event.ranAt,
            status: event.status,
            ...(event.sessionID ? { sessionId: event.sessionID } : {}),
          },
        });
      } catch {
        uiOpenChamberEventClients.delete(client);
      }
    }
  },
  logger: console,
});
const emitSessionCreatedEvent = (event) => {
  for (const client of uiOpenChamberEventClients) {
    try {
      writeSseEvent(client, {
        type: 'openchamber:session-created',
        properties: {
          sessionId: event.sessionID,
          directory: event.directory,
          createdAt: event.createdAt,
          promptDispatched: event.promptDispatched === true,
          dispatchedAsCommand: event.dispatchedAsCommand === true,
          ...(event.projectID ? { projectId: event.projectID } : {}),
          ...(event.title ? { title: event.title } : {}),
        },
      });
    } catch {
      uiOpenChamberEventClients.delete(client);
    }
  }
};
const resolveMemoryProjectId = createMemoryProjectResolver({
  listProjectPaths: async () => {
    const settings = await readSettingsFromDiskMigrated().catch(() => null);
    return sanitizeProjects(settings?.projects || []).map((project) => project.path);
  },
  resolvePrimaryWorktreeRoot,
  managedProjectRoots: [...new Set([path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'chats'), OPENCHAMBER_CHATS_DIR])],
});

const emitAgentMemoryChangedEvent = (event) => {
  for (const client of uiOpenChamberEventClients) {
    try {
      writeSseEvent(client, {
        type: 'openchamber:agent-memory-changed',
        properties: {
          scope: event.scope,
          ...(event.projectId ? { projectId: event.projectId } : {}),
        },
      });
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
  sanitizeProjects,
  projectConfigRuntime,
  scheduledTasksRuntime,
  chatsScope: scheduledChatsScope,
  resolvePrimaryWorktreeRoot,
  readModelCatalog,
});
const openChamberSessionService = createOpenChamberSessionService({
  onSessionArchived: (sessionID, archivedAt) => extensionSessionEvents.processPayload({
    type: 'openchamber:session-archived',
    properties: { sessionID, archivedAt },
  }),
  chatsScope: scheduledChatsScope,
  readSettingsFromDiskMigrated,
  sanitizeProjects,
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
const browserControlBroker = createBrowserControlBroker({
  createId: () => `browser-${crypto.randomUUID()}`,
  emitRequest: (request) => {
    const needsBrowserView = request.action !== 'browser.open';
    let delivered = 0;
    for (const client of uiOpenChamberEventClients) {
      if (needsBrowserView && client.openchamberBrowserCapable !== true) continue;
      try {
        writeSseEvent(client, {
          type: 'openchamber:browser-control-request',
          properties: {
            requestId: request.requestId,
            action: request.action,
            parameters: request.parameters,
            context: request.context,
          },
        });
        delivered += 1;
      } catch {
        uiOpenChamberEventClients.delete(client);
      }
    }
    return delivered;
  },
});

const emitBrowserProviderResetEvent = ({ guestId, guestName }) => {
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
  readSettingsFromDiskMigrated,
  emitDesktopNotification,
  broadcastUiNotification,
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
    execute: (...args) => openChamberControlService.execute(...args),
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

const browserUploadStore = createUploadStore();
const openChamberControlService = createOpenChamberControlService({
  isHiddenSession: (sessionID, record) => hiddenSessions.has(sessionID, record),
  chatsScope: scheduledChatsScope,
  chatRoots: [path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'chats'), OPENCHAMBER_CHATS_DIR],
  updateSessionMetadata: updateSessionMetadataWith,
  isWorktreePinned: isWorktreeDirectoryPinned,
  readPendingRequests: () => sessionRuntime.getPendingBlockingRequestsSnapshot(),
  isPermissionAutoAnswered: (sessionId, directory, permissionId) => permissionAutoAcceptRuntime.isPermissionAutoAnswered(sessionId, directory, permissionId),
  readSettingsFromDiskMigrated,
  sanitizeProjects,
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
  isKnowledgeToolEnabled: async () => {
    const settings = await readSettingsFromDiskMigrated().catch(() => null);
    return settings?.agentKnowledgeToolEnabled !== false;
  },
  isRenderToolEnabled: async () => {
    const settings = await readSettingsFromDiskMigrated().catch(() => null);
    return settings?.agentRenderToolEnabled !== false;
  },
  isSecretToolEnabled: async () => {
    const settings = await readSettingsFromDiskMigrated().catch(() => null);
    return settings?.agentSecretToolEnabled !== false;
  },
  secretFiles,
  onPageWaitChange: (change) => {
    sessionRuntime.trackWaitingPage(change);
    if (change.type === 'waiting') {
      const payload = {
        type: 'openchamber:page-waiting',
        properties: { sessionID: change.sessionId, directory: change.directory, page: { id: change.callId, title: change.title } },
      };
      broadcastOpenChamberUiEvent(payload);
      void maybeSendPushForTrigger(payload);
      extensionSessionEvents.processPayload(payload, change.directory);
      return;
    }
    const settled = {
      type: 'openchamber:page-settled',
      properties: { sessionID: change.sessionId, pageID: change.callId },
    };
    broadcastOpenChamberUiEvent(settled);
    void maybeSendPushForTrigger(settled);
    extensionSessionEvents.processPayload(settled, change.directory);
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
    setWorktreeTaskTitle,
    readPlaceholderBranch: (directory) => readRenameableGeneratedBranch(directory),
    renamePlaceholderBranch: renameGeneratedWorktreeBranch,
  },
  dispatchResults: dispatchResultsRuntime,
  prWatch: prWatchRuntime,
  extensionWaits: extensionWaitsRuntime,
  laterPages: process.env.OPENCHAMBER_SPACE_IDLE_STOP_FILE ? null : laterPagesRuntime,
  workflowRuntime,
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
const bootstrapOpenCodeAtStartup = async (...args) => {
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
  void waitForOpenCodeReady()
    .then(() => sessionMetadataStore.migrateLegacy())
    .catch((error) => console.warn('[openchamber-sessions] session metadata migration failed:', error?.message ?? error));
  void waitForOpenCodeReady()
    .then(() => openChamberSessionService.sessionArchive.migrateLegacy())
    .catch((error) => console.warn('[openchamber-sessions] session archive migration failed:', error?.message ?? error));
};
const killProcessOnPort = (...args) => openCodeLifecycleRuntime.killProcessOnPort(...args);
const waitForPortRelease = (...args) => openCodeLifecycleRuntime.waitForPortRelease(...args);

const setupProxy = (...args) => serverUtilsRuntime.setupProxy(...args);
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
  stopFolderWatches: () => {
    stopEnterprisePolicyWatch();
    featureRoutesRuntime.stopFolderWatches();
  },
});

const gracefulShutdown = (...args) => gracefulShutdownRuntime.gracefulShutdown(...args);

async function main(options = {}) {
  beginGuestServiceHost({ registryDir: guestServiceRegistryDir(OPENCHAMBER_DATA_DIR) });
  applyOutboundProxyFromEnv();
  const port = Number.isFinite(options.port) && options.port >= 0 ? Math.trunc(options.port) : DEFAULT_PORT;
  const host = typeof options.host === 'string' && options.host.length > 0 ? options.host : undefined;
  const effectiveBindHost = host
    || (typeof process.env.OPENCHAMBER_HOST === 'string' && process.env.OPENCHAMBER_HOST.trim().length > 0
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
    getActivePort: () => {
      const address = server?.address?.();
      return typeof address === 'object' && address ? address.port : null;
    },
    getActiveHost: () => server?.address?.()?.address ?? null,
  });
  limitFailoverRuntime = createLimitFailoverRuntime({
    fsPromises,
    path,
    instanceDir,
    readSettings: () => readSettingsFromDiskMigrated(),
    authorizeRequest: (req) => agentToolRuntime.authorizeRequest(req),
    broadcastUiEvent: (event) => broadcastOpenChamberUiEvent(event),
  });
  managedConfigRuntime = createManagedConfigRuntime({
    fsPromises,
    path,
    instanceDir,
    env: process.env,
    agentToolRuntime,
    limitFailoverRuntime,
    readSettings: () => readSettingsFromDiskMigrated(),
    listExtensionSkillDirectories: guestAgentContext.skillDirectories,
    listExtensionPluginDirectories: guestAgentContext.pluginDirectories,
    openchamberVersion: OPENCHAMBER_VERSION,
    readPluginDenials: () => pluginSwitchStore.denials(),
  });
  stopEnterprisePolicyWatch = watchEnterprisePolicy({
    onChange: () => {
      managedConfigRuntime.refreshManagedConfigFile().catch((error) => {
        console.warn('Failed to rewrite the managed OpenCode config after a policy change:', error?.message ?? error);
      });
      broadcastOpenChamberUiEvent({ type: 'openchamber:guests-changed' });
    },
  });
  await ensureChatsDir({ fsPromises, chatsDir: OPENCHAMBER_CHATS_DIR, warn: (message) => console.warn(`[data-dir] ${message}`) });

  const requestReachedLanAddress = (req) => {
    const raw = typeof req?.socket?.localAddress === 'string' ? req.socket.localAddress : '';
    const address = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) return null;
    if (address.startsWith('127.')) return null;
    return address;
  };
  const advertisedLanUrl = readAdvertisedLanUrl();
  const resolvePairingTransports = (req) => {
    const activePort = tunnelRuntimeContext.getActivePort() || port;
    const local = `http://127.0.0.1:${activePort}`;
    if (advertisedLanUrl) {
      return { local, lan: advertisedLanUrl, relayAvailable: !relayBlockedByEnterprise() };
    }
    let lanHost = null;
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
  const resolveDirectLanUrls = (req) => {
    if (advertisedLanUrl) return [advertisedLanUrl];
    const activePort = tunnelRuntimeContext.getActivePort() || port;
    const urls = [];
    const push = (host) => {
      if (typeof host !== 'string' || !host) return;
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
        // interface scan failure → whatever we already collected
      }
    } else {
      const h = String(effectiveBindHost || '').toLowerCase();
      if (h && h !== '127.0.0.1' && h !== 'localhost' && h !== '::1') push(effectiveBindHost);
    }
    return urls;
  };
  const uiPassword = typeof options.uiPassword === 'string'
    ? options.uiPassword
    : (typeof process.env.OPENCHAMBER_UI_PASSWORD === 'string' ? process.env.OPENCHAMBER_UI_PASSWORD : null);
  if (
    isNetworkExposedBindHost(effectiveBindHost)
    && !(typeof uiPassword === 'string' && uiPassword.trim().length > 0)
    && !isUnsafeUnauthenticatedLanAllowed(process.env)
  ) {
    throw new Error(getUnauthenticatedLanErrorMessage(effectiveBindHost));
  }
  if (isNetworkExposedBindHost(effectiveBindHost) && isNetworkAccessBlocked()) {
    throw new Error(NETWORK_ACCESS_BLOCKED_ERROR);
  }
  const tryCfTunnel = options.tryCfTunnel === true;
  const apiOnly = options.apiOnly === true || isEnvFlagEnabled(process.env.OPENCHAMBER_API_ONLY);
  const shouldUseCanonicalTunnelConfig = typeof options.tunnelMode === 'string'
    || typeof options.tunnelProvider === 'string'
    || options.tunnelConfigPath === null
    || typeof options.tunnelConfigPath === 'string'
    || typeof options.tunnelToken === 'string'
    || typeof options.tunnelHostname === 'string';
  const startupTunnelRequest = shouldUseCanonicalTunnelConfig
    ? normalizeTunnelStartRequest({
        provider: normalizeTunnelProvider(options.tunnelProvider),
        mode: options.tunnelMode,
        configPath: normalizeOptionalPath(options.tunnelConfigPath),
        token: typeof options.tunnelToken === 'string' ? options.tunnelToken.trim() : '',
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
  const onTunnelReady = typeof options.onTunnelReady === 'function' ? options.onTunnelReady : null;
  if (typeof options.exitOnShutdown === 'boolean') {
    exitOnShutdown = options.exitOnShutdown;
  }
  if (typeof options.onDesktopNotification === 'function') {
    notificationEmitterRuntime.setOnDesktopNotification(options.onDesktopNotification);
  }
  if (typeof options.getIsWindowFocused === 'function') {
    notificationTriggerRuntime.setGetIsWindowFocused(options.getIsWindowFocused);
  }
  const getDesktopRuntimeConfig = typeof options.getDesktopRuntimeConfig === 'function'
    ? options.getDesktopRuntimeConfig
    : null;
  const desktopUpdater = options.desktopUpdater
    && typeof options.desktopUpdater.check === 'function'
    && typeof options.desktopUpdater.install === 'function'
    && typeof options.desktopUpdater.restart === 'function'
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

  const buildSpacesHost = async () => createSpacesHost({
    dataDir: OPENCHAMBER_DATA_DIR,
    dockerPath: searchPathFor('docker', buildAugmentedPath()) ?? 'docker',
    sshDockerHost: dockerHostOf((await readSettingsFromDiskMigrated().catch(() => null))?.isolatedSpacesSshHost),
    colimaPath: searchPathFor('colima', buildAugmentedPath()),
    findProgram: (name) => searchPathFor(name, buildAugmentedPath()) ?? null,
    gitPath: searchPathFor('git', buildAugmentedPath()) ?? 'git',
    hostEnvironment: { ...process.env, PATH: buildAugmentedPath() },
    listProjectDirectories: async () => {
      const settings = await readSettingsFromDiskMigrated();
      return sanitizeProjects(settings?.projects || []).map((project) => project.path);
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
      console.error(`[spaces] isolated spaces are unavailable this start: ${error?.code ?? ''} ${error?.message ?? error}`.trim());
      spacesHost = null;
    }
  }

  const app = express();
  const serverStartedAt = new Date().toISOString();
  const packagedClientOrigins = new Set([
    'openchamber-ui://app',
    'capacitor://localhost',
    'http://localhost',
    'https://localhost',
  ]);
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
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (packagedClientOrigins.has(origin) || (allowLocalDevOrigins && isLocalDevClientOrigin(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept,X-Requested-With,Cache-Control,X-OpenCode-Directory,X-OpenCode-Directory-Encoding,Ngrok-Skip-Browser-Warning,CF-Access-Client-Id,CF-Access-Client-Secret,X-OpenChamber-Surface,X-OpenChamber-Provider,X-OpenChamber-Model,X-OpenChamber-Part-Shells');
      res.setHeader('Access-Control-Expose-Headers', 'x-next-cursor');
      // external: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Max-Age Chromium caps the preflight cache lifetime at 2 hours.
      res.setHeader('Access-Control-Max-Age', '7200');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }
    next();
  });
  app.use(compression({
    filter: (req, res) => {
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
  let tunnelRuntimeContextHolder = null;

  const bootstrapResult = bootstrapRuntime.setupBaseRoutes(app, {
    process,
    openchamberVersion: OPENCHAMBER_VERSION,
    runtimeName: process.env.OPENCHAMBER_RUNTIME || 'web',
    serverStartedAt,
    gracefulShutdown,
    readOpenCodeLoad: () => readOpenCodeLoad({ buildOpenCodeUrl, getOpenCodeAuthHeaders }),
    getHealthSnapshot: () => {
      const launchSpec = resolvedOpencodeBinary && !useWslForOpencode
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
        opencodeBinarySource: resolvedOpencodeBinarySource || null,
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
      if (Number.isFinite(activePort) && activePort > 0) return activePort;
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
        return typeof name === 'string' && name.trim().length > 0 ? name.trim() : 'OpenChamber';
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
    writeSettingsToDisk,
    addOrUpdatePushSubscription,
    removePushSubscription,
    addOrUpdateApnsToken,
    removeApnsToken,
    updateUiVisibility,
    clearPendingPushBadge: () => clearPendingPushBadge(),
    clearSessionPushNotifications: (sessionId) => notificationTriggerRuntime.clearSessionPushNotifications(sessionId),
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
    desktopUpdater,
    getOpenCodeCompatibility,
    skipBodyParsing: (req) => spacesHost?.skipsBodyParsing(req) === true,
  });
  uiAuthController = bootstrapResult.uiAuthController;
  app.use(spaceArchive.guard);
  app.use((req, res, next) => (spacesHost ? spacesHost.middleware(req, res, next) : next()));
  server.prependListener('upgrade', (...args) => { spacesHost?.upgradeHandler(...args); });
  const startSpacesHost = (host) => {
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
    os,
    readSettingsFromDiskMigrated,
    writeSettingsToDisk,
    relayKeyStore,
    remoteClientAuthRuntime,
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
  relayService.registerRoutes(app);
  registerSharePageRoutes(app, sharePagesRuntime);
  registerReceivedPageRoutes(app, receivedPagesRuntime);

  registerBrowserControlRoutes(app, { express, broker: browserControlBroker });
  registerUploadRoute(app, { store: browserUploadStore });

  const devServerScanner = createDevServerScanner({ spawn, platform: process.platform });
  const listDevServers = () => devServerScanner.discover({
    ownPorts: [port, openCodePort].filter((value) => Number.isInteger(value) && value > 0),
  });

  createDevTunnelRuntime({
    server,
    discoverDevServers: listDevServers,
    uiAuthController,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
    logger: console,
  });

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
    getOpenCodePluginDelivery: () => openCodePluginDelivery({
      external: isExternalOpenCode || ENV_SKIP_OPENCODE_START,
      origin: ENV_CONFIGURED_OPENCODE_HOST?.origin || openCodeBaseUrl || null,
      ownsConfigFile: managedConfigRuntime?.ownsConfigFile() ?? true,
    }),
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
      const launch = resolveManagedOpenCodeLaunchSpec(lastOpenCodeLaunchDiagnostics?.sourceBinary || resolvedOpencodeBinary);
      const upgrade = () => runOpenCodeCliUpgrade(launch, {
        env: { ...getLoginShellEnvSnapshot(), ...process.env, PATH: buildManagedOpenCodePath() },
        cwd: os.homedir(),
      });
      // external: https://learn.microsoft.com/en-us/windows/win32/fileio/creating-and-opening-files Windows cannot replace the running executable; the managed process stops during installation.
      if (process.platform !== 'win32') return upgrade();
      return restartOpenCode('opencode-upgrade', { whileStopped: upgrade });
    },
    formatSettingsResponse,
    readSettingsFromDisk,
    readSettingsFromDiskMigrated,
    persistSettings,
    persistResolvedSettings: (...args) => settingsRuntime.persistResolvedSettings(...args),
    sanitizeProjects,
    sanitizeSkillCatalogs,
    isUnsafeSkillRelativePath,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    getOpenCodePort: () => openCodePort,
    getOwnPorts: () => [port, openCodePort].filter((value) => Number.isInteger(value) && value > 0),
    getActivePort: () => {
      const address = server?.address?.();
      return address && Number.isInteger(address.port) ? address.port : null;
    },
    getActiveHost: () => server?.address?.()?.address ?? null,
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

  try {
    await scheduledTasksRuntime.start();
  } catch (error) {
    console.warn('[ScheduledTasks] Failed to start runtime:', error?.message || error);
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
      tunnel: {
        active: Boolean(tunnelService.getPublicUrl()),
      },
      scheduledTasks: scheduledTasksRuntime.getStatus(),
    }),
    isReady: () => isOpenCodeReady,
    getManagedOpenCodePreflight: () => openCodeLifecycleRuntime.getManagedOpenCodePreflight(),
    restartOpenCode: () => restartOpenCode(),
    getOpenCodeProcessInfo: () => {
      const managed = Boolean((openCodeProcess || openCodePort) && !ENV_SKIP_OPENCODE_START && !isExternalOpenCode);
      return {
        managed,
        pid: managed && typeof openCodeProcess?.pid === 'number' ? openCodeProcess.pid : null,
        port: managed ? openCodePort : null,
      };
    },
    stop: (shutdownOptions = {}) => gracefulShutdown({ exitProcess: shutdownOptions.exitProcess ?? false }),
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
