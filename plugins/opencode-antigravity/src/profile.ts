// agy profile files this plugin owns (SR 4.4, 7.4, 9): the bridge agent, the PreToolUse guard (script
// plus its `hooks.json` entry) and the layer 3 permission match. `settings.json` belongs to the auth
// design and is written only through `updateProfileSettings`.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  PermissionRequestParams,
  PermissionTurnView,
  ProfileApi,
  ProfilePrepareInput,
  ToolGuardOutcome,
} from "./contracts.ts";
import { isRecord } from "./prompt.ts";

export const GUARD_HOOK_KEY = "opencode-bridge-guard";
export const GUARD_SCRIPT_NAME = "opencode-tool-guard.mjs";
/** Seconds agy waits for the hook. */
const GUARD_HOOK_TIMEOUT_S = 5;
const GUARD_PROBE_TIMEOUT_MS = 5000;
/**
 * The live smoke test (agy 1.5.15) saw `call_mcp_tool` in both the hook and the permission request.
 * `mcp_tool`, which agy's hook docs derive from the step type, stays accepted by name in the guard and
 * layer 3, but layer 3 takes `kind: "execute"` only under `call_mcp_tool` (review L-5).
 */
export const MCP_CALL_TOOL_NAMES: readonly string[] = ["call_mcp_tool", "mcp_tool"];

const SERVER_KEYS = ["ServerName", "serverName", "server_name"] as const;
const TOOL_KEYS = ["ToolName", "toolName", "tool_name"] as const;
/** Every key a `call_mcp_tool` call carries; a nameless request with any other key is a built-in tool. */
const MCP_CALL_KEYS = new Set<string>([...SERVER_KEYS, ...TOOL_KEYS, "Arguments", "arguments"]);
/** The name and ACP kind agy 1.5.15 gives the MCP call's permission request (live smoke test, SR 11.3 step 7). */
const MCP_CALL_NAME = "call_mcp_tool";
const MCP_CALL_KIND = "execute";
/** ACP tool kinds of agy's built-in tools. Only a request named `call_mcp_tool` may carry `execute`. */
const BUILT_IN_KINDS = new Set(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode"]);

export interface ProfileNames {
  /** `AGENT_NAME`: the base of each pool's agent name `<base>-<poolId8>`. */
  agentName: string;
  /** `MCP_SERVER_NAME`, the only server the guard and layer 3 let through. */
  mcpServerName: string;
}

/** What runs the guard script: the plugin's own runtime. */
export interface GuardRuntime {
  execPath: string;
  /** `process.versions.bun` is set: OpenCode 2.x, compiled or plain `bun`. */
  bun: boolean;
  platform: NodeJS.Platform;
}

export function currentGuardRuntime(): GuardRuntime {
  return { execPath: process.execPath, bun: typeof process.versions.bun === "string", platform: process.platform };
}

function shellQuotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * SR 7.4. The compiled `opencode` binary runs a script as Bun only with `BUN_BE_BUN=1`; for a plain
 * `bun` the variable is harmless. agy runs the command with `sh -c` (or `cmd /c`) in the dir that holds
 * `hooks.json`, so the script path is relative.
 */
export function guardCommand(runtime: GuardRuntime): string {
  if (runtime.platform === "win32") {
    const exe = `"${runtime.execPath}"`;
    return runtime.bun ? `set "BUN_BE_BUN=1" && ${exe} ${GUARD_SCRIPT_NAME}` : `${exe} ${GUARD_SCRIPT_NAME}`;
  }
  const exe = shellQuotePosix(runtime.execPath);
  return runtime.bun ? `BUN_BE_BUN=1 ${exe} ./${GUARD_SCRIPT_NAME}` : `${exe} ./${GUARD_SCRIPT_NAME}`;
}

/** The guard reads only `toolCall.name` and `toolCall.args`; it never prints `allow` and writes nothing to disk. */
function guardScriptSource(mcpServerName: string): string {
  const server = JSON.stringify(mcpServerName);
  const names = JSON.stringify(MCP_CALL_TOOL_NAMES);
  const reason = JSON.stringify(
    `Only OpenCode tools are available here. Call them through call_mcp_tool with ServerName "${mcpServerName}".`,
  );
  return `// Lets only OpenCode's MCP server through to the permission check; every other tool is denied.
const SERVER = ${server};
const NAMES = ${names};
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
let call;
try { call = JSON.parse(Buffer.concat(chunks).toString("utf8")).toolCall; } catch {}
const name = typeof call?.name === "string" ? call.name : "";
let args = call && typeof call === "object" ? call.args : undefined;
if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = undefined; } }
if (!args || typeof args !== "object") args = {};
const server = args.ServerName ?? args.serverName ?? args.server_name;
const ok = NAMES.includes(name) && server === SERVER;
process.stdout.write(JSON.stringify(ok
  ? { decision: "force_ask" }
  : { decision: "deny", reason: ${reason} }) + "\\n");
`;
}

function configDir(geminiDir: string): string {
  return path.join(geminiDir, "config");
}

async function writeAtomic(file: string, content: string, mode: number): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, content, { mode });
    await chmod(tmp, mode);
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

type JsonFile = { kind: "missing" } | { kind: "invalid" } | { kind: "ok"; value: Record<string, unknown> };

async function readJsonObject(file: string): Promise<JsonFile> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    // Any other read error must not look like an empty file: the rewrite would drop the user's hooks.
    if (isRecord(err) && err.code === "ENOENT") return { kind: "missing" };
    throw err;
  }
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? { kind: "ok", value } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

function hookEntry(command: string): Record<string, unknown> {
  return {
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: GUARD_HOOK_TIMEOUT_S }] }],
  };
}

async function writeGuardScript(geminiDir: string, mcpServerName: string): Promise<void> {
  const dir = configDir(geminiDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeAtomic(path.join(dir, GUARD_SCRIPT_NAME), guardScriptSource(mcpServerName), 0o700);
}

async function writeHookEntry(geminiDir: string, command: string): Promise<void> {
  const file = path.join(configDir(geminiDir), "hooks.json");
  const existing = await readJsonObject(file);
  if (existing.kind === "invalid") await rename(file, `${file}.corrupt-${Date.now()}`);
  const hooks = existing.kind === "ok" ? { ...existing.value } : {};
  hooks[GUARD_HOOK_KEY] = hookEntry(command);
  await writeAtomic(file, `${JSON.stringify(hooks, null, 2)}\n`, 0o600);
}

/** Writes the guard script (mode 0700) and our `hooks.json` key; every other hook is kept as is. */
export async function writeToolGuardHook(geminiDir: string, command: string, mcpServerName: string): Promise<void> {
  await writeGuardScript(geminiDir, mcpServerName);
  await writeHookEntry(geminiDir, command);
}

/** Deletes our `hooks.json` key and the guard script; every other hook stays. An unreadable `hooks.json` is left alone. */
export async function removeToolGuardHook(geminiDir: string): Promise<void> {
  const file = path.join(configDir(geminiDir), "hooks.json");
  const existing = await readJsonObject(file);
  if (existing.kind === "ok" && GUARD_HOOK_KEY in existing.value) {
    const hooks = { ...existing.value };
    delete hooks[GUARD_HOOK_KEY];
    await writeAtomic(file, `${JSON.stringify(hooks, null, 2)}\n`, 0o600);
  }
  await unlink(path.join(configDir(geminiDir), GUARD_SCRIPT_NAME)).catch(() => undefined);
}

/**
 * Runs a hook command the way agy does (`sh -c` or `cmd /c`, cwd = the dir holding `hooks.json`) with
 * `payload` on stdin. Returns the printed `decision`, or null on timeout, a bad exit or bad output.
 */
export function runGuardCommand(cwd: string, command: string, payload: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    const finish = (decision: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(decision);
    };
    const child = spawn(command, { cwd, shell: true, stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 65_536) stdout += chunk;
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0) return finish(null);
      const line = stdout.trim().split("\n").pop() ?? "";
      try {
        const value: unknown = JSON.parse(line);
        finish(isRecord(value) && typeof value.decision === "string" ? value.decision : null);
      } catch {
        finish(null);
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(payload);
  });
}

/** Sample hook payloads: an OpenCode MCP call and a shell command. */
function guardProbePayloads(mcpServerName: string): { mcp: string; other: string } {
  return {
    mcp: JSON.stringify({
      toolCall: { id: "probe-mcp", name: "call_mcp_tool", args: { ServerName: mcpServerName, ToolName: "read", Arguments: {} } },
    }),
    other: JSON.stringify({ toolCall: { id: "probe-cmd", name: "run_command", args: { CommandLine: "true" } } }),
  };
}

/** SR 7.4: the exact hook command must answer `force_ask` for an MCP call and `deny` for anything else. */
export async function probeGuardRuntime(
  geminiDir: string,
  command: string,
  mcpServerName: string,
  timeoutMs: number = GUARD_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const payloads = guardProbePayloads(mcpServerName);
  const cwd = configDir(geminiDir);
  const [mcp, other] = await Promise.all([
    runGuardCommand(cwd, command, payloads.mcp, timeoutMs),
    runGuardCommand(cwd, command, payloads.other, timeoutMs),
  ]);
  return mcp === "force_ask" && other === "deny";
}

/**
 * The custom agent with no built-in tools. agy 1.5.15 gives it `call_mcp_tool` only for an MCP server
 * its own frontmatter defines; a name-only entry exposes the tools natively as `mcp_<server>_<tool>`
 * instead, and with no entry the agent has no MCP at all (live smoke test). The entry points at the
 * proxy's pool endpoint, which routes each call by its conversation id; sessions also get their own
 * per-session server of the same name through `session/new`.
 */
function bridgeAgentFile(names: ProfileNames, agentName: string, mcpPoolUrl: string): string {
  return [
    "---",
    `name: ${agentName}`,
    "description: OpenCode provider bridge agent (MCP tools only)",
    "mainAgent: true",
    "tools: []",
    "mcpServers:",
    `  - name: ${names.mcpServerName}`,
    `    url: ${JSON.stringify(mcpPoolUrl)}`,
    "---",
    `You are acting as a model backend for OpenCode. Execute tools only through call_mcp_tool on ServerName "${names.mcpServerName}". Never call list_resources, read_resource, or manage_task.`,
    "",
  ].join("\n");
}

export interface ProfileOptions extends ProfileNames {
  guardRuntime?: GuardRuntime;
  probeTimeoutMs?: number;
}

/**
 * Pool start: agent file, `toolPermission: "strict"` through the bridge, then the guard. The guard is
 * written only in a plugin-owned profile, and only after its exact command passed the probe.
 */
export async function prepareProfileDir(
  input: ProfilePrepareInput,
  options: ProfileOptions,
): Promise<{ guard: ToolGuardOutcome }> {
  const { geminiDir } = input.bridge;
  const agentsDir = path.join(configDir(geminiDir), "agents");
  await mkdir(agentsDir, { recursive: true, mode: 0o700 });
  // Mode 0600: the file holds the MCP token. One file per pool (review L-1).
  if (!isPoolAgentName(options.agentName, input.agentName)) throw new Error("The agent name must be the base name plus a pool tag.");
  await writeAtomic(agentFile(geminiDir, input.agentName), bridgeAgentFile(options, input.agentName, input.mcpPoolUrl), 0o600);
  await input.bridge.updateProfileSettings({ toolPermission: "strict" });

  if (!input.toolGuardHook) {
    await removeToolGuardHook(geminiDir);
    return { guard: "removed" };
  }
  // A user's own gemini dir: a global hook there would deny tools in their own agy sessions.
  if (!input.bridge.isPluginOwnedProfile()) return { guard: "skipped-foreign-profile" };

  const command = guardCommand(options.guardRuntime ?? currentGuardRuntime());
  await writeGuardScript(geminiDir, options.mcpServerName);
  const ok = await probeGuardRuntime(geminiDir, command, options.mcpServerName, options.probeTimeoutMs);
  if (!ok) {
    await removeToolGuardHook(geminiDir);
    return { guard: "skipped-probe-failed" };
  }
  await writeHookEntry(geminiDir, command);
  return { guard: "installed" };
}

/** Every value the sources hold under any of `keys`. */
function valuesOf(sources: readonly Record<string, unknown>[], keys: readonly string[]): unknown[] {
  const values: unknown[] = [];
  for (const source of sources) {
    for (const key of keys) if (source[key] !== undefined) values.push(source[key]);
  }
  return values;
}

/** One non-empty string that every value agrees on, or null. */
function agreed(values: readonly unknown[]): string | null {
  const first = values[0];
  if (typeof first !== "string" || first.length === 0) return null;
  return values.every((value) => value === first) ? first : null;
}

/**
 * Layer 3 (SR 7.4 rules 1 to 4). The caller has already mapped `params.sessionId` to a turn of the
 * current generation; a null turn is a rejection. A built-in tool kind is a rejection. Server and
 * tool names are read from `args` and `rawInput` under each casing, and every value found has to agree.
 */
export function matchMcpPermission(
  params: PermissionRequestParams,
  turn: PermissionTurnView | null,
  mcpServerName: string,
): boolean {
  if (!turn || turn.done || !turn.allowTools) return false;
  const call = params.toolCall;
  if (!call) return false;
  const named = call.name !== undefined && call.name !== "";
  if (named && !MCP_CALL_TOOL_NAMES.includes(call.name ?? "")) return false;
  // agy 1.5.15 sends the MCP call as `name: "call_mcp_tool"`, `kind: "execute"` (live smoke test). Any
  // other built-in kind, and `execute` without that name, is a built-in tool.
  if (call.kind !== undefined && BUILT_IN_KINDS.has(call.kind) && !(call.name === MCP_CALL_NAME && call.kind === MCP_CALL_KIND)) return false;
  const sources = [call.args, call.rawInput].filter(isRecord);
  // Only the shape of the arguments says this is the MCP call: a built-in tool with injected ServerName
  // and ToolName still carries its own keys (CommandLine, TargetFile, ...).
  if (sources.some((source) => Object.keys(source).some((key) => !MCP_CALL_KEYS.has(key)))) return false;
  const server = agreed(valuesOf(sources, SERVER_KEYS));
  const tool = agreed(valuesOf(sources, TOOL_KEYS));
  if (server !== mcpServerName || tool === null) return false;
  return turn.allowedToolNames.has(tool);
}

function agentFile(geminiDir: string, agentName: string): string {
  return path.join(configDir(geminiDir), "agents", `${agentName}.md`);
}

const POOL_TAG = /^[0-9a-f]{8}$/;

/** `<base>-<8 hex>`: the only names this module writes, deletes or sweeps. */
function isPoolAgentName(base: string, name: string): boolean {
  return name.startsWith(`${base}-`) && POOL_TAG.test(name.slice(base.length + 1));
}

export async function removeAgentFile(geminiDir: string, base: string, agentName: string): Promise<void> {
  if (!isPoolAgentName(base, agentName)) return;
  await unlink(agentFile(geminiDir, agentName)).catch(() => undefined);
}

export function removeAgentFileSync(geminiDir: string, base: string, agentName: string): void {
  if (!isPoolAgentName(base, agentName)) return;
  try {
    unlinkSync(agentFile(geminiDir, agentName));
  } catch {
    // Already gone.
  }
}

/** Per-pool files of dead pools; the pre-per-pool shared `<base>.md` only when no other process uses the profile. */
export async function sweepAgentFiles(geminiDir: string, base: string, livePoolTags: ReadonlySet<string>, othersAlive: boolean): Promise<void> {
  const dir = path.join(configDir(geminiDir), "agents");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const file of names) {
    if (!file.endsWith(".md")) continue;
    const name = file.slice(0, -3);
    const stale = isPoolAgentName(base, name) ? !livePoolTags.has(name.slice(base.length + 1)) : name === base && !othersAlive;
    if (stale) await unlink(path.join(dir, file)).catch(() => undefined);
  }
}

export function createProfileApi(options: ProfileOptions): ProfileApi {
  return {
    prepareProfileDir: (input) => prepareProfileDir(input, options),
    matchMcpPermission: (params, turn) => matchMcpPermission(params, turn, options.mcpServerName),
    removeAgentFile: (geminiDir, agentName) => removeAgentFile(geminiDir, options.agentName, agentName),
    removeAgentFileSync: (geminiDir, agentName) => removeAgentFileSync(geminiDir, options.agentName, agentName),
    sweepAgentFiles: (geminiDir, tags, othersAlive) => sweepAgentFiles(geminiDir, options.agentName, tags, othersAlive),
  };
}
