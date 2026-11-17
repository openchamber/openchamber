import { opencodeClient, type OpencodeHealthProbe, OpencodeApiError } from '@/lib/opencode/client';
import { type ConfigSlice } from './types';
import { captureConfigRuntimeContext, isConfigRuntimeContextCurrent, configRuntime } from './runtime';
import { markStartupTrace, measureStartupTrace } from '@/lib/startupTrace';
import { streamDebugEnabled } from '@/stores/utils/streamDebug';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { fromDirectoryKey, normalizeConfigPath as resolveConfigDirectory, toDirectoryKey } from './directories';
import { resolveProjectDirectory } from './worktreeProjects';
import { isChatDraftOpen, getFallbackProjectDirectory } from './projectDefaults';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resolveChatsRootDirectory } from '@/lib/chatDirectories';
import { hydrateConfigCatalogFromCache } from './catalogHydration';
import { _agentsLoadErrors } from './projectErrors';
import { isOpenCodeTrustPending } from '@/lib/opencodeTrust';
import { isLocationNotFoundError } from '@/lib/opencode/location-errors';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CONNECTION_PROBE_TIMEOUT_MS = 800;
const CONNECTION_HEALTH_WAIT_MS = 3_000;

const probeOpenCodeHealth = async (timeoutMs = CONNECTION_PROBE_TIMEOUT_MS): Promise<boolean> => {
    return Promise.race([
        opencodeClient.checkHealth().catch(() => false),
        sleep(Math.max(1, timeoutMs)).then(() => false),
    ]);
};

let _initializeAppInFlight: Promise<void> | null = null;

export const createConfigConnection: ConfigSlice<'probeConnection' | 'checkConnection' | 'initializeApp'> = (set, get) => ({
    probeConnection: async (options?: { timeoutMs?: number }) => {
        const isHealthy = await probeOpenCodeHealth(options?.timeoutMs);
        if (isHealthy) {
            set({ isConnected: true, hasEverConnected: true, connectionPhase: "connected" });
            return true;
        }

        const state = get();
        if (state.isConnected) {
            return true;
        }

        set({
            isConnected: false,
            connectionPhase: state.hasEverConnected ? "reconnecting" : "connecting",
            lastDisconnectReason: 'health_probe_unhealthy',
        });
        return false;
    },

    checkConnection: async () => {
        const runtimeContext = captureConfigRuntimeContext();
        markStartupTrace('checkConnection:start');
        const maxAttempts = 5;
        let attempt = 0;
        let lastError: unknown = null;
        let lastProbe: OpencodeHealthProbe = 'unreachable';

        while (attempt < maxAttempts) {
            if (!isConfigRuntimeContextCurrent(runtimeContext)) return false;
            try {
                markStartupTrace('checkConnection:attempt', { attempt: attempt + 1 });
                const probeStarted = Date.now();
                lastProbe = await measureStartupTrace(
                    'checkConnection:health',
                    () => opencodeClient.probeHealth({ waitMs: CONNECTION_HEALTH_WAIT_MS }),
                    { attempt: attempt + 1 },
                );
                const isHealthy = lastProbe === 'healthy';
                if (!isConfigRuntimeContextCurrent(runtimeContext)) return false;
                if (!isHealthy && attempt < maxAttempts - 1) {
                    const hasEverConnected = get().hasEverConnected;
                    set({
                        isConnected: false,
                        connectionPhase: hasEverConnected ? "reconnecting" : "connecting",
                        lastDisconnectReason: 'health_check_unhealthy',
                    });
                    attempt += 1;
                    await sleep(Math.max(0, 400 * attempt - (Date.now() - probeStarted)));
                    continue;
                }

                const hasEverConnected = get().hasEverConnected;
                set(isHealthy
                    ? { isConnected: true, hasEverConnected: true, connectionPhase: "connected" }
                    : {
                        isConnected: false,
                        connectionPhase: hasEverConnected ? "reconnecting" : "connecting",
                        lastDisconnectReason: lastProbe === 'unreachable' ? 'health_check_failed' : 'health_check_unhealthy',
                    });
                markStartupTrace('checkConnection:end', { healthy: isHealthy, attempts: attempt + 1 });
                return isHealthy;
            } catch (error) {
                lastError = error;
                attempt += 1;
                const delay = 400 * attempt;
                await sleep(delay);
            }
        }

        if (!isConfigRuntimeContextCurrent(runtimeContext)) return false;
        if (lastError) {
            console.warn("[ConfigStore] Failed to reach OpenCode after retrying:", lastError);
        }
        set({
            isConnected: false,
            connectionPhase: get().hasEverConnected ? "reconnecting" : "connecting",
            lastDisconnectReason: 'health_check_failed',
        });
        markStartupTrace('checkConnection:end', { healthy: false, attempts: maxAttempts });
        return false;
    },

    initializeApp: async () => {
        if (_initializeAppInFlight) {
            markStartupTrace('initializeApp:deduped');
            return _initializeAppInFlight;
        }

        const runtimeContext = captureConfigRuntimeContext();
        const instanceGeneration = configRuntime.instanceGeneration;
        const run = (async () => {
            const initStarted = typeof performance !== 'undefined' ? performance.now() : Date.now();
            markStartupTrace('initializeApp:start');
            try {
                const debug = streamDebugEnabled();
                if (debug) console.log("Starting app initialization...");

                void get().loadSessionDefaults();
                const isConnected = await get().checkConnection();
                if (!isConfigRuntimeContextCurrent(runtimeContext)) return;
                if (debug) console.log("Connection check result:", isConnected);

                if (!isConnected) {
                    if (debug) console.log("Server not connected");
                    set({
                        isConnected: false,
                        connectionPhase: get().hasEverConnected ? "reconnecting" : "connecting",
                        lastInitFailure: {
                            step: get().lastDisconnectReason === 'health_check_unhealthy' ? 'openCodeUnavailable' : 'serverUnreachable',
                            message: null,
                        },
                    });
                    return;
                }

                if (debug) console.log("Initializing app...");
                markStartupTrace('initApp:skipped', { reason: 'checkConnection already verified health' });


                const initialDirectory = opencodeClient.getDirectory()
                    ?? useDirectoryStore.getState().currentDirectory
                    ?? fromDirectoryKey(get().activeDirectoryKey);
                const resolvedProject = isSpaceDirectory(initialDirectory) ? null : resolveProjectForSessionDirectory(
                    useProjectsStore.getState().projects,
                    useSessionUIStore.getState().availableWorktreesByProject,
                    initialDirectory ?? null,
                );
                const resolvedInitialDirectory = (resolvedProject || resolveProjectDirectory(initialDirectory))
                    ? resolveConfigDirectory(initialDirectory)
                    : null;
                const chatsRoot = isChatDraftOpen() ? await resolveChatsRootDirectory().catch(() => null) : null;
                if (!isConfigRuntimeContextCurrent(runtimeContext)) return;
                const chatDraftDirectory = isChatDraftOpen() ? resolveConfigDirectory(chatsRoot) : null;
                const sessionState = useSessionUIStore.getState();
                const openSessionDirectory = sessionState.currentSessionId
                    ? resolveConfigDirectory(sessionState.currentSessionDirectory)
                    : null;
                const configDirectory = openSessionDirectory ?? chatDraftDirectory ?? resolvedInitialDirectory ?? getFallbackProjectDirectory();
                if (!configDirectory) {
                    markStartupTrace('initializeApp:noProjectConfigDirectory');
                    set({ isInitialized: true, isConnected: true, hasEverConnected: true, connectionPhase: "connected", lastInitFailure: null });
                    return;
                }
                if (!openSessionDirectory && !chatDraftDirectory && !resolvedInitialDirectory && initialDirectory !== configDirectory) {
                    markStartupTrace('initializeApp:normalizedUnknownDirectoryToProject', {
                        initialDirectory,
                        configDirectory,
                    });
                    opencodeClient.setDirectory(configDirectory);
                    useDirectoryStore.getState().setDirectory(configDirectory, { showOverlay: false });
                }
                const configDirectoryKey = toDirectoryKey(configDirectory);
                if (get().activeDirectoryKey !== configDirectoryKey) {
                    set({ activeDirectoryKey: configDirectoryKey });
                    void hydrateConfigCatalogFromCache(configDirectoryKey);
                }

                if (debug) console.log("Loading providers and agents...");
                const [, agentsLoaded] = await Promise.all([
                    get().loadProviders({ directory: configDirectory, source: 'initializeApp' }),
                    get().loadAgents({ directory: configDirectory, source: 'initializeApp' }),
                ]);

                if (!isConfigRuntimeContextCurrent(runtimeContext)) return;
                if (!agentsLoaded) {
                    const configError = get().projectConfigErrors[configDirectoryKey];
                    const agentsError = _agentsLoadErrors.get(configDirectoryKey);
                    const awaitsTrust = !configError && agentsError instanceof OpencodeApiError && agentsError.status === 403
                        && await isOpenCodeTrustPending(configDirectory);
                    if (!isConfigRuntimeContextCurrent(runtimeContext)) return;
                    if (configError) {
                        markStartupTrace('initializeApp:projectConfigInvalid', { configDirectoryKey, name: configError.name });
                    } else if (awaitsTrust) {
                        markStartupTrace('initializeApp:projectAwaitsTrust', { configDirectoryKey });
                    } else if (isLocationNotFoundError(agentsError)
                        || await opencodeClient.getDirectoryAvailability(configDirectory) === 'missing') {
                        if (!isConfigRuntimeContextCurrent(runtimeContext)) return;
                        markStartupTrace('initializeApp:projectDirectoryMissing', { configDirectoryKey });
                    } else {
                        set({ lastInitFailure: { step: 'loadAgents', message: _agentsLoadErrors.get(configDirectoryKey)?.message || null } });
                        return;
                    }
                }
                set({ isInitialized: true, isConnected: true, hasEverConnected: true, connectionPhase: "connected", lastInitFailure: null });
                setTimeout(() => {
                    if (instanceGeneration !== configRuntime.instanceGeneration) return;
                    void get().loadAgents({ directory: configDirectory, source: 'startupAgentRecheck' });
                }, 8_000);
                const initEnded = typeof performance !== 'undefined' ? performance.now() : Date.now();
                markStartupTrace('initializeApp:end', {
                    durationMs: Math.round(initEnded - initStarted),
                    providers: get().providers.length,
                    agents: get().agents.length,
                });
                if (debug) console.log("App initialized successfully");
            } catch (error) {
                if (!isConfigRuntimeContextCurrent(runtimeContext)) return;
                console.error("Failed to initialize app:", error);
                set({
                    isInitialized: false,
                    isConnected: false,
                    connectionPhase: get().hasEverConnected ? "reconnecting" : "connecting",
                    lastDisconnectReason: 'init_error',
                    lastInitFailure: { step: 'unexpected', message: (error instanceof Error ? error.message : String(error)) || null },
                });
                markStartupTrace('initializeApp:error', { error: error instanceof Error ? error.message : String(error) });
            }
        })().finally(() => {
            if (_initializeAppInFlight === run) _initializeAppInFlight = null;
        });

        _initializeAppInFlight = run;
        return run;
    },
});

export const resetConfigInitialization = (): void => { _initializeAppInFlight = null; };
