// Profile files through the real proxy start with the real WP-B2 profile module (SR 7.4, 11.2): the
// agent file, the PreToolUse guard and its hooks.json entry, and `toolPermission` through the bridge.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GUARD_HOOK_KEY, GUARD_SCRIPT_NAME, runGuardCommand } from "../../src/profile.ts";
import { resolveRuntimeConfig } from "../../src/config.ts";
import { AntigravityProxy } from "../../src/proxy.ts";
import { Harness, SYSTEM, TEST_TIMINGS, realSessionModules, toolRound, user, type HarnessOptions } from "../fixtures/proxy-harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

/** `before` runs after the dirs exist and before the proxy start prepares the profile. */
async function harness(opts: HarnessOptions = {}, before?: (h: Harness) => void): Promise<Harness> {
  const h = new Harness({ scenario: "tools", realModules: true, ...opts });
  open.push(h);
  before?.(h);
  return h.start();
}

/** This plugin's per-pool agent files. */
function agentFiles(h: Harness): string[] {
  try {
    return readdirSync(path.join(configDir(h), "agents")).filter((f) => /^opencode-bridge-[0-9a-f]{8}\.md$/.test(f)).sort();
  } catch {
    return [];
  }
}

function configDir(h: Harness): string {
  return path.join(h.geminiDir, "config");
}

function readHooks(h: Harness): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path.join(configDir(h), "hooks.json"), "utf8"));
  return typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};
}

function guardCommandOf(hooks: Record<string, unknown>): string {
  const entry = hooks[GUARD_HOOK_KEY];
  const text = JSON.stringify(entry);
  const match = /"command":"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!match?.[1]) throw new Error("no guard command");
  const parsed: unknown = JSON.parse(`"${match[1]}"`);
  return typeof parsed === "string" ? parsed : "";
}

const FOREIGN = { PreToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: "echo mine" }] }] };

function writeForeignHook(h: Harness): void {
  mkdirSync(configDir(h), { recursive: true });
  writeFileSync(path.join(configDir(h), "hooks.json"), `${JSON.stringify({ "my-hook": FOREIGN })}\n`);
}

describe("profile files (SR 7.4)", () => {
  test("a plugin-owned profile gets the guard (script 0700, hooks.json entry), and the guard decides like the design says", async () => {
    const h = await harness({}, writeForeignHook);
    const script = path.join(configDir(h), GUARD_SCRIPT_NAME);
    expect(existsSync(script)).toBe(true);
    if (process.platform !== "win32") expect(statSync(script).mode & 0o777).toBe(0o700);
    const hooks = readHooks(h);
    expect(hooks["my-hook"]).toEqual(FOREIGN);
    const ours = JSON.stringify(hooks[GUARD_HOOK_KEY]);
    expect(ours).toContain('"PreToolUse"');
    expect(ours).toContain('"matcher":"*"');
    expect(h.proxy.guardOutcome).toBe("installed");

    const command = guardCommandOf(hooks);
    const mcp = JSON.stringify({ toolCall: { name: "mcp_tool", args: { ServerName: "opencode", ToolName: "read" } } });
    const shell = JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: "cat ~/.ssh/id_rsa" } } });
    expect(await runGuardCommand(configDir(h), command, mcp, 5000)).toBe("force_ask");
    expect(await runGuardCommand(configDir(h), command, shell, 5000)).toBe("deny");
  });

  test("toolGuardHook: false removes our entry and script and keeps the foreign hook", async () => {
    const h = await harness({ options: { toolGuardHook: false } }, (w) => {
      mkdirSync(configDir(w), { recursive: true });
      const hooks = { "my-hook": FOREIGN, [GUARD_HOOK_KEY]: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "old" }] }] } };
      writeFileSync(path.join(configDir(w), "hooks.json"), `${JSON.stringify(hooks)}\n`);
      writeFileSync(path.join(configDir(w), GUARD_SCRIPT_NAME), "// stale\n");
    });
    const hooks = readHooks(h);
    expect(hooks[GUARD_HOOK_KEY]).toBeUndefined();
    expect(hooks["my-hook"]).toEqual(FOREIGN);
    expect(existsSync(path.join(configDir(h), GUARD_SCRIPT_NAME))).toBe(false);
    expect(h.proxy.guardOutcome).toBe("removed");
  });

  test("a user gemini dir without the plugin marker gets no hook, and tools still work through layer 3", async () => {
    const h = await harness({ bridge: { pluginOwnedProfile: false } });
    expect(h.proxy.guardOutcome).toBe("skipped-foreign-profile");
    expect(existsSync(path.join(configDir(h), "hooks.json"))).toBe(false);
    expect(existsSync(path.join(configDir(h), GUARD_SCRIPT_NAME))).toBe(false);
    const messages = [SYSTEM, user("read")];
    const r1 = await h.chat({ messages });
    expect(r1.finishReason).toBe("tool_calls");
    const r2 = await h.chat({ messages: [...messages, ...toolRound(r1, () => "ok")] });
    expect(r2.text).toBe("TOOL_RESULT:ok");
  });

  test("the agent file names this pool's MCP endpoint, mode 0600, never the proxy token; toolPermission went through updateProfileSettings", async () => {
    const h = await harness();
    // A tool turn, so the MCP token exists and is in use.
    const r1 = await h.chat({ messages: [SYSTEM, user("read")] });
    expect(r1.finishReason).toBe("tool_calls");
    const files = agentFiles(h);
    expect(files).toHaveLength(1);
    const name = files[0]?.slice(0, -3) ?? "";
    expect(name).toMatch(/^opencode-bridge-[0-9a-f]{8}$/);
    // agy runs exactly this pool's agent.
    expect(h.journal().find((e) => e.method === "process/start")?.params.agent).toBe(name);
    const file = path.join(configDir(h), "agents", files[0] ?? "");
    const agent = readFileSync(file, "utf8");
    expect(agent).toContain(`name: ${name}`);
    expect(agent).toContain("tools: []");
    expect(agent).not.toContain(h.proxy.proxyToken);
    // The token from the per-session MCP URL agy was given in session/new.
    const servers = JSON.stringify(h.journal().find((e) => e.method === "session/new")?.params.mcpServers ?? []);
    const mcpToken = /\/mcp\/([0-9a-f]+)\//.exec(servers)?.[1] ?? "";
    expect(mcpToken.length).toBeGreaterThan(10);
    // The token is in the file (agy needs the URL), so only the owner may read it, and no log line carries it.
    expect(agent).toContain(`url: "http://127.0.0.1:${h.proxy.port}/mcp/${mcpToken}/pool"`);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(h.logs.join("\n")).not.toContain(mcpToken);
    expect(h.bridge.calls.settingsPatches).toEqual([{ toolPermission: "strict" }]);
    expect(existsSync(path.join(h.geminiDir, "antigravity-acp", "settings.json"))).toBe(false); // the fake bridge owns the write
  });

  test("pool stop deletes its agent file; a restart writes a new one with the new port and token (review L-2)", async () => {
    const h = await harness();
    const before = agentFiles(h);
    expect(before).toHaveLength(1);
    await h.proxy.stop();
    expect(agentFiles(h)).toEqual([]);
    await h.restart();
    const after = agentFiles(h);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]);
    expect(readFileSync(path.join(configDir(h), "agents", after[0] ?? ""), "utf8")).toContain(`http://127.0.0.1:${h.proxy.port}/mcp/`);
  });

  test("two pools on one profile keep their own agent files; each agy runs its own pool's (review L-1)", async () => {
    const h = await harness();
    const { config } = resolveRuntimeConfig({ debug: true }, {}, TEST_TIMINGS);
    const second = new AntigravityProxy({
      ...realSessionModules({ dataDir: h.dataDir, bridge: h.bridge, sessionStore: false }),
      bridge: h.bridge,
      config,
      dataDir: h.dataDir,
      runRoot: h.runRoot,
      baseArgs: (g) => ["acp", "--gemini-dir", g, "--app-data-dir", "antigravity-acp"],
      discoverAfterSpawn: false,
    });
    await second.start();
    try {
      const files = agentFiles(h);
      expect(files).toHaveLength(2);
      const contents = files.map((f) => readFileSync(path.join(configDir(h), "agents", f), "utf8"));
      expect(contents.filter((c) => c.includes(`127.0.0.1:${h.proxy.port}/`))).toHaveLength(1);
      expect(contents.filter((c) => c.includes(`127.0.0.1:${second.port}/`))).toHaveLength(1);
      // The first pool's agy, started after the second pool, still runs the first pool's agent.
      await h.chat({ messages: [SYSTEM, user("hi")] });
      const started = h.journal().find((e) => e.method === "process/start")?.params.agent;
      const own = files.find((f) => readFileSync(path.join(configDir(h), "agents", f), "utf8").includes(`127.0.0.1:${h.proxy.port}/`))?.slice(0, -3);
      expect(started).toBe(own);
    } finally {
      await second.stop();
    }
    // The second pool's file is gone; the first one's stays while it runs.
    expect(agentFiles(h)).toHaveLength(1);
  });

  test("a spawn sweeps agent files of pools that are gone, and an earlier version's shared file (review L-1)", async () => {
    const h = await harness({}, (w) => {
      const agents = path.join(configDir(w), "agents");
      mkdirSync(agents, { recursive: true });
      writeFileSync(path.join(agents, "opencode-bridge-deadbeef.md"), "stale\n");
      writeFileSync(path.join(agents, "opencode-bridge.md"), "old shared file\n");
      writeFileSync(path.join(agents, "my-agent.md"), "the user's own\n");
    });
    await h.chat({ messages: [SYSTEM, user("hi")] });
    const files = agentFiles(h);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toBe("opencode-bridge-deadbeef.md");
    expect(existsSync(path.join(configDir(h), "agents", "opencode-bridge.md"))).toBe(false);
    expect(existsSync(path.join(configDir(h), "agents", "my-agent.md"))).toBe(true);
  });
});
