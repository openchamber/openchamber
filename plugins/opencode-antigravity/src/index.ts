// Plugin entry (architecture 1.1; IA 10.1, 11.1, 16; SR 8.3, 8.4). Each `setup(ctx)` runs once per
// OpenCode location. It resolves both configs, takes a lease on the process-wide pool for its profile
// (proxy, session store, bridge), registers the provider, the integration and the `model.request`
// hook, attaches its location to the auth manager, and runs the session and credential event loops.
// The pool outlives a plugin reload: the last cleanup waits `RELOAD_GRACE_MS`, then awaits the proxy's
// async stop, and a setup arriving meanwhile waits for that stop before it builds a fresh pool.

import { randomBytes } from "node:crypto";
import {
  createInstallAuthBridge,
  getAuthManager,
  runCredentialEvents,
  type AuthManager,
  type IntegrationDomainLike,
} from "./auth/manager.ts";
import { AUTH_METHODS, supportedMethods, type IntegrationEditorLike } from "./auth/methods.ts";
import { ensureProfileDirs } from "./auth/settings.ts";
import { resolveRuntimeConfig, type RuntimeConfig } from "./config.ts";
import {
  AGENT_NAME,
  DISCOVERY_INTERVAL_MS,
  HEADER_DIRECTORY,
  HEADER_KIND,
  HEADER_META,
  HEADER_PROXY_TOKEN,
  HEADER_SESSION,
  INTEGRATION_ID,
  MCP_SERVER_NAME,
  PLUGIN_ID,
  POOL_GLOBAL_KEY,
  PROVIDER_ID,
  PROVIDER_NAME,
  PRUNE_FIRST_DELAY_MS,
  PRUNE_INTERVAL_MS,
  RELOAD_GRACE_MS,
} from "./constants.ts";
import type { InstallAuthBridge, SessionStoreApi, ToolGuardOutcome } from "./contracts.ts";
import { runEventLoop, type OpenCodeEventLike } from "./events.ts";
import { classifyRequest, emittedHashes } from "./fingerprint.ts";
import { getBinaryManager, type BinaryManager } from "./install/binary-manager.ts";
import { LOG_PREFIX, logIssues, resolveInstallAuthConfig, singletonKey, type InstallAuthConfig } from "./install/config.ts";
import { agyBaseArgs } from "./install/env.ts";
import { getField } from "./install/fs-utils.ts";
import { toOpenCodeModelInfo } from "./models.ts";
import { createProfileApi } from "./profile.ts";
import { buildSessionAppend, buildTurnPrompt } from "./prompt.ts";
import { AntigravityProxy, type AntigravityProxyOptions } from "./proxy.ts";
import { buildReplayPrompt } from "./replay.ts";
import { MemorySessionStore, SessionStore } from "./session-store.ts";

// ---------------------------------------------------------------------------
// OpenCode 2.3.0 plugin context, as far as this plugin uses it. Structural copies of
// `@opencode/plugin` `promise/*.d.ts`, so the plugin has no type dependency on OpenCode.
// ---------------------------------------------------------------------------

/** `SessionModelRequest`: the `model.request` hook input. `baseURL` and `headers` are writable. */
export interface ModelRequestInput {
  readonly sessionID: string;
  readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string };
  readonly kind: string;
  baseURL?: string;
  headers: Record<string, string>;
}

/** `Provider.Info` fields this plugin sets. */
export interface ProviderInfoInput {
  id: string;
  integrationID: string;
  name: string;
  activation: "auto" | "enabled" | "disabled";
  package: string;
  settings: { baseURL: string };
}

export type OpenCodeModelInfo = ReturnType<typeof toOpenCodeModelInfo>;

export interface ProviderEditorLike {
  add(input: { info: ProviderInfoInput; models: readonly OpenCodeModelInfo[] }): void;
}

export interface PluginContextLike {
  readonly location: { readonly directory: string };
  readonly options?: unknown;
  readonly provider: {
    transform(callback: (editor: ProviderEditorLike) => void): Promise<unknown>;
    reload(): Promise<void>;
  };
  readonly integration: IntegrationDomainLike & {
    transform(callback: (editor: IntegrationEditorLike) => void): Promise<unknown>;
  };
  readonly session: {
    hook(
      name: "model.request",
      callback: (input: ModelRequestInput) => Promise<void> | void,
      options?: { providerID?: string },
    ): Promise<unknown>;
  };
  readonly event: {
    subscribe(options: { types: string[]; signal: AbortSignal }): AsyncIterable<OpenCodeEventLike>;
  };
}

export type Cleanup = () => Promise<void>;

export interface AntigravityPlugin {
  readonly id: string;
  setup(ctx: PluginContextLike): Promise<Cleanup>;
}

// ---------------------------------------------------------------------------
// Shared pools (SR 8.4)
// ---------------------------------------------------------------------------

const POOL_BRAND = "opencode-antigravity.pools.v3";

interface PoolEntry {
  refs: number;
  state: "starting" | "ready" | "stopping";
  /** The configuration the value was built with; see `SharedPoolOptions.fingerprint`. */
  fingerprint: string;
  /** The "first configuration wins" line was logged for this entry. */
  mismatchLogged: boolean;
  /** Resolves with the started value; rejects when creation failed (the entry is gone by then). */
  ready: Promise<unknown>;
  /** Set once `ready` resolved. */
  value: unknown;
  /** Set while `state` is `stopping`; settles when the stop did. */
  stopped: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface PoolRegistry {
  brand: typeof POOL_BRAND;
  entries: Map<string, PoolEntry>;
  /** Config issue lines already logged in this process. */
  loggedIssues: Set<string>;
}

function isPoolRegistry(value: unknown): value is PoolRegistry {
  return getField(value, "brand") === POOL_BRAND && getField(value, "entries") instanceof Map && getField(value, "loggedIssues") instanceof Set;
}

/** On `globalThis`, so a reloaded copy of this module finds the pools of the old copy. */
function poolRegistry(): PoolRegistry {
  const existing: unknown = Reflect.get(globalThis, POOL_GLOBAL_KEY);
  if (isPoolRegistry(existing)) return existing;
  const created: PoolRegistry = { brand: POOL_BRAND, entries: new Map(), loggedIssues: new Set() };
  Reflect.set(globalThis, POOL_GLOBAL_KEY, created);
  return created;
}

/** Pools alive in this process, starting, ready or stopping. For tests and diagnostics. */
export function activePoolCount(): number {
  return poolRegistry().entries.size;
}

export interface SharedLease<T> {
  readonly value: T;
  /** Drops the ref; the last release stops the value after the grace period. Idempotent. */
  release(): void;
}

export interface SharedPoolOptions<T> {
  create: () => Promise<T>;
  stop: (value: T) => Promise<void>;
  /** Accepts a value made by another copy of this module (a reload); a mismatch makes a new one. */
  isValue: (value: unknown) => value is T;
  graceMs: number;
  /**
   * The configuration `create` would use. An idle entry (no lease, waiting out the grace period) with
   * another fingerprint is stopped and rebuilt, so a reload with changed options takes effect. An entry
   * a live lease holds is shared as it is: one value per key, and `onMismatch` runs once for it.
   */
  fingerprint: string;
  onMismatch?: () => void;
}

/** Moves the entry to `stopping` and removes it from the registry once the stop settled. */
function beginStop<T>(registry: PoolRegistry, key: string, entry: PoolEntry, value: T, opts: SharedPoolOptions<T>): void {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  entry.state = "stopping";
  entry.stopped = opts
    .stop(value)
    .catch(() => {})
    .finally(() => {
      if (registry.entries.get(key) === entry) registry.entries.delete(key);
    });
}

/**
 * One value per key per process, ref-counted. A key whose stop is running is awaited first, so two
 * proxies never run against one profile. Creation runs once for concurrent callers; a failed creation
 * removes the entry and rejects every waiter.
 */
export async function acquireShared<T>(key: string, opts: SharedPoolOptions<T>): Promise<SharedLease<T>> {
  const registry = poolRegistry();
  for (;;) {
    const entry = registry.entries.get(key);
    if (entry?.state === "stopping") {
      await entry.stopped;
      continue;
    }
    if (entry && entry.fingerprint !== opts.fingerprint) {
      if (entry.state === "ready" && entry.refs === 0 && opts.isValue(entry.value)) {
        beginStop(registry, key, entry, entry.value, opts);
        continue;
      }
      if (!entry.mismatchLogged) {
        entry.mismatchLogged = true;
        opts.onMismatch?.();
      }
    }
    if (entry) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      entry.refs += 1;
      let value: unknown;
      try {
        value = await entry.ready;
      } catch (err) {
        entry.refs -= 1;
        throw err;
      }
      if (!opts.isValue(value)) {
        entry.refs -= 1;
        throw new Error("The Antigravity pool was created by an incompatible plugin version.");
      }
      return leaseFor(registry, key, entry, value, opts);
    }
    const created: PoolEntry = {
      refs: 1,
      state: "starting",
      fingerprint: opts.fingerprint,
      mismatchLogged: false,
      ready: opts.create(),
      value: null,
      stopped: null,
      timer: null,
    };
    registry.entries.set(key, created);
    let value: unknown;
    try {
      value = await created.ready;
    } catch (err) {
      if (registry.entries.get(key) === created) registry.entries.delete(key);
      throw err;
    }
    created.value = value;
    created.state = "ready";
    if (!opts.isValue(value)) throw new Error("The Antigravity pool did not start.");
    return leaseFor(registry, key, created, value, opts);
  }
}

function leaseFor<T>(registry: PoolRegistry, key: string, entry: PoolEntry, value: T, opts: SharedPoolOptions<T>): SharedLease<T> {
  let released = false;
  return {
    value,
    release: () => {
      if (released) return;
      released = true;
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.refs > 0 || entry.timer || entry.state === "stopping") return;
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (entry.refs > 0 || registry.entries.get(key) !== entry) return;
        beginStop(registry, key, entry, value, opts);
      }, opts.graceMs);
      entry.timer.unref?.();
    },
  };
}

// ---------------------------------------------------------------------------
// The pool: one proxy, store and bridge per profile config
// ---------------------------------------------------------------------------

const POOL_VALUE_BRAND = "opencode-antigravity.pool-value.v2";

interface Pool {
  readonly brand: typeof POOL_VALUE_BRAND;
  readonly proxy: AntigravityProxy;
  readonly store: SessionStoreApi;
  readonly auth: AuthManager;
  readonly binary: BinaryManager;
  readonly bridge: InstallAuthBridge;
  /** `ctx.provider.reload` of every live setup, called when discovery changed the catalog. */
  readonly reloaders: Set<() => Promise<void>>;
  lastDiscoveryAt: number;
  stop(): Promise<void>;
}

function isPool(value: unknown): value is Pool {
  return getField(value, "brand") === POOL_VALUE_BRAND;
}

/** Test seams. Production uses the defaults. */
export interface PluginDeps {
  env?: NodeJS.ProcessEnv;
  /** Lines that always print (config issues, guard warnings). Default stderr. */
  log?: (line: string) => void;
  /** Default `RELOAD_GRACE_MS`. */
  reloadGraceMs?: number;
  /** Extra proxy options, such as a private `runRoot` or `discoverAfterSpawn: false`. */
  proxy?: Partial<Pick<AntigravityProxyOptions, "runRoot" | "discoverAfterSpawn" | "spawner" | "clock">>;
  /** Called with each pool right after it started. */
  onPoolStarted?: (pool: { proxy: AntigravityProxy; store: SessionStoreApi; bridge: InstallAuthBridge }) => void;
}

const GUARD_WARNINGS: Partial<Record<ToolGuardOutcome, string>> = {
  "skipped-foreign-profile": "The tool guard hook is off because geminiDir is not a profile this plugin created. OpenCode's permission checks still apply.",
  "skipped-probe-failed": "The tool guard hook is off because its runtime check failed. OpenCode's permission checks still apply.",
};

interface PoolInput {
  install: InstallAuthConfig;
  runtime: RuntimeConfig;
  configIssue: string | null;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  deps: PluginDeps;
}

async function createPool(input: PoolInput): Promise<Pool> {
  const { install, runtime, env, log } = input;
  const debug = runtime.debug ? (line: string): void => log(`${LOG_PREFIX} ${line}`) : undefined;
  const binary = getBinaryManager(install, { env, log, debug });
  const auth = getAuthManager(install, { env, log, debug, binary });
  const bridge = createInstallAuthBridge(binary, auth, { env });
  const store: SessionStoreApi = runtime.sessionStore
    ? new SessionStore({
        dataDir: install.dataDir,
        geminiDir: install.geminiDir,
        poolId: randomBytes(8).toString("hex"),
        authEpoch: () => bridge.authEpoch(),
        isPluginOwnedProfile: () => bridge.isPluginOwnedProfile(),
        sessionTtlDays: runtime.sessionTtlDays,
        maxStoredSessions: runtime.maxStoredSessions,
      })
    : new MemorySessionStore();
  const reloaders = new Set<() => Promise<void>>();
  const proxy = new AntigravityProxy({
    classify: classifyRequest,
    store,
    buildAppend: (i) => buildSessionAppend(i, MCP_SERVER_NAME),
    buildReplay: buildReplayPrompt,
    buildTurnPrompt,
    hashes: emittedHashes,
    profile: createProfileApi({ agentName: AGENT_NAME, mcpServerName: MCP_SERVER_NAME }),
    bridge,
    config: runtime,
    dataDir: install.dataDir,
    baseArgs: agyBaseArgs,
    configIssue: input.configIssue,
    authStatus: () => auth.state.kind,
    onModelsChanged: () => {
      for (const reload of [...reloaders]) void reload().catch(() => {});
    },
    log: (line) => log(line),
    ...input.deps.proxy,
  });
  // The profile dirs and marker first: `proxy.start` installs the guard only in a plugin-owned profile,
  // and on the very first start nothing has created the gemini dir yet (IA 4, SR 7.4).
  try {
    await ensureProfileDirs(install.dataDir, install.geminiDir, { defaultGeminiDir: install.defaultGeminiDir });
    await proxy.start();
  } catch (err) {
    // The proxy already subscribed to binary changes and may have written its owner file: undo both,
    // so a retried setup does not pile them up.
    await proxy.stop().catch(() => {});
    throw err;
  }
  auth.attachRuntime(proxy.runtimeControl, proxy.createRunDir);
  const warning = proxy.guardOutcome ? GUARD_WARNINGS[proxy.guardOutcome] : undefined;
  if (warning) log(`${LOG_PREFIX} ${warning}`);
  binary.startBackground();
  auth.scheduleSetupProbe();

  // SR 4.8: prune 30 s after start, then every 6 h. `prune()` never throws.
  let pruneInterval: ReturnType<typeof setInterval> | null = null;
  const pruneFirst = setTimeout(() => {
    void store.prune();
    pruneInterval = setInterval(() => void store.prune(), PRUNE_INTERVAL_MS);
    pruneInterval.unref?.();
  }, PRUNE_FIRST_DELAY_MS);
  pruneFirst.unref?.();

  const pool: Pool = {
    brand: POOL_VALUE_BRAND,
    proxy,
    store,
    auth,
    binary,
    bridge,
    reloaders,
    lastDiscoveryAt: 0,
    stop: async () => {
      clearTimeout(pruneFirst);
      if (pruneInterval) clearInterval(pruneInterval);
      reloaders.clear();
      auth.dispose();
      // Stops agy (up to 8 s), closes the listener, releases the store's locks and the owner file.
      await proxy.stop();
    },
  };
  input.deps.onPoolStarted?.({ proxy, store, bridge });
  return pool;
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

export const SHARED_CONFIG_MESSAGE = `${LOG_PREFIX} Another OpenCode location uses this Antigravity profile with other options; the running pool keeps the options it started with until every location using it closes.`;

function metaHeader(model: ModelRequestInput["model"]): string {
  return Buffer.from(JSON.stringify({ modelId: model.id, effort: model.variant })).toString("base64url");
}

export function createPlugin(deps: PluginDeps = {}): AntigravityPlugin {
  return {
    id: PLUGIN_ID,
    async setup(ctx) {
      const env = deps.env ?? process.env;
      const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
      const install = resolveInstallAuthConfig(ctx.options, env);
      const runtime = resolveRuntimeConfig(ctx.options, env);

      // Each issue once per process, however many locations and reloads run setup.
      const registry = poolRegistry();
      const fresh = [...install.issues, ...runtime.issues].filter((issue) => !registry.loggedIssues.has(issue));
      for (const issue of fresh) registry.loggedIssues.add(issue);
      logIssues(fresh, log);

      // An unsupported authMethod: the integration registers with zero methods and chat answers 401 (IA 3, 10.1).
      const configIssue = AUTH_METHODS[install.config.authMethod].configIssue(install.config);
      const lease = await acquireShared(singletonKey(install.config), {
        create: () => createPool({ install: install.config, runtime: runtime.config, configIssue, env, log, deps }),
        stop: (pool) => pool.stop(),
        isValue: isPool,
        graceMs: deps.reloadGraceMs ?? RELOAD_GRACE_MS,
        fingerprint: JSON.stringify({ install: install.config, runtime: runtime.config, configIssue }),
        onMismatch: () => log(SHARED_CONFIG_MESSAGE),
      });
      const pool = lease.value;
      const proxy = pool.proxy;
      const directory = ctx.location.directory;
      const controller = new AbortController();
      const reload = (): Promise<void> => ctx.provider.reload();
      let detach: (() => void) | null = null;
      let cleaned = false;
      const cleanup = async (): Promise<void> => {
        if (cleaned) return;
        cleaned = true;
        controller.abort();
        pool.reloaders.delete(reload);
        detach?.();
        lease.release();
      };

      // A failure past this point must hand the lease back, or the pool never stops.
      try {
        // 1. Provider. No `settings.apiKey`: OpenCode sends the marker credential once signed in (IA 13.3).
        //    The callback runs again on every reload, so it reads the current catalog and port.
        await ctx.provider.transform((editor) => {
          editor.add({
            info: {
              id: PROVIDER_ID,
              integrationID: INTEGRATION_ID,
              name: PROVIDER_NAME,
              activation: "enabled",
              package: "@opencode/ai/providers/openai-compatible",
              settings: { baseURL: proxy.url },
            },
            models: proxy.catalog.map(toOpenCodeModelInfo),
          });
        });

        // 2. Integration: always registered, with the sign-in method only when the config allows it (IA 10.1).
        await ctx.integration.transform((editor) => {
          editor.update(INTEGRATION_ID, (info) => {
            info.name = PROVIDER_NAME;
          });
          for (const spec of supportedMethods(install.config)) spec.register(editor, pool.auth);
        });

        // 3. Per-request headers (SR 8.1, architecture 3 step 2).
        await ctx.session.hook(
          "model.request",
          (req) => {
            req.baseURL = proxy.url;
            req.headers[HEADER_PROXY_TOKEN] = proxy.proxyToken;
            req.headers[HEADER_META] = metaHeader(req.model);
            if (req.kind) req.headers[HEADER_KIND] = req.kind;
            req.headers[HEADER_DIRECTORY] = encodeURIComponent(directory);
            if (req.sessionID) req.headers[HEADER_SESSION] = req.sessionID;
          },
          { providerID: PROVIDER_ID },
        );

        // 4. Location handle for connection statuses and logout (IA 11.1).
        detach = pool.auth.attach({ directory, integration: ctx.integration });

        // 5. Event loops: session interrupts and deletes (SR 8.3), credential removal (IA 11.2).
        const debugLog = (line: string): void => {
          if (runtime.config.debug) log(`${LOG_PREFIX} ${line}`);
        };
        void runEventLoop(ctx.event, proxy, controller.signal, debugLog);
        void runCredentialEvents(ctx.event.subscribe({ types: ["credential.updated"], signal: controller.signal }), pool.auth).catch((err: unknown) => {
          if (!controller.signal.aborted) debugLog(`credential event loop ended (${err instanceof Error ? err.name : "error"})`);
        });

        // 6. Catalog refresh on an already running agy; never spawns (SR 3.3).
        pool.reloaders.add(reload);
        const now = Date.now();
        if (proxy.process.state === "ready" && now - pool.lastDiscoveryAt > DISCOVERY_INTERVAL_MS) {
          pool.lastDiscoveryAt = now;
          void proxy.refreshModels(directory);
        }
      } catch (err) {
        await cleanup();
        throw err;
      }
      return cleanup;
    },
  };
}

export default createPlugin();
