import { installOpenCodeV2, supportsOpenCodeV2Install } from './lib/opencode/v2-install.js';
import { describeOpenCodeCompatibility, readOpenCodeCliVersion, readExternalOpenCodeVersion } from './lib/opencode/compatibility.js';
import 'reflect-metadata';
import express from 'express';
import { buildRestartNotification } from './lib/opencode/restart-notification.js';
import compression from 'compression';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import { fileURLToPath } from 'url';
import os from 'os';
import crypto from 'crypto';
import http2 from 'node:http2';
import { createUiAuth } from './lib/ui-auth/ui-auth.js';
import { createTunnelAuth } from './lib/opencode/tunnel-auth.js';
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
  isUiAuthConfigured,
  isUnsafeUnauthenticatedLanAllowed,
  readAdvertisedLanUrl,
} from './lib/security/bind-host.js';
import { isEnterpriseMode, isNetworkAccessBlocked, NETWORK_ACCESS_BLOCKED_ERROR, readEnterprisePolicy } from './lib/enterprise-mode.js';
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
import { createProjectDirectoryRuntime } from './lib/opencode/project-directory-runtime.js';
import { createSettingsNormalizationRuntime } from './lib/opencode/settings-normalization-runtime.js';
import { createSettingsHelpers } from './lib/opencode/settings-helpers.js';
import { createThemeRuntime } from './lib/opencode/theme-runtime.js';
import { createFeatureRoutesRuntime } from './lib/opencode/feature-routes-runtime.js';
import { parseServeCliOptions } from './lib/opencode/cli-options.js';
import {
  isRequestAuthorized,
  registerAuthAndAccessRoutes,
  registerCommonRequestMiddleware,
  registerServerStatusRoutes,
} from './lib/opencode/core-routes.js';
import { registerOpenChamberRoutes } from './lib/opencode/openchamber-routes.js';
import { createServerUtilsRuntime } from './lib/opencode/server-utils-runtime.js';
import { createOpenCodeTrust } from './lib/opencode-trust/index.js';
import { registerSessionProjectRoutes } from './lib/projects/session-directory.js';
import { guardOpenCodeFetch } from './lib/opencode-trust/fetch-guard.js';
import { createStaticRoutesRuntime } from './lib/opencode/static-routes-runtime.js';
import { createSettingsRuntime } from './lib/opencode/settings-runtime.js';
import { createOpenCodeResolutionRuntime } from './lib/opencode/opencode-resolution-runtime.js';
import { runOpenCodeCliUpgrade } from './lib/opencode/cli-upgrade.js';
import { resolveOpenCodeUpgradeCapability } from './lib/opencode/upgrade-capability.js';
import { createBootstrapRuntime } from './lib/opencode/bootstrap-runtime.js';
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
import { createTrackerRegistry } from './lib/trackers/registry.js';
import { createTrackerSessionStatus } from './lib/trackers/session-status.js';
import { sourceControlProviderDescriptors } from './lib/source-control/provider-descriptors.js';
import { createSessionKnowledgeRuntime } from './lib/session-knowledge/runtime.js';
import { createMessageSearchRuntime } from './lib/message-search/runtime.js';
import { createScheduledTasksRuntime } from './lib/scheduled-tasks/runtime.js';
import { createSuggestedTasksRuntime } from './lib/suggested-tasks/runtime.js';
import { createBotsHost, createBotChildServer } from './lib/bots/host.js';
import { createMcpToolsRuntime } from './lib/mcp-tools/runtime.js';
import { createSuggestionStore } from './lib/suggested-tasks/store.js';
import { resolveSessionDefaults } from './lib/scheduled-tasks/session-defaults.js';
import { createChatsScope } from './lib/scheduled-tasks/chats-scope.js';
import { createUnregisteredScheduledWorktreeBridge } from './lib/scheduled-tasks/worktree-bridge.js';
import { createServerStartupRuntime } from './lib/opencode/server-startup-runtime.js';
import { createTunnelWiringRuntime } from './lib/opencode/tunnel-wiring-runtime.js';
import { createStartupPipelineRuntime } from './lib/opencode/startup-pipeline-runtime.js';
import { runCliEntryIfMain } from './lib/opencode/cli-entry-runtime.js';
import { registerNotificationRoutes } from './lib/notifications/routes.js';
import { createNotificationEmitterRuntime } from './lib/notifications/emitter-runtime.js';
import { createNotificationTriggerRuntime } from './lib/notifications/runtime.js';
import { createAppVersionMarker, createNotificationCenterPersistence, createNotificationCenterRuntime } from './lib/notifications/center.js';
import { getCurrentVersion as getInstalledOpenChamberVersion } from './lib/package-manager.js';
import { createPushRuntime } from './lib/notifications/push-runtime.js';
import { createApnsRuntime } from './lib/notifications/apns-runtime.js';
import { createNotificationTemplateRuntime } from './lib/notifications/template-runtime.js';
import { createPermissionAutoAcceptRuntime } from './lib/permission-auto-accept/runtime.js';
import { createMessageQueueRuntime } from './lib/message-queue/runtime.js';
import { createFixLoopRuntime } from './lib/pr-fix-loop/runtime.js';
import { createSpaceWorker } from './lib/pr-fix-loop/space-worker.js';
import { createApprovalPublication } from './lib/pr-fix-loop/publication.js';
import { createHostGit } from './lib/spaces/host-git.js';
import { runCommand as runSpaceCommand } from './lib/spaces/run-command.js';
import { unwrapOpenCodeResponse } from './lib/opencode/response-envelope.js';
import { createTokenSnapshotReader } from './lib/pr-fix-loop/token-usage.js';
import { createRestackRuntime } from './lib/pr-stacks/restack.js';
import { isGitHubRateLimited, noteIfGitHubRateLimit, noteGitHubRateLimit } from './lib/github/rate-limit.js';
import { isGraphqlRateLimitError } from './lib/github/pr-summaries.js';
import { createAutoReviewRuntime } from './lib/auto-review/runtime.js';
import { createAutomationAdmission, sessionKey } from './lib/session-automation/runtime.js';
import { createDispatchResultsRuntime } from './lib/dispatch-results/runtime.js';
import { createPrWatchRuntime } from './lib/pr-watch/runtime.js';
import { createMergeFollowRuntime } from './lib/github/merge-follow.js';
import { createWorkflowAgentSessions } from './lib/workflows/agent-session.js';
import { createWorkflowRuntime } from './lib/workflows/runtime.js';
import { createWorkflowRunStore } from './lib/workflows/store.js';
import { createRoutingRuntime } from './lib/routing/runtime.js';
import { createJevClient } from './lib/routing/jev.js';
import { createSessionWorkRuntime } from './lib/session-work/runtime.js';
import { createSessionInterruptionRuntime } from './lib/session-interruption/runtime.js';
import { restartInterruptedNotification } from './lib/session-interruption/restart.js';
import { OpenCode } from '@opencode/client';
import { createAutoResumeRuntime } from './lib/session-interruption/auto-resume.js';
import { readCgroupMemory } from './lib/opencode/cgroup-memory.js';
import { createSessionLineage } from './lib/session-lineage.js';
import { createGracefulShutdownRuntime } from './lib/opencode/shutdown-runtime.js';
import { beginGuestServiceHost, beginGuestServiceShutdown, proxyGuestServiceRequest, refreshServerBrowserOrigins, stopAllGuestServices } from './lib/guests/service.js';
import { serverBrowserOrigins } from './lib/guests/server-browser-config.js';
import { guestServiceRegistryDir } from './lib/guests/service-registry.js';
import { findInstalledGuest, listInstalledGuests } from './lib/guests/catalog.js';
import { createExtensionSessionEvents } from './lib/guests/session-events.js';
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
import {
  addDetachedWorktree,
  configureGitEnvironment,
  getCheckedOutBranch,
  getWorktreeBootstrapGateStatus,
  getRepositoryRemoteUrls,
  getWorktrees,
  listChangedPathsSince,
  readScanCheckout,
  readRenameableGeneratedBranch,
  removeDetachedWorktree,
  renameGeneratedWorktreeBranch,
  resolvePrimaryWorktreeRoot,
  runGitCommandNoEditor,
  setWorktreeTaskTitle,
} from './lib/git/service.js';
import { getLinearAuth } from './lib/linear/auth.js';
import { createEnvironmentStore } from './lib/environment/store.js';
import { createEnvironmentRuntime } from './lib/environment/runtime.js';
import { readOpenCodeServiceEnv } from './lib/environment/opencode-service-env.js';
import { OPENCODE_CONFIG_DIR } from './lib/opencode/shared.js';
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
import { createManagedConfigRuntime } from './lib/opencode/managed-config-file.js';
import { createLimitFailoverRuntime } from './lib/limit-failover/runtime.js';
import { prepareInstanceDir } from './lib/opencode/instance-dir.js';
import { createOpenChamberSessionService } from './lib/openchamber-sessions/routes.js';
import { createSessionMetadataStore, createOpenCodeSessionMetadata } from './lib/openchamber-sessions/session-metadata-store.js';
import { createUnreadBaseline } from './lib/openchamber-sessions/unread-baseline.js';
import { createTurnDurationRecorder } from './lib/openchamber-sessions/turn-duration.js';
import { createOpenCodeClient } from './lib/openchamber-sessions/opencode-client.js';
import { createScheduledTaskService } from './lib/scheduled-tasks/service.js';
import { createOpenChamberControlService } from './lib/openchamber-control/service.js';
import { createPluginNotificationEmitter } from './lib/notifications/emit-route.js';
import { OpenChamberControlError } from './lib/openchamber-control/error.js';
import { createSessionLinker } from './lib/openchamber-sessions/session-link.js';
import { linkedWorktreeOf } from './lib/openchamber-sessions/work-naming.js';
import { createFileOpenRequester } from './lib/openchamber-control/file-open.js';
import { createSecretFiles } from './lib/openchamber-control/secret-request.js';
import { applyConnectAttemptTimeout } from './lib/network-defaults.js';
import { applyOutboundProxyFromEnv } from './lib/outbound-proxy.js';
import { applyForkReleaseSource } from './lib/fork-identity.js';
import { applySystemCertificates } from './lib/system-ca.js';
import { readOpenCodeLoad } from './lib/diagnostics/opencode-load.js';
import { readAgentServerMode, createAgentTunnelContext } from './lib/agent-server/mode.js';
import { asNonEmptyString } from './lib/shared/guards.js';
import { createAgentUpstream } from './lib/agent-server/agent-upstream.js';
import { classify, normalizedRequestUrl } from './lib/agent-server/ownership.js';
import { createFrontDoor, frontDoorRequestGate } from './lib/agent-server/front-door.js';
import { createAgentStreams } from './lib/agent-server/agent-streams.js';
import { createFrontDoorTrackedItems } from './lib/agent-server/tracked-items.js';
import { createSettingsMirror } from './lib/agent-server/settings-mirror.js';
import { createProjectRegistry, sanitizeRegistryProjects } from './lib/agent-server/project-registry.js';
import { createHostdClient } from './lib/hostd/client.js';
import { trustProjectRepositories } from './lib/agent-server/git-trust.js';
import { registerDisplayMetadataRoute, readAgentDisplayMetadata } from './lib/agent-server/display-metadata.js';
import { registerAgentProtectedMcpRoutes, createProtectedMcpMirror, AGENT_PROTECTED_MCP_ROUTE } from './lib/agent-server/protected-mcp.js';
import { registerSpaceTransferRoutes } from './lib/agent-server/space-transfer-routes.js';
import { createAgentFixLoopServices } from './lib/agent-server/fix-loop-services.js';
import { registerFixLoopServiceRoutes } from './lib/agent-server/fix-loop-service-routes.js';
import { registerFrontDoorFixLoopRoutes } from './lib/agent-server/front-door-fix-loops.js';
import { createAgentHeadTransfer } from './lib/pr-fix-loop/agent-head-transfer.js';
import { registerHostCredentialRoutes } from './lib/agent-server/host-credential-routes.js';
import { createAgentHostCredentials } from './lib/agent-server/host-credentials.js';
import { createAgentCredentialSource } from './lib/agent-server/credential-source.js';

// Background CLI launches enter here in a fresh process, without CLI defaults.
applyConnectAttemptTimeout();
applySystemCertificates();
applyOutboundProxyFromEnv();
applyForkReleaseSource();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverMode = readAgentServerMode();
const { frontDoor: FRONT_DOOR, agent: AGENT_SERVER } = serverMode;
const agentUpstream = FRONT_DOOR ? createAgentUpstream(serverMode.upstream) : null;
const frontDoorTrackedItems = FRONT_DOOR ? createFrontDoorTrackedItems({ upstream: agentUpstream }) : null;
// Where the front door listens, set by main(): the agent's Server Browser refuses these origins.
let frontDoorListen = null;
const frontDoorOrigins = (settings) => {
  if (!frontDoorListen) throw new Error('front_door_origins_unknown');
  const { port, host } = frontDoorListen;
  const listening = serverBrowserOrigins({
    settingsOrigins: Array.isArray(settings.serverBrowserOpenChamberOrigins) ? settings.serverBrowserOpenChamberOrigins : [],
    // A pipe listener reports a string here, which has no port.
    port: server?.address?.()?.port ?? port,
    host,
    addresses: ['0.0.0.0', '::'].includes(host)
      ? Object.values(os.networkInterfaces()).flatMap((entries) => (entries ?? []).map((entry) => entry.address))
      : [],
  });
  const configuredOrigin = asNonEmptyString(settings.publicOrigin);
  let publicOrigin = null;
  try { publicOrigin = configuredOrigin ? new URL(configuredOrigin).origin : null; } catch { publicOrigin = null; }
  return [...new Set([...listening, ...(publicOrigin && /^https?:/.test(publicOrigin) ? [publicOrigin] : [])])];
};
const settingsMirror = FRONT_DOOR ? createSettingsMirror({ upstream: agentUpstream, ownOrigins: async (settings) => frontDoorOrigins(settings) }) : null;
// The agent server's git must trust the human's projects it works in, see agent-server/git-trust.js.
const trustAgentProjects = async (projects) => {
  try {
    await trustProjectRepositories({
      projects: Array.isArray(projects) ? projects : [],
      runGit: (args) => runSpaceCommand(resolveGitBinaryForSpawn(), args, { timeoutMs: 10_000 }),
    });
  } catch (error) {
    console.warn(`[agent-server] the projects' repositories were not trusted: ${error?.code ?? 'git_failed'}`);
  }
};
let projectRegistry = createProjectRegistry();
let frontDoorRuntime = null;
let agentStreams = null;

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

/**
 * SSE endpoint paths that must never be compressed by the compression middleware.
 *
 * The compression middleware filter runs before route handlers, so
 * `res.getHeader('Content-Type')` is still undefined at that point.
 * This means the Accept-header check alone is not sufficient for
 * non-standard clients (e.g. curl, fetch) that omit Accept.
 * Path-based exclusion acts as a deterministic fallback.
 */
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
  if (/^\/api\/guests\/[^/]+\/loopback(?:\/|$)/.test(pathname)) return true;
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
    const packagePath = path.resolve(__dirname, '..', 'package.json');
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
  realpathSync: FRONT_DOOR ? undefined : fs.realpathSync,
  readdirSync: FRONT_DOOR ? undefined : fs.readdirSync,
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
const sanitizeProjects = (...args) => FRONT_DOOR ? sanitizeRegistryProjects(...args) : settingsNormalizationRuntime.sanitizeProjects(...args);

// Every OpenChamber-owned file and folder hangs off one root: the default
// `~/.config/openchamber`, or `OPENCHAMBER_DATA_DIR` when set. The user
// folders (`projects/`, `themes/`, `speech-models/`) are copied into a custom
// root once at startup (`migrateLegacyUserDirs`), because they used to ignore
// the variable.
const OPENCHAMBER_DEFAULT_CONFIG_ROOT = path.join(os.homedir(), '.config', 'openchamber');
const OPENCHAMBER_USER_CONFIG_ROOT = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : OPENCHAMBER_DEFAULT_CONFIG_ROOT;
const OPENCHAMBER_USER_THEMES_DIR = path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'themes');
const OPENCHAMBER_PROJECTS_CONFIG_DIR = path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'projects');
// OPENCHAMBER_CHATS_DIR relocates managed chat worktrees — needed when the
// OpenCode server runs as a separate user that cannot traverse $HOME.
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
const protectedMcpMirror = FRONT_DOOR ? createProtectedMcpMirror({ upstream: agentUpstream, dataDir: OPENCHAMBER_DATA_DIR }) : null;
const SETTINGS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'settings.json');
const PUSH_SUBSCRIPTIONS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'push-subscriptions.json');
const APNS_TOKENS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'apns-tokens.json');
const openCodeTrust = createOpenCodeTrust({
  storePath: path.join(OPENCHAMBER_DATA_DIR, 'opencode-trust.json'),
  // Declared further down; first read on the first check, after startup.
  listKnownDirectories: async () => {
    const settings = await readSettingsFromDiskMigrated();
    return sanitizeProjects(settings?.projects || []).map((project) => project.path);
  },
});
// Server features reach OpenCode through clients of their own, with folders
// the UI hands them. Every such request passes the same trust check as the
// proxy. Installed before any runtime below captures `fetch`.
if (!FRONT_DOOR) globalThis.fetch = guardOpenCodeFetch({
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
const formatSettingsResponse = (...args) => FRONT_DOOR ? settingsRuntime.formatSettingsResponse(...args) : settingsHelpers.formatSettingsResponse(...args);

const projectDirectoryRuntime = createProjectDirectoryRuntime({
  fsPromises,
  path,
  normalizeDirectoryPath,
  getReadSettingsFromDiskMigrated: () => readSettingsFromDiskMigrated,
  sanitizeProjects,
  // A space's directory never runs on the host, whatever route carries it.
  refuseDirectory: (candidate) => spacesHost?.refuseDirectory(candidate) ?? null,
});

const resolveDirectoryCandidate = (...args) => projectDirectoryRuntime.resolveDirectoryCandidate(...args);
const validateDirectoryPath = (...args) => projectDirectoryRuntime.validateDirectoryPath(...args);
const resolveProjectDirectory = (...args) => projectDirectoryRuntime.resolveProjectDirectory(...args);
const resolveOptionalProjectDirectory = (...args) => projectDirectoryRuntime.resolveOptionalProjectDirectory(...args);

const settingsRuntime = createSettingsRuntime({
  frontDoor: FRONT_DOOR,
  beforeProjectsSave: FRONT_DOOR ? (projects, currentProjects) => projectRegistry.beforeProjectsSave(projects, currentProjects) : undefined,
  onSettingsWritten: async (settings) => {
    await settingsMirror?.onSettingsWritten(settings);
    if (AGENT_SERVER) await trustAgentProjects(settings.projects);
    if (!FRONT_DOOR) await refreshServerBrowserOrigins();
  },
  fsPromises,
  path,
  crypto,
  SETTINGS_FILE_PATH,
  sanitizeProjects,
  sanitizeSettingsUpdate,
  mergePersistedSettings,
  normalizeSettingsPaths,
  normalizeStringArray,
  formatSettingsResponse: (...args) => settingsHelpers.formatSettingsResponse(...args),
  resolveDirectoryCandidate,
  normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteTunnelPresets,
  normalizeManagedRemoteTunnelPresetTokens,
  syncManagedRemoteTunnelConfigWithPresets,
  upsertManagedRemoteTunnelToken,
  chatRoots: [path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'chats'), OPENCHAMBER_CHATS_DIR],
  onManagedPluginSettingsChanged: () => managedConfigRuntime?.refreshManagedConfigFile(),
  // Declared further down; settings are only saved once the server serves requests.
  onMessageSearchEnabledChanged: (enabled) => messageSearchRuntime?.setEnabled(enabled),
  onMessageSearchReasoningChanged: (enabled) => messageSearchRuntime?.setReasoningEnabled(enabled),
  // Running spaces hear the new default at once; the save does not wait for them.
  onPermissionDefaultModeChanged: (mode) => {
    void spacesHost?.journey.changePermissionDefault(mode).catch((error) => {
      console.warn(`[spaces] the default permission mode did not reach the running spaces: ${error?.code ?? error?.message ?? error}`);
    });
  },
  // Declared further down; settings are only saved once the server serves requests.
  // A folder OpenCode may not open yet must not become the one server-side
  // reads fall back to.
  onLastDirectoryChanged: (directory) => {
    if (FRONT_DOOR) return;
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
  // clientPushAccess needs this runtime, so it is created later: read it per send.
  getInvalidSessionKeys: () => clientPushAccess.invalidSessionKeys(),
});

const getOrCreateVapidKeys = (...args) => pushRuntime.getOrCreateVapidKeys(...args);
const addOrUpdatePushSubscription = (...args) => pushRuntime.addOrUpdatePushSubscription(...args);
const removePushSubscription = (...args) => pushRuntime.removePushSubscription(...args);
const sendPushToAllUiSessions = (...args) => AGENT_SERVER ? Promise.resolve() : pushRuntime.sendPushToAllUiSessions(...args);
// Set once the notification trigger runtime exists (declared later). When a UI
// client reports it became visible, reset the native push badge set — the same
// moment the device zeroes its icon badge on becomeActive, keeping them in sync.
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

// Host relay identity keys, shared by the push relay and the private relay.
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
const sendApnsToAllUiSessions = (...args) => AGENT_SERVER ? Promise.resolve() : apnsRuntime.sendApnsToAllUiSessions(...args);

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

// OpenChamber-owned events (queue changes, archive state) travel on the shared
// control stream, not on OpenCode's event proxy. One broadcaster so every owner
// reaches the same clients.
const broadcastOpenChamberUiEvent = createGlobalUiEventBroadcaster({
  sseClients: uiOpenChamberEventClients,
  wsClients: uiNotificationWsClients,
  writeSseEvent,
});

// Permission modes and requests left for the user go where the global events
// go (the main WebSocket, and the notification stream an isolated space's host
// reads) and to the control stream: a window whose main event stream runs over
// SSE reads only that one, and without them it hides requests for good.
const broadcastControlSseEvent = createGlobalUiEventBroadcaster({
  sseClients: uiOpenChamberEventClients,
  wsClients: new Set(),
  writeSseEvent,
});
const broadcastPermissionUiEvent = (payload) => {
  broadcastControlSseEvent(payload);
  broadcastGlobalUiEvent(payload);
};

/**
 * Per-session OpenChamber state (goal progress, the assist recap, the
 * obligatory-context cursor, pinned notes) lives in OpenCode's session
 * metadata. The store merge-patches it there and migrates what older
 * OpenChamber versions kept in `sessions-metadata.json`.
 */
const sessionMetadataStore = createSessionMetadataStore({
  dataDir: OPENCHAMBER_DATA_DIR,
  // Called, not captured: the OpenCode URL and auth helpers are declared
  // further down and only ever used once a request arrives.
  openCode: {
    read: (...args) => createOpenCodeSessionMetadata({ buildOpenCodeUrl, getOpenCodeAuthHeaders }).read(...args),
    write: (...args) => createOpenCodeSessionMetadata({ buildOpenCodeUrl, getOpenCodeAuthHeaders }).write(...args),
  },
});

const readStoredSessionMetadata = (sessionID, options) => sessionMetadataStore.get(sessionID, options);

// A cut-off question that stops waiting (answered, dismissed, superseded)
// takes its "Needs you" entry in the notification center with it. Called, not
// captured: the center is declared further down.
const settlePendingQuestionNotifications = (sessionID, patch) => {
  if (patch?.openchamber?.pendingQuestion !== null) return;
  void notificationCenter.resolve({ sessionId: sessionID, kinds: ['question'] }).catch((error) => {
    console.warn('[notification-center] could not resolve a settled question:', error?.message ?? error);
  });
};

const persistSessionMetadataPatch = async (sessionID, patch, { directory = '' } = {}) => {
  const metadata = await sessionMetadataStore.setSessionMetadata(sessionID, patch, { directory });
  settlePendingQuestionNotifications(sessionID, patch);
  // The full merged object, so a client that missed an earlier patch does not
  // have to reconstruct it.
  broadcastOpenChamberUiEvent({
    type: 'openchamber:session-metadata',
    properties: { sessionID, metadata },
  });
  // The write itself arms the goal loop: it is the authoritative signal and
  // does not depend on the event stream being connected.
  // Called, not captured: the runtime is declared further down.
  if (patch?.openchamber && 'goal' in patch.openchamber) {
    void Promise.resolve(sessionGoalRuntime.notifyGoalChanged(sessionID, directory, metadata))
      .catch((error) => console.warn('[session-goal] could not arm after a goal change:', error?.message ?? error));
  }
  return metadata;
};

/** A metadata change decided against the record at write time; broadcast only when it changed. */
const updateSessionMetadataWith = async (sessionID, decide, { directory = '' } = {}) => {
  let decided = null;
  const result = await sessionMetadataStore.updateSessionMetadata(sessionID, (metadata) => {
    decided = decide(metadata);
    return decided;
  }, { directory });
  if (result.changed) settlePendingQuestionNotifications(sessionID, decided);
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
  // Called, not captured: the OpenCode URL and auth helpers are declared further down.
  readTurnStart: FRONT_DOOR ? null : (sessionId) => createTurnStartReader({ buildOpenCodeUrl, getOpenCodeAuthHeaders }).readTurnStart(sessionId),
  buildOpenCodeUrl: (...args) => buildOpenCodeUrl(...args),
  getOpenCodeAuthHeaders: () => getOpenCodeAuthHeaders(),
  acquireRestartResume: async (sessionId) => {
    if (FRONT_DOOR) return null;
    await automationAdmission.ready();
    return automationAdmission.trySend(null, [sessionKey(sessionId)]);
  },
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

const projectConfigRuntime = FRONT_DOOR ? null : createProjectConfigRuntime({
  fsPromises,
  path,
  projectsDirPath: OPENCHAMBER_PROJECTS_CONFIG_DIR,
});

const projectContextRuntime = FRONT_DOOR ? null : createProjectContextRuntime({
  fsPromises,
  path,
  projectsDirPath: OPENCHAMBER_PROJECTS_CONFIG_DIR,
  resolveSharedPlansDir: (projectId) => projectConfigRuntime.resolveSharedPlansDir(projectId),
  onChanged: (projectId) => broadcastOpenChamberUiEvent({
    type: 'openchamber:project-context-changed',
    properties: { projectId },
  }),
});

const agentMemoryRuntime = FRONT_DOOR ? null : createAgentMemoryRuntime({
  fsPromises,
  path,
  projectsDirPath: OPENCHAMBER_PROJECTS_CONFIG_DIR,
  userConfigRoot: OPENCHAMBER_USER_CONFIG_ROOT,
});

/**
 * One switch for everything memory-related. It gates the tool, these routes,
 * and the session index alike, so turning memory off leaves nothing behind
 * that still reads or writes the store.
 */
const isAgentMemoryEnabled = async () => {
  const settings = await readSettingsFromDiskMigrated().catch(() => null);
  return settings?.agentMemoryToolEnabled === true;
};

// HMR-persistent state via globalThis
// These values survive Vite HMR reloads to prevent zombie OpenCode processes
const hmrStateRuntime = createHmrStateRuntime({
  globalThisLike: globalThis,
  os,
  processLike: process,
  stateKey: '__openchamberHmrState',
});
const hmrState = hmrStateRuntime.getOrCreateHmrState();
hmrStateRuntime.ensureUserProvidedOpenCodePassword(hmrState);

// Non-HMR state (safe to reset on reload)
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
// The isolated-spaces host: the place, the manager and the dispatcher. Null while the feature's
// switch is off, and then nothing of the feature runs (decision 19 in the module's DOCUMENTATION.md).
let spacesHost = null;
let spaceArchive = null;
const isInsideBotSpace = Boolean(process.env.OPENCHAMBER_SPACE_IDLE_STOP_FILE);
let botsHost = null;
let botChildServer = null;
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
// Built once the HTTP server exists (it hooks `upgrade`); the browser
// provider router is built earlier and reaches it through this holder.
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

// Sync helper - call after modifying any HMR state variable
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

// Sync helper - call to restore state from HMR (e.g., on module reload)
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

// Module-level variables that shadow HMR state
// These are synced to/from hmrState to survive HMR reloads
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

const getOpenCodeAuthHeaders = (...args) => FRONT_DOOR ? {} : openCodeAuthStateRuntime.getOpenCodeAuthHeaders(...args);
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
const buildOpenCodeUrl = (...args) => FRONT_DOOR ? agentUpstream.buildUrl(args[0]) : openCodeNetworkRuntime.buildOpenCodeUrl(...args);
const ensureOpenCodeApiPrefix = (...args) => openCodeNetworkRuntime.ensureOpenCodeApiPrefix(...args);
const scheduleOpenCodeApiDetection = (...args) => { if (!FRONT_DOOR) return openCodeNetworkRuntime.scheduleOpenCodeApiDetection(...args); };

// Plugin-registered providers exist only inside the running OpenCode process.
// Small-model callers resolve them through this connection; without it they
// stay on the file-based resolution and plugin models remain unreachable.
if (!FRONT_DOOR) configureOpenCodeRuntimeProviders({
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
const isBundledOpenCodeCliPath = (...args) => openCodeEnvRuntime.isBundledOpenCodeCliPath(...args);
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

if (!FRONT_DOOR) applyLoginShellEnvSnapshot();

notificationTemplateRuntime = createNotificationTemplateRuntime({
  fetchImpl: FRONT_DOOR ? agentUpstream.fetch : fetch,
  readDisplayMetadata: FRONT_DOOR ? (directory) => readAgentDisplayMetadata(agentUpstream, directory) : null,
  readSettingsFromDisk,
  persistSettings,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  resolveGitBinaryForSpawn,
  resolvePrimaryWorktreeRoot,
  chatRoots: [path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'chats'), OPENCHAMBER_CHATS_DIR],
});

// Every notification the trigger runtime raises is also kept here, so clients
// can list and mark read what they missed.
const notificationCenter = createNotificationCenterRuntime({
  persistence: createNotificationCenterPersistence({ dataDir: OPENCHAMBER_DATA_DIR }),
  broadcast: broadcastOpenChamberUiEvent,
});
const recordCenterNotification = (entry) => {
  void notificationCenter.record(entry).catch((error) => {
    console.warn('[notification-center] could not record a notification:', error?.message ?? error);
  });
};
/** Same, once per kind and `requestId`: a check that repeats (an update version) adds nothing new. */
const recordCenterNotificationOnce = (entry) => {
  void notificationCenter.recordOnce(entry).catch((error) => {
    console.warn('[notification-center] could not record a notification:', error?.message ?? error);
  });
};

// A start on a new OpenChamber version says so once. The first start of a
// data directory has nothing to compare with and records nothing.
{
  const currentVersion = getInstalledOpenChamberVersion();
  if (currentVersion !== 'unknown') {
    void createAppVersionMarker({ dataDir: OPENCHAMBER_DATA_DIR }).noteVersion(currentVersion).then((previous) => {
      if (!previous) return;
      recordCenterNotification({
        kind: 'update',
        priority: 'low',
        delivery: 'delivered',
        title: `OpenChamber updated to ${currentVersion}`,
        body: `Previous version: ${previous}`,
        action: { type: 'openchamber-update', version: currentVersion },
      });
    });
  }
}
// Extension notification channels (`provides: ["notifications"]`): the user's
// notifications go to the service of every approved, connected channel, and
// the service reaches its server only through these handles on the callback
// listener. Accounts live in their own store; the service never sees a token.
const notificationChannelHandles = createOutboundHandles();
setHostCallbackRoute(NOTIFICATIONS_OUTBOUND_PATH, {
  refusal: notificationChannelHandles.refusal,
  serve: notificationChannelHandles.serve,
});
const extensionNotificationChannels = FRONT_DOOR ? null : createExtensionNotificationChannels({
  listGuests: () => listInstalledGuests({ persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR) }),
  proxyServiceRequest: proxyGuestServiceRequest,
  persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR),
  accounts: createNotificationChannelAccounts({ persistPath: notificationChannelsPersistPath(OPENCHAMBER_DATA_DIR) }),
  handles: notificationChannelHandles,
  isAnyUiVisible,
});

const notificationTriggerRuntime = createNotificationTriggerRuntime({
  fetchImpl: FRONT_DOOR ? agentUpstream.fetch : fetch,
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
  isAnyInteractiveClientVisible,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readSessionMetadata: readStoredSessionMetadata,
  recordNotification: recordCenterNotification,
  // Declared further down; only ever called after startup.
  awaitTurnVerdict: (sessionId) => sessionWorkRuntime?.awaitTurnVerdict(sessionId) ?? null,
  // Read at call time: the isolated-spaces switch turns the host on and off live.
  spaceFetchFor: (spaceId) => spacesHost?.openCodeFetchFor(spaceId) ?? null,
  // Declared further down; only ever called after startup.
  isInAutoReview: (sessionId, turnEndedAt) => autoReviewRuntime?.speaksFor(sessionId, turnEndedAt) ?? false,
  deliverToExtensionChannels: (delivery) => extensionNotificationChannels?.deliver(delivery),
});

const maybeSendPushForTrigger = (...args) => notificationTriggerRuntime.maybeSendPushForTrigger(...args);
const setAutoAcceptSession = (sessionId, enabled) => permissionAutoAcceptRuntime.setSessionPolicy(sessionId, enabled);
clearPendingPushBadge = () => notificationTriggerRuntime.clearPendingPushBadge();

// Which sessions are subsessions: per-turn work skips them without reading.
const sessionLineage = createSessionLineage();

// Unread marks are OpenCode's (`time.idle` / `time.viewed`); the baseline keeps
// turns that ended before OpenChamber read them from all showing as unread.
// Read now, so a turn that ends before the first client asks is not counted
// as old.
const unreadBaseline = createUnreadBaseline({ dataDir: OPENCHAMBER_DATA_DIR });
void unreadBaseline.get();

const turnDurationRecorder = FRONT_DOOR ? null : createTurnDurationRecorder({
  persistSessionMetadataPatch: (...args) => persistSessionMetadataPatch(...args),
  isChildSession: (sessionID) => sessionLineage.isChild(sessionID),
});

const sessionAssistRuntime = FRONT_DOOR ? null : createSessionAssistRuntime({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getSmallModelService: async () => import('./lib/small-model/index.js'),
  persistSessionAssist: (sessionID, directory, assist) =>
    persistSessionMetadataPatch(sessionID, { openchamber: { assist } }, { directory }),
  // Declared further down; only ever called after startup.
  isSessionArchived: (sessionID) => openChamberSessionService.sessionArchive.isArchived(sessionID),
  // Declared further down; only ever called after startup.
  evaluateTurn: (input) => sessionWorkRuntime.evaluateTurnEnd(input),
  lineage: sessionLineage,
  // Clients hold a left chat's OpenCode location until its assist is done.
  onPendingChange: ({ sessionId, directory, pending }) => broadcastOpenChamberUiEvent({
    type: 'openchamber:session-assist',
    properties: { sessionID: sessionId, directory: directory || null, pending },
  }),
});

// One Jev client for every feature, so a rate limit one of them hits pauses them all.
const jevClient = createJevClient();

const sessionGoalRuntime = FRONT_DOOR ? null : createSessionGoalRuntime({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getSmallModelService: async () => import('./lib/small-model/index.js'),
  classifierEndpoint: () => routingRuntime.classifierEndpoint(),
  jev: jevClient,
  readSessionMetadata: readStoredSessionMetadata,
  persistSessionGoal: async (sessionID, directory, goal, canWrite) => {
    if (!canWrite) return persistSessionMetadataPatch(sessionID, { openchamber: { goal } }, { directory });
    const result = await updateSessionMetadataWith(sessionID, (metadata) => (
      canWrite(metadata) ? { openchamber: { goal } } : null
    ), { directory });
    return result.changed;
  },
  isGoalDriverActive: async (driver) => {
    const guests = await listInstalledGuests({ persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR) });
    return guests.some((guest) => guest.enabled && guest.goal?.driver === driver);
  },
  emitGoalNotification: async ({ sessionId, directory, status, goal }) => {
    const title = status === 'complete'
      ? 'Goal complete'
      : (status === 'budgetLimited' ? 'Goal reached its token budget' : 'Goal blocked');
    const detail = goal?.statusReason && goal.statusReason !== 'verified by audit' && goal.statusReason !== 'reported by agent'
      ? goal.statusReason
      : '';
    const objective = typeof goal?.objective === 'string' ? goal.objective.slice(0, 140) : '';
    await notificationTriggerRuntime.notifyGoalSettle({
      sessionId,
      directory,
      status,
      title,
      body: [objective, detail].filter(Boolean).join(' · ').slice(0, 240),
    }).catch((error) => {
      console.warn('[session-goal] notification delivery failed:', error?.message || error);
    });
  },
});

/** A directory-scoped OpenCode client for one session-route call. */
const openCodeSessionClient = (directory) => createOpenCodeClient({
  baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
  headers: getOpenCodeAuthHeaders(),
  directory,
});

const mcpToolsRuntime = createMcpToolsRuntime({
  resolveProjectDirectory: async (projectId) => {
    const settings = await readSettingsFromDiskMigrated();
    const project = sanitizeProjects(settings?.projects || []).find((entry) => entry.id === projectId);
    if (!project) return null;
    const validated = await validateDirectoryPath(project.path);
    if (!validated.ok) throw Object.assign(new Error(validated.error), { statusCode: 400 });
    return validated.directory;
  },
  createClient: openCodeSessionClient,
  isExternalOpenCode: () => isExternalOpenCode || ENV_SKIP_OPENCODE_START,
});

/**
 * Owns what a session must be told about the project's knowledge. Every sender
 * asks it — the UI over HTTP, scheduled tasks and agent-dispatched sessions in
 * process — so the answer cannot differ between them.
 */
const sessionKnowledgeRuntime = FRONT_DOOR ? null : createSessionKnowledgeRuntime({
  projectContextRuntime,
  agentMemoryRuntime,
  // Called, not captured: the resolver is declared further down, and taking a
  // reference here would read it before it exists.
  resolveProjectId: (directory) => resolveMemoryProjectId(directory),
  isAgentMemoryEnabled,
  // The plugin carrying the tool exists only in an OpenCode we launched.
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
  isReadAloudEnabled: async () => {
    const settings = await readSettingsFromDiskMigrated().catch(() => null);
    return settings?.showMessageTTSButtons === true;
  },
  isSecretRequestAvailable: async () => {
    if (isExternalOpenCode || ENV_SKIP_OPENCODE_START) return false;
    const settings = await readSettingsFromDiskMigrated().catch(() => null);
    return settings?.agentSecretToolEnabled !== false;
  },
  isWorkflowAvailable: async () => {
    if (isExternalOpenCode || ENV_SKIP_OPENCODE_START) return false;
    // Declared further down; only ever called after startup.
    return isWorkflowToolEnabled();
  },
  areAgentToolsInCodeMode: async () => {
    const settings = await readSettingsFromDiskMigrated().catch(() => null);
    return settings?.agentToolsCodeMode === true;
  },
  readSessionMetadata: readStoredSessionMetadata,
  // Pins are read from and written to OpenChamber's own store.
  persistSessionMetadata: (sessionID, directory, patch) => persistSessionMetadataPatch(sessionID, patch, { directory }),
  collectFollowedPullStacks: (directory, session) => featureRoutesRuntime.collectFollowedPullStacks(directory, session),
  instructionEntries: {
    put: (sessionID, directory, key, value) => openCodeSessionClient(directory)
      .experimental.session.instructions.entry.put({ sessionID, key, value }),
    remove: (sessionID, directory, key) => openCodeSessionClient(directory)
      .experimental.session.instructions.entry.remove({ sessionID, key }),
  },
});

const contextObligatoryRuntime = FRONT_DOOR ? null : createContextObligatoryRuntime({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readSessionMetadata: readStoredSessionMetadata,
  persistContextCursor: (sessionID, directory, patch) => persistSessionMetadataPatch(sessionID, patch, { directory }),
});

// Keeps the prompt cache of the sessions the user picked warm while they sit
// idle; the per-session counterpart of OpenCode's `warming` config.
const sessionWarmingRuntime = FRONT_DOOR ? null : createSessionWarmingRuntime({
  dataDir: OPENCHAMBER_DATA_DIR,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  broadcast: broadcastOpenChamberUiEvent,
});
sessionWarmingRuntime?.start();

// The tracker registry, one per server. Tracker and source-control ids share
// one namespace (tracked items, the read cache), so the source-control ids are
// refused here and an overlap fails at startup.
const trackerRegistry = createTrackerRegistry(undefined, {
  foreignIds: sourceControlProviderDescriptors.list().map((descriptor) => descriptor.id),
});
// Session events for every tracker that posts session comments: each one's
// runtime starts on the first event and a failed load is retried later, so a
// tracker that fails to load leaves the others running and is not silent for good.
const trackerSessionStatus = FRONT_DOOR ? null : createTrackerSessionStatus({ registry: trackerRegistry });
// Session events for extension services (`contributes.sessionEvents`): one
// request per event per subscribed service, with the ready notification's
// gates on "the turn is finished". The catalog decides who receives what.
const extensionSessionEvents = FRONT_DOOR ? null : createExtensionSessionEvents({
  listGuests: () => listInstalledGuests({ persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR) }),
  proxyServiceRequest: proxyGuestServiceRequest,
  persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR),
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchLastAssistantMessageText,
  readSessionMetadata: readStoredSessionMetadata,
  // Both declared further down; only ever called after startup.
  isSessionAutoAccepting: (sessionId, directory, requestId) => permissionAutoAcceptRuntime.isPermissionAutoAnswered(sessionId, directory, requestId),
  isInAutoReview: (sessionId, turnEndedAt) => autoReviewRuntime.speaksFor(sessionId, turnEndedAt),
});

const globalMessageStreamHub = createGlobalMessageStreamHub({
  isSpaceSession: (id) => Boolean(spacesHost?.index.claimedBy(id)),
  fetchImpl: FRONT_DOOR ? agentUpstream.fetch : fetch,
  upstreamOrigin: FRONT_DOOR ? 'agent' : null,
  upstreamPath: FRONT_DOOR ? '/api/global/event' : '/api/event',
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  upstreamStallTimeoutMs: getUpstreamStallTimeoutMs,
  deltaCoalesceWindowMs: resolveDeltaCoalesceWindowMs(),
});

// Jev model routing and the permission safety net. Every failure keeps the
// user's own model or the auto-accept reply it was asked about.
const routingRuntime = FRONT_DOOR ? null : createRoutingRuntime({
  dataDir: OPENCHAMBER_DATA_DIR,
  jev: jevClient,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  broadcastGlobalUiEvent: broadcastOpenChamberUiEvent,
  isSessionWarm: (sessionId, cacheLifetimeMs) => sessionWarmingRuntime.isSessionWarm(sessionId, cacheLifetimeMs),
});

// "In work": Jev opens a session when real work starts in it and hints when a
// turn looks like the end of it. The same turn-end call gates session assist.
const sessionWorkRuntime = FRONT_DOOR ? null : createSessionWorkRuntime({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  classifierEndpoint: () => routingRuntime.classifierEndpoint(),
  jev: jevClient,
  readMetadata: (sessionID, directory) => sessionMetadataStore.get(sessionID, { directory }),
  updateMetadata: updateSessionMetadataWith,
  isSessionArchived: (sessionID) => openChamberSessionService.sessionArchive.isArchived(sessionID),
  chatRoots: [path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'chats'), OPENCHAMBER_CHATS_DIR],
  lineage: sessionLineage,
});

const sessionInterruptionRuntime = FRONT_DOOR ? null : createSessionInterruptionRuntime({
  persistMetadata: persistSessionMetadataPatch,
  updateMetadata: updateSessionMetadataWith,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  // A question cut off by a restart or the inactivity eviction waits for the
  // user like a live one, so it lands in the center's "Needs you" too.
  onPendingQuestion: ({ sessionId, directory, sessionTitle, title }) => recordCenterNotification({
    kind: 'question',
    priority: 'high',
    delivery: 'delivered',
    title: 'Interrupted question waiting for you',
    body: title,
    sessionId,
    directory,
    sessionName: sessionTitle,
  }),
});

// Manual Continue for restart records uses the same automation admission as
// queued sends. The session runtime owns automatic restart recovery.
const automationAdmission = FRONT_DOOR ? null : createAutomationAdmission({
  restore: async () => {
    await Promise.all([autoReviewRuntime.load(), prFixLoopRuntime.load()]);
    return [...autoReviewRuntime.ownershipClaims(), ...prFixLoopRuntime.ownershipClaims()];
  },
  onRelease: (keys) => {
    for (const key of keys) if (key.startsWith('session:')) messageQueueRuntime.release(key.slice('session:'.length));
    prWatchRuntime.release(keys);
  },
});

const autoResumeRuntime = FRONT_DOOR ? null : createAutoResumeRuntime({
  updateMetadata: updateSessionMetadataWith,
  readMemory: () => readCgroupMemory(),
  sendPrompt: async ({ sessionId, directory, text, description, metadata }) => {
    await automationAdmission.ready();
    const release = automationAdmission.trySend(null, [sessionKey(sessionId)]);
    if (!release) throw new Error('The session is owned by an automation. Its restart notice remains available.');
    try {
      const headers = { ...getOpenCodeAuthHeaders() };
      if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
      return await OpenCode.make({ baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''), headers })
        .session.synthetic(
          { sessionID: sessionId, text, description, metadata, delivery: 'steer', resume: true },
          { signal: AbortSignal.timeout(15_000) },
        );
    } finally { release(); }
  },
});

const permissionAutoAcceptRuntime = FRONT_DOOR ? null : createPermissionAutoAcceptRuntime({
  globalEventHub: globalMessageStreamHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readSettingsFromDiskMigrated,
  persistSettings,
  broadcastGlobalUiEvent: broadcastPermissionUiEvent,
  evaluatePermission: (permission, directory) => routingRuntime.evaluatePermission(permission, directory),
  onPermissionReplied: (permissionId) => routingRuntime.forgetPermission(permissionId),
  resolveLegacyEnabledMode: async () => ((await routingRuntime.legacySafetyNetEnabled()) ? 'safety' : 'auto'),
  // Only a space's environment names this file: the host writes the user's default there.
  readDefaultMode: process.env.OPENCHAMBER_SPACE_PERMISSION_DEFAULT_FILE
    ? () => readSpacePermissionDefault(process.env.OPENCHAMBER_SPACE_PERMISSION_DEFAULT_FILE)
    : undefined,
});
permissionAutoAcceptRuntime?.start();
// A request the safety net held still needs the user, so only one that was
// actually answered automatically skips the notification.
notificationTriggerRuntime.setGetIsSessionAutoAccepting(
  (sessionId, directory, permissionId) => permissionAutoAcceptRuntime?.isPermissionAutoAnswered(sessionId, directory, permissionId) ?? false,
);

// Auto-review runs its loop here, so a closed tab or a locked phone does not
// stop it; while a run goes, the reviewed session's queue waits for it.
const autoReviewRuntime = FRONT_DOOR ? null : createAutoReviewRuntime({
  automation: automationAdmission,
  globalEventHub: globalMessageStreamHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  sessionKnowledgeRuntime,
  broadcastUiEvent: broadcastOpenChamberUiEvent,
  // Declared right below; only called once a run ends.
  onRunSettled: (sessionId) => messageQueueRuntime.release(sessionId),
  onRunEnded: (ended) => notificationTriggerRuntime.notifyAutoReviewEnded(ended),
  routeSend: ({ sessionId, directory, text }) => (
    routingRuntime.isAutoSession(sessionId) ? routingRuntime.routeSend({ sessionId, directory, body: { text } }) : null
  ),
  dataDir: OPENCHAMBER_DATA_DIR,
});
autoReviewRuntime?.start();

// Queued follow-up messages are delivered by the server so a closed tab or a
// dropped connection no longer strands them (VS Code keeps its UI-side queue).
const messageQueueRuntime = FRONT_DOOR ? null : createMessageQueueRuntime({
  automation: automationAdmission,
  globalEventHub: globalMessageStreamHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  sessionKnowledgeRuntime,
  // OpenCode's event SSE proxy cannot carry OpenChamber-owned events. Use the
  // shared control stream for SSE clients and the existing WS fan-out.
  broadcastGlobalUiEvent: broadcastOpenChamberUiEvent,
  resolveAutoSelection: (send) => routingRuntime.resolveAutoSelection(send),
  persistSessionGoal: (sessionID, directory, goal) =>
    persistSessionMetadataPatch(sessionID, { openchamber: { goal } }, { directory }),
  isDeliveryHeld: (sessionId) => autoReviewRuntime.holdsDelivery(sessionId),
  deliveryHoldReady: autoReviewRuntime.startupLoad,
  beforeScheduledTaskSend: (...args) => scheduledTasksRuntime.beforeScheduledTaskSend(...args),
  validateScheduledTaskTarget: (...args) => scheduledTasksRuntime.validateTarget(...args),
  assertFixLoopHostDispatch: (...args) => prFixLoopRuntime.assertHostDispatch(...args),
  assertBotDispatch: (input) => {
    if (!botsHost) throw Object.assign(new Error('Bot dispatch is unavailable'), { code: 'BOT_HOST_REQUIRED' });
    return botsHost.assertDispatch(input);
  },
  onScheduledTaskResult: (...args) => scheduledTasksRuntime.onScheduledTaskResult(...args),
  dataDir: OPENCHAMBER_DATA_DIR,
});
messageQueueRuntime?.start();

// Stacked PR restacks and PR fix loops hand work to a session through the
// queue above, so a busy session gets it when its turn ends.
const queueServerMessage = (kind, id) => async (sessionId, directory, item) => {
  await messageQueueRuntime.enqueue(sessionId, directory, { ...item, origin: { kind, id } });
};
// A restack paused on a conflict the user resolves (`pause` mode) goes to the
// center once per conflicting branch; in `agent` mode the session resolves it.
const announcedRestackConflicts = new Set();
const recordRestackConflict = (run) => {
  if (run?.status !== 'paused' || run.conflictMode !== 'pause') return;
  const step = Array.isArray(run.steps) ? run.steps.find((candidate) => candidate?.status === 'conflict') : null;
  const key = `${run.id}\0${step?.branch ?? ''}`;
  if (announcedRestackConflicts.has(key)) return;
  announcedRestackConflicts.add(key);
  recordCenterNotification({
    kind: 'restack',
    priority: 'high',
    delivery: 'delivered',
    title: 'Restack stopped on a conflict',
    body: step?.branch ? `${step.branch} onto ${step.onto ?? ''}`.trim() : '',
    sessionId: run.sessionId,
    directory: run.directory,
    requestId: run.id,
  });
};
const prStackRestackRuntime = FRONT_DOOR ? null : createRestackRuntime({
  runGit: runGitCommandNoEditor,
  dataDir: OPENCHAMBER_DATA_DIR,
  readConflictMode: async () => ((await readSettingsFromDisk().catch(() => ({})))?.prStackConflictMode === 'agent' ? 'agent' : 'pause'),
  sendToSession: ({ sessionId, directory, text }) => queueServerMessage('pr-stack', sessionId)(sessionId, directory, {
    content: 'Stacked PRs: resolve the restack conflict',
    text,
  }),
  broadcast: (event) => {
    broadcastOpenChamberUiEvent(event);
    recordRestackConflict(event?.properties?.run);
  },
});
const prFixLoopActivity = FRONT_DOOR ? null : createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders });
const approvalGit = FRONT_DOOR ? null : createHostGit({ runCommand: (_binary, args, options) => runSpaceCommand(resolveGitBinaryForSpawn(), args, options) });
const agentFixLoopServices = FRONT_DOOR ? createAgentFixLoopServices(agentUpstream) : null;
const approvalGitServices = () => FRONT_DOOR ? agentFixLoopServices : featureRoutesRuntime.fixLoopGitServices();
const exactFixLoopOctokit = async (accountId) => {
  const github = await import('./lib/github/octokit.js');
  if (!accountId) return github.getOctokitOrNull('github.com');
  return (await github.getOctokitForAccountId(accountId))?.octokit ?? null;
};
const approvalWorker = createSpaceWorker({
  dataDir: OPENCHAMBER_DATA_DIR, getHost: () => spacesHost, git: approvalGit, gitServices: approvalGitServices,
  upstream: FRONT_DOOR ? agentUpstream : null,
  seedHead: FRONT_DOOR ? createAgentHeadTransfer({ upstream: agentUpstream,
    services: agentFixLoopServices, dataDir: OPENCHAMBER_DATA_DIR, gitPath: resolveGitBinaryForSpawn() }) : null,
  readHostSession: FRONT_DOOR ? agentFixLoopServices.readHostSession : async (sessionId) => {
    const response = await fetch(buildOpenCodeUrl(`/api/session/${encodeURIComponent(sessionId)}`, ''), {
      headers: getOpenCodeAuthHeaders(), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('The original host session is unavailable');
    return unwrapOpenCodeResponse(await response.json());
  },
});
const prFixLoopRuntime = createFixLoopRuntime({
  approvalOnly: FRONT_DOOR,
  automation: automationAdmission,
  dataDir: OPENCHAMBER_DATA_DIR,
  botWatch: {
    getOctokit: (...args) => botsHost.botWatch.getOctokit(...args),
    deliver: (...args) => botsHost.botWatch.deliver(...args),
    authorizeApp: (...args) => botsHost.botWatch.authorizeApp(...args),
  },
  getOctokit: FRONT_DOOR ? agentFixLoopServices.getOctokit : exactFixLoopOctokit,
  readFeedback: FRONT_DOOR ? agentFixLoopServices.readFeedback : async (input) => (await import('./lib/github/pr-feedback.js')).readPullFeedback(input),
  readAuthorPermission: FRONT_DOOR ? agentFixLoopServices.readAuthorPermission : async (input) => (await import('./lib/github/pr-feedback.js')).readFeedbackAuthorPermission(input),
  readFailedChecks: FRONT_DOOR ? agentFixLoopServices.readFailedChecks : async (input) => (await import('./lib/github/pr-feedback.js')).readFailedChecks(input),
  isRateLimited: () => !FRONT_DOOR && isGitHubRateLimited(),
  noteRateLimit: (error) => {
    if (FRONT_DOOR) return error?.statusCode === 429;
    if (isGraphqlRateLimitError(error)) {
      noteGitHubRateLimit(error);
      return true;
    }
    return noteIfGitHubRateLimit(error);
  },
  isSessionWorking: async (sessionId) => {
    const isolated = await botsHost?.isSessionWorking(sessionId);
    if (isolated !== undefined) return isolated;
    const statuses = await prFixLoopActivity.fetchActiveSessionStatuses();
    if (!statuses) return null;
    if (statuses[sessionId]) return true;
    return prFixLoopActivity.hasWorkingChildren(sessionId, statuses);
  },
  hasQueuedItem: async (sessionId, loopId) => {
    const queue = botsHost ? await botsHost.queueForSession(sessionId) : messageQueueRuntime;
    await queue.load();
    return (queue.sessionSnapshot(sessionId)?.items ?? [])
      .some((item) => item.origin?.kind === 'pr-fix-loop' && item.origin.id === loopId);
  },
  enqueue: async (sessionId, directory, item) => {
    const queue = botsHost ? await botsHost.queueForSession(sessionId) : messageQueueRuntime;
    await queue.enqueue(sessionId, directory, item);
  },
  readTokenSnapshot: (...args) => botsHost
    ? botsHost.readTokenSnapshot(...args)
    : createTokenSnapshotReader({ buildOpenCodeUrl, getOpenCodeAuthHeaders })(...args),
  workerRuntime: approvalWorker,
  publication: createApprovalPublication({ dataDir: OPENCHAMBER_DATA_DIR, git: approvalGit, gitServices: approvalGitServices,
    captureRef: FRONT_DOOR ? agentFixLoopServices.captureRef : null }),
  applyReviewOperation: (input) => approvalGitServices().applyReviewOperation(input),
  notify: async (loop) => {
    if (loop.botAuthority) { botsHost.onPullRequestSettled(loop); return; }
    const settings = await readSettingsFromDisk();
    if (settings.notifyOnCompletion === false) return;
    const titles = {
      ready: 'Pull request is ready',
      closed: 'Pull request closed',
      limitReached: 'Fix loop reached its iteration limit',
      budgetReached: 'Fix loop reached its token budget',
      error: 'Fix loop stopped',
    };
    // A watching loop announces each round's ready PR once and keeps watching.
    const prReady = loop.status === 'watching' && loop.statusReason === 'pr-ready';
    const title = prReady ? 'Pull request is ready' : titles[loop.status] ?? 'Fix loop finished';
    const reason = prReady ? 'still watching for new CI failures and reviews' : loop.statusReason;
    const notificationPayload = {
      title,
      body: [`#${loop.number} ${loop.title}`.trim(), reason].filter(Boolean).join(' · ').slice(0, 240),
      tag: `pr-fix-loop-${loop.id}`,
      kind: 'goal',
      sessionId: loop.sessionId,
      directory: loop.directory,
    };
    const desktopNotificationDelivered = emitDesktopNotification(notificationPayload);
    broadcastUiNotification(notificationPayload, { desktopNotificationDelivered });
    recordCenterNotification({
      kind: 'fix-loop',
      priority: prReady || loop.status === 'ready' || loop.status === 'closed' ? 'normal' : 'high',
      delivery: 'delivered',
      title,
      body: notificationPayload.body,
      sessionId: loop.sessionId,
      directory: loop.directory,
      requestId: loop.id,
    });
    void notificationTriggerRuntime.sendGoalSettlePush({
      sessionId: loop.sessionId,
      directory: loop.directory,
      status: prReady || loop.status === 'ready' ? 'complete' : 'blocked',
      title,
      body: notificationPayload.body,
    }).catch((error) => console.warn('[pr-fix-loop] push fanout failed:', error?.message || error));
  },
  // Center only: the loop's row in the chat already shows the approval.
  notifyAwaitingApproval: async (loop) => {
    recordCenterNotification({
      kind: 'fix-loop',
      priority: 'high',
      delivery: 'delivered',
      title: 'Fix loop is waiting for your approval',
      body: `#${loop.number} ${loop.title}`.trim().slice(0, 240),
      sessionId: loop.sessionId,
      directory: loop.directory,
      requestId: loop.id,
    });
  },
  resolveNotifications: (loop) => notificationCenter.resolve({ sessionId: loop.sessionId, kinds: ['fix-loop'], requestId: loop.id }),
  broadcast: (event) => broadcastOpenChamberUiEvent(event),
  readDefaults: async () => (await readSettingsFromDisk().catch(() => ({})))?.prFixLoopDefaults ?? {},
});

// Sessions an agent dispatched with `returnResult` report back to it: their
// final answer lands in the dispatching session and wakes it.
const dispatchResultsRuntime = FRONT_DOOR ? null : createDispatchResultsRuntime({
  globalEventHub: globalMessageStreamHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  dataDir: OPENCHAMBER_DATA_DIR,
  // Declared further down; only ever called after startup.
  isSessionArchived: (sessionID) => openChamberSessionService.sessionArchive.isArchived(sessionID),
});
dispatchResultsRuntime?.start();

// An agent waiting on its pull request: followed through the tracked-items
// service (attached when the routes create it), woken with one message.
const prWatchRuntime = FRONT_DOOR ? null : createPrWatchRuntime({
  automation: automationAdmission,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  broadcastUiEvent: broadcastOpenChamberUiEvent,
  dataDir: OPENCHAMBER_DATA_DIR,
  readCleanupOnMerge: async () => (await readSettingsFromDiskMigrated())?.mergedWorktreeCleanupEnabled === true,
  // Declared further down; only ever called after startup.
  isSessionArchived: (sessionID) => openChamberSessionService.sessionArchive.isArchived(sessionID),
  insideSpace: Boolean(process.env.OPENCHAMBER_SPACE_IDLE_STOP_FILE),
});
prWatchRuntime?.start(globalMessageStreamHub);
const mergeFollowRuntime = FRONT_DOOR ? null : createMergeFollowRuntime({
  dataDir: OPENCHAMBER_DATA_DIR,
  notify: (notification) => notificationTriggerRuntime.notifyPullRequest(notification),
});

// Agent workflows: scripts that fan a task out to many agents, run here while
// the agent that asked stays free. Off until the user turns the tool on.
const isWorkflowToolEnabled = async () => {
  const settings = await readSettingsFromDiskMigrated().catch(() => null);
  return settings?.agentWorkflowToolEnabled === true;
};
const workflowAgentSessions = FRONT_DOOR ? null : createWorkflowAgentSessions({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  // Declared further down; only ever called after startup.
  waitForOpenCodeReady: (...args) => waitForOpenCodeReady(...args),
  globalEventHub: globalMessageStreamHub,
});
const workflowRuntime = FRONT_DOOR ? null : createWorkflowRuntime({
  store: createWorkflowRunStore({ fsPromises, path, dataDir: OPENCHAMBER_DATA_DIR }),
  agentSessions: workflowAgentSessions,
  postSynthetic: workflowAgentSessions.postSynthetic,
  // Declared further down; only ever called after startup.
  broadcast: (event) => broadcastOpenChamberUiEvent(event),
  isEnabled: isWorkflowToolEnabled,
  fsPromises,
  path,
});
void workflowRuntime?.start().catch((error) => {
  console.warn('[workflows] failed to restore runs:', error?.message ?? error);
});
// Reports wait for OpenCode, which answers once the event hub connects.
globalMessageStreamHub.subscribeStatus((status) => {
  if (status?.type === 'connect') void workflowRuntime?.deliverPending();
});

// Full-text search over this server's conversations (user messages and agent
// replies). Opt-in: off by default, and off means idle. The index is derived
// data in the data dir, fed from the same event stream; see lib/message-search.
const messageSearchRuntime = FRONT_DOOR ? null : createMessageSearchRuntime({
  dataDir: OPENCHAMBER_DATA_DIR,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  globalEventHub: globalMessageStreamHub,
  readSettings: async () => {
    const settings = await readSettingsFromDisk();
    return { enabled: settings.messageSearchEnabled === true, reasoning: settings.messageSearchReasoningEnabled === true };
  },
});

const openCodeWatcherRuntime = createOpenCodeWatcherRuntime({
  waitForOpenCodePort: (...args) => waitForOpenCodePort(...args),
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  parseSseDataPayload: (...args) => parseSseDataPayload(...args),
  globalEventHub: globalMessageStreamHub,
  onPayload: (payload, { spaceId }) => {
    maybeCacheSessionInfoFromEvent(payload, { spaceId });
    void maybeSendPushForTrigger(payload, { spaceId });
    sessionRuntime.processOpenCodeSsePayload(payload, { spaceId });
    resolveCenterEntriesFor(payload);
    void botsHost?.processPayload(payload, { spaceId });
  },
  // Turns already running when the stream (re)connects sent no start this
  // server saw; OpenCode's running list names them.
  onConnect: async () => {
    if (FRONT_DOOR) { void protectedMcpMirror.push(); return; }
    const readAt = Date.now();
    const statuses = await createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders }).fetchActiveSessionStatuses();
    if (statuses) sessionRuntime.adoptRunningSessions(Object.keys(statuses), readAt);
  },
});

// A folder is checked once each time OpenCode opens it: the trust answer
// holds until OpenCode reports the folder closed. While the stream is down
// closings go unreported, so answers fall back to a short life, and a new
// connection starts them over.
if (!FRONT_DOOR) globalMessageStreamHub.subscribeEvent((event) => {
  if (event?.payload?.type !== 'location.shutdown') return;
  const directory = event.payload.location?.directory ?? event.directory;
  if (directory && directory !== 'global') void openCodeTrust.forget(directory);
});

if (FRONT_DOOR) globalMessageStreamHub.subscribeEvent((event) => {
  for (const payload of event?.translated?.() ?? []) prFixLoopRuntime.processPayload(payload);
});
if (!FRONT_DOOR) globalMessageStreamHub.subscribeStatus((status) => {
  if (status?.type === 'connect') {
    openCodeTrust.followLocations(true);
    // A goal whose idle event fell while the stream was down has no timer.
    void sessionGoalRuntime.recoverActiveGoals();
  } else if (status?.type === 'disconnect' || status?.type === 'error') openCodeTrust.followLocations(false);
});

// What the center keeps moves to its history once nothing waits on the user:
// a finished turn or an error when the user writes in that session again, a
// question or permission when it is answered.
const resolveCenterEntries = (target) => {
  void notificationCenter.resolve(target).catch((error) => {
    console.warn('[notification-center] could not resolve notifications:', error?.message ?? error);
  });
};
const resolveCenterEntriesFor = (payload) => {
  const sessionId = payload.properties?.sessionID;
  if (!sessionId) return;
  if (payload.type === 'message.updated' && payload.properties?.info?.role === 'user') {
    resolveCenterEntries({ sessionId, kinds: ['ready', 'error'] });
  } else if (payload.type === 'permission.replied') {
    resolveCenterEntries({ sessionId, kinds: ['permission'], requestId: payload.properties.requestID || null });
  } else if (payload.type === 'form.settled') {
    resolveCenterEntries({ sessionId, kinds: ['question'], requestId: payload.properties.formID || null });
  }
};

const recordOpenCodeUpdate = (version) => {
  recordCenterNotificationOnce({
    kind: 'opencode-update',
    priority: 'normal',
    delivery: 'delivered',
    title: `OpenCode ${version} is available`,
    body: '',
    requestId: version,
    action: { type: 'opencode-update', version },
  });
};

// Session-assist subscribes to the hub directly: it needs the envelope's
// directory to route its own OpenCode calls to the right instance.
console.log('[session-assist] listening for session events');
if (!FRONT_DOOR) globalMessageStreamHub.subscribeEvent((event) => {
  const directory = typeof event?.directory === 'string' && event.directory && event.directory !== 'global'
    ? event.directory
    : '';
  // The hub translates v2 wire events into the server's vocabulary once; these
  // consumers were written against it and stay unaware of the wire shape.
  for (const payload of event?.translated?.() ?? []) {
    // The user cancelled the turn: stop the OpenChamber tool actions that
    // turn still has running (a browser action, a memory write). OpenCode 2
    // gives the plugin no abort signal, so this is where the cancel lands.
    if (payload.type === 'session.idle' && payload.properties?.aborted === true) {
      agentToolRuntime?.abortSession?.(payload.properties.sessionID);
    }
    if (payload.type === 'installation.update-available' && payload.properties?.version) {
      recordOpenCodeUpdate(payload.properties.version);
    }
    sessionLineage.observe(payload);
    turnDurationRecorder.processPayload(payload, directory || payload.properties?.directory || '');
    sessionAssistRuntime.processPayload(payload, directory || payload.properties?.directory || '');
    sessionWorkRuntime.processPayload(payload, directory || payload.properties?.directory || '');
    sessionGoalRuntime.processPayload(payload, directory || payload.properties?.directory || '');
    prFixLoopRuntime.processPayload(payload);
    if (payload.type === 'session.idle' || (payload.type === 'session.status' && payload.properties?.status?.type === 'idle')) {
      prStackRestackRuntime.noteSessionIdle(payload.properties?.sessionID);
    }
    sessionInterruptionRuntime.processPayload(payload, directory || payload.properties?.directory || '');
    contextObligatoryRuntime.processPayload(payload, directory || payload.properties?.directory || '');
    sessionWarmingRuntime.processPayload(payload);
    trackerSessionStatus.processPayload(payload, { spaceId: event?.spaceId ?? null });
    extensionSessionEvents.processPayload(payload, directory || payload.properties?.directory || '');
  }
});

/**
 * Browser bridges hand us the raw v2 wire payload (they forward it untouched to
 * the client). The synthetic OpenChamber frames the UI also expects are derived
 * from the translated event, so the translation happens here.
 */
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
      // The event that starts a turn carries its own start; it may reach this
      // bridge before the session runtime has recorded it.
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


const serverUtilsRuntime = createServerUtilsRuntime({
  // Read lazily: the archive store is created with the session service further
  // down, while the proxy is registered later still.
  getArchivedSessions: () => openChamberSessionService.archiveStore.getAll(),
  getUnreadBaseline: () => unreadBaseline.get(),
  getStoredSessionMetadata: () => sessionMetadataStore.listUnmigrated(),
  // Isolated spaces: with the switch on, the session list carries every space's sessions and
  // the global SSE stream their events. Called, not captured: the host is made in `main`.
  getMergeSpaceSessionList: () => (spacesHost ? (payload) => spacesHost.mergeSessionList(payload) : null),
  getSpaceEventHub: () => (spacesHost ? globalMessageStreamHub : null),
  openCodeTrust,
  // The checkout gate loads a folder's saved setup state on its first request,
  // so a worktree that failed before a restart stays closed from the start.
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
const waitForOpenCodePort = (...args) => FRONT_DOOR ? Promise.resolve(Number(new URL(agentUpstream.origin).port || 80)) : serverUtilsRuntime.waitForOpenCodePort(...args);
const buildAugmentedPath = (...args) => serverUtilsRuntime.buildAugmentedPath(...args);
const buildManagedOpenCodePath = (...args) => serverUtilsRuntime.buildManagedOpenCodePath(...args);

// Variables from Settings for the processes OpenChamber starts: the managed
// OpenCode, Git, the terminal and command execution (lib/environment).
const environmentStore = createEnvironmentStore({
  filePath: path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'environment.json'),
});
const listConfiguredProjects = async () => {
  const settings = await readSettingsFromDiskMigrated();
  return sanitizeProjects(settings?.projects || []);
};
const environmentRuntime = FRONT_DOOR ? null : createEnvironmentRuntime({
  store: environmentStore,
  listProjects: listConfiguredProjects,
  spawn,
  // The terminal's PATH: a packaged server starts with a minimal one, where
  // direnv, devenv or nix would not be found.
  commandBaseEnv: () => ({ ...process.env, PATH: buildAugmentedPath() }),
  readOpenCodeServiceEnv: () => readOpenCodeServiceEnv(OPENCODE_CONFIG_DIR),
  isEnterpriseMode: () => isEnterpriseMode(),
});
if (!FRONT_DOOR) configureGitEnvironment(environmentRuntime);
const parseSseDataPayload = (...args) => serverUtilsRuntime.parseSseDataPayload(...args);
const staticRoutesRuntime = createStaticRoutesRuntime({
  fetchImpl: FRONT_DOOR ? agentUpstream.fetch : fetch,
  fs,
  path,
  process,
  __dirname,
  express,
  resolveProjectDirectory: FRONT_DOOR ? async () => ({ directory: (await readSettingsFromDiskMigrated()).lastDirectory ?? null }) : resolveProjectDirectory,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readSettingsFromDiskMigrated,
  normalizePwaAppName,
  normalizePwaOrientation,
  // uiAuthController is created at startup, after this runtime: read it per request.
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
  // Most-recently-used directories first: OpenCode initializes each directory
  // lazily on first request (seconds on large session stores), so the
  // lifecycle warms these right after readiness — before the UI's first
  // interactive request would otherwise pay that cost.
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
    // A deleted project would fail every read scoped to it, and the first entry
    // also scopes server-side reads that have no directory of their own.
    // Warming a folder runs its OpenCode plugins, so only trusted ones warm;
    // the rest wait for the user to open them.
    const existing = await Promise.all([...new Set(directories)].map(async (directory) => (
      (await fs.promises.stat(directory).catch(() => null))?.isDirectory()
        && await openCodeTrust.isTrusted(directory).catch(() => false)
        ? directory
        : null
    )));
    return existing.filter(Boolean);
  },
  noProjectDirectory: OPENCHAMBER_CHATS_DIR,
  // A managed restart can move OpenCode to a NEW port (the old one may stay
  // occupied if killProcessOnPort/waitForPortRelease didn't free it in time,
  // on any platform). Rebind the message-stream upstream readers to the current port
  // so the UI keeps receiving events instead of staying pinned to the old
  // process (#2638). The runtime is created later by the startup pipeline;
  // by the time any restart runs, it is assigned.
  onOpenCodeRestarted: ({ cause }) => {
    // A restart reloads plugins: provider ports, credentials and the provider
    // list itself can all differ from what was cached.
    resetOpenCodeRuntimeProviders();
    try {
      messageStreamRuntime?.rebindUpstream();
    } catch (error) {
      console.warn('Failed to rebind message stream after OpenCode restart:', error?.message ?? error);
    }
    let recovery;
    try {
      recovery = sessionRuntime.interruptBusySessionsAfterRestart();
    } catch (error) {
      console.warn('Failed to reconcile sessions after OpenCode restart:', error?.message ?? error);
      return;
    }
    if (recovery.sessionIds.length === 0) return;
    // Keep recovery details until the session runs again, so failed automatic
    // attempts still leave Continue and cut-off questions available after reload.
    void sessionInterruptionRuntime.recordRestartInterruptions({ ...recovery, cause })
      .then((recordedSessions) => {
        const details = new Map(recordedSessions.map((session) => [session.sessionId, session]));
        const sessions = recovery.sessionIds.map((sessionId) => details.get(sessionId) ?? { sessionId });
        const notice = { ...restartInterruptedNotification(sessions), ...buildRestartNotification(recovery) };
        broadcastUiNotification(notice);
        const single = sessions.length === 1 ? sessions[0] : null;
        recordCenterNotification({
          kind: 'restart',
          priority: 'high',
          delivery: 'delivered',
          title: notice.title,
          body: notice.body,
          sessionId: single?.sessionId,
          directory: single?.directory,
          sessionName: single?.title,
          action: {
            type: 'sessions',
            sessions: sessions.slice(0, 50).map(({ sessionId, directory, title }) => ({
              sessionId, directory: directory || null, title: title || null,
            })),
          },
        });
      })
      .catch((error) => console.warn('Failed to announce sessions interrupted by the OpenCode restart:', error?.message ?? error));
  },
  getManagedOpenCodeEnv: async () => (managedConfigRuntime ? managedConfigRuntime.buildManagedChildEnv() : {}),
  getUserEnvironment: () => environmentRuntime.forOpenCode(),
});

// Quota lookups, voice keys and routing read provider credentials from the
// running OpenCode (`GET /api/credential`), plus the values of the variables a
// managed OpenCode takes keys from, read from the environment it was given.
configureOpenCodeCredentials(FRONT_DOOR ? createAgentCredentialSource(agentUpstream) : openCodeCredentialSource({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getLaunchEnvironment: () => openCodeLifecycleRuntime.getManagedOpenCodeProcessEnv(),
  getDefaultDirectory: () => openCodeLifecycleRuntime.getDefaultOpenCodeDirectory(),
}));
// A new worktree runs the start command OpenCode keeps on the project record.
if (!FRONT_DOOR) configureProjectStartCommandSource(openCodeProjectStartCommandSource({ buildOpenCodeUrl, getOpenCodeAuthHeaders }));

const getOpenCodeCompatibility = async () => {
  if (isExternalOpenCode || ENV_SKIP_OPENCODE_START) {
    const base = ENV_CONFIGURED_OPENCODE_HOST?.origin || openCodeBaseUrl || `http://127.0.0.1:${openCodePort || ENV_EFFECTIVE_PORT}`;
    const version = await readExternalOpenCodeVersion(base, getOpenCodeAuthHeaders()).catch(() => null);
    return describeOpenCodeCompatibility(version, 'external', false);
  }
  const binary = ensureOpencodeCliEnv();
  const installation = isBundledOpenCodeCliPath(binary) ? 'bundled' : 'managed';
  const version = await readOpenCodeCliVersion(resolveManagedOpenCodeLaunchSpec(binary)).catch(() => null);
  // A CLI pinned by the administrator is theirs to replace, never ours.
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
    isBundledBinary: isBundledOpenCodeCliPath,
    pinnedByPolicy: Boolean(readEnterprisePolicy().opencodeBinary),
  });
};

const restartOpenCode = (...args) => {
  if (FRONT_DOOR) throw Object.assign(new Error('front_door_refused'), { code: 'front_door_refused' });
  return openCodeLifecycleRuntime.restartOpenCode(...args);
};
const waitForOpenCodeReady = (...args) => openCodeLifecycleRuntime.waitForOpenCodeReady(...args);
const waitForAgentPresence = (...args) => openCodeLifecycleRuntime.waitForAgentPresence(...args);
const refreshOpenCodeAfterConfigChange = (...args) => openCodeLifecycleRuntime.refreshOpenCodeAfterConfigChange(...args);
const startHealthMonitoring = () => openCodeLifecycleRuntime.startHealthMonitoring(HEALTH_CHECK_INTERVAL);
const triggerHealthCheck = () => { if (!FRONT_DOOR) return openCodeLifecycleRuntime.triggerHealthCheck(); };
const scheduledChatsScope = createChatsScope(OPENCHAMBER_CHATS_DIR);
// Git routes fill this bridge after the scheduler is created.
const scheduledWorktreeBridge = createUnregisteredScheduledWorktreeBridge();
const scheduledTasksRuntime = FRONT_DOOR ? null : createScheduledTasksRuntime({
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
  // Declared further down; the scheduler only calls it when a scan task fires.
  runSuggestedScan: (projectID, reason) => suggestedTasksRuntime.runScan(projectID, reason),
  runBot: (projectId, botId, occurrence) => {
    if (!botsHost) throw new Error('Bots require the host server');
    return botsHost.runScheduled(projectId, botId, occurrence);
  },
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
    if (event.status === 'error') {
      recordCenterNotification({
        kind: 'scheduled-task',
        priority: 'high',
        delivery: 'delivered',
        title: event.taskName?.trim() ? `Scheduled task failed: ${event.taskName.trim()}` : 'Scheduled task failed',
        body: event.error ?? '',
        sessionId: event.sessionID,
        directory: event.directory,
        action: { type: 'scheduled-tasks', projectId: scheduledChatsScope.toPublicID(event.projectID) },
      });
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
/**
 * Maps a session directory onto the project whose memory it belongs to, so a
 * session running in a worktree writes to the project the panel shows.
 */
const resolveMemoryProjectId = createMemoryProjectResolver({
  listProjectPaths: async () => {
    const settings = await readSettingsFromDiskMigrated().catch(() => null);
    return sanitizeProjects(settings?.projects || []).map((project) => project.path);
  },
  resolvePrimaryWorktreeRoot,
  managedProjectRoots: [...new Set([path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'chats'), OPENCHAMBER_CHATS_DIR])],
});

/**
 * Tells open panels that the service changed what it remembers, so what it just
 * stored is visible without reopening anything.
 */
const emitAgentMemoryChangedEvent = (event) => {
  for (const client of uiOpenChamberEventClients) {
    try {
      writeSseEvent(client, {
        // The UI listens for exactly this name (`lib/openchamberEvents.ts`);
        // under any other name the Memory panel only catches up on reload.
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
const scheduledTaskService = FRONT_DOOR ? null : createScheduledTaskService({
  readSettingsFromDiskMigrated,
  sanitizeProjects,
  projectConfigRuntime,
  scheduledTasksRuntime,
  chatsScope: scheduledChatsScope,
  resolvePrimaryWorktreeRoot,
});
const sessionServiceDependencies = {
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
  // Holds the archive file (`session-archive.js`) beside the instance it describes.
  dataDir: OPENCHAMBER_DATA_DIR,
  sessionMetadataStore,
  persistSessionMetadata: persistSessionMetadataPatch,
  updateSessionMetadata: updateSessionMetadataWith,
  broadcastGlobalUiEvent: broadcastOpenChamberUiEvent,
  resolveAutoSelection: (input) => routingRuntime.resolveAutoSelection(input),
  isAutoReady: async () => (await routingRuntime.describe()).autoReady,
};
const openChamberSessionService = FRONT_DOOR ? null : createOpenChamberSessionService(sessionServiceDependencies);
if (isInsideBotSpace) {
  botChildServer = createBotChildServer({ dataDir: OPENCHAMBER_DATA_DIR, updateMetadata: persistSessionMetadataPatch });
} else if (!FRONT_DOOR) {
  botsHost = createBotsHost({
    dataDir: OPENCHAMBER_DATA_DIR, projectsDir: OPENCHAMBER_PROJECTS_CONFIG_DIR,
    projectConfigRuntime, scheduledTasksRuntime, listProjects: listConfiguredProjects,
    resolveProject: async (projectId) => {
      const project = (await listConfiguredProjects()).find((entry) => entry.id === projectId);
      if (!project) throw Object.assign(new Error('Bot project is unavailable'), { code: 'BOT_PROJECT_NOT_FOUND', status: 404 });
      return project;
    },
    sessionService: openChamberSessionService,
    readOnlySessionService: createOpenChamberSessionService({ ...sessionServiceDependencies,
      sessionKnowledgeRuntime: { sync: (sessionId, directory) => sessionKnowledgeRuntime.sync(sessionId, directory, { includeMemorySaveRule: false }) },
    }),
    clientFor: openCodeSessionClient, permissionAutoAcceptRuntime, sessionKnowledgeRuntime,
    readSessionDefaults: async (projectId) => {
      const settings = await readSettingsFromDiskMigrated();
      const project = sanitizeProjects(settings.projects || []).find((entry) => entry.id === projectId);
      const defaults = resolveSessionDefaults({ settings, project });
      if (!defaults.providerID || !defaults.modelID) {
        const model = unwrapOpenCodeResponse(await openCodeSessionClient(project.path).model.default());
        defaults.providerID = model.providerID; defaults.modelID = model.id;
      }
      const selection = { providerID: defaults.providerID, modelID: defaults.modelID };
      if (defaults.variant) selection.variant = defaults.variant;
      if (defaults.agent) selection.agent = defaults.agent;
      return selection;
    },
    buildOpenCodeUrl, getOpenCodeAuthHeaders, getSpacesHost: () => spacesHost, getSpaceArchive: () => spaceArchive,
    messageQueueRuntime, notificationCenter, notify: notificationTriggerRuntime.notifyBotAttention,
    broadcast: broadcastOpenChamberUiEvent, getFixLoopRuntime: () => prFixLoopRuntime,
    disposeInstance: async (directory) => openCodeSessionClient(directory).debug.location.evict({ location: { directory } }),
  });
}
// Browser actions are published to whichever OpenChamber clients are connected;
// the one owning the browser panel answers. `emitRequest` returns the number of
// clients reached so the broker can fail fast when nobody is listening.
const browserControlBroker = FRONT_DOOR ? null : createBrowserControlBroker({
  createId: () => `browser-${crypto.randomUUID()}`,
  emitRequest: (request) => {
    // Opening a page only needs a panel to open it in; everything else needs a
    // client that can actually drive one. Counting the right clients is what
    // lets the broker say "not here" instead of timing out.
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

/**
 * Tells every client the selected browser provider was dropped back to the
 * in-app browser, so Settings shows the change and the user hears why.
 */
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
/**
 * Tells every client a chat's agent is about to use its browser; a client
 * showing that chat with "Follow agent" on opens the Browser panel.
 */
const announceBrowserAgentActivity = ({ guestId, action, context }) => {
  for (const client of uiOpenChamberEventClients) {
    try {
      writeSseEvent(client, {
        type: 'openchamber:browser-agent-activity',
        properties: { guestId, action, directory: context?.directory ?? null, sessionId: context?.sessionId ?? null },
      });
    } catch {
      uiOpenChamberEventClients.delete(client);
    }
  }
};
const BROWSER_HELP_NOTIFICATION_TITLE = 'The agent needs your help in the browser';
const BROWSER_HELP_LOGIN_NOTIFICATION_TITLE = 'The agent needs you to sign in';
const BROWSER_HELP_PROFILE_NOTIFICATION_TITLE = 'The agent asks to save its logins in a browser profile';
const BROWSER_HELP_REASON_MAX = 500;

/**
 * Tells the person a `browser.requestHelp` needs them: the live in-app
 * notification (desktop + SSE, same as `notify.send`) and, unlike that tool,
 * a web-push/APNs fanout too — see notifications/DOCUMENTATION.md for why
 * this one is not gated by the notify tool's own toggle. Skips both when the
 * user turned native notifications off; `notificationTriggerRuntime` is
 * declared above this point specifically so it can be captured here.
 * `reason` arrives already validated (1-300 chars) by the control service
 * that built these `parameters`; only its length here is this function's own
 * concern, since a push notification body has a smaller budget. `kind` is
 * the agent's `browser.requestHelp` parameter (`'login'`/`'page'`), read
 * only to pick the title — the provider decides what to actually do with it.
 */
const notifyBrowserHelp = async ({ guestId, reason, kind, context }) => {
  const settings = await readSettingsFromDiskMigrated();
  if (settings.nativeNotificationsEnabled === false) {
    return;
  }
  const sessionId = context?.sessionId || null;
  const directory = context?.directory || null;
  const title = kind === 'login'
    ? BROWSER_HELP_LOGIN_NOTIFICATION_TITLE
    : kind === 'profile' ? BROWSER_HELP_PROFILE_NOTIFICATION_TITLE : BROWSER_HELP_NOTIFICATION_TITLE;
  const body = reason.trim().slice(0, BROWSER_HELP_REASON_MAX);
  const tag = `browser-help-${sessionId || guestId}`;
  const notificationPayload = {
    title,
    body,
    tag,
    kind: AGENT_SERVER ? 'browser-help' : 'plugin',
    sessionId,
    directory,
    requireHidden: false,
    // Read by the Electron click handler (maybeShowNativeNotification) to
    // open this guest's panel alongside the session; ignored elsewhere.
    guestId,
  };
  const desktopNotificationDelivered = emitDesktopNotification(notificationPayload);
  broadcastUiNotification(notificationPayload, { desktopNotificationDelivered });
  recordCenterNotification({
    kind: 'browser-help',
    priority: 'high',
    delivery: 'delivered',
    title,
    body,
    sessionId,
    directory,
  });

  // The push deep link needs a session to reopen; a help request with none
  // (a CLI-invoked action, for instance) still gets the in-app notice above.
  if (!sessionId) {
    return;
  }
  await notificationTriggerRuntime.sendBrowserHelpPush({
    sessionId,
    guestId,
    title,
    body,
  });
};

// Every browser action passes through here: the in-app view by default, or an
// extension service chosen in Settings → OpenChamber Tools.
const browserControlRouter = FRONT_DOOR ? null : createBrowserControlRouter({
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
  notifyBrowserHelp,
  announceAgentActivity: announceBrowserAgentActivity,
});

// "Show this file" reaches every connected client; the ones showing that
// project open it. Nothing comes back, so the count of clients reached is the
// only signal the agent gets.
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
  recordNotification: recordCenterNotification,
  isSubagentSession: (sessionId, directory) => notificationTriggerRuntime.isSubagentSession(sessionId, directory),
});

// Suggested tasks: scans timed by the scheduler above, with filesystem reads
// and explicitly selected MCP tools, collected into a per-project inbox.
const suggestedTasksRuntime = FRONT_DOOR ? null : createSuggestedTasksRuntime({
  projectConfigRuntime,
  scheduledTasksRuntime,
  store: createSuggestionStore({ projectsDirPath: OPENCHAMBER_PROJECTS_CONFIG_DIR }),
  listProjects: async () => {
    const settings = await readSettingsFromDiskMigrated();
    return sanitizeProjects(settings?.projects || []);
  },
  projectContextRuntime,
  sessionService: openChamberSessionService,
  sessionKnowledgeRuntime,
  permissionAutoAcceptRuntime,
  readMcpServers: async (directory) => (await openCodeSessionClient(directory).mcp.list({ location: { directory } })).data,
  readSessionDefaults: async (projectID) => {
    const settings = await readSettingsFromDiskMigrated();
    const project = sanitizeProjects(settings?.projects || []).find((entry) => entry.id === projectID) ?? null;
    return resolveSessionDefaults({ settings, project });
  },
  globalEventHub: globalMessageStreamHub,
  git: { readScanCheckout, listChangedPathsSince, addDetachedWorktree, removeDetachedWorktree, getRepositoryRemoteUrls },
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  notify: (payload) => pluginNotificationEmitter.emit(payload),
  broadcast: broadcastOpenChamberUiEvent,
  isLinearConnected: () => Boolean(getLinearAuth()),
  readProjectOpenIssues: (directory) => featureRoutesRuntime.readProjectOpenIssues(directory),
  deliverSuggestionToBot: (input) => {
    if (!botsHost) throw new Error('Bots require the host server');
    return botsHost.deliverSuggestion(input);
  },
  scanCheckoutsDir: path.join(OPENCHAMBER_DATA_DIR, 'suggested-tasks', 'checkouts'),
});
suggestedTasksRuntime?.start();
// Secrets the user saved for an agent (secret.request). Each file is deleted
// 24 hours after it was written: on start, and hourly while the server runs.
const secretFiles = createSecretFiles({ directory: path.join(OPENCHAMBER_DATA_DIR, 'secrets') });
void secretFiles.sweep();
setInterval(() => { void secretFiles.sweep(); }, 60 * 60 * 1000).unref();

const insideSpaceTaskNaming = process.env.OPENCHAMBER_SPACE_TASK_TITLE_FILE && process.env.OPENCHAMBER_SPACE_USER_TASK_TITLE_FILE
  ? createInsideSpaceTaskNaming({
    agentFile: process.env.OPENCHAMBER_SPACE_TASK_TITLE_FILE,
    userFile: process.env.OPENCHAMBER_SPACE_USER_TASK_TITLE_FILE,
    announce: broadcastOpenChamberUiEvent,
  }) : null;

const openChamberControlService = FRONT_DOOR ? null : createOpenChamberControlService({
  chatsScope: scheduledChatsScope,
  readSettingsFromDiskMigrated,
  sanitizeProjects,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  waitForOpenCodeReady,
  isOpenCodeDirectoryTrusted: (directory) => openCodeTrust.isTrusted(directory),
  sessionService: openChamberSessionService,
  scheduledTaskService,
  browserControl: browserControlRouter,
  fileOpen: fileOpenRequester,
  projectContextRuntime,
  // The resolver session knowledge reads pinned notes and plans through, so
  // what an agent writes is what the next session is given.
  resolveProjectContextId: resolveMemoryProjectId,
  // On by default; a plugin generated before it was switched off must not
  // keep writing.
  // Like file.open: every connected window hears it, the ones showing that
  // project open the plan.
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
  // On by default, like knowledge.
  isRenderToolEnabled: async () => {
    const settings = await readSettingsFromDiskMigrated().catch(() => null);
    return settings?.agentRenderToolEnabled !== false;
  },
  isSecretToolEnabled: async () => {
    const settings = await readSettingsFromDiskMigrated().catch(() => null);
    return settings?.agentSecretToolEnabled !== false;
  },
  secretFiles,
  // A page that waits for the user's answer shows the session as waiting
  // the way a form does: the pending list the clients seed from, a live event
  // for the clients already connected, and the "Input needed" notification.
  onPageWaitChange: (change) => {
    sessionRuntime.trackWaitingPage(change);
    if (change.type === 'waiting') {
      const payload = {
        type: 'openchamber:page-waiting',
        properties: { sessionID: change.sessionId, directory: change.directory, page: { id: change.callId, title: change.title } },
      };
      broadcastOpenChamberUiEvent(payload);
      void maybeSendPushForTrigger(payload);
      // Server-made, so it never passes through the hub loop: told here.
      extensionSessionEvents.processPayload(payload, change.directory);
      return;
    }
    const settled = {
      type: 'openchamber:page-settled',
      properties: { sessionID: change.sessionId, pageID: change.callId },
    };
    broadcastOpenChamberUiEvent(settled);
    extensionSessionEvents.processPayload(settled, change.directory);
    resolveCenterEntries({ sessionId: change.sessionId, kinds: ['question'], requestId: change.callId });
  },
  // The tool is off by default; a plugin generated before it was switched off
  // must not keep paging the user.
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
  workflowRuntime,
  archiveStore: openChamberSessionService.archiveStore,
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
  if (FRONT_DOOR) {
    globalMessageStreamHub.subscribeStatus((status) => { isOpenCodeReady = status.type === 'connect'; });
    void ensureGlobalWatcherStarted();
    agentStreams?.start();
    return;
  }
  await openCodeLifecycleRuntime.bootstrapOpenCodeAtStartup(...args);
  // These steps need a running OpenCode; a retry runs them once it starts.
  if (openCodeLifecycleRuntime.scheduleBootstrapRetry(bootstrapOpenCodeAtStartup, finishOpenCodeBootstrap)) return;
  finishOpenCodeBootstrap();
};
const finishOpenCodeBootstrap = () => {
  scheduleOpenCodeApiDetection();
  if (openCodeLifecycleState.openCodeProcess && !openCodeLifecycleState.isExternalOpenCode) {
    startHealthMonitoring();
  }
  // The global watcher used to start only for desktop notifications; the
  // session-assist runtime also rides its event hub, so it now starts
  // unconditionally once OpenCode is up.
  void ensureGlobalWatcherStarted().catch((error) => {
    console.warn(`Global event watcher startup failed: ${error?.message || error}`);
  });
  // Entries the sweep cannot push now stay in the legacy file and are pushed on
  // the session's next write or the next start.
  void waitForOpenCodeReady()
    .then(() => sessionMetadataStore.migrateLegacy())
    .catch((error) => console.warn('[openchamber-sessions] session metadata migration failed:', error?.message ?? error));
  // The listener is already serving the shell. Runtime workers start only after
  // lifecycle bootstrap has selected its endpoint and confirmed readiness.
  void (async () => {
    try {
      await waitForOpenCodeReady();
      if (isShuttingDown) return;
      await botsHost?.start();
    } catch (error) {
      console.warn('[bots] Host startup failed:', error?.code ?? 'BOT_HOST_START_FAILED');
    }
    if (isShuttingDown) return;
    try { await prFixLoopRuntime.start(); }
    catch { console.warn('[pr-fix-loop] persisted state could not be loaded; loops remain disabled'); }
    if (isShuttingDown) return;
    try { await scheduledTasksRuntime.start(); }
    catch (error) { console.warn('[ScheduledTasks] Failed to start runtime:', error?.message || error); }
  })();
  // Archive state OpenChamber kept before OpenCode held it moves to OpenCode in
  // one pass (`session-archive.js`).
  void waitForOpenCodeReady()
    .then(() => openChamberSessionService.sessionArchive.migrateLegacy())
    .catch((error) => console.warn('[openchamber-sessions] session archive migration failed:', error?.message ?? error));
};
const killProcessOnPort = (...args) => openCodeLifecycleRuntime.killProcessOnPort(...args);
const waitForPortRelease = (...args) => openCodeLifecycleRuntime.waitForPortRelease(...args);

const setupProxy = (...args) => { if (!FRONT_DOOR) return serverUtilsRuntime.setupProxy(...args); };
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
  sessionAssistRuntime,
  sessionWorkRuntime,
  autoResumeRuntime,
  sessionGoalRuntime,
  contextObligatoryRuntime,
  sessionWarmingRuntime,
  autoReviewRuntime,
  prWatchRuntime,
  messageQueueRuntime,
  prFixLoopRuntime,
  mergeFollowRuntime,
  dispatchResultsRuntime,
  suggestedTasksRuntime,
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
  shouldSkipOpenCodeStop: () => FRONT_DOOR || ENV_SKIP_OPENCODE_START || isExternalOpenCode,
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
  disposeFeatureRoutes: () => { agentStreams?.close(); frontDoorRuntime?.close(); globalMessageStreamHub.stop(); featureRoutesRuntime.dispose(); },
  stopAllGuestServices,
  extensionSessionEvents,
  getGuestSurfaceRuntime: () => guestSurfaceRuntime,
  getRealtimeProxyRuntime: () => realtimeProxyRuntime,
  getDictationRuntime: () => dictationRuntime,
  getRelayService: () => relayServiceInstance,
  getRelayReconcileTimer: () => relayReconcileTimer,
  getSpacesHost: () => spacesHost,
  getBotsHost: () => botsHost,
  stopFolderWatches: featureRoutesRuntime.stopFolderWatches,
});

const gracefulShutdown = (...args) => gracefulShutdownRuntime.gracefulShutdown(...args);

async function main(options = {}) {
  if (FRONT_DOOR) {
    // The root component decides, as root, who owns a project folder and opens the human's to the
    // agent; the front door itself cannot look into any home folder.
    const hostd = createHostdClient();
    projectRegistry = createProjectRegistry({
      shareProject: options.shareProject ?? ((directory) => hostd.request({ op: 'share-project', path: directory })),
      ownsProject: options.ownsProject ?? (async (directory) => (await hostd.request({ op: 'project-owner', path: directory }))?.owner === 'agent'),
    });
  }
  // Again at start: the desktop shell merges the login shell's environment,
  // where proxy variables often live, after this module first loaded.
  applyOutboundProxyFromEnv();
  const port = Number.isFinite(options.port) && options.port >= 0 ? Math.trunc(options.port) : DEFAULT_PORT;
  const host = typeof options.host === 'string' && options.host.length > 0 ? options.host : undefined;
  const effectiveBindHost = host
    || (typeof process.env.OPENCHAMBER_HOST === 'string' && process.env.OPENCHAMBER_HOST.trim().length > 0
      ? process.env.OPENCHAMBER_HOST.trim()
      : '127.0.0.1');
  if (FRONT_DOOR) frontDoorListen = { port, host: effectiveBindHost };
  if (!FRONT_DOOR) beginGuestServiceHost({
    registryDir: guestServiceRegistryDir(OPENCHAMBER_DATA_DIR),
    browserOrigins: async () => {
      const settings = await readSettingsFromDiskStrict();
      return serverBrowserOrigins({
        settingsOrigins: settings.serverBrowserOpenChamberOrigins,
        // A pipe listener reports a string here, which has no port.
        port: server?.address?.()?.port ?? port,
        host: effectiveBindHost,
        addresses: ['0.0.0.0', '::'].includes(effectiveBindHost)
          ? Object.values(os.networkInterfaces()).flatMap((entries) => (entries ?? []).map((entry) => entry.address))
          : [],
      });
    },
  });
  const instanceDir = await prepareInstanceDir({ fsPromises, path, dataDir: OPENCHAMBER_DATA_DIR });
  agentToolRuntime = FRONT_DOOR ? null : createAgentToolRuntime({
    mcpToolsRuntime,
    crypto,
    fsPromises,
    path,
    instanceDir,
    env: process.env,
    executeAction: (...args) => openChamberControlService.execute(...args),
    executeBotAction: (request, requestOptions) => (botChildServer ?? botsHost).handleTool(request, requestOptions),
    // A v2 tool call carries no directory, only the session it runs in.
    resolveSessionDirectory: (sessionID) => openChamberControlService.resolveSessionDirectory(sessionID),
    getActivePort: () => {
      const address = server?.address?.();
      return typeof address === 'object' && address ? address.port : null;
    },
    // A pipe listener reports a string here, which has no address to bind back to.
    getActiveHost: () => server?.address?.()?.address ?? null,
  });
  limitFailoverRuntime = FRONT_DOOR ? null : createLimitFailoverRuntime({
    fsPromises,
    path,
    instanceDir,
    readSettings: () => readSettingsFromDiskMigrated(),
    authorizeRequest: (req) => agentToolRuntime.authorizeRequest(req),
    broadcastUiEvent: (event) => broadcastOpenChamberUiEvent(event),
  });
  managedConfigRuntime = FRONT_DOOR ? null : createManagedConfigRuntime({
    fsPromises,
    path,
    dataDir: OPENCHAMBER_DATA_DIR,
    instanceDir,
    env: process.env,
    agentToolRuntime,
    limitFailoverRuntime,
    readSettings: () => readSettingsFromDiskMigrated(),
    isBotToolAvailable: () => Boolean(botsHost || botChildServer),
  });
  if (!FRONT_DOOR) await ensureChatsDir({ fsPromises, chatsDir: OPENCHAMBER_CHATS_DIR, warn: (message) => console.warn(`[data-dir] ${message}`) });

  // Pairing transports advertised to the create-device dialog. LAN reachability is
  // derived from the SERVER's actual bind (a wildcard bind → the machine's LAN IP;
  // a specific non-loopback host → that host), NOT from how the UI was opened — so
  // "Local network" works even when the UI is opened on localhost, and is absent
  // when the server is only bound to loopback (a LAN link would not connect).
  // The IPv4 the requesting client actually reached this server on (if any).
  // Strips the IPv6-mapped prefix; loopback means "not a LAN path".
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
      // Prefer the address the client is ALREADY talking to us on — it is the
      // one interface guaranteed to be routable from that client's network.
      // Interface scanning is only a fallback: on servers with virtual bridges
      // (docker0 etc.) the first non-internal IPv4 can be an address no other
      // machine can reach, which produced pairing links whose LAN candidate
      // silently failed and forced devices onto the relay.
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
  // ALL direct LAN URLs this server is currently reachable on, for the
  // candidates-refresh endpoint: the address the requesting client already
  // reached us on first (guaranteed routable from its network — over the relay
  // tunnel this is loopback and yields nothing), then every non-internal IPv4
  // interface. A client that paired while the machine had a different DHCP
  // lease uses this to replace its stale LAN candidate.
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
  const uiPasswordHash = options.uiPasswordHash !== undefined
    ? options.uiPasswordHash
    : (typeof process.env.OPENCHAMBER_UI_PASSWORD_HASH === 'string' ? process.env.OPENCHAMBER_UI_PASSWORD_HASH : null);
  if (
    isNetworkExposedBindHost(effectiveBindHost)
    && !isUiAuthConfigured({ password: uiPassword, passwordHash: uiPasswordHash })
    && !isUnsafeUnauthenticatedLanAllowed(process.env)
  ) {
    throw new Error(getUnauthenticatedLanErrorMessage(effectiveBindHost));
  }
  if (FRONT_DOOR && !isUiAuthConfigured({ password: uiPassword, passwordHash: uiPasswordHash })) throw new Error('Front door requires UI password authentication.');
  // Enterprise mode keeps the server on this machine unless the administrator
  // allowed network access. The server is a package anyone can install, so
  // this holds for the CLI and --host as much as for the desktop toggle.
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

  // Voice enumeration is independent from route registration. Start it now,
  // but do not hold server listen or managed OpenCode startup on `say -v "?"`.
  const sayTTSCapability = detectSayTtsCapability(process);

  // The chats of deleted spaces, imported into the host's OpenCode and kept read-only there
  // (decision 9). It reads a folder of the data directory and runs nothing else, so it
  // exists with the switch on or off: an archived chat must stay read-only either way.
  const hostOpenCodeClient = () => {
    const options = { baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''), headers: getOpenCodeAuthHeaders() };
    return FRONT_DOOR ? OpenCode.make({ ...options, fetch: agentUpstream.fetch }) : createOpenCodeClient(options);
  };
  spaceArchive = createSpaceArchive({
    dataDir: OPENCHAMBER_DATA_DIR,
    hostOpenCode: {
      importChat: (chat) => hostOpenCodeClient().experimental.session.import(chat),
      removeChat: (sessionID) => hostOpenCodeClient().session.remove({ sessionID }),
    },
  });

  // The isolated-spaces switch, read here at start and changed live through its route below.
  // While it is off the feature has no place, no manager, no route and runs no `docker`.
  // A front door reads the human's model providers and secrets through the agent server.
  const agentHostCredentials = FRONT_DOOR ? createAgentHostCredentials(agentUpstream) : null;
  const buildSpacesHost = async () => createSpacesHost({
    frontDoor: FRONT_DOOR ? agentUpstream : false,
    hostProviders: agentHostCredentials?.hostProviders,
    readHostSecret: agentHostCredentials?.readHostSecret,
    dataDir: OPENCHAMBER_DATA_DIR,
    dockerPath: searchPathFor('docker', buildAugmentedPath()) ?? 'docker',
    // The machine of the Docker over SSH place, when the settings name one.
    sshDockerHost: dockerHostOf((await readSettingsFromDiskMigrated().catch(() => null))?.isolatedSpacesSshHost),
    // Only for a clean-up of the spaces' disk on Colima, to give the freed space back; null without it.
    colimaPath: searchPathFor('colima', buildAugmentedPath()),
    // For getting Docker ready on this computer: brew, colima, asked again at every look.
    findProgram: (name) => searchPathFor(name, buildAugmentedPath()) ?? null,
    gitPath: searchPathFor('git', buildAugmentedPath()) ?? 'git',
    // git starts `docker exec` itself when code moves in or out, so its PATH must find docker.
    hostEnvironment: { ...process.env, PATH: buildAugmentedPath() },
    // So the session list can say which registered project each space was made for.
    listProjectDirectories: async () => {
      const settings = await readSettingsFromDiskMigrated();
      return sanitizeProjects(settings?.projects || []).map((project) => project.path);
    },
    readIdleStop: async () => readIdleStopSetting((await readSettingsFromDiskMigrated())?.isolatedSpacesIdleStop),
    saveIdleStop: (setting) => persistSettings({ isolatedSpacesIdleStop: setting }),
    readPermissionDefault: async () => permissionDefaultOf((await readSettingsFromDiskMigrated())?.permissionDefaultMode),
    archive: spaceArchive,
    // What the host says to the login issuer when it renews a browser login for a space.
    userAgent: `OpenChamber/${OPENCHAMBER_VERSION}`,
  });
  const startupSettings = await readSettingsFromDiskMigrated().catch(() => null);
  if (FRONT_DOOR) await settingsMirror.start(startupSettings ?? {});
  if (AGENT_SERVER) await trustAgentProjects(startupSettings?.projects);
  if (!AGENT_SERVER && startupSettings?.isolatedSpacesEnabled === true) {
    try {
      spacesHost = await buildSpacesHost();
    } catch (error) {
      // The feature is absent then, and the rest of the server starts as with the switch off.
      console.error(`[spaces] isolated spaces are unavailable this start: ${error?.code ?? ''} ${error?.message ?? error}`.trim());
      spacesHost = null;
    }
  }

  const app = express();
  if (FRONT_DOOR) app.use((req, res, next) => {
    const pathname = normalizedRequestUrl(req)?.pathname.toLowerCase() ?? '';
    if (pathname === AGENT_PROTECTED_MCP_ROUTE || pathname.startsWith(`${AGENT_PROTECTED_MCP_ROUTE}/`)) return res.status(403).json({ code: 'front_door_refused' });
    next();
  });
  if (FRONT_DOOR) app.use(frontDoorRequestGate);
  if (AGENT_SERVER) app.use((req, res, next) => {
    const url = normalizedRequestUrl(req);
    const pathname = url?.pathname.toLowerCase() ?? '';
    if (/^\/api\/(?:push|protected-mcp|spaces)(?:\/|$)/.test(pathname)
      || /^\/api\/openchamber\/(?:relay|tunnel|spaces)(?:\/|$)/.test(pathname)
      || /^\/api\/openchamber\/update(?:-|\/|$)/.test(pathname) && req.method !== 'GET') {
      return res.status(403).json({ code: 'agent_feature_disabled', error: 'This feature is owned by the front door.' });
    }
    next();
  });
  const serverStartedAt = new Date().toISOString();
  const packagedClientOrigins = new Set([
    'openchamber-ui://app',
    'capacitor://localhost',
    'http://localhost',
    'https://localhost',
  ]);
  const allowLocalDevOrigins = allowsLocalDevOrigins(process.env);
  // Keeps other sites from framing the app (clickjacking). Routes that serve
  // untrusted documents set a Content-Security-Policy of their own, which
  // replaces this one.
  const frameAncestorsPolicy = buildFrameAncestorsPolicy({
    allowLocalDevOrigins,
    extra: process.env.OPENCHAMBER_FRAME_ANCESTORS,
  });
  // Forwarded headers are believed only from a proxy on this machine or a
  // private network (cloudflared, Docker, a LAN reverse proxy). From anyone
  // else they are the client's own words, and the login rate limit keys on
  // req.ip, so a client must not be able to name its own address.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  // Keep self-hosted instances out of search engines. The app shell is served
  // publicly (it loads before prompting for the UI password), so without this
  // even a password-protected instance gets crawled and indexed. Applies to
  // every response; the robots.txt route makes the intent explicit for crawlers.
  app.use((req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    // The preview proxy relays a dev server's own pages, whose types and
    // referrer behaviour are that app's business. Everything else is ours:
    // served with real types, and its address (a tunnel host, short-lived
    // auth tokens, session ids) never follows a link out as a Referer.
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
      // The packaged desktop UI (openchamber-ui://) and the dev UI sit on a
      // different origin, so every custom request header must be listed here or
      // the browser refuses the request at preflight, before it reaches a route.
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept,X-Requested-With,Cache-Control,X-OpenCode-Directory,X-OpenCode-Directory-Encoding,Ngrok-Skip-Browser-Warning,X-OpenChamber-Surface,X-OpenChamber-Provider,X-OpenChamber-Model,X-OpenChamber-Part-Shells');
      res.setHeader('Access-Control-Expose-Headers', 'x-next-cursor');
      // Without it the browser sends a preflight before every request: in the
      // packaged app that was 45% of all requests while idle. Chromium caps
      // the cache at two hours.
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
  gracefulShutdownRuntime.trackServerConnections(server);
  // A policy placed while the server runs cannot rebind it, so connections
  // from other machines are dropped until the next start binds loopback.
  if (isNetworkExposedBindHost(effectiveBindHost)) {
    server.on('connection', (socket) => {
      if (!isLoopbackBindHost(socket.remoteAddress ?? '') && isNetworkAccessBlocked()) socket.destroy();
    });
  }
  // Same pattern for the tunnel runtime: created after the base routes so
  // /api/system/info resolves port + tunnel URL lazily at request time.
  let tunnelRuntimeContextHolder = null;

  const bootstrapResult = bootstrapRuntime.setupBaseRoutes(app, {
    frontDoor: FRONT_DOOR,
    afterApiAuth: (auth) => {
      if (AGENT_SERVER) registerSpaceTransferRoutes(app, { agent: true, readSettings: readSettingsFromDiskMigrated, dataDir: OPENCHAMBER_DATA_DIR, resolveGitPath: resolveGitBinaryForSpawn });
      registerFixLoopServiceRoutes(app, { agentServer: AGENT_SERVER, readSettings: readSettingsFromDiskMigrated,
        gitServices: approvalGitServices, getOctokit: exactFixLoopOctokit,
        readFeedback: async (input) => (await import('./lib/github/pr-feedback.js')).readPullFeedback(input),
        readAuthorPermission: async (input) => (await import('./lib/github/pr-feedback.js')).readFeedbackAuthorPermission(input),
        readFailedChecks: async (input) => (await import('./lib/github/pr-feedback.js')).readFailedChecks(input),
        dataDir: OPENCHAMBER_DATA_DIR, resolveGitPath: resolveGitBinaryForSpawn });
      if (!FRONT_DOOR) return;
      app.use(spaceArchive.guard);
      frontDoorRuntime = createFrontDoor({ upstream: agentUpstream, getSpacesHost: () => spacesHost, hub: globalMessageStreamHub, uiAuthController: auth, isRequestOriginAllowed });
      app.use(frontDoorRuntime.middleware);
      app.get(['/api/global/event', '/api/event'], frontDoorRuntime.serveEvents);
      server.prependListener('upgrade', frontDoorRuntime.upgradeHandler);
      agentStreams = createAgentStreams({
        upstream: agentUpstream,
        onControlConnection: (connectionId) => { void frontDoorTrackedItems.setControlConnection(connectionId).catch(() => {}); },
        isSpaceSession: (id) => Boolean(spacesHost?.index.claimedBy(id)),
        isOwnerFixLoopIdentity: (id) => prFixLoopRuntime.ownsIdentity(id),
        broadcastUiEvent: (event) => {
          broadcastOpenChamberUiEvent(event);
          if (event.type === 'openchamber:page-waiting') void maybeSendPushForTrigger(event);
          if (event.type === 'openchamber:page-settled') resolveCenterEntries({ sessionId: event.properties.sessionID, kinds: ['question'], requestId: event.properties.pageID });
        },
        broadcastGlobalUiEvent: (event) => {
          broadcastPermissionUiEvent(event);
          if (event.type === 'openchamber:notification') void notificationTriggerRuntime.deliverAgentNotification(event).catch(() => console.warn('[agent-streams] notification_delivery_failed'));
        },
      });
    },
    openChamberControlService,
    sanitizeProjects,
    validateDirectoryPath,
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
    // Port this instance serves on and the active tunnel's public URL (if
    // any), for /api/system/info. Resolved lazily because the tunnel runtime
    // is created after these base routes are registered.
    getServerPort: () => {
      const activePort = tunnelRuntimeContextHolder?.getActivePort?.();
      if (Number.isFinite(activePort) && activePort > 0) return activePort;
      return Number.isFinite(port) && port > 0 ? port : null;
    },
    getTunnelUrl: () => tunnelRuntimeContextHolder?.tunnelService?.getPublicUrl?.() ?? null,
    verboseRequestLogs: OPENCHAMBER_VERBOSE_REQUEST_LOGS,
    uiPassword,
    uiPasswordHash,
    tunnelAuthController,
    remoteClientAuthRuntime,
    clientPairingRuntime,
    getRelayPairingCandidate: (options) => {
      if (!relayServiceInstance) return null;
      // A relay pairing link enables the relay on demand; a plain link only
      // advertises relay when it is already on.
      return options?.ensureEnabled
        ? relayServiceInstance.ensureEnabledForPairing()
        : relayServiceInstance.getPairingCandidate();
    },
    // Re-evaluate the relay lifecycle after pairing/device changes (a revoked or
    // redeemed device can flip relay demand on or off).
    reconcileRelay: () => (relayServiceInstance ? relayServiceInstance.reconcile() : Promise.resolve()),
    removeClientPushDevices: clientPushAccess.removeDevicesOfClients,
    getPairingTransports: resolvePairingTransports,
    getDirectCandidateUrls: resolveDirectLanUrls,
    // Stable server identity for client-side verification of learned addresses.
    // Lazily resolved: the relay service is constructed after these routes.
    getServerId: () => (relayServiceInstance ? relayServiceInstance.getServerId() : Promise.resolve(null)),
    // The display name a paired device shows for THIS server. Devices name the
    // connection by the issuing machine's hostname, not the per-device pairing
    // label typed by the operator.
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
    __dirname,
    openchamberDataDir: OPENCHAMBER_DATA_DIR,
    modelsDevApiUrl: MODELS_DEV_API_URL,
    modelsMetadataCacheTtl: MODELS_METADATA_CACHE_TTL,
    fetchFreeZenModels,
    getCachedZenModels,
    setAutoAcceptSession,
    notificationCenter,
    agentToolRuntime,
    limitFailoverRuntime,
    desktopUpdater,
    onUpdateAvailable: (updateInfo) => recordCenterNotificationOnce({
      kind: 'update',
      priority: 'normal',
      delivery: 'delivered',
      title: `OpenChamber ${updateInfo.version} is available`,
      body: updateInfo.currentVersion ? `Installed: ${updateInfo.currentVersion}` : '',
      requestId: updateInfo.version,
      action: { type: 'openchamber-update', version: updateInfo.version },
    }),
    skipBodyParsing: (req) => FRONT_DOOR ? ['agent', 'space'].includes(classify(req)) : spacesHost?.skipsBodyParsing(req) === true,
  });
  uiAuthController = bootstrapResult.uiAuthController;
  // After the API auth gate, before every route that reads a directory, before the OpenCode proxy.
  // The slot is mounted once and reads the host at call time, so the switch can turn the feature
  // on and off live: with no host it passes every request on and no upgrade is taken.
  // An archived chat of a deleted space is read and deleted, never run or changed.
  app.use(spaceArchive.guard);
  app.use((req, res, next) => (spacesHost ? spacesHost.middleware(req, res, next) : next()));
  // First of all upgrade handlers: a socket addressed to a space by its directory carries a path
  // a host handler would take too, and the space's handler marks it as the space's before they run.
  server.prependListener('upgrade', (req, ...args) => {
    if (!FRONT_DOOR || classify(req) === 'space') spacesHost?.upgradeHandler(req, ...args);
  });
  const startSpacesHost = (host) => {
    host.prepareUpgrades({ uiAuthController, isRequestOriginAllowed });
    // Every space's events join the host's hub, and the host asks each space for its live status;
    // each space's queue changes and permission modes reach the browsers on the streams the host's own use.
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
  if (!AGENT_SERVER) registerSpaceRoutes(app, {
    getJourney: () => spacesHost?.journey ?? null,
    getPlaces: () => spacesHost?.places() ?? [],
    getDockerSetup: () => (spacesHost ? { placeId: spacesHost.localPlaceId, setup: spacesHost.dockerSetup } : null),
    readSwitch: spacesSwitch.readSwitch,
    setSwitch: spacesSwitch.setSwitch,
    setMachine: spacesSwitch.setMachine,
    getArchive: () => spaceArchive,
    getUiPasskeys: (req) => uiAuthController?.passkeyCredentials?.(req) ?? { rpID: null, passkeys: [] },
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

  const tunnelRuntimeContext = AGENT_SERVER ? createAgentTunnelContext() : tunnelWiringRuntime.initialize(app, port, Boolean(uiPassword?.trim()));
  const { tunnelService, startTunnelWithNormalizedRequest } = tunnelRuntimeContext;
  tunnelRuntimeContextHolder = tunnelRuntimeContext;

  // Private relay host service: config + management routes + host client
  // lifecycle. Loopback port comes from the same source the tunnel uses so
  // relay-tunneled requests hit the local Express app on 127.0.0.1.
  const relayService = AGENT_SERVER ? null : createRelayService({
    crypto,
    os,
    readSettingsFromDiskMigrated,
    writeSettingsToDisk,
    relayKeyStore,
    remoteClientAuthRuntime,
    getLocalPort: () => tunnelRuntimeContext.getActivePort(),
    // One relay host per machine: every instance sharing this data dir shares
    // the relay identity (serverId), so concurrent hosts evict each other at
    // the relay worker and devices land on a random local instance.
    hostLock: createRelayHostLock({
      lockFilePath: path.join(OPENCHAMBER_DATA_DIR, 'relay-host.lock'),
      fs,
      process,
    }),
    // Dev/debug instances share the data dir (and thus the relay identity) with
    // the production instance, so they must not host the relay on their own —
    // paired devices would land on them. OPENCHAMBER_RELAY_HOST=off disables
    // passive hosting explicitly (dev scripts set it); the Electron dev shell is
    // covered via OPENCHAMBER_ELECTRON_DEV. OPENCHAMBER_RELAY_HOST=on overrides
    // both. Explicit enable/pairing on the instance still hosts regardless.
    allowPassiveHost: process.env.OPENCHAMBER_RELAY_HOST === 'on'
      || (process.env.OPENCHAMBER_RELAY_HOST !== 'off' && process.env.OPENCHAMBER_ELECTRON_DEV !== '1'),
    // Relay demand = any paired device or pending pairing session that uses the
    // relay transport. Drives the auto on/off lifecycle.
    hasRelayDemand: async () => {
      // A store read failure must NOT masquerade as "no demand": reconcile
      // persists enabled=false and severs paired devices. Any affirmative
      // answer wins; otherwise a failed check aborts reconcile (throw) so the
      // relay keeps its current state until a trustworthy read succeeds.
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
  relayService?.registerRoutes(app);

  if (!FRONT_DOOR) registerBrowserControlRoutes(app, { express, broker: browserControlBroker });

  // One scanner backs both discovery and the tunnel allowlist, so a port the
  // user can see is exactly a port the tunnel will dial.
  const devServerScanner = createDevServerScanner({ spawn, platform: process.platform });
  const listDevServers = () => devServerScanner.discover({
    ownPorts: [port, openCodePort].filter((value) => Number.isInteger(value) && value > 0),
  });

  if (!FRONT_DOOR) createDevTunnelRuntime({
    server,
    discoverDevServers: listDevServers,
    uiAuthController,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
    logger: console,
  });

  if (!FRONT_DOOR) registerSessionProjectRoutes(app, {
    validateDirectoryPath,
    openCodeTrust,
    registerSessionProject: settingsRuntime.registerSessionProject,
    resolveSessionDirectory: async (sessionID) => (await openCodeSessionClient().session.get({ sessionID })).location.directory,
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
  if (FRONT_DOOR) registerFrontDoorFixLoopRoutes(app, { runtime: prFixLoopRuntime, services: agentFixLoopServices, upstream: agentUpstream,
    isSpaceSession: (id) => Boolean(spacesHost?.index.claimedBy(id)),
    readDefaults: async () => (await readSettingsFromDiskMigrated())?.prFixLoopDefaults ?? {},
    listProjectDirectories: async () => (await listConfiguredProjects()).map((project) => project.path) });
  await featureRoutesRuntime.registerRoutes(app, {
    frontDoor: FRONT_DOOR,
    agentServer: AGENT_SERVER,
    agentUpstream,
    frontDoorTrackedItems,
    protectedMcpMirror,
    environmentStore,
    environmentRuntime,
    listConfiguredProjects,
    messageSearchRuntime,
    sessionWarmingRuntime,
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
    isOpenCodeRunning: () => Boolean(openCodePort && isOpenCodeReady && !isRestartingOpenCode),
    isLocalMcpScopeSupported: () => !isExternalOpenCode && !ENV_SKIP_OPENCODE_START,
    onGuestDeactivated: async (event) => {
      guestSurfaceRuntime?.endForGuest(event.guestId);
      return browserControlRouter.handleGuestDeactivated(event);
    },
    onExtensionSessionEventsChanged: () => extensionSessionEvents.reconcile(),
    extensionNotificationChannels,
    surfaceViewerHeaders: (guestId, viewerId) => guestSurfaceRuntime?.viewerHeaders(guestId, viewerId) ?? null,
    isRequestOriginAllowed,
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
      // Windows cannot replace an executable that is running. npm then leaves
      // the package without opencode.exe, and the next start fails. The server
      // stops for the install and comes back on the new version.
      if (process.platform !== 'win32') return upgrade();
      return restartOpenCode('opencode-upgrade', { whileStopped: upgrade });
    },
    formatSettingsResponse,
    readSettingsFromDisk,
    readSettingsFromDiskMigrated,
    persistSettings,
    sanitizeProjects,
    sanitizeSkillCatalogs,
    isUnsafeSkillRelativePath,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    getOpenCodePort: () => openCodePort,
    // Dev-server discovery must not offer OpenChamber's own listeners back to
    // the user as something to preview.
    getOwnPorts: () => [port, openCodePort].filter((value) => Number.isInteger(value) && value > 0),
    getActivePort: () => {
      const address = server?.address?.();
      return address && Number.isInteger(address.port) ? address.port : null;
    },
    // A pipe listener reports a string here, which has no address to bind back to.
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
    suggestedTasksRuntime,
    botsServer: botChildServer ?? botsHost,
    mcpToolsRuntime,
    autoResumeRuntime,
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
    prStackRestackRuntime,
    prFixLoopRuntime,
    autoReviewRuntime,
    prWatchRuntime,
    routingRuntime,
    mergeFollowRuntime,
    workflowRuntime,
  });
  if (!FRONT_DOOR) registerDisplayMetadataRoute(app, { readSettings: readSettingsFromDiskMigrated, resolveGitBinaryForSpawn, resolvePrimaryWorktreeRoot, chatRoots: [OPENCHAMBER_CHATS_DIR] });
  registerAgentProtectedMcpRoutes(app, {
    agentServer: AGENT_SERVER,
    dataDir: OPENCHAMBER_DATA_DIR,
    listProjectDirectories: async () => (await listConfiguredProjects()).map((project) => project.path),
  });
  registerHostCredentialRoutes(app, {
    agentServer: AGENT_SERVER,
    credentialSource: openCodeCredentialSource({ buildOpenCodeUrl, getOpenCodeAuthHeaders }),
    listProjectDirectories: async () => sanitizeProjects((await readSettingsFromDiskMigrated())?.projects || []).map((project) => project.path),
  });
  if (FRONT_DOOR) void prFixLoopRuntime.start().catch(() => console.warn('[pr-fix-loop] persisted state could not be loaded; loops remain disabled'));

  // After bootstrap: the upgrade gate needs the real UI auth controller.
  guestSurfaceRuntime = FRONT_DOOR ? null : createGuestSurfaceRuntime({
    server,
    uiAuthController,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
    persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR),
    findGuest: (id) => findInstalledGuest(id, extensionsPersistPath(OPENCHAMBER_DATA_DIR)),
    idleStopMs: BROWSER_PROVIDER_IDLE_MS,
  });

  const startupPipelineResult = await startupPipelineRuntime.run({
    frontDoor: FRONT_DOOR,
    fetchImpl: FRONT_DOOR ? agentUpstream.fetch : fetch,
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
    // Git's credential helper reaches the server through a file that names
    // the port, so it is written once the port is known and before OpenCode,
    // whose shells will use it, starts.
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
    startupTunnelRequest: AGENT_SERVER ? null : startupTunnelRequest,
    onTunnelReady,
    tunnelRuntimeContext,
    attachSignals,
    apiOnly,
    dictationModelsDir: path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'speech-models'),
  });
  terminalRuntime = startupPipelineResult.terminalRuntime;
  dictationRuntime = startupPipelineResult.dictationRuntime;
  messageStreamRuntime = startupPipelineResult.messageStreamRuntime;

  // Only opens a relay control socket when the user opted in (config enabled).
  // Reconcile the relay lifecycle from demand on startup: run it if any relay
  // device/session exists, stop it (and clear a stale enabled flag) otherwise.
  void relayService?.reconcile();

  // Relay demand can change outside our routes: `openchamber connect-url
  // --relay` writes a pending relay session straight to the on-disk store, and
  // pending sessions expire without any request hitting us. Poll reconcile so a
  // headless instance picks the relay up (or drops it) within a minute.
  relayReconcileTimer = AGENT_SERVER ? null : setInterval(() => {
    void relayService.reconcile();
  }, 60_000);
  relayReconcileTimer?.unref?.();

  // The server inside an isolated space stops itself after the user's idle hours, and the space's
  // container with it (decision 11). Only a space's environment names the setting's
  // file, so this never runs anywhere else. The exit code tells the host why it stopped.
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
      scheduledTasks: scheduledTasksRuntime?.getStatus() ?? { running: false },
    }),
    isReady: () => isOpenCodeReady,
    getManagedOpenCodePreflight: () => openCodeLifecycleRuntime.getManagedOpenCodePreflight(),
    restartOpenCode: () => restartOpenCode(),
    getOpenCodeProcessInfo: () => {
      const managed = Boolean(!FRONT_DOOR && (openCodeProcess || openCodePort) && !ENV_SKIP_OPENCODE_START && !isExternalOpenCode);
      // Only ever expose pid/port for a server WE manage. The Electron-side
      // killer kills by port (lsof + kill -KILL), so returning a port we don't
      // own — e.g. an external/desktop OpenCode on 4096 we attached to — would
      // let a single miscomputed `managed` flag take down the user's separate
      // server. Structurally withhold what isn't ours so the killer has no
      // target, instead of relying on the flag check alone.
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
  currentFilename: __filename,
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
