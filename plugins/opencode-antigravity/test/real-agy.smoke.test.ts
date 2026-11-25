// Opt-in smoke test against the real `agy` binary (SR 11.3). Skipped unless `AGY_SMOKE=1`.
//
//   AGY_SMOKE=1 bun test test/real-agy.smoke.test.ts
//
// Binary: T3 Code's active release under `~/.t3/tools/antigravity-acp/<platform>/versions/*` (read
// only), else the plugin's managed one. Every run uses a throwaway gemini dir and TMPDIR, the plugin's
// runtime env (`SSH_CONNECTION` set, so agy never opens a browser) and the runtime flags, and writes
// nothing outside its temp dir.
//
// Without a sign-in: identity and capabilities, signed-out `authenticate` and `session/new`, the hook
// matcher syntax (`agy plugin validate`, offline), and whether `<gemini>/config/hooks.json` loads with
// `--include-default-customizations=false`. The last one needs a session, so it authenticates with
// `gemini-api-key` and a made-up key: agy then sends one model request that Google rejects with
// "API key not valid". No account is involved.
//
// With a signed-in plugin profile (`AGY_SMOKE_GEMINI_DIR=<gemini dir>`, a copy is fine): a tools turn
// through `call_mcp_tool` with the guard on (step 2), and resume after a restart keeping the
// `_meta` append (step 3). Steps 1 and 4 to 9 need a person reading agy's log and stay manual.

import { describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AcpClient, AcpError, type AcpCapabilities } from "../src/acp-client.ts";
import { isSignInRequired } from "../src/auth/errors.ts";
import { createInstallAuthBridge, getAuthManager } from "../src/auth/manager.ts";
import { updateProfileSettings } from "../src/auth/settings.ts";
import { resolveRuntimeConfig } from "../src/config.ts";
import { AGENT_NAME, DEFAULT_TIMINGS, HEADER_DIRECTORY, HEADER_PROXY_TOKEN, HEADER_SESSION, MARKER_ACCESS, MCP_SERVER_NAME } from "../src/constants.ts";
import type { OpenAiMessage } from "../src/contracts.ts";
import { getBinaryManager } from "../src/install/binary-manager.ts";
import { resolveInstallAuthConfig } from "../src/install/config.ts";
import { agyBaseArgs, buildAgyEnv } from "../src/install/env.ts";
import { managedDirs, resolveDataDir } from "../src/install/paths.ts";
import { agyTarget, detectMusl } from "../src/install/platform.ts";
import { inspectActive } from "../src/install/release.ts";
import { findT3Binary } from "../src/install/resolve.ts";
import { compareSemver, MIN_AGY_VERSION } from "../src/install/verify.ts";
import { GUARD_HOOK_KEY, prepareProfileDir } from "../src/profile.ts";
import { AntigravityProxy } from "../src/proxy.ts";
import { systemClock } from "../src/stall-watchdog.ts";
import { MOCK_NO_BROWSER_MESSAGE } from "./fixtures/mock-agy.ts";
import { READ_TOOL, realSessionModules, summarize, toolRound, user, type ChatResult } from "./fixtures/proxy-harness.ts";
import { FakeInstallAuthBridge } from "./fixtures/fake-bridge.ts";

/** Any loopback URL: these tests never start an MCP endpoint. */
const TEST_POOL_URL = "http://127.0.0.1:1/mcp/test-token/pool";
/** A per-pool agent name: the base plus an 8-hex pool tag. */
const TEST_AGENT_NAME = "opencode-bridge-0000beef";


const SMOKE = process.env.AGY_SMOKE === "1";
const SIGNED_IN_GEMINI_DIR = process.env.AGY_SMOKE_GEMINI_DIR ?? "";

async function findRealBinary(): Promise<{ path: string; version: string } | null> {
  const target = agyTarget(process.platform, process.arch, detectMusl());
  if (!target) return null;
  const t3 = await findT3Binary(process.env, target);
  if (t3) return t3;
  const managed = await inspectActive(managedDirs(resolveDataDir(process.env), target), { executableName: target.executableName });
  return managed.status === "valid" ? { path: managed.executable, version: managed.version } : null;
}

const BINARY = SMOKE ? await findRealBinary() : null;
if (SMOKE && !BINARY) process.stderr.write("[smoke] AGY_SMOKE=1 but no agy binary was found under ~/.t3 or the managed dir; skipping.\n");
const RUN = SMOKE && BINARY !== null;
const BIN = BINARY?.path ?? "";

interface Workspace {
  root: string;
  geminiDir: string;
  tmp: string;
  cwd: string;
  logFile: string;
}

function workspace(): Workspace {
  const root = mkdtempSync(path.join(tmpdir(), "agy-smoke-"));
  const geminiDir = path.join(root, "gemini");
  const ws = { root, geminiDir, tmp: path.join(root, "tmp"), cwd: path.join(root, "work"), logFile: path.join(geminiDir, "antigravity-acp", "log", "smoke.log") };
  for (const dir of [ws.tmp, ws.cwd, path.dirname(ws.logFile)]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return ws;
}

/** The runtime env of the plugin; `extra` is merged after it. Refuses to run without `SSH_CONNECTION`. */
function runtimeEnv(ws: Workspace, extra: Record<string, string> = {}): Record<string, string> {
  const env = buildAgyEnv({ kind: "runtime", tmpDir: ws.tmp, config: { geminiDir: ws.geminiDir, isolatedAuth: true, authMethod: "oauth-personal", auth: {} } });
  if (env.SSH_CONNECTION === undefined || env.BROWSER !== undefined) throw new Error("the runtime env would let agy open a browser");
  return { ...env, ...extra };
}

interface Agy {
  client: AcpClient;
  child: ChildProcessWithoutNullStreams;
  signInLines: string[];
  stderr: () => string;
  stop: () => Promise<void>;
}

function startAgy(ws: Workspace, opts: { env?: Record<string, string>; customizationsFlag?: boolean } = {}): Agy {
  const args = [
    ...agyBaseArgs(ws.geminiDir),
    ...(opts.customizationsFlag === false ? [] : ["--include-default-customizations=false"]),
    "--disable-telemetry",
    "--agent",
    TEST_AGENT_NAME,
    "--log-file",
    ws.logFile,
  ];
  const child = spawn(BIN, args, { cwd: ws.cwd, env: runtimeEnv(ws, opts.env), stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 65_536) stderr += chunk.toString("utf8");
  });
  const signInLines: string[] = [];
  const client = new AcpClient({
    transport: child,
    generation: 1,
    clock: systemClock,
    timings: DEFAULT_TIMINGS,
    allowPermission: () => false,
    onSignInLine: (stream) => signInLines.push(stream),
  });
  return {
    client,
    child,
    signInLines,
    stderr: () => stderr,
    stop: async () => {
      child.stdin.end();
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      if (child.exitCode === null) child.kill("SIGTERM");
      await exited;
      clearTimeout(timer);
    },
  };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

function cleanup(ws: Workspace): void {
  rmSync(ws.root, { recursive: true, force: true });
}

describe.skipIf(!RUN)("real agy, no sign-in (SR 11.3)", () => {
  test("initialize: the identity and capabilities the runtime relies on", async () => {
    const ws = workspace();
    const agy = startAgy(ws);
    try {
      const caps: AcpCapabilities = await agy.client.initialize();
      process.stderr.write(`[smoke] ${BIN} reports ${caps.agentName ?? "?"} ${caps.agentVersion ?? "?"}\n`);
      expect(caps.agentName).toBe("Antigravity ACP Server");
      expect(compareSemver(caps.agentVersion ?? "0.0.0", MIN_AGY_VERSION)).toBeGreaterThanOrEqual(0);
      expect(caps.canResume).toBe(true);
      expect(caps.canClose).toBe(true);
      expect(caps.appendsSystemPrompt).toBe(true);
      expect(caps.steers).toBe(true);
    } finally {
      await agy.stop();
      cleanup(ws);
    }
  }, 30_000);

  test("signed out: authenticate fails at once with the no-browser error, session/new with -32000; both are sign-in errors", async () => {
    const ws = workspace();
    const agy = startAgy(ws);
    try {
      await agy.client.initialize();
      const started = Date.now();
      const err = await rejection(agy.client.authenticate("oauth-personal"));
      const tookMs = Date.now() - started;
      expect(err).toBeInstanceOf(AcpError);
      if (!(err instanceof AcpError)) return;
      process.stderr.write(`[smoke] signed-out authenticate: ${err.code} after ${tookMs} ms\n`);
      expect(err.code).toBe(-32603);
      expect(err.message).toBe(MOCK_NO_BROWSER_MESSAGE); // the fake agy answers with the same text
      expect(isSignInRequired(err)).toBe(true);
      expect(tookMs).toBeLessThan(5000);
      // 1.5.15 prints no "Open the following link" line on a signed-out authenticate.
      expect(agy.signInLines).toEqual([]);
      const newErr = await rejection(agy.client.newSession({ cwd: ws.cwd, mcpServers: [], append: null }));
      expect(newErr).toBeInstanceOf(AcpError);
      if (newErr instanceof AcpError) {
        expect(newErr.code).toBe(-32000);
        expect(isSignInRequired(newErr)).toBe(true);
      }
    } finally {
      await agy.stop();
      cleanup(ws);
    }
  }, 30_000);

  test("hook matchers: the guard's \"*\" passes agy's validator, an invalid regex is flagged", async () => {
    const ws = workspace();
    try {
      // The exact hooks.json entry the plugin writes, in a plugin dir the validator reads.
      const bridge = new FakeInstallAuthBridge({ geminiDir: ws.geminiDir });
      const { guard } = await prepareProfileDir({ bridge, toolGuardHook: true, mcpPoolUrl: TEST_POOL_URL, agentName: TEST_AGENT_NAME }, { agentName: AGENT_NAME, mcpServerName: MCP_SERVER_NAME });
      expect(guard).toBe("installed");
      const written: unknown = JSON.parse(readFileSync(path.join(ws.geminiDir, "config", "hooks.json"), "utf8"));
      const ours = typeof written === "object" && written !== null && GUARD_HOOK_KEY in written ? Reflect.get(written, GUARD_HOOK_KEY) : null;
      expect(ours).not.toBeNull();
      const pluginDir = path.join(ws.root, "plugin");
      mkdirSync(pluginDir);
      writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify({ name: "smoke", displayName: "Smoke", description: "smoke", version: "1.0.0" }));
      const bad = { PreToolUse: [{ matcher: "(", hooks: [{ type: "command", command: "true" }] }] };
      const dotStar = { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: "true" }] }] };
      writeFileSync(path.join(pluginDir, "hooks.json"), JSON.stringify({ [GUARD_HOOK_KEY]: ours, "smoke-bad": bad, "smoke-dotstar": dotStar }));
      const result = spawnSync(BIN, ["plugin", "validate", pluginDir], { env: runtimeEnv(ws), cwd: ws.root, encoding: "utf8", timeout: 30_000, input: "" });
      const out = `${result.stdout}\n${result.stderr}`;
      process.stderr.write(`[smoke] plugin validate exit ${result.status}\n`);
      expect(out).toContain("Validation passed");
      expect(out).toContain('"smoke-bad"'); // the validator does check matchers
      expect(out).not.toContain(`"${GUARD_HOOK_KEY}"`);
      expect(out).not.toContain('"smoke-dotstar"');
    } finally {
      cleanup(ws);
    }
  }, 60_000);

  test("hooks.json under <gemini>/config loads with --include-default-customizations=false (invalid API key, one rejected model call)", async () => {
    const ws = workspace();
    const recorded = path.join(ws.root, "session-start.jsonl");
    const bridge = new FakeInstallAuthBridge({ geminiDir: ws.geminiDir });
    await prepareProfileDir({ bridge, toolGuardHook: true, mcpPoolUrl: TEST_POOL_URL, agentName: TEST_AGENT_NAME }, { agentName: AGENT_NAME, mcpServerName: MCP_SERVER_NAME });
    await updateProfileSettings(ws.geminiDir, { toolPermission: "strict" });
    // A second hook next to the guard records SessionStart, which fires on the first prompt. Hooks run
    // with the dir holding hooks.json as cwd, so the script path is relative.
    const configDir = path.join(ws.geminiDir, "config");
    const hooksFile = path.join(configDir, "hooks.json");
    const hooks: unknown = JSON.parse(readFileSync(hooksFile, "utf8"));
    writeFileSync(
      path.join(configDir, "smoke-recorder.mjs"),
      [
        'import { appendFileSync } from "node:fs";',
        "const chunks = [];",
        "for await (const c of process.stdin) chunks.push(c);",
        "let event = null;",
        'try { event = JSON.parse(Buffer.concat(chunks).toString("utf8")).hookEventName ?? null; } catch {}',
        `appendFileSync(${JSON.stringify(recorded)}, JSON.stringify({ cwd: process.cwd(), event }) + "\\n");`,
        'process.stdout.write("{}\\n");',
        "",
      ].join("\n"),
    );
    const recorder = `BUN_BE_BUN=1 '${process.execPath.replace(/'/g, `'\\''`)}' ./smoke-recorder.mjs`;
    writeFileSync(
      hooksFile,
      JSON.stringify({ ...(typeof hooks === "object" && hooks !== null ? hooks : {}), "smoke-session-start": { SessionStart: [{ type: "command", command: recorder, timeout: 10 }] } }),
    );
    const agy = startAgy(ws, { env: { GEMINI_API_KEY: "smoke-test-key-not-valid" } });
    try {
      await agy.client.initialize();
      await agy.client.authenticate("gemini-api-key");
      const session = await agy.client.newSession({ cwd: ws.cwd, mcpServers: [], append: "Smoke test session." });
      await agy.client.prompt(session.sessionId, [{ type: "text", text: "Reply with ok." }]).catch(() => null);
      const until = Date.now() + 10_000;
      while (!existsSync(recorded) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      const log = existsSync(ws.logFile) ? readFileSync(ws.logFile, "utf8") : "";
      expect(log).not.toContain("Failed to parse hooks file");
      expect(log).not.toContain(`Agent "${TEST_AGENT_NAME}" not found`);
      expect(existsSync(recorded)).toBe(true);
      const first: unknown = JSON.parse(readFileSync(recorded, "utf8").split("\n")[0] ?? "{}");
      process.stderr.write(`[smoke] SessionStart hook ran: ${JSON.stringify(first)}\n`);
      expect(first).toEqual({ cwd: realpathSync(path.join(ws.geminiDir, "config")), event: "SessionStart" });
    } finally {
      await agy.stop();
      cleanup(ws);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Signed-in steps. They talk to a real model and spend quota.
// ---------------------------------------------------------------------------

/** Debug lines of the signed-in proxies: metadata only (ids, plans, permission tool names and key names). */
const proxyLogs: string[] = [];

async function startRealProxy(dataDir: string): Promise<AntigravityProxy> {
  const env = { ...process.env, OPENCODE_ANTIGRAVITY_DATA_DIR: dataDir };
  const install = resolveInstallAuthConfig({ binaryPath: BIN, geminiDir: SIGNED_IN_GEMINI_DIR }, env);
  const binary = getBinaryManager(install.config, { env });
  const auth = getAuthManager(install.config, { env, binary });
  const bridge = createInstallAuthBridge(binary, auth, { env });
  const { config } = resolveRuntimeConfig({ debug: true }, {});
  const modules = realSessionModules({ dataDir, bridge, sessionStore: true });
  const proxy = new AntigravityProxy({
    ...modules,
    bridge,
    config,
    dataDir,
    baseArgs: agyBaseArgs,
    authStatus: () => auth.state.kind,
    log: (line) => proxyLogs.push(line),
  });
  await proxy.start();
  auth.attachRuntime(proxy.runtimeControl, proxy.createRunDir);
  return proxy;
}

/** A second PreToolUse hook next to the guard that records the tool name and argument keys it sees, never values. */
function addToolNameRecorder(file: string): void {
  const configDir = path.join(SIGNED_IN_GEMINI_DIR, "config");
  const hooksFile = path.join(configDir, "hooks.json");
  const hooks: unknown = existsSync(hooksFile) ? JSON.parse(readFileSync(hooksFile, "utf8")) : {};
  writeFileSync(
    path.join(configDir, "smoke-tool-recorder.mjs"),
    [
      'import { appendFileSync } from "node:fs";',
      "const chunks = [];",
      "for await (const c of process.stdin) chunks.push(c);",
      "let call = null;",
      'try { call = JSON.parse(Buffer.concat(chunks).toString("utf8")).toolCall ?? null; } catch {}',
      "const args = call && typeof call.args === \"object\" && call.args ? Object.keys(call.args) : [];",
      `appendFileSync(${JSON.stringify(file)}, JSON.stringify({ name: call?.name ?? null, argKeys: args }) + "\\n");`,
      // force_ask, like the guard: an empty answer counts as a deny.
      'process.stdout.write(JSON.stringify({ decision: "force_ask" }) + "\\n");',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const command = `BUN_BE_BUN=1 '${process.execPath.replace(/'/g, `'\\''`)}' ./smoke-tool-recorder.mjs`;
  const base = typeof hooks === "object" && hooks !== null ? hooks : {};
  writeFileSync(hooksFile, JSON.stringify({ ...base, "smoke-tool-recorder": { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: 5 }] }] } }), { mode: 0o600 });
}

function removeToolNameRecorder(): void {
  const configDir = path.join(SIGNED_IN_GEMINI_DIR, "config");
  const hooksFile = path.join(configDir, "hooks.json");
  if (existsSync(hooksFile)) {
    const hooks: unknown = JSON.parse(readFileSync(hooksFile, "utf8"));
    if (typeof hooks === "object" && hooks !== null) {
      Reflect.deleteProperty(hooks, "smoke-tool-recorder");
      writeFileSync(hooksFile, JSON.stringify(hooks), { mode: 0o600 });
    }
  }
  rmSync(path.join(configDir, "smoke-tool-recorder.mjs"), { force: true });
}

/** Spawns agy once and reads the account's real catalog; `AGY_SMOKE_MODEL` overrides the pick. */
async function liveModel(proxy: AntigravityProxy, cwd: string): Promise<string> {
  const { lease } = await proxy.process.acquire("discovery");
  try {
    await proxy.refreshModels(cwd);
  } finally {
    lease.release();
  }
  const ids = proxy.catalog.map((m) => m.id);
  process.stderr.write(`[smoke] live catalog: ${ids.join(", ")}\n`);
  const wanted = process.env.AGY_SMOKE_MODEL;
  const model = wanted && ids.includes(wanted) ? wanted : ids[0];
  if (!model) throw new Error("the account offers no models");
  return model;
}

async function chat(proxy: AntigravityProxy, cwd: string, messages: OpenAiMessage[], model: string): Promise<ChatResult> {
  const res = await fetch(`${proxy.url}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${MARKER_ACCESS}`,
      [HEADER_PROXY_TOKEN]: proxy.proxyToken,
      [HEADER_SESSION]: "ses_smoke",
      [HEADER_DIRECTORY]: encodeURIComponent(cwd),
    },
    body: JSON.stringify({ model, messages, tools: [READ_TOOL], stream: true }),
  });
  return summarize(res.status, res.headers, await res.text(), (res.headers.get("content-type") ?? "").includes("text/event-stream"));
}

function reportLogs(): void {
  for (const line of proxyLogs) {
    if (/permission|plan |session\/resume|mcp call|mcp pool|retry line|turn stalled|guard/.test(line)) process.stderr.write(`[smoke] ${line}\n`);
  }
}

describe.skipIf(!RUN || !SIGNED_IN_GEMINI_DIR)("real agy, signed-in profile (SR 11.3 steps 2 and 3)", () => {
  test("a tools turn goes through call_mcp_tool with the guard on; after a restart the resumed session still knows the protocol", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agy-smoke-signed-in-"));
    const cwd = path.join(root, "work");
    mkdirSync(cwd);
    writeFileSync(path.join(cwd, "notes.txt"), "The smoke word is pelican.\n");
    const seen = path.join(root, "hook-tool-names.jsonl");
    let proxy = await startRealProxy(path.join(root, "data"));
    try {
      process.stderr.write(`[smoke] guard: ${proxy.guardOutcome ?? "?"}\n`);
      addToolNameRecorder(seen);
      const model = await liveModel(proxy, cwd);
      process.stderr.write(`[smoke] model: ${model}\n`);
      const system: OpenAiMessage = { role: "system", content: "You are a coding assistant. Use the read tool when asked about files." };
      let messages: OpenAiMessage[] = [system, user("Use the read tool to read notes.txt, then tell me the smoke word.")];
      const r1 = await chat(proxy, cwd, messages, model);
      process.stderr.write(`[smoke] turn 1: status ${r1.status}, finish ${r1.finishReason ?? "none"}, calls ${r1.toolCalls.map((c) => c.name).join(",") || "none"}${r1.error ? `, error ${r1.error.code}` : ""}\n`);
      if (existsSync(seen)) process.stderr.write(`[smoke] hook saw: ${readFileSync(seen, "utf8").trim().split("\n").join(" ")}\n`);
      expect(r1.finishReason).toBe("tool_calls");
      expect(r1.toolCalls[0]?.name).toBe("read");
      expect(proxyLogs.some((l) => l.includes("permission allowed name=call_mcp_tool"))).toBe(true);
      messages = [...messages, ...toolRound(r1, () => "The smoke word is pelican.")];
      const r2 = await chat(proxy, cwd, messages, model);
      process.stderr.write(`[smoke] turn 2: finish ${r2.finishReason ?? "none"}, mentions pelican: ${r2.text.toLowerCase().includes("pelican")}\n`);
      expect(r2.text.toLowerCase()).toContain("pelican");
      messages = [...messages, { role: "assistant", content: r2.text }];

      await proxy.stop();
      proxy = await startRealProxy(path.join(root, "data"));
      const r3 = await chat(proxy, cwd, [...messages, user("Which tool do you call to run OpenCode tools, and with which ServerName? Answer in one line.")], model);
      process.stderr.write(`[smoke] after resume: ${r3.text.slice(0, 200)}\n`);
      // The restart resumed the stored ACP session (no fresh replay), and the model still names the protocol.
      expect(proxyLogs.some((l) => l.includes("session/resume failed"))).toBe(false);
      expect(proxyLogs.filter((l) => l.includes("plan append")).length).toBeGreaterThan(0);
      expect(r3.text).toContain("call_mcp_tool");
      expect(r3.text).toContain("opencode");
    } finally {
      reportLogs();
      removeToolNameRecorder();
      await proxy.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 600_000);
});
