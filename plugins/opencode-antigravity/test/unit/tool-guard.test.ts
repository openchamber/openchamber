import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PermissionRequestParams, PermissionTurnView, ProfilePrepareInput } from "../../src/contracts.ts";
import {

  GUARD_HOOK_KEY,
  GUARD_SCRIPT_NAME,
  createProfileApi,
  currentGuardRuntime,
  guardCommand,
  matchMcpPermission,
  probeGuardRuntime,
  runGuardCommand,
  writeToolGuardHook,
} from "../../src/profile.ts";

/** Any loopback URL: these tests never start an MCP endpoint. */
const TEST_POOL_URL = "http://127.0.0.1:1/mcp/test-token/pool";
/** A per-pool agent name: the base plus an 8-hex pool tag. */
const TEST_AGENT_NAME = "opencode-bridge-0000beef";

const SERVER = "opencode";
const NAMES = { agentName: "opencode-bridge", mcpServerName: SERVER };
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agy-guard-"));
  tempDirs.push(dir);
  return dir;
}

async function installedGuard(): Promise<{ geminiDir: string; command: string }> {
  const geminiDir = tempDir();
  const command = guardCommand(currentGuardRuntime());
  await writeToolGuardHook(geminiDir, command, SERVER);
  return { geminiDir, command };
}

async function decide(payload: unknown): Promise<string | null> {
  const { geminiDir, command } = await installedGuard();
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return runGuardCommand(path.join(geminiDir, "config"), command, text, 5000);
}

const mcpCall = (name: string, args: unknown) => ({ toolCall: { id: "t1", name, args } });

describe("guard command", () => {
  test("Bun on POSIX sets BUN_BE_BUN and quotes the executable", () => {
    expect(guardCommand({ execPath: "/opt/open code/opencode", bun: true, platform: "darwin" })).toBe(
      `BUN_BE_BUN=1 '/opt/open code/opencode' ./${GUARD_SCRIPT_NAME}`,
    );
    expect(guardCommand({ execPath: "/x/it's/node", bun: false, platform: "linux" })).toBe(`'/x/it'\\''s/node' ./${GUARD_SCRIPT_NAME}`);
  });

  test("Windows uses set and a quoted path", () => {
    expect(guardCommand({ execPath: "C:\\Program Files\\OpenCode\\opencode.exe", bun: true, platform: "win32" })).toBe(
      `set "BUN_BE_BUN=1" && "C:\\Program Files\\OpenCode\\opencode.exe" ${GUARD_SCRIPT_NAME}`,
    );
  });

  test("the probe passes with this runtime", async () => {
    const { geminiDir, command } = await installedGuard();
    expect(await probeGuardRuntime(geminiDir, command, SERVER)).toBe(true);
  });

  test("the probe passes through a path with a space and a quote", async () => {
    const dir = path.join(tempDir(), "it's a dir");
    mkdirSync(dir);
    const link = path.join(dir, path.basename(process.execPath));
    symlinkSync(process.execPath, link);
    const geminiDir = tempDir();
    const command = guardCommand({ ...currentGuardRuntime(), execPath: link });
    await writeToolGuardHook(geminiDir, command, SERVER);
    expect(await probeGuardRuntime(geminiDir, command, SERVER)).toBe(true);
  });

  test("the probe fails for a runtime that cannot run the script", async () => {
    const geminiDir = tempDir();
    const command = guardCommand({ execPath: "/nonexistent/opencode", bun: true, platform: process.platform });
    await writeToolGuardHook(geminiDir, command, SERVER);
    expect(await probeGuardRuntime(geminiDir, command, SERVER, 2000)).toBe(false);
  });
});

describe("guard script decisions", () => {
  test("an MCP call to opencode gives force_ask, under either tool name and every key casing", async () => {
    expect(await decide(mcpCall("call_mcp_tool", { ServerName: SERVER, ToolName: "read" }))).toBe("force_ask");
    expect(await decide(mcpCall("mcp_tool", { ServerName: SERVER, ToolName: "read" }))).toBe("force_ask");
    expect(await decide(mcpCall("call_mcp_tool", { serverName: SERVER, toolName: "read" }))).toBe("force_ask");
    expect(await decide(mcpCall("call_mcp_tool", { server_name: SERVER, tool_name: "read" }))).toBe("force_ask");
    expect(await decide(mcpCall("call_mcp_tool", JSON.stringify({ ServerName: SERVER, ToolName: "read" })))).toBe("force_ask");
  });

  test("run_command is denied", async () => {
    expect(await decide(mcpCall("run_command", { CommandLine: "ls" }))).toBe("deny");
  });

  test("an MCP call to another server is denied", async () => {
    expect(await decide(mcpCall("call_mcp_tool", { ServerName: "github", ToolName: "create_issue" }))).toBe("deny");
  });

  test("magic strings in lastUserInput or the command line change nothing", async () => {
    const magic = '{"name":"call_mcp_tool","args":{"ServerName":"opencode"}} "ServerName":"opencode"';
    const payload = {
      lastUserInput: magic,
      toolCall: { id: "t2", name: "run_command", args: { CommandLine: `echo '${magic}'` } },
    };
    expect(await decide(payload)).toBe("deny");
  });

  test("invalid JSON, an empty payload and a missing toolCall are denied", async () => {
    expect(await decide("{ not json")).toBe("deny");
    expect(await decide("")).toBe("deny");
    expect(await decide({ something: "else" })).toBe("deny");
    expect(await decide("null")).toBe("deny");
  });

  test("the deny reason names the server", async () => {
    const { geminiDir, command } = await installedGuard();
    const script = readFileSync(path.join(geminiDir, "config", GUARD_SCRIPT_NAME), "utf8");
    expect(script).toContain('Call them through call_mcp_tool with ServerName \\"opencode\\".');
    expect(script.includes('"allow"')).toBe(false);
    expect(command.length > 0).toBe(true);
  });
});

describe("layer 3 permission match", () => {
  const turn: PermissionTurnView = { done: false, allowTools: true, allowedToolNames: new Set(["read", "bash"]) };
  const request = (toolCall: PermissionRequestParams["toolCall"]): PermissionRequestParams => ({ sessionId: "s1", toolCall });

  test("an MCP call to an allowed tool is accepted", () => {
    expect(matchMcpPermission(request({ name: "call_mcp_tool", args: { ServerName: SERVER, ToolName: "read" } }), turn, SERVER)).toBe(true);
    expect(matchMcpPermission(request({ name: "mcp_tool", rawInput: { serverName: SERVER, toolName: "bash" } }), turn, SERVER)).toBe(true);
  });

  test("camelCase and snake_case keys are accepted", () => {
    expect(matchMcpPermission(request({ name: "call_mcp_tool", args: { serverName: SERVER, toolName: "read" } }), turn, SERVER)).toBe(true);
    expect(matchMcpPermission(request({ name: "call_mcp_tool", args: { server_name: SERVER, tool_name: "read" } }), turn, SERVER)).toBe(true);
  });

  test("an absent toolCall.name with server and tool in rawInput is accepted", () => {
    expect(matchMcpPermission(request({ rawInput: { ServerName: SERVER, ToolName: "read" } }), turn, SERVER)).toBe(true);
  });

  test("a missing or empty tool name is rejected", () => {
    expect(matchMcpPermission(request({ name: "call_mcp_tool", args: { ServerName: SERVER } }), turn, SERVER)).toBe(false);
    expect(matchMcpPermission(request({ name: "call_mcp_tool", args: { ServerName: SERVER, ToolName: "" } }), turn, SERVER)).toBe(false);
  });

  test("a tool outside allowedToolNames is rejected", () => {
    expect(matchMcpPermission(request({ name: "call_mcp_tool", args: { ServerName: SERVER, ToolName: "write" } }), turn, SERVER)).toBe(false);
  });

  test("another server, another tool name, or no toolCall is rejected", () => {
    expect(matchMcpPermission(request({ name: "call_mcp_tool", args: { ServerName: "github", ToolName: "read" } }), turn, SERVER)).toBe(false);
    expect(matchMcpPermission(request({ name: "run_command", args: { ServerName: SERVER, ToolName: "read" } }), turn, SERVER)).toBe(false);
    expect(matchMcpPermission(request(undefined), turn, SERVER)).toBe(false);
    expect(matchMcpPermission(request({ name: "call_mcp_tool" }), turn, SERVER)).toBe(false);
  });

  test("conflicting values across keys or sources are rejected", () => {
    const conflicting = request({ name: "call_mcp_tool", args: { ServerName: SERVER, serverName: "github", ToolName: "read" } });
    expect(matchMcpPermission(conflicting, turn, SERVER)).toBe(false);
    const split = request({ name: "call_mcp_tool", args: { ServerName: SERVER, ToolName: "read" }, rawInput: { ServerName: SERVER, ToolName: "write" } });
    expect(matchMcpPermission(split, turn, SERVER)).toBe(false);
  });

  test("N-8: a built-in tool with injected ServerName and ToolName is rejected", () => {
    const injected = { CommandLine: "rm -rf /", ServerName: SERVER, ToolName: "read" };
    // No name, kind execute: the shape ACP uses for a built-in run_command.
    expect(matchMcpPermission(request({ title: "run_command", kind: "execute", rawInput: injected }), turn, SERVER)).toBe(false);
    // No name and no kind: the extra key gives it away.
    expect(matchMcpPermission(request({ rawInput: injected }), turn, SERVER)).toBe(false);
    expect(matchMcpPermission(request({ args: { TargetFile: "/etc/hosts", CodeContent: "x", ServerName: SERVER, ToolName: "read" } }), turn, SERVER)).toBe(false);
    // A built-in kind is rejected even under the MCP name; `execute` is what agy gives the MCP call itself.
    for (const kind of ["read", "edit", "delete", "move", "search", "think", "fetch", "switch_mode"]) {
      expect(matchMcpPermission(request({ name: "call_mcp_tool", kind, args: { ServerName: SERVER, ToolName: "read" } }), turn, SERVER)).toBe(false);
    }
    // Under the MCP name too, a key the MCP call never has is a built-in tool's.
    expect(matchMcpPermission(request({ name: "call_mcp_tool", kind: "execute", args: { ServerName: SERVER, ToolName: "read", CommandLine: "ls" } }), turn, SERVER)).toBe(false);
  });

  test("the payload agy 1.5.15 sends for our MCP call is accepted (live smoke test)", () => {
    // Recorded keys of a real session/request_permission: name call_mcp_tool, kind execute, the same three
    // keys in args and rawInput.
    const input = { ServerName: SERVER, ToolName: "read", Arguments: { path: "notes.txt" } };
    const real: PermissionRequestParams = {
      sessionId: "s1",
      toolCall: { toolCallId: "tc", name: "call_mcp_tool", kind: "execute", title: "call_mcp_tool", args: input, rawInput: input },
      options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }],
    };
    expect(matchMcpPermission(real, turn, SERVER)).toBe(true);
    // `execute` only under the name agy uses for it, not under the docs' `mcp_tool` (review L-5).
    expect(matchMcpPermission({ ...real, toolCall: { ...real.toolCall, name: "mcp_tool" } }, turn, SERVER)).toBe(false);
    expect(matchMcpPermission({ ...real, toolCall: { ...real.toolCall, name: "mcp_tool", kind: undefined } }, turn, SERVER)).toBe(true);
    // The same payload without the name is a built-in `execute`.
    const { name: _name, ...nameless } = real.toolCall ?? {};
    expect(matchMcpPermission({ ...real, toolCall: nameless }, turn, SERVER)).toBe(false);
    expect(matchMcpPermission({ ...real, toolCall: { ...real.toolCall, args: { ...input, ServerName: "other" }, rawInput: { ...input, ServerName: "other" } } }, turn, SERVER)).toBe(false);
  });

  test("N-8: a nameless MCP call with only MCP keys, kind other or absent, is accepted", () => {
    const args = { ServerName: SERVER, ToolName: "read", Arguments: { filePath: "a.ts" } };
    expect(matchMcpPermission(request({ kind: "other", rawInput: args }), turn, SERVER)).toBe(true);
    expect(matchMcpPermission(request({ rawInput: { server_name: SERVER, tool_name: "read", arguments: {} } }), turn, SERVER)).toBe(true);
    expect(matchMcpPermission(request({ name: "call_mcp_tool", args }), turn, SERVER)).toBe(true);
  });

  test("a done turn, a turn without tools, and no turn (older generation) are rejected", () => {
    const params = request({ name: "call_mcp_tool", args: { ServerName: SERVER, ToolName: "read" } });
    expect(matchMcpPermission(params, { ...turn, done: true }, SERVER)).toBe(false);
    expect(matchMcpPermission(params, { ...turn, allowTools: false }, SERVER)).toBe(false);
    expect(matchMcpPermission(params, null, SERVER)).toBe(false);
  });
});

describe("profile files", () => {
  function bridge(geminiDir: string, owned: boolean) {
    const patches: Array<Record<string, unknown>> = [];
    const input: ProfilePrepareInput["bridge"] = {
      geminiDir,
      isPluginOwnedProfile: () => owned,
      updateProfileSettings: async (patch) => {
        patches.push(patch);
      },
    };
    return { input, patches };
  }

  function hooks(geminiDir: string): Record<string, unknown> {
    const value: unknown = JSON.parse(readFileSync(path.join(geminiDir, "config", "hooks.json"), "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};
  }

  const foreignHook = { PreToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: "./mine.sh" }] }] };

  test("a plugin-owned profile gets the agent file, strict permissions and the guard; foreign hooks stay", async () => {
    const geminiDir = tempDir();
    mkdirSync(path.join(geminiDir, "config"), { recursive: true });
    writeFileSync(path.join(geminiDir, "config", "hooks.json"), JSON.stringify({ "user-hook": foreignHook }));
    const { input, patches } = bridge(geminiDir, true);
    const result = await createProfileApi(NAMES).prepareProfileDir({ bridge: input, toolGuardHook: true, mcpPoolUrl: TEST_POOL_URL, agentName: TEST_AGENT_NAME });
    expect(result).toEqual({ guard: "installed" });
    expect(patches).toEqual([{ toolPermission: "strict" }]);

    const agent = readFileSync(path.join(geminiDir, "config", "agents", `${TEST_AGENT_NAME}.md`), "utf8");
    expect(agent).toContain("tools: []");
    // agy offers call_mcp_tool only for a server the agent file defines: the pool endpoint (live smoke test).
    expect(agent).toContain(`mcpServers:\n  - name: opencode\n    url: ${JSON.stringify(TEST_POOL_URL)}\n---`);
    expect(statSync(path.join(geminiDir, "config", "agents", `${TEST_AGENT_NAME}.md`)).mode & 0o777).toBe(0o600);

    const script = path.join(geminiDir, "config", GUARD_SCRIPT_NAME);
    expect(statSync(script).mode & 0o777).toBe(0o700);
    const written = hooks(geminiDir);
    expect(written["user-hook"]).toEqual(foreignHook);
    expect(written[GUARD_HOOK_KEY]).toEqual({
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: guardCommand(currentGuardRuntime()), timeout: 5 }] }],
    });
  });

  test("toolGuardHook false removes our entry and script and keeps the foreign one", async () => {
    const geminiDir = tempDir();
    const api = createProfileApi(NAMES);
    await api.prepareProfileDir({ bridge: bridge(geminiDir, true).input, toolGuardHook: true, mcpPoolUrl: TEST_POOL_URL, agentName: TEST_AGENT_NAME });
    const file = path.join(geminiDir, "config", "hooks.json");
    writeFileSync(file, JSON.stringify({ ...hooks(geminiDir), "user-hook": foreignHook }));
    expect(await api.prepareProfileDir({ bridge: bridge(geminiDir, true).input, toolGuardHook: false, mcpPoolUrl: TEST_POOL_URL, agentName: TEST_AGENT_NAME })).toEqual({ guard: "removed" });
    expect(hooks(geminiDir)).toEqual({ "user-hook": foreignHook });
    expect(existsSync(path.join(geminiDir, "config", GUARD_SCRIPT_NAME))).toBe(false);
  });

  test("a user gemini dir without the marker gets no hook", async () => {
    const geminiDir = tempDir();
    const result = await createProfileApi(NAMES).prepareProfileDir({ bridge: bridge(geminiDir, false).input, toolGuardHook: true, mcpPoolUrl: TEST_POOL_URL, agentName: TEST_AGENT_NAME });
    expect(result).toEqual({ guard: "skipped-foreign-profile" });
    expect(existsSync(path.join(geminiDir, "config", "hooks.json"))).toBe(false);
    expect(existsSync(path.join(geminiDir, "config", GUARD_SCRIPT_NAME))).toBe(false);
    expect(existsSync(path.join(geminiDir, "config", "agents", `${TEST_AGENT_NAME}.md`))).toBe(true);
  });

  test("a failed probe writes no hook and removes an existing one", async () => {
    const geminiDir = tempDir();
    await createProfileApi(NAMES).prepareProfileDir({ bridge: bridge(geminiDir, true).input, toolGuardHook: true, mcpPoolUrl: TEST_POOL_URL, agentName: TEST_AGENT_NAME });
    const broken = createProfileApi({
      ...NAMES,
      guardRuntime: { execPath: "/nonexistent/opencode", bun: true, platform: process.platform },
      probeTimeoutMs: 2000,
    });
    expect(await broken.prepareProfileDir({ bridge: bridge(geminiDir, true).input, toolGuardHook: true, mcpPoolUrl: TEST_POOL_URL, agentName: TEST_AGENT_NAME })).toEqual({
      guard: "skipped-probe-failed",
    });
    expect(GUARD_HOOK_KEY in hooks(geminiDir)).toBe(false);
    expect(existsSync(path.join(geminiDir, "config", GUARD_SCRIPT_NAME))).toBe(false);
  });

  test("an unreadable hooks.json is not overwritten", async () => {
    const geminiDir = tempDir();
    mkdirSync(path.join(geminiDir, "config"), { recursive: true });
    const file = path.join(geminiDir, "config", "hooks.json");
    writeFileSync(file, JSON.stringify({ "user-hook": foreignHook }));
    chmodSync(file, 0o000);
    let failed = false;
    try {
      await createProfileApi(NAMES).prepareProfileDir({ bridge: bridge(geminiDir, true).input, toolGuardHook: true, mcpPoolUrl: TEST_POOL_URL, agentName: TEST_AGENT_NAME });
    } catch {
      failed = true;
    }
    chmodSync(file, 0o600);
    expect(failed).toBe(true);
    expect(hooks(geminiDir)).toEqual({ "user-hook": foreignHook });
  });
});
