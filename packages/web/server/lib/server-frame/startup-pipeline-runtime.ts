import { recordStartupPerformance } from '../diagnostics/startup-performance.js';
import type { DictationRuntimeDependencies, createDictationRuntime } from '../dictation/runtime.js';
import type { MessageStreamWsRuntimeOptions, createMessageStreamWsRuntime } from '../event-stream/runtime.js';
import type { createOpenCodeEnvRuntime } from '../opencode/env-runtime.js';
import type { createTerminalRuntime } from '../terminal/runtime.js';
import type { createEnvironmentRuntime } from '../environment/runtime.js';
import type { createServerStartupRuntime, ListenOptions, ServerStartupDependencies } from './server-startup-runtime.js';
import type { createStaticRoutesRuntime } from './static-routes-runtime.js';

type TerminalOptions =
  & Required<Pick<DictationRuntimeDependencies, 'app' | 'express' | 'uiAuthController' | 'isRequestOriginAllowed'>>
  & Pick<MessageStreamWsRuntimeOptions, 'rejectWebSocketUpgrade'>
  & Pick<ReturnType<typeof createOpenCodeEnvRuntime>, 'searchPathFor' | 'isExecutable'>
  & {
    server: ServerStartupDependencies['server'];
    tunnelAuthController: ServerStartupDependencies['tunnelAuthController'];
    fs: typeof import('node:fs');
    path: typeof import('node:path');
    buildAugmentedPath: () => string;
    TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: number;
    TERMINAL_INPUT_WS_REBIND_WINDOW_MS: number;
    TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW: number;
    environmentRuntime: ReturnType<typeof createEnvironmentRuntime> | null;
    broadcastUiEvent: (event: { type: string; properties: object }) => void;
  };

interface StartupPipelineDependencies {
  createTerminalRuntime: (options: TerminalOptions) => ReturnType<typeof createTerminalRuntime>;
  createDictationRuntime: typeof createDictationRuntime;
  createMessageStreamWsRuntime: typeof createMessageStreamWsRuntime;
  createServerStartupRuntime: typeof createServerStartupRuntime;
}

type PipelineOptions =
  & ServerStartupDependencies
  & Pick<ListenOptions, 'port' | 'startupTunnelRequest' | 'onTunnelReady'>
  & Pick<TerminalOptions, 'fs' | 'path' | 'buildAugmentedPath' | 'searchPathFor' | 'isExecutable' | 'broadcastUiEvent'>
  & Pick<TerminalOptions, 'app' | 'express' | 'uiAuthController' | 'isRequestOriginAllowed' | 'rejectWebSocketUpgrade'>
  & Required<Pick<MessageStreamWsRuntimeOptions, 'buildOpenCodeUrl' | 'getOpenCodeAuthHeaders' | 'globalEventHub' |
    'processForwardedEventPayload' | 'triggerHealthCheck' | 'upstreamStallTimeoutMs'>>
  & {
    host: string | undefined;
    messageStreamWsClients: MessageStreamWsRuntimeOptions['wsClients'];
    terminalHeartbeatIntervalMs: number;
    terminalRebindWindowMs: number;
    terminalMaxRebindsPerWindow: number;
    environmentRuntime?: TerminalOptions['environmentRuntime'];
    setupProxy: (app: TerminalOptions['app']) => void;
    scheduleOpenCodeApiDetection: () => void;
    bootstrapOpenCodeAtStartup: () => Promise<void>;
    onListenerReady?: (() => Promise<void>) | null;
    staticRoutesRuntime: ReturnType<typeof createStaticRoutesRuntime>;
    tunnelRuntimeContext: { setActivePort: (port: number) => void };
    attachSignals: boolean;
    apiOnly: boolean;
    dictationModelsDir: string;
  };

export const createStartupPipelineRuntime = (dependencies: StartupPipelineDependencies) => {
  const {
    createTerminalRuntime,
    createDictationRuntime,
    createMessageStreamWsRuntime,
    createServerStartupRuntime,
  } = dependencies;

  const run = async (options: PipelineOptions) => {
    const pipelineStartedAt = performance.now();
    recordStartupPerformance('web.pipeline.start');
    const {
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
      globalEventHub,
      processForwardedEventPayload,
      messageStreamWsClients,
      triggerHealthCheck,
      upstreamStallTimeoutMs,
      terminalHeartbeatIntervalMs,
      terminalRebindWindowMs,
      terminalMaxRebindsPerWindow,
      environmentRuntime = null,
      broadcastUiEvent,
      setupProxy,
      scheduleOpenCodeApiDetection,
      bootstrapOpenCodeAtStartup,
      onListenerReady = null,
      staticRoutesRuntime,
      process,
      crypto,
      normalizeTunnelBootstrapTtlMs,
      readSettingsFromDiskMigrated,
      tunnelAuthController,
      startTunnelWithNormalizedRequest,
      gracefulShutdown,
      getSignalsAttached,
      setSignalsAttached,
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
      dictationModelsDir,
    } = options;

    const terminalRuntime = createTerminalRuntime({
      app,
      server,
      express,
      fs,
      path,
      uiAuthController,
      tunnelAuthController,
      buildAugmentedPath,
      searchPathFor,
      isExecutable,
      isRequestOriginAllowed,
      rejectWebSocketUpgrade,
      TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: terminalHeartbeatIntervalMs,
      TERMINAL_INPUT_WS_REBIND_WINDOW_MS: terminalRebindWindowMs,
      TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW: terminalMaxRebindsPerWindow,
      environmentRuntime,
      broadcastUiEvent,
    });

    const dictationRuntime = createDictationRuntime({
      app,
      server,
      express,
      uiAuthController,
      isRequestOriginAllowed,
      rejectWebSocketUpgrade,
      modelsDir: dictationModelsDir,
    });

    const messageStreamRuntime = createMessageStreamWsRuntime({
      server,
      uiAuthController,
      isRequestOriginAllowed,
      rejectWebSocketUpgrade,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      globalEventHub,
      processForwardedEventPayload,
      wsClients: messageStreamWsClients,
      triggerHealthCheck,
      upstreamStallTimeoutMs,
    });

    setupProxy(app);

    if (apiOnly) {
      staticRoutesRuntime.registerApiOnlyFallbackRoutes(app);
    } else {
      staticRoutesRuntime.registerStaticRoutes(app);
    }

    const serverStartupRuntime = createServerStartupRuntime({
      process,
      crypto,
      server,
      normalizeTunnelBootstrapTtlMs,
      readSettingsFromDiskMigrated,
      tunnelAuthController,
      startTunnelWithNormalizedRequest,
      gracefulShutdown,
      getSignalsAttached,
      setSignalsAttached,
      syncToHmrState,
      TUNNEL_MODE_QUICK,
      TUNNEL_MODE_MANAGED_LOCAL,
      TUNNEL_MODE_MANAGED_REMOTE,
    });

    const bindHost = serverStartupRuntime.resolveBindHost(host);
    const startupResult = await serverStartupRuntime.startListeningAndMaybeTunnel({
      port,
      bindHost,
      startupTunnelRequest,
      onTunnelReady,
    });
    recordStartupPerformance('web.listener.ready', {
      durationMs: performance.now() - pipelineStartedAt,
    });
    tunnelRuntimeContext.setActivePort(startupResult.activePort);
    if (onListenerReady) await onListenerReady();
    scheduleOpenCodeApiDetection();
    void bootstrapOpenCodeAtStartup();

    serverStartupRuntime.attachProcessHandlers({ attachSignals });

    return {
      terminalRuntime,
      dictationRuntime,
      messageStreamRuntime,
    };
  };

  return {
    run,
  };
};
