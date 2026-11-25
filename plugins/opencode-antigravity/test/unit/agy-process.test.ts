import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { AgyExitedError } from "../../src/acp-client.ts";
import { AgyProcessManager, BreakerOpenError, type AgyChild, type ExitInfo, type Spawner } from "../../src/agy-process.ts";
import { resolveRuntimeConfig } from "../../src/config.ts";
import type { RunDir } from "../../src/contracts.ts";
import { FakeInstallAuthBridge } from "../fixtures/fake-bridge.ts";
import { FakeClock } from "../fixtures/fake-clock.ts";

type Behavior = "ok" | "crash-on-start" | "unauth" | "hold-init";

class FakeChild implements AgyChild {
  readonly pid: number;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly args: readonly string[];
  exited = false;
  killedWith: string[] = [];
  private exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  private releaseInit: (() => void) | null = null;

  constructor(pid: number, args: readonly string[], behavior: Behavior) {
    this.pid = pid;
    this.args = args;
    let buf = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const msg: unknown = JSON.parse(line);
        if (typeof msg !== "object" || msg === null || !("method" in msg) || !("id" in msg)) continue;
        const id = msg.id;
        if (msg.method === "initialize") {
          if (behavior === "crash-on-start") return void this.exit(1, null);
          const answer = (): void =>
            this.send({ jsonrpc: "2.0", id, result: { agentInfo: { name: "Antigravity ACP Server", version: "1.5.15" }, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } } });
          if (behavior === "hold-init") this.releaseInit = answer;
          else answer();
        } else if (msg.method === "authenticate") {
          if (behavior === "unauth") this.send({ jsonrpc: "2.0", id, error: { code: -32000, message: "Authentication required" } });
          else this.send({ jsonrpc: "2.0", id, result: {} });
        }
      }
    });
    this.stdin.on("finish", () => this.exit(0, null));
  }

  answerInit(): void {
    this.releaseInit?.();
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.exited) this.stdout.write(`${JSON.stringify(msg)}\n`);
  }

  exit(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    queueMicrotask(() => {
      for (const l of this.exitListeners) l(code, signal);
    });
  }

  kill(signal: NodeJS.Signals): void {
    this.killedWith.push(signal);
    this.exit(null, signal);
  }

  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.exitListeners.push(listener);
  }
}

function setup(opts: { behavior?: Behavior; options?: Record<string, unknown> } = {}) {
  const clock = new FakeClock();
  const { config } = resolveRuntimeConfig({ idleShutdownMs: 600_000, breakerCooldownMs: 30_000, ...opts.options }, {});
  const bridge = new FakeInstallAuthBridge({ geminiDir: "/tmp/agy-unit-gemini", binaryPath: "/fake/agy" });
  const children: FakeChild[] = [];
  let behavior: Behavior = opts.behavior ?? "ok";
  const spawner: Spawner = (_file, args) => {
    const child = new FakeChild(1000 + children.length, args, behavior);
    children.push(child);
    return child;
  };
  const exits: ExitInfo[] = [];
  const released: string[] = [];
  const manager = new AgyProcessManager({
    config,
    install: bridge,
    baseArgs: (g) => ["acp", "--gemini-dir", g, "--app-data-dir", "antigravity-acp"],
    createRunDir: async (): Promise<RunDir> => {
      const path = `/tmp/agy-unit-run-${children.length}`;
      return { path, release: async () => void released.push(path) };
    },
    dataDir: "/tmp/agy-unit-data",
    allowPermission: () => false,
    onExit: (info) => exits.push(info),
    clock,
    spawner,
  });
  bridge.attachRuntime({ stop: (r) => manager.stop(r), hold: (r) => manager.hold(r) });
  return {
    clock,
    bridge,
    manager,
    children,
    exits,
    released,
    setBehavior: (b: Behavior) => {
      behavior = b;
    },
  };
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("AgyProcessManager", () => {
  test("concurrent acquires join one start; args carry the runtime flags", async () => {
    const s = setup();
    const [a, b] = await Promise.all([s.manager.acquire("turn"), s.manager.acquire("turn")]);
    expect(s.children).toHaveLength(1);
    expect(a.gen.generation).toBe(1);
    expect(b.gen.generation).toBe(1);
    expect(s.manager.state).toBe("ready");
    const args = s.children[0]?.args ?? [];
    expect(args.slice(0, 5)).toEqual(["acp", "--gemini-dir", "/tmp/agy-unit-gemini", "--app-data-dir", "antigravity-acp"]);
    expect(args).toContain("--include-default-customizations=false");
    expect(args).toContain("--disable-telemetry");
    expect(args[args.indexOf("--agent") + 1]).toBe("opencode-bridge");
    expect(args[args.indexOf("--log-file") + 1]).toMatch(/antigravity-acp\/log\/opencode-\d{8}T\d{6}-\d+-1\.log$/);
    expect(args).not.toContain("--process-per-session");
    expect(s.bridge.calls.beforeSpawn).toBe(1);
    expect(s.bridge.calls.reportAuthenticated).toBe(1);
    expect(s.bridge.calls.buildSpawnEnv).toEqual([{ tmpDir: "/tmp/agy-unit-run-0" }]);
  });

  test("processPerSession adds the flag", async () => {
    const s = setup({ options: { processPerSession: true } });
    await s.manager.acquire("turn");
    expect(s.children[0]?.args).toContain("--process-per-session");
  });

  test("stop twice returns one promise; acquire during stopping waits, then spawns generation 2", async () => {
    const s = setup();
    const { lease } = await s.manager.acquire("turn");
    lease.release();
    const first = s.manager.stop("idle");
    const second = s.manager.stop("auth-changed");
    expect(second).toBe(first);
    expect(s.manager.state).toBe("stopping");
    const next = s.manager.acquire("turn");
    await first;
    const acquired = await next;
    expect(acquired.gen.generation).toBe(2);
    expect(s.children).toHaveLength(2);
    expect(s.exits[0]?.expected).toBe(true);
    expect(s.exits[0]?.reason).toBe("idle");
    expect(s.released).toContain("/tmp/agy-unit-run-0");
  });

  test("stop during starting kills the child at once, without waiting out initialize; waiters get agy_exited", async () => {
    const s = setup({ behavior: "hold-init" });
    const waiter = s.manager.acquire("turn");
    await tick();
    expect(s.manager.state).toBe("starting");
    const stopped = s.manager.stop("auth-changed");
    expect(s.children[0]?.killedWith).toEqual(["SIGTERM"]);
    await stopped;
    expect(await rejection(waiter)).toBeInstanceOf(AgyExitedError);
    expect(s.manager.state).toBe("stopped");
    expect(s.children[0]?.exited).toBe(true);
    expect(s.exits[0]?.reason).toBe("auth-changed");
  });

  test("draining keeps existing leases on the old generation; new ones get a new generation", async () => {
    const s = setup();
    const old = await s.manager.acquire("turn");
    s.bridge.setBinary("/fake/agy-2", "1.5.16");
    expect(s.manager.state).toBe("draining");
    let fresh: Awaited<ReturnType<AgyProcessManager["acquire"]>> | null = null;
    const pending = s.manager.acquire("turn").then((r) => {
      fresh = r;
    });
    await tick();
    expect(fresh).toBeNull();
    expect(s.children[0]?.exited).toBe(false);
    old.lease.release();
    await pending;
    expect(old.gen.generation).toBe(1);
    expect(s.manager.generation).toBe(2);
    expect(s.exits[0]?.reason).toBe("binary-changed");
  });

  test("draining: a request waiting longer than drainWaitMs stops the old child; without one nothing stops (O-6)", async () => {
    const s = setup();
    const old = await s.manager.acquire("turn");
    s.bridge.setBinary("/fake/agy-2", "1.5.16");
    s.clock.advance(3_600_000); // no request waits: the parked lease keeps the old child as long as it likes
    expect(s.manager.state).toBe("draining");
    expect(s.manager.drainDeadline).toBeNull();
    let fresh: Awaited<ReturnType<AgyProcessManager["acquire"]>> | null = null;
    const pending = s.manager.acquire("turn").then((r) => {
      fresh = r;
    });
    await tick();
    expect(s.manager.drainDeadline).toBe(s.clock.now() + 30_000);
    s.clock.advance(29_999);
    await tick();
    expect(fresh).toBeNull();
    s.clock.advance(1);
    await pending;
    expect(s.children[0]?.exited).toBe(true);
    expect(s.exits[0]?.reason).toBe("binary-changed");
    expect(s.manager.generation).toBe(2);
    old.lease.release(); // late release of the old generation changes nothing
    expect(s.manager.state).toBe("ready");
  });

  test("stop during starting before any child exists resolves at once; the start then spawns nothing (O-1)", async () => {
    const s = setup();
    const unblock = s.bridge.blockSpawns(); // beforeSpawn waits, as during a logout
    const acquiring = rejection(s.manager.acquire("turn"));
    await tick();
    expect(s.manager.state).toBe("starting");
    let stopped = false;
    void s.manager.stop("auth-changed").then(() => {
      stopped = true;
    });
    await tick();
    expect(stopped).toBe(true);
    unblock();
    await acquiring;
    expect(s.children).toHaveLength(0);
    expect(s.manager.state).toBe("stopped");
    expect((await s.manager.acquire("turn")).gen.generation).toBe(2);
  });

  test("three crashes during starting open the breaker; it closes after the cooldown", async () => {
    const s = setup({ behavior: "crash-on-start" });
    for (let i = 0; i < 3; i++) expect(await rejection(s.manager.acquire("turn"))).toBeInstanceOf(AgyExitedError);
    expect(s.manager.state).toBe("broken");
    const err = await rejection(s.manager.acquire("turn"));
    expect(err).toBeInstanceOf(BreakerOpenError);
    expect(err instanceof BreakerOpenError ? err.retryAfterMs : 0).toBe(30_000);
    expect(s.children).toHaveLength(3);
    s.clock.advance(30_000);
    expect(s.manager.state).toBe("stopped");
    s.setBehavior("ok");
    expect((await s.manager.acquire("turn")).gen.generation).toBe(4);
  });

  test("a sign-in failure does not count toward the breaker and is reported", async () => {
    const s = setup({ behavior: "unauth" });
    for (let i = 0; i < 4; i++) await rejection(s.manager.acquire("turn"));
    expect(s.manager.state).toBe("stopped");
    expect(s.bridge.calls.reportSignInRequired.length).toBe(4);
  });

  test("beforeSpawn rejecting never spawns", async () => {
    const s = setup();
    s.bridge.signOut();
    const err = await rejection(s.manager.acquire("turn"));
    expect(s.bridge.isSignInRequired(err)).toBe(true);
    expect(s.children).toHaveLength(0);
    expect(s.bridge.calls.reportSignInRequired).toEqual([]);
  });

  test("idle stop after idleShutdownMs with zero leases; a login hold keeps it alive", async () => {
    const s = setup();
    const { lease } = await s.manager.acquire("turn");
    lease.release();
    s.clock.advance(599_999);
    expect(s.manager.state).toBe("ready");
    const hold = s.manager.hold("login");
    s.clock.advance(3_600_000);
    expect(s.manager.state).toBe("ready");
    hold.release();
    s.clock.advance(600_000);
    await tick();
    expect(s.manager.state).toBe("stopped");
    expect(s.exits[0]?.reason).toBe("idle");
  });

  test("an acquire clears the idle timer", async () => {
    const s = setup();
    (await s.manager.acquire("turn")).lease.release();
    s.clock.advance(500_000);
    const second = await s.manager.acquire("turn");
    s.clock.advance(500_000);
    expect(s.manager.state).toBe("ready");
    second.lease.release();
    s.clock.advance(600_000);
    await tick();
    expect(s.manager.state).toBe("stopped");
  });

  test("abandoned turns: three within 10 min stop the process as wedged", async () => {
    const s = setup();
    const { gen } = await s.manager.acquire("turn");
    s.manager.reportAbandoned(gen.generation);
    s.manager.reportAbandoned(gen.generation);
    expect(s.manager.state).toBe("ready");
    s.manager.reportAbandoned(gen.generation);
    await tick();
    expect(s.manager.state).toBe("stopped");
    expect(s.exits[0]?.reason).toBe("wedged");
  });

  test("one abandoned turn and no RPC settled for stallTimeoutMs is wedged", async () => {
    const s = setup({ options: { stallTimeoutMs: 180_000 } });
    const { gen } = await s.manager.acquire("turn");
    s.manager.reportAbandoned(gen.generation);
    s.clock.advance(150_000);
    expect(s.manager.state).toBe("ready");
    s.clock.advance(30_000);
    await tick();
    expect(s.manager.state).toBe("stopped");
    expect(s.manager.abandonedTurns).toBe(0);
  });

  test("RPC timeouts count toward the wedged check", async () => {
    const s = setup();
    const { gen } = await s.manager.acquire("turn");
    for (let i = 0; i < 3; i++) void gen.client.closeSession(`s${i}`).catch(() => {});
    await tick();
    s.clock.advance(30_000);
    await tick();
    expect(s.manager.state).toBe("stopped");
    expect(s.exits[0]?.reason).toBe("wedged");
  });

  test("a child that never exits after SIGKILL still ends in stopped", async () => {
    const s = setup();
    const { lease } = await s.manager.acquire("turn");
    lease.release();
    const child = s.children[0];
    if (child) {
      child.kill = (signal) => {
        child.killedWith.push(signal);
      };
      child.stdin.removeAllListeners("finish");
    }
    const stopped = s.manager.stop("shutdown");
    for (let i = 0; i < 6; i++) {
      await tick();
      s.clock.advance(5_000);
    }
    await stopped;
    expect(child?.killedWith).toEqual(["SIGTERM", "SIGKILL"]);
    expect(s.manager.state).toBe("stopped");
    expect(s.exits[0]?.signal).toBe("SIGKILL");
  });

  test("an unexpected exit while ready is a crash: pending RPCs reject, exit is not expected", async () => {
    const s = setup();
    const { gen } = await s.manager.acquire("turn");
    const pending = gen.client.prompt("s1", [{ type: "text", text: "x" }]);
    s.children[0]?.exit(137, null);
    expect(await rejection(pending)).toBeInstanceOf(AgyExitedError);
    expect(s.exits[0]).toEqual({ generation: 1, code: 137, signal: null, expected: false, reason: null, uptimeMs: 0 });
    expect(s.manager.state).toBe("stopped");
  });
});
