// Plugin registration and wiring (architecture 5, WP-C): the real `setup` against a fake OpenCode
// context and the fake agy. No network: `binaryPath` points at the mock, so nothing downloads.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SIGNED_OUT_MESSAGE } from "../src/auth/errors.ts";
import type { ConnectionLike, ConnectionStatusValue } from "../src/auth/manager.ts";
import type { OAuthMethodRegistration } from "../src/auth/methods.ts";
import { HEADER_DIRECTORY, HEADER_KIND, HEADER_META, HEADER_PROXY_TOKEN, HEADER_SESSION, MARKER_ACCESS, PLUGIN_ID } from "../src/constants.ts";
import type { OpenAiMessage, SessionStoreApi } from "../src/contracts.ts";
import type { OpenCodeEventLike } from "../src/events.ts";
import {
  SHARED_CONFIG_MESSAGE,
  acquireShared,
  activePoolCount,
  createPlugin,
  type Cleanup,
  type ModelRequestInput,
  type OpenCodeModelInfo,
  type PluginContextLike,
  type ProviderInfoInput,
} from "../src/index.ts";
import { resetProcessSingletons } from "../src/install/singletons.ts";
import type { AntigravityProxy } from "../src/proxy.ts";
import { readJournal, writeMockAgyWrapper } from "./fixtures/mock-agy.ts";
import { READ_TOOL, SYSTEM, summarize, toolRound, user, waitFor, type ChatResult } from "./fixtures/proxy-harness.ts";

// ---------------------------------------------------------------------------
// Fake OpenCode context
// ---------------------------------------------------------------------------

class EventChannel {
  private readonly listeners = new Set<(event: OpenCodeEventLike) => void>();
  readonly subscriptions: string[][] = [];
  ended = 0;

  emit(event: OpenCodeEventLike): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  subscribe(options: { types: string[]; signal: AbortSignal }): AsyncIterable<OpenCodeEventLike> {
    this.subscriptions.push([...options.types]);
    const channel = this;
    return {
      async *[Symbol.asyncIterator]() {
        const queue: OpenCodeEventLike[] = [];
        let wake: (() => void) | null = null;
        const listener = (event: OpenCodeEventLike): void => {
          if (!options.types.includes(event.type)) return;
          queue.push(event);
          wake?.();
        };
        const onAbort = (): void => wake?.();
        channel.listeners.add(listener);
        options.signal.addEventListener("abort", onAbort);
        try {
          while (!options.signal.aborted) {
            const next = queue.shift();
            if (next) {
              yield next;
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = null;
          }
        } finally {
          channel.listeners.delete(listener);
          options.signal.removeEventListener("abort", onAbort);
          channel.ended++;
        }
      },
    };
  }
}

interface HookRecord {
  name: string;
  callback: (input: ModelRequestInput) => Promise<void> | void;
  options: { providerID?: string } | undefined;
}

class FakeContext implements PluginContextLike {
  readonly location: { directory: string };
  readonly options: unknown;
  readonly events = new EventChannel();
  providerAdds: Array<{ info: ProviderInfoInput; models: readonly OpenCodeModelInfo[] }> = [];
  integrationNames: string[] = [];
  methods: OAuthMethodRegistration[] = [];
  hooks: HookRecord[] = [];
  reloads = 0;
  connections: ConnectionLike[] = [];
  statuses: Array<ConnectionStatusValue | undefined> = [];
  private providerCallbacks: Array<(editor: { add: FakeContext["providerAdd"] }) => void> = [];

  constructor(directory: string, options: unknown) {
    this.location = { directory };
    this.options = options;
  }

  private readonly providerAdd = (input: { info: ProviderInfoInput; models: readonly OpenCodeModelInfo[] }): void => {
    this.providerAdds.push(input);
  };

  /** Makes `provider.transform` reject, as a closing location can. */
  failProviderTransform = false;

  readonly provider: PluginContextLike["provider"] = {
    transform: async (callback) => {
      if (this.failProviderTransform) throw new Error("location is closing");
      this.providerCallbacks.push(callback);
      callback({ add: this.providerAdd });
      return { dispose: async () => {} };
    },
    reload: async () => {
      this.reloads++;
      for (const callback of this.providerCallbacks) callback({ add: this.providerAdd });
    },
  };

  readonly integration: PluginContextLike["integration"] = {
    transform: async (callback) => {
      callback({
        update: (_id, update) => {
          const info = { name: "" };
          update(info);
          this.integrationNames.push(info.name);
        },
        method: { update: (input) => this.methods.push(input) },
      });
      return { dispose: async () => {} };
    },
    get: async () => ({ data: { connections: this.connections } }),
    connection: {
      active: async () => this.connections[0],
      status: async (input) => {
        this.statuses.push(input.status);
      },
    },
  };

  readonly session: PluginContextLike["session"] = {
    hook: async (name, callback, options) => {
      this.hooks.push({ name, callback, options });
      return { dispose: async () => {} };
    },
  };

  readonly event: PluginContextLike["event"] = {
    subscribe: (options) => this.events.subscribe(options),
  };

  /** Runs the `model.request` hook the way OpenCode does before a chat request. */
  async requestHeaders(input: { sessionID: string; kind?: string; model?: string; variant?: string }): Promise<ModelRequestInput> {
    const hook = this.hooks.find((h) => h.name === "model.request");
    if (!hook) throw new Error("no model.request hook");
    const req: ModelRequestInput = {
      sessionID: input.sessionID,
      model: { id: input.model ?? "gemini-3.8-flash", providerID: "antigravity", ...(input.variant ? { variant: input.variant } : {}) },
      kind: input.kind ?? "primary",
      headers: {},
    };
    await hook.callback(req);
    return req;
  }

  /** A chat request with the headers the hook sets plus OpenCode's marker credential. */
  async chat(sessionID: string, messages: OpenAiMessage[], opts: { auth?: boolean } = {}): Promise<ChatResult> {
    const req = await this.requestHeaders({ sessionID });
    const headers: Record<string, string> = { "content-type": "application/json", ...req.headers };
    if (opts.auth !== false) headers.authorization = `Bearer ${MARKER_ACCESS}`;
    const res = await fetch(`${req.baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gemini-3.8-flash", messages, tools: [READ_TOOL], stream: true }),
    });
    const raw = await res.text();
    return summarize(res.status, res.headers, raw, (res.headers.get("content-type") ?? "").includes("text/event-stream"));
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface World {
  dir: string;
  dataDir: string;
  journal: string;
  binary: string;
  logs: string[];
  proxies: AntigravityProxy[];
  stores: SessionStoreApi[];
  cleanups: Cleanup[];
}

const worlds: World[] = [];

function world(scenario = "text"): World {
  const dir = mkdtempSync(path.join(tmpdir(), "agy-plugin-"));
  const journal = path.join(dir, "journal.jsonl");
  const w: World = {
    dir,
    dataDir: path.join(dir, "data"),
    journal,
    binary: writeMockAgyWrapper(dir, { scenario, journal }),
    logs: [],
    proxies: [],
    stores: [],
    cleanups: [],
  };
  worlds.push(w);
  return w;
}

function plugin(w: World, graceMs = 30) {
  return createPlugin({
    env: { PATH: process.env.PATH ?? "", HOME: w.dir, OPENCODE_ANTIGRAVITY_DATA_DIR: w.dataDir },
    log: (line) => w.logs.push(line),
    reloadGraceMs: graceMs,
    proxy: { runRoot: path.join(w.dir, "run"), discoverAfterSpawn: false },
    onPoolStarted: ({ proxy, store }) => {
      w.proxies.push(proxy);
      w.stores.push(store);
    },
  });
}

async function setup(w: World, options: Record<string, unknown> = {}, directory = w.dir, graceMs = 30): Promise<FakeContext> {
  const ctx = new FakeContext(directory, { binaryPath: w.binary, ...options });
  w.cleanups.push(await plugin(w, graceMs).setup(ctx));
  return ctx;
}

afterEach(async () => {
  for (const w of worlds.splice(0)) {
    for (const cleanup of w.cleanups) await cleanup();
    await waitFor(() => activePoolCount() === 0, 15_000).catch(() => {});
    rmSync(w.dir, { recursive: true, force: true });
  }
  resetProcessSingletons();
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registration (IA 10.1, 13.3)", () => {
  test("the provider has no settings.apiKey; the integration has the oauth-personal method", async () => {
    const w = world();
    const ctx = await setup(w);
    expect(ctx.providerAdds).toHaveLength(1);
    const { info, models } = ctx.providerAdds[0] ?? { info: null, models: [] };
    expect(info).toEqual({
      id: "antigravity",
      integrationID: "antigravity",
      name: "Antigravity",
      activation: "enabled",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: w.proxies[0]?.url ?? "" },
    });
    expect(JSON.stringify(info)).not.toContain(w.proxies[0]?.proxyToken ?? "missing");
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]?.providerID).toBe("antigravity");
    expect(ctx.integrationNames).toEqual(["Antigravity"]);
    expect(ctx.methods.map((m) => ({ integrationID: m.integrationID, method: m.method }))).toEqual([
      { integrationID: "antigravity", method: { id: "oauth-personal", type: "oauth", label: "Sign in with Google" } },
    ]);
    expect(createPlugin().id).toBe(PLUGIN_ID);
    // A fresh data dir: the profile is the plugin's own from the first start, so the guard is on.
    expect(w.proxies[0]?.guardOutcome).toBe("installed");
    expect(w.logs.filter((l) => l.includes("tool guard hook is off"))).toEqual([]);
  });

  test("an unsupported authMethod keeps the integration with zero methods; chat answers 401 with the issue", async () => {
    const w = world();
    const ctx = await setup(w, { authMethod: "gemini-api-key" });
    expect(ctx.integrationNames).toEqual(["Antigravity"]);
    expect(ctx.methods).toEqual([]);
    expect(ctx.providerAdds).toHaveLength(1);
    const issue = 'Antigravity sign-in method "gemini-api-key" is not available in this plugin version.';
    expect(w.logs.filter((l) => l.includes(issue))).toHaveLength(1);
    const r = await ctx.chat("ses_issue", [SYSTEM, user("hi")]);
    expect(r.status).toBe(401);
    expect(r.error?.message).toContain(issue);
    expect(readJournal(w.journal)).toEqual([]);
    // A second location logs nothing new.
    await setup(w, { authMethod: "gemini-api-key" }, path.join(w.dir, "other"));
    expect(w.logs.filter((l) => l.includes(issue))).toHaveLength(1);
  });

  test("the model.request hook sets the base URL and the proxy, meta, kind, directory and session headers", async () => {
    const w = world();
    const directory = path.join(w.dir, "my project");
    const ctx = await setup(w, {}, directory);
    expect(ctx.hooks.map((h) => ({ name: h.name, options: h.options }))).toEqual([{ name: "model.request", options: { providerID: "antigravity" } }]);
    const req = await ctx.requestHeaders({ sessionID: "ses_hook", kind: "title", model: "gemini-4-neon", variant: "high" });
    const proxy = w.proxies[0];
    expect(req.baseURL).toBe(proxy?.url);
    expect(req.headers[HEADER_PROXY_TOKEN]).toBe(proxy?.proxyToken);
    expect(JSON.parse(Buffer.from(req.headers[HEADER_META] ?? "", "base64url").toString("utf8"))).toEqual({ modelId: "gemini-4-neon", effort: "high" });
    expect(req.headers[HEADER_KIND]).toBe("title");
    expect(req.headers[HEADER_DIRECTORY]).toBe(encodeURIComponent(directory));
    expect(req.headers[HEADER_SESSION]).toBe("ses_hook");
    expect(req.headers.authorization).toBeUndefined();
  });
});

describe("wiring", () => {
  test("a chat turn through the hook headers reaches agy; /health reports the auth state kind", async () => {
    const w = world();
    const ctx = await setup(w);
    const r = await ctx.chat("ses_chat", [SYSTEM, user("hello")]);
    expect(r.status).toBe(200);
    expect(r.text).toBe("PLAIN_TEXT_OK");
    const noMarker = await ctx.chat("ses_chat", [SYSTEM, user("hello")], { auth: false });
    expect(noMarker.status).toBe(401);
    const health: unknown = await (await fetch(`http://127.0.0.1:${w.proxies[0]?.port}/health`)).json();
    expect(health).toEqual({ ok: true, acp: "ready", auth: "signed_in", binary: { source: "explicit", version: "1.5.15", phase: "ready" } });
  });

  test("the session event loop: an interrupt cancels the parked turn; cleanup ends both loops", async () => {
    const w = world("tools");
    const ctx = await setup(w);
    expect(ctx.events.subscriptions).toEqual([
      ["session.deleted", "session.execution.interrupted", "session.execution.failed"],
      ["credential.updated"],
    ]);
    const messages: OpenAiMessage[] = [SYSTEM, user("read a file")];
    const r1 = await ctx.chat("ses_loop", messages);
    expect(r1.finishReason).toBe("tool_calls");
    ctx.events.emit({ type: "session.execution.interrupted", data: { sessionID: "ses_loop" } });
    await waitFor(() => readJournal(w.journal).some((e) => e.method === "session/cancel"));
    const r2 = await ctx.chat("ses_loop", [...messages, ...toolRound(r1)]);
    expect(r2.status).toBe(200);
    expect(readJournal(w.journal).filter((e) => e.method === "session/new")).toHaveLength(2);

    const store = w.stores[0];
    // The binding must exist first, or the check below proves nothing (N-14). The fake bridge is not in
    // use here: the real AuthEpoch starts at "0".
    let saved = false;
    for (let i = 0; i < 100 && !saved; i++) {
      saved = (await store?.load("ses_loop", "0").catch(() => null)) != null;
      if (!saved) await new Promise((r) => setTimeout(r, 20));
    }
    expect(saved).toBe(true);
    ctx.events.emit({ type: "session.deleted", data: { sessionID: "ses_loop" } });
    let gone = false;
    for (let i = 0; i < 100 && !gone; i++) {
      gone = (await store?.load("ses_loop", "0").catch(() => null)) === null;
      if (!gone) await new Promise((r) => setTimeout(r, 20));
    }
    expect(gone).toBe(true);

    for (const cleanup of w.cleanups.splice(0)) await cleanup();
    await waitFor(() => ctx.events.ended === 2);
  });

  test("credential.updated with no credential left signs out; chat then answers the sign-in text", async () => {
    const w = world();
    const ctx = await setup(w);
    ctx.connections = [{ type: "oauth" }];
    expect((await ctx.chat("ses_cred", [SYSTEM, user("hello")])).status).toBe(200);
    ctx.connections = [];
    ctx.events.emit({ type: "credential.updated", data: { integrationID: "other" } });
    ctx.events.emit({ type: "credential.updated", data: { integrationID: "antigravity", credentialID: "c1" } });
    const healthAuth = async (): Promise<unknown> => getHealthAuth(w.proxies[0]);
    let auth: unknown = null;
    for (let i = 0; i < 150 && auth !== "signed_out"; i++) {
      auth = await healthAuth();
      if (auth !== "signed_out") await new Promise((r) => setTimeout(r, 40));
    }
    expect(auth).toBe("signed_out");
    const r = await ctx.chat("ses_cred", [SYSTEM, user("hello"), { role: "assistant", content: "PLAIN_TEXT_OK" }, user("again")]);
    expect(r.status).toBe(401);
    expect(r.error?.message).toBe(SIGNED_OUT_MESSAGE);
  }, 15_000);

  test("two locations share one pool; a discovery that changes the catalog reloads both providers", async () => {
    const w = world();
    const a = await setup(w, {}, path.join(w.dir, "a"));
    const b = await setup(w, {}, path.join(w.dir, "b"));
    expect(w.proxies).toHaveLength(1);
    expect((await a.requestHeaders({ sessionID: "s" })).baseURL).toBe((await b.requestHeaders({ sessionID: "s" })).baseURL);
    expect((await a.chat("ses_a", [SYSTEM, user("hi")])).status).toBe(200);
    const changed = await w.proxies[0]?.refreshModels(w.dir);
    expect(changed).toBe(true);
    await waitFor(() => a.reloads === 1 && b.reloads === 1);
    expect(a.providerAdds.at(-1)?.models.map((m) => m.id)).toEqual(w.proxies[0]?.catalog.map((m) => m.id));
  });
});

async function getHealthAuth(proxy: AntigravityProxy | undefined): Promise<unknown> {
  if (!proxy) return null;
  const body: unknown = await (await fetch(`http://127.0.0.1:${proxy.port}/health`)).json();
  return typeof body === "object" && body !== null && "auth" in body ? body.auth : null;
}

describe("pool sharing and reload (SR 8.4)", () => {
  test("a setup during the async stop waits for it, then builds a fresh pool", async () => {
    const w = world();
    const first = await setup(w, {}, w.dir, 40);
    expect((await first.chat("ses_r", [SYSTEM, user("hi")])).status).toBe(200);
    const old = w.proxies[0];
    const oldPort = old?.port;
    expect(old?.process.state).toBe("ready");
    const cleanup = w.cleanups.pop();
    await cleanup?.();
    // Inside the grace period the pool is reused.
    const again = await setup(w, {}, w.dir, 40);
    expect(w.proxies).toHaveLength(1);
    expect((await again.requestHeaders({ sessionID: "s" })).headers[HEADER_PROXY_TOKEN]).toBe(old?.proxyToken);
    await w.cleanups.pop()?.();
    // After the grace period the stop starts; agy is running, so it takes a while.
    await waitFor(() => old?.process.state === "stopping" || old?.process.state === "stopped", 2000);
    const third = await setup(w, {}, w.dir, 40);
    expect(old?.process.state).toBe("stopped");
    expect(w.proxies).toHaveLength(2);
    const fresh = w.proxies[1];
    expect(fresh).not.toBe(old);
    expect((await third.requestHeaders({ sessionID: "s" })).headers[HEADER_PROXY_TOKEN]).toBe(fresh?.proxyToken);
    expect(await fetch(`http://127.0.0.1:${oldPort}/health`).then(() => "open", () => "closed")).toBe("closed");
    expect((await third.chat("ses_r", [SYSTEM, user("hi")])).status).toBe(200);
  }, 15_000);

  test("acquireShared: release at zero waits the grace, the stop is awaited by the next acquire", async () => {
    const order: string[] = [];
    const gate = deferred();
    let made = 0;
    const isValue = (value: unknown): value is { n: number } => typeof value === "object" && value !== null && "n" in value;
    const opts = {
      create: async () => {
        made++;
        order.push(`create ${made}`);
        return { n: made };
      },
      stop: async (value: { n: number }) => {
        order.push(`stop ${value.n} begins`);
        await gate.promise;
        order.push(`stop ${value.n} ends`);
      },
      isValue,
      graceMs: 20,
      fingerprint: "same",
    };
    const key = `test-${Date.now()}`;
    const one = await acquireShared(key, opts);
    const two = await acquireShared(key, opts);
    expect(two.value).toBe(one.value);
    one.release();
    one.release(); // idempotent
    two.release();
    await waitFor(() => order.includes("stop 1 begins"));
    const next = acquireShared(key, opts);
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual(["create 1", "stop 1 begins"]);
    gate.resolve();
    const three = await next;
    expect(three.value.n).toBe(2);
    expect(order).toEqual(["create 1", "stop 1 begins", "stop 1 ends", "create 2"]);
    three.release();
    await waitFor(() => order.includes("stop 2 ends"));
  });

  test("acquireShared: a failed creation rejects every waiter and the next acquire retries", async () => {
    let attempts = 0;
    const isValue = (value: unknown): value is string => typeof value === "string";
    const opts = {
      create: async () => {
        attempts++;
        await new Promise((r) => setTimeout(r, 10));
        if (attempts === 1) throw new Error("port in use");
        return "ok";
      },
      stop: async () => {},
      isValue,
      graceMs: 10,
      fingerprint: "same",
    };
    const key = `fail-${Date.now()}`;
    const results = await Promise.allSettled([acquireShared(key, opts), acquireShared(key, opts)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    const lease = await acquireShared(key, opts);
    expect(lease.value).toBe("ok");
    lease.release();
  });

  test("acquireShared: an idle entry with another fingerprint is rebuilt; a held one is shared and reported once", async () => {
    const order: string[] = [];
    let made = 0;
    const isValue = (value: unknown): value is { n: number } => typeof value === "object" && value !== null && "n" in value;
    let mismatches = 0;
    const opts = (fingerprint: string) => ({
      create: async () => {
        made++;
        order.push(`create ${made} ${fingerprint}`);
        return { n: made };
      },
      stop: async (value: { n: number }) => {
        order.push(`stop ${value.n}`);
      },
      isValue,
      graceMs: 5_000,
      fingerprint,
      onMismatch: () => mismatches++,
    });
    const key = `fp-${Date.now()}`;
    const a = await acquireShared(key, opts("A"));
    // Held by a live lease: shared as is, reported once.
    const b = await acquireShared(key, opts("B"));
    const c = await acquireShared(key, opts("B"));
    expect(b.value).toBe(a.value);
    expect(c.value).toBe(a.value);
    expect(mismatches).toBe(1);
    a.release();
    b.release();
    c.release();
    // Idle in its (long) grace period: another fingerprint stops it at once and builds a new one.
    const d = await acquireShared(key, opts("B"));
    expect(d.value.n).toBe(2);
    expect(order).toEqual(["create 1 A", "stop 1", "create 2 B"]);
    // The same fingerprint reuses the idle entry.
    d.release();
    const e = await acquireShared(key, opts("B"));
    expect(e.value).toBe(d.value);
    e.release();
  });

  test("a reload with changed options inside the grace period builds a pool with the new options", async () => {
    const w = world();
    await setup(w, { statusNotes: true }, w.dir, 1_000);
    await w.cleanups.pop()?.();
    const ctx = await setup(w, { statusNotes: false }, w.dir, 1_000);
    expect(w.proxies).toHaveLength(2);
    expect(w.proxies[0]?.process.state).toBe("stopped");
    expect((await ctx.requestHeaders({ sessionID: "s" })).headers[HEADER_PROXY_TOKEN]).toBe(w.proxies[1]?.proxyToken);
    expect(w.logs.filter((l) => l === SHARED_CONFIG_MESSAGE)).toEqual([]);
  });

  test("a second location with other options shares the running pool and logs that once", async () => {
    const w = world();
    await setup(w, { statusNotes: true }, path.join(w.dir, "a"));
    await setup(w, { statusNotes: false }, path.join(w.dir, "b"));
    await setup(w, { statusNotes: false }, path.join(w.dir, "c"));
    expect(w.proxies).toHaveLength(1);
    expect(w.logs.filter((l) => l === SHARED_CONFIG_MESSAGE)).toHaveLength(1);
  });
});

describe("setup failures release what they took", () => {
  test("a registration that rejects after the pool started hands the lease back, so the pool stops", async () => {
    const w = world();
    const ctx = new FakeContext(w.dir, { binaryPath: w.binary });
    ctx.failProviderTransform = true;
    const failed = await plugin(w, 20).setup(ctx).then(() => "resolved", (err: unknown) => (err instanceof Error ? err.message : "rejected"));
    expect(failed).toBe("location is closing");
    expect(w.proxies).toHaveLength(1);
    await waitFor(() => activePoolCount() === 0, 5000);
    expect(w.proxies[0]?.process.state).toBe("stopped");
    expect(ctx.events.subscriptions).toEqual([]);
  });

  test("a pool whose proxy cannot listen leaves no owner file and no pool; a later setup works", async () => {
    const w = world();
    const busy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") });
    try {
      const ctx = new FakeContext(w.dir, { binaryPath: w.binary, proxyPort: busy.port });
      const failed = await plugin(w).setup(ctx).then(() => "resolved", () => "rejected");
      expect(failed).toBe("rejected");
      expect(activePoolCount()).toBe(0);
      expect(existsSync(path.join(w.dataDir, "owners", `${process.pid}.json`))).toBe(false);
    } finally {
      await busy.stop(true);
    }
    const ctx = await setup(w);
    expect((await ctx.chat("ses_after", [SYSTEM, user("hi")])).status).toBe(200);
  });
});
