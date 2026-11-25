import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AUTH_URL_STDOUT_PREFIX,
  NEEDS_AUTH_STATUS_MESSAGE,
  SIGNED_OUT_MESSAGE,
  SIGN_IN_GATE_MESSAGE,
  SignInRequiredError,
  SignInUrlLineError,
  isSignInRequired,
  redactAgyOutput,
} from "../src/auth/errors.ts";
import type {
  InstallAuthBridge,
  Lease,
  ProviderFailureKind,
  RequestPlanKind,
  RuntimeControl,
} from "../src/contracts.ts";
import { FakeInstallAuthBridge, createFakeBridge } from "./fixtures/fake-bridge.ts";
import {
  MOCK_AGENT_NAME,
  MOCK_NO_BROWSER_MESSAGE,
  MOCK_REPLY_TEXT,
  MOCK_THOUGHT_TEXT,
  readJournal,
  writeMockAgyWrapper,
} from "./fixtures/mock-agy.ts";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return undefined;
}

/** Same shape as the runtime's AcpError: numeric JSON-RPC code plus message. */
class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "AcpError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// isSignInRequired (IA 15.1, 17.1 auth-probe truth table)
// ---------------------------------------------------------------------------

describe("isSignInRequired", () => {
  const cases: Array<[string, unknown, boolean]> = [
    ["ACP -32000", new RpcError(-32000, "Authentication required"), true],
    ["ACP -32603 with agy's no-browser text", new RpcError(-32603, MOCK_NO_BROWSER_MESSAGE), true],
    // Only the -32603 prefix rule matches this one: it has no `agy acp --login`.
    ["ACP -32603 no-browser prefix alone", new RpcError(-32603, "No browser is available here (remote session)."), true],
    ["no-browser prefix with another code", new RpcError(-32602, "No browser is available here (remote session)."), false],
    ["plain object -32000", { code: -32000, message: "Unauthenticated" }, true],
    ["any message containing `agy acp --login`", new Error("Please run `agy acp --login` first"), true],
    ["SignInUrlLineError", new SignInUrlLineError("stdout"), true],
    ["SignInRequiredError", new SignInRequiredError(), true],
    ["same names from another module copy", Object.assign(new Error("x"), { name: "SignInUrlLineError" }), true],
    ["unrelated ACP -32603", new RpcError(-32603, "Internal error: model unavailable"), false],
    ["-32603 with the no-browser text not at the start", new RpcError(-32603, `Error: ${"No browser is available here"}`), false],
    ["other ACP code", new RpcError(-32601, "Method not found"), false],
    ["Node system error with a string code", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), false],
    ["timeout error", Object.assign(new Error("ACP request timed out"), { name: "AcpTimeoutError" }), false],
    ["null", null, false],
    ["undefined", undefined, false],
    ["unrelated string", "boom", false],
    ["string mentioning the login command", "run agy acp --login", true],
  ];
  for (const [name, err, expected] of cases) {
    test(name, () => {
      expect(isSignInRequired(err)).toBe(expected);
    });
  }
});

describe("auth error texts and classes", () => {
  test("constants match the install/auth design", () => {
    expect(AUTH_URL_STDOUT_PREFIX).toBe("Open the following link to authenticate the ACP server: ");
    expect(SIGNED_OUT_MESSAGE).toBe("Antigravity is signed out. Open Settings, Providers, Antigravity and connect again.");
    expect(SIGN_IN_GATE_MESSAGE).toBe("Sign in to Antigravity in Settings, Providers before using it.");
    expect(NEEDS_AUTH_STATUS_MESSAGE).toBe("Signed out of Antigravity. Connect again to sign in.");
  });

  test("SignInUrlLineError keeps no URL and carries the signed-out text", () => {
    const err = new SignInUrlLineError("stderr");
    expect(err.message).toBe(SIGNED_OUT_MESSAGE);
    expect(err.stream).toBe("stderr");
    expect(err.code).toBe("auth_required");
    expect(err.name).toBe("SignInUrlLineError");
  });

  test("SignInRequiredError defaults to the signed-out text", () => {
    expect(new SignInRequiredError().message).toBe(SIGNED_OUT_MESSAGE);
    expect(new SignInRequiredError("custom").message).toBe("custom");
  });

  test("redactAgyOutput drops sensitive lines and cuts the rest", () => {
    expect(redactAgyOutput("  https://accounts.google.com/o/oauth2/auth?state=abc")).toBe("");
    expect(redactAgyOutput("state=abc")).toBe("");
    expect(redactAgyOutput("code=xyz")).toBe("");
    expect(redactAgyOutput("refresh Token expired")).toBe("");
    expect(redactAgyOutput("signed in as me@example.com")).toBe("");
    expect(redactAgyOutput("login cancelled: no authorization code was entered")).toBe(
      "login cancelled: no authorization code was entered",
    );
    expect(redactAgyOutput("ok line\n\nhttps://x\nsecond")).toBe("ok line\nsecond");
    expect(redactAgyOutput("x".repeat(300)).length).toBe(200);
    // A cut never splits a surrogate pair.
    expect(redactAgyOutput("😀".repeat(250))).toBe("😀".repeat(200));
  });
});

// ---------------------------------------------------------------------------
// Fake bridge
// ---------------------------------------------------------------------------

// Type-level checks: these lines only compile when the fakes satisfy the contracts.
const bridgeContract: InstallAuthBridge = createFakeBridge({ geminiDir: "/nonexistent" });
const fakeIsBridge = (b: FakeInstallAuthBridge): InstallAuthBridge => b;
const planKinds: Record<RequestPlanKind, true> = {
  meta: true,
  ephemeral: true,
  resume: true,
  append: true,
  redo: true,
  fresh: true,
};
const failureKinds: Record<ProviderFailureKind, true> = {
  stalled: true,
  rate_limited: true,
  capacity: true,
  quota_exhausted: true,
  agy_exited: true,
  breaker_open: true,
  auth_required: true,
  auth_changed: true,
  binary_not_found: true,
  config_issue: true,
  provider_error: true,
  client_aborted: true,
};

function fakeRuntime(): RuntimeControl & { stops: string[]; holds: string[] } {
  const stops: string[] = [];
  const holds: string[] = [];
  return {
    stops,
    holds,
    async stop(reason) {
      stops.push(reason);
    },
    hold(reason): Lease {
      holds.push(reason);
      return { generation: 0, release() {} };
    },
  };
}

describe("fake InstallAuthBridge", () => {
  test("satisfies the contract", () => {
    expect(typeof bridgeContract.resolveBinary).toBe("function");
    expect(fakeIsBridge(createFakeBridge({ geminiDir: "/g" })).geminiDir).toBe("/g");
    expect(Object.keys(planKinds).length).toBe(6);
    expect(Object.keys(failureKinds).length).toBe(12);
  });

  test("resolves the configured binary and builds a runtime env", async () => {
    const bridge = createFakeBridge({ geminiDir: "/g", binaryPath: "/bin/agy", binaryVersion: "1.5.16" });
    expect(await bridge.resolveBinary()).toEqual({ path: "/bin/agy", version: "1.5.16" });
    expect(bridge.binaryStatus()).toEqual({ phase: "ready", source: "explicit", version: "1.5.16" });
    const env = bridge.buildSpawnEnv({ tmpDir: "/tmp/run-1" });
    expect(env.GEMINI_HOME).toBe("/g");
    expect(env.TMPDIR).toBe("/tmp/run-1");
    expect(env.SSH_CONNECTION).toBe("127.0.0.1 0 127.0.0.1 0");
    expect(bridge.calls.resolveBinary).toBe(1);
  });

  test("binary missing rejects with code binary_not_found", async () => {
    const bridge = createFakeBridge({ geminiDir: "/g", binaryPath: "/bin/agy" });
    bridge.setBinaryMissing("Could not download Antigravity from Google: offline.");
    const err = await rejection(bridge.resolveBinary());
    expect(err instanceof Error && "code" in err ? err.code : null).toBe("binary_not_found");
    expect(bridge.binaryStatus().phase).toBe("missing");
    expect(bridge.isSignInRequired(err)).toBe(false);
  });

  test("holdResolve reports a download until released", async () => {
    const bridge = createFakeBridge({ geminiDir: "/g", binaryPath: "/bin/agy" });
    const release = bridge.holdResolve({ phase: "downloading", bytes: 1, total: 10 });
    let resolved = false;
    const pending = bridge.resolveBinary().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(bridge.binaryStatus()).toEqual({ phase: "downloading", bytes: 1, total: 10 });
    release();
    await pending;
    expect(resolved).toBe(true);
    expect(bridge.binaryStatus().phase).toBe("ready");
  });

  test("signed out after logout: beforeSpawn rejects until the epoch changes", async () => {
    const bridge = createFakeBridge({ geminiDir: "/g", binaryPath: "/bin/agy" });
    bridge.signOut();
    const err = await rejection(bridge.beforeSpawn());
    expect(err instanceof SignInRequiredError).toBe(true);
    expect(bridge.isSignInRequired(err)).toBe(true);

    const events: string[] = [];
    const off = bridge.onAuthChanged((e) => events.push(`${e.reason}:${e.epoch}`));
    const change = bridge.changeAuth("login");
    expect(events).toEqual([]); // delivered in a microtask, like the real AuthEpoch
    await change.delivered;
    expect(events).toEqual(["login:2"]);
    expect(bridge.authEpoch()).toBe("2");
    expect(await rejection(bridge.beforeSpawn())).toBeUndefined();
    off();
    await bridge.changeAuth("account-changed").delivered;
    expect(events).toEqual(["login:2"]);
    expect(bridge.listenerCounts().auth).toBe(0);
  });

  test("simulateLogout follows AuthManager's order and blocks spawns meanwhile", async () => {
    const bridge = createFakeBridge({ geminiDir: "/g", binaryPath: "/bin/agy" });
    const order: string[] = [];
    let finishStop = (): void => {};
    bridge.attachRuntime({
      stop(reason) {
        order.push(`stop:${reason}`);
        return new Promise<void>((resolve) => {
          finishStop = resolve;
        });
      },
      hold: () => ({ generation: 0, release() {} }),
    });
    bridge.onAuthChanged((e) => order.push(`event:${e.reason}`));

    const logout = bridge.simulateLogout();
    let spawnSettled = false;
    const spawn = rejection(bridge.beforeSpawn()).then((err) => {
      spawnSettled = true;
      return err;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["event:logout", "stop:auth-changed"]);
    expect(spawnSettled).toBe(false); // waits while logging out

    finishStop();
    await logout;
    expect((await spawn) instanceof SignInRequiredError).toBe(true);
    expect(bridge.authState).toBe("signed_out");
  });

  test("simulateLogout signs out even when the runtime stop rejects", async () => {
    const bridge = createFakeBridge({ geminiDir: "/g", binaryPath: "/bin/agy" });
    bridge.attachRuntime({
      stop: () => Promise.reject(new Error("stop failed")),
      hold: () => ({ generation: 0, release() {} }),
    });
    const err = await rejection(bridge.simulateLogout());
    expect(err instanceof Error ? err.message : null).toBe("stop failed");
    expect((await rejection(bridge.beforeSpawn())) instanceof SignInRequiredError).toBe(true);
  });

  test("shared auth leaves file token storage off", () => {
    const shared = createFakeBridge({ geminiDir: "/g", isolatedAuth: false }).buildSpawnEnv({ tmpDir: "/t" });
    expect(shared.AGY_ACP_FORCE_FILE_STORAGE).toBeUndefined();
    expect(shared.SSH_CONNECTION).toBe("127.0.0.1 0 127.0.0.1 0");
    const isolated = createFakeBridge({ geminiDir: "/g" }).buildSpawnEnv({ tmpDir: "/t" });
    expect(isolated.AGY_ACP_FORCE_FILE_STORAGE).toBe("1");
  });

  test("reports, settings and binary change are recorded", async () => {
    const bridge = createFakeBridge({ geminiDir: "/g", binaryPath: "/bin/agy" });
    const runtime = fakeRuntime();
    bridge.attachRuntime(runtime);
    bridge.reportAuthenticated();
    expect(bridge.authState).toBe("signed_in");
    bridge.reportSignInRequired(SIGNED_OUT_MESSAGE);
    expect(bridge.calls.reportSignInRequired).toEqual([SIGNED_OUT_MESSAGE]);
    expect(runtime.stops).toEqual(["auth-changed"]);

    await bridge.updateProfileSettings({ toolPermission: "strict" });
    await bridge.updateProfileSettings({ auth: { type: "oauth-personal" } });
    expect(bridge.settings).toEqual({ toolPermission: "strict", auth: { type: "oauth-personal" } });

    const changes: string[] = [];
    bridge.onBinaryChanged((e) => changes.push(`${e.path}@${e.version}`));
    bridge.setBinary("/bin/agy2", "1.5.17");
    expect(changes).toEqual(["/bin/agy2@1.5.17"]);
    expect(await bridge.resolveBinary()).toEqual({ path: "/bin/agy2", version: "1.5.17" });
  });

  test("blockSpawns holds beforeSpawn until released", async () => {
    const bridge = createFakeBridge({ geminiDir: "/g", binaryPath: "/bin/agy" });
    const release = bridge.blockSpawns();
    let passed = false;
    const pending = bridge.beforeSpawn().then(() => {
      passed = true;
    });
    await Promise.resolve();
    expect(passed).toBe(false);
    release();
    await pending;
    expect(passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mock-agy smoke
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Minimal JSON-RPC client over the fake's stdio. */
class RpcChild {
  readonly updates: JsonObject[] = [];
  /** Arrival order of incoming lines: `update` or `reply:<id>`. */
  readonly order: string[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = "";
  private nextId = 1;
  private readonly exited: Promise<number | null>;

  constructor(binary: string, args: string[]) {
    this.child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.exited = new Promise((resolve) => this.child.once("exit", (code) => resolve(code)));
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
  }

  request(method: string, params: JsonObject = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: JsonObject): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async close(): Promise<number | null> {
    this.child.stdin.end();
    return this.exited;
  }

  private onData(text: string): void {
    this.buffer += text;
    let at: number;
    while ((at = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (!line) continue;
      const msg: unknown = JSON.parse(line);
      if (!isObject(msg)) continue;
      if (msg.method === "session/update" && isObject(msg.params)) {
        this.order.push("update");
        this.updates.push(msg.params);
        continue;
      }
      if (typeof msg.id !== "number" || msg.method !== undefined) continue;
      this.order.push(`reply:${msg.id}`);
      const entry = this.pending.get(msg.id);
      if (!entry) continue;
      this.pending.delete(msg.id);
      if (isObject(msg.error)) {
        const code = typeof msg.error.code === "number" ? msg.error.code : -32603;
        const message = typeof msg.error.message === "string" ? msg.error.message : "error";
        entry.reject(new RpcError(code, message));
      } else {
        entry.resolve(msg.result);
      }
    }
  }
}

function startMock(scenario?: string): { rpc: RpcChild; journal: string; geminiDir: string } {
  const dir = tempDir("mock-agy-");
  const geminiDir = path.join(dir, "gemini");
  const journal = path.join(dir, "journal.jsonl");
  const binary = writeMockAgyWrapper(dir, { scenario, journal });
  const rpc = new RpcChild(binary, ["acp", "--gemini-dir", geminiDir, "--app-data-dir", "antigravity-acp"]);
  return { rpc, journal, geminiDir };
}

function field(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

describe("mock-agy", () => {
  test("initialize, authenticate, session/new and one prompt", async () => {
    const { rpc, journal } = startMock();
    try {
      const init = await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      expect(field(init, "protocolVersion")).toBe(1);
      expect(field(init, "agentInfo", "name")).toBe(MOCK_AGENT_NAME);
      expect(field(init, "agentInfo", "version")).toBe("1.5.15");
      expect(field(init, "agentCapabilities", "auth", "logout")).toEqual({});
      expect(field(init, "agentCapabilities", "loadSession")).toBe(true);
      expect(field(init, "agentCapabilities", "sessionCapabilities", "resume")).toEqual({});
      expect(field(init, "agentCapabilities", "_meta", "antigravity", "systemPrompt", "append")).toBe(true);
      const methods = field(init, "authMethods");
      expect(Array.isArray(methods) ? methods.map((m) => field(m, "id")) : []).toContain("oauth-personal");

      expect(await rpc.request("authenticate", { methodId: "oauth-personal" })).toEqual({});

      const created = await rpc.request("session/new", {
        cwd: "/work",
        mcpServers: [],
        _meta: { antigravity: { systemPrompt: { append: "APPEND" } } },
      });
      const sessionId = field(created, "sessionId");
      expect(typeof sessionId).toBe("string");
      if (typeof sessionId !== "string") return;

      const result = await rpc.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "hello " }, { type: "text", text: "agy" }],
      });
      expect(field(result, "stopReason")).toBe("end_turn");
      const kinds = rpc.updates.map((u) => field(u, "update", "sessionUpdate"));
      expect(kinds).toEqual(["agent_thought_chunk", "agent_message_chunk"]);
      expect(rpc.updates.map((u) => field(u, "update", "content", "text"))).toEqual([MOCK_THOUGHT_TEXT, MOCK_REPLY_TEXT]);
      expect(rpc.updates.every((u) => field(u, "sessionId") === sessionId)).toBe(true);

      const entries = readJournal(journal);
      // The fake records how it was started first: the `--agent` it got (review L-1).
      expect(entries.map((e) => e.method)).toEqual(["process/start", "initialize", "authenticate", "session/new", "session/prompt"]);
      const prompt = entries[4];
      expect(prompt?.sessionId).toBe(sessionId);
      expect(prompt?.promptText).toBe("hello agy");
      expect(field(entries[3]?.params, "_meta", "antigravity", "systemPrompt", "append")).toBe("APPEND");
    } finally {
      expect(await rpc.close()).toBe(0);
    }
  });

  test("identity switches turn fields off and compose", async () => {
    const { rpc } = startMock("wrong-name,no-logout,no-oauth-personal,no-resume,no-append");
    try {
      const init = await rpc.request("initialize", { protocolVersion: 1 });
      expect(field(init, "agentInfo", "name") === MOCK_AGENT_NAME).toBe(false);
      expect(field(init, "agentCapabilities", "auth", "logout")).toBeUndefined();
      const methods = field(init, "authMethods");
      expect(Array.isArray(methods) ? methods.map((m) => field(m, "id")).includes("oauth-personal") : true).toBe(false);
      expect(field(init, "agentCapabilities", "sessionCapabilities", "resume")).toBeUndefined();
      expect(field(init, "agentCapabilities", "sessionCapabilities", "close")).toEqual({});
      expect(field(init, "agentCapabilities", "_meta", "antigravity", "systemPrompt", "append")).toBe(false);
    } finally {
      await rpc.close();
    }
  });

  test("signed-out authenticate is classified as sign-in required", async () => {
    for (const scenario of ["signed-out", "unauth"]) {
      const { rpc } = startMock(scenario);
      try {
        await rpc.request("initialize", { protocolVersion: 1 });
        const err = await rejection(rpc.request("authenticate", { methodId: "oauth-personal" }));
        expect(err instanceof RpcError).toBe(true);
        expect(isSignInRequired(err)).toBe(true);
      } finally {
        await rpc.close();
      }
    }
  });

  test("session/cancel ends a stalled prompt as cancelled and is journaled", async () => {
    const { rpc, journal } = startMock("stall");
    try {
      await rpc.request("initialize", { protocolVersion: 1 });
      const sessionId = field(await rpc.request("session/new", { cwd: "/w", mcpServers: [] }), "sessionId");
      expect(typeof sessionId).toBe("string");
      const prompt = rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "x" }] });
      while (rpc.updates.length === 0) await new Promise((r) => setTimeout(r, 10));
      rpc.notify("session/cancel", { sessionId });
      expect(field(await prompt, "stopReason")).toBe("cancelled");
      const methods = readJournal(journal).map((e) => e.method);
      expect(methods).toContain("session/cancel");
    } finally {
      await rpc.close();
    }
  });

  test("unknown methods answer -32601, including Object.prototype names", async () => {
    const { rpc } = startMock("unauth");
    try {
      for (const method of ["session/nope", "constructor", "toString"]) {
        const err = await rejection(rpc.request(method, {}));
        expect(err instanceof RpcError ? err.code : null).toBe(-32601);
      }
    } finally {
      await rpc.close();
    }
  });

  test("a scenario method wraps the others through next(): slow-start keeps no-logout", async () => {
    const { rpc } = startMock("slow-start=150,no-logout");
    try {
      const started = Date.now();
      const init = await rpc.request("initialize", { protocolVersion: 1 });
      expect(Date.now() - started >= 140).toBe(true);
      expect(field(init, "agentCapabilities", "auth", "logout")).toBeUndefined();
      expect(field(init, "agentInfo", "name")).toBe(MOCK_AGENT_NAME);
    } finally {
      await rpc.close();
    }
  });

  test("a superseded prompt replies cancelled before the newer one streams", async () => {
    const { rpc } = startMock("stall");
    try {
      await rpc.request("initialize", { protocolVersion: 1 }); // id 1
      const sessionId = field(await rpc.request("session/new", { cwd: "/w", mcpServers: [] }), "sessionId"); // id 2
      const first = rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "one" }] }); // id 3
      while (rpc.updates.length === 0) await new Promise((r) => setTimeout(r, 10));
      const second = rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "two" }] }); // id 4
      expect(field(await first, "stopReason")).toBe("cancelled");
      while (rpc.updates.length < 2) await new Promise((r) => setTimeout(r, 10));
      rpc.notify("session/cancel", { sessionId });
      expect(field(await second, "stopReason")).toBe("cancelled");
      expect(rpc.order).toEqual(["reply:1", "reply:2", "update", "reply:3", "update", "reply:4"]);
    } finally {
      await rpc.close();
    }
  });
});
