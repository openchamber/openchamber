import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { AcpClient, AcpError, AcpTimeoutError, AgyExitedError, parseCapabilities } from "../../src/acp-client.ts";
import { AUTH_URL_STDOUT_PREFIX, SignInUrlLineError } from "../../src/auth/errors.ts";
import { DEFAULT_TIMINGS } from "../../src/constants.ts";
import type { PermissionRequestParams } from "../../src/contracts.ts";
import { FakeClock } from "../fixtures/fake-clock.ts";

interface Wire {
  client: AcpClient;
  clock: FakeClock;
  stdout: PassThrough;
  stderr: PassThrough;
  sent: Array<Record<string, unknown>>;
  signInLines: string[];
  permissions: PermissionRequestParams[];
}

function wire(allow = true): Wire {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const clock = new FakeClock();
  const sent: Array<Record<string, unknown>> = [];
  let buf = "";
  stdin.on("data", (c: Buffer) => {
    buf += c.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) !== -1) {
      const parsed: unknown = JSON.parse(buf.slice(0, i));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) sent.push(Object.fromEntries(Object.entries(parsed)));
      buf = buf.slice(i + 1);
    }
  });
  const signInLines: string[] = [];
  const permissions: PermissionRequestParams[] = [];
  const client = new AcpClient({
    transport: { stdin, stdout, stderr },
    generation: 1,
    clock,
    timings: DEFAULT_TIMINGS,
    allowPermission: (p) => {
      permissions.push(p);
      return allow;
    },
    onSignInLine: (s) => signInLines.push(s),
  });
  return { client, clock, stdout, stderr, sent, signInLines, permissions };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("AcpClient", () => {
  test("the sign-in line on stdout rejects the pending authenticate at once", async () => {
    const w = wire();
    const auth = w.client.authenticate("oauth-personal");
    w.stdout.write(`${AUTH_URL_STDOUT_PREFIX}https://accounts.google.com/o/oauth2/auth?state=secret\n`);
    const err = await rejection(auth);
    expect(err).toBeInstanceOf(SignInUrlLineError);
    expect(w.signInLines).toEqual(["stdout"]);
    expect(String(err)).not.toContain("state=secret");
    // Later requests fail the same way.
    expect(await rejection(w.client.newSession({ cwd: "/", mcpServers: [], append: null }))).toBeInstanceOf(SignInUrlLineError);
  });

  test("the sign-in line on stderr, even with a glog prefix and no newline yet", async () => {
    const w = wire();
    const auth = w.client.authenticate("oauth-personal");
    w.stderr.write(`I1124 10:00:00 1 x.go:1] ${AUTH_URL_STDOUT_PREFIX}https://accounts.google.com/x`);
    expect(await rejection(auth)).toBeInstanceOf(SignInUrlLineError);
    expect(w.signInLines).toEqual(["stderr"]);
  });

  test("every RPC except session/prompt times out (30 s, initialize 30 s, authenticate 60 s)", async () => {
    const w = wire();
    const init = w.client.initialize();
    const auth = w.client.authenticate("oauth-personal");
    const created = w.client.newSession({ cwd: "/", mcpServers: [], append: null });
    const resumed = w.client.resumeSession("s1", { cwd: "/", mcpServers: [], append: null });
    const config = w.client.setConfigOption("s1", "model", "m");
    const closed = w.client.closeSession("s1");
    let promptSettled = false;
    void w.client.prompt("s1", [{ type: "text", text: "hi" }]).then(
      () => (promptSettled = true),
      () => (promptSettled = true),
    );
    w.clock.advance(29_999);
    await tick();
    w.clock.advance(1);
    for (const p of [init, created, resumed, config, closed]) {
      const err = await rejection(p);
      expect(err).toBeInstanceOf(AcpTimeoutError);
    }
    w.clock.advance(30_000);
    expect(await rejection(auth)).toBeInstanceOf(AcpTimeoutError);
    w.clock.advance(3_600_000);
    await tick();
    expect(promptSettled).toBe(false);
  });

  test("replies resolve by id; errors become AcpError; exit rejects the rest", async () => {
    const w = wire();
    const created = w.client.newSession({ cwd: "/p", mcpServers: [], append: "APPEND" });
    const prompt = w.client.prompt("s1", [{ type: "text", text: "hi" }]);
    await tick();
    const newReq = w.sent.find((m) => m.method === "session/new");
    expect(newReq?.params).toEqual({ cwd: "/p", mcpServers: [], _meta: { antigravity: { systemPrompt: { append: "APPEND" } } } });
    w.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: newReq?.id, error: { code: -32603, message: "nope" } })}\n`);
    const err = await rejection(created);
    expect(err).toBeInstanceOf(AcpError);
    w.client.rejectAll(new AgyExitedError(137, null));
    expect(await rejection(prompt)).toBeInstanceOf(AgyExitedError);
  });

  test("config options: grouped and flat values flatten into one list (moved from the prototype's plugin.test.ts)", async () => {
    const w = wire();
    const created = w.client.newSession({ cwd: "/p", mcpServers: [], append: null });
    await tick();
    const newReq = w.sent.find((m) => m.method === "session/new");
    const configOptions = [
      {
        id: "model",
        category: "model",
        currentValue: "gemini-3.8-flash",
        options: [{ value: "gemini-3.8-flash", name: "Flash" }, { group: "Pro", options: [{ value: "gemini-4-neon", name: "Neon" }] }],
      },
    ];
    w.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: newReq?.id, result: { sessionId: "s9", configOptions } })}\n`);
    const result = await created;
    expect(result.sessionId).toBe("s9");
    expect(result.configOptions[0]?.values.map((v) => v.value)).toEqual(["gemini-3.8-flash", "gemini-4-neon"]);
    expect(result.configOptions[0]?.currentValue).toBe("gemini-3.8-flash");
  });

  test("permission requests: allow_once when allowed, never allow_always; fs callbacks refused", async () => {
    const w = wire(true);
    const options = [
      { optionId: "always", kind: "allow_always" },
      { optionId: "once", kind: "allow_once" },
      { optionId: "deny", kind: "reject_once" },
    ];
    w.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9000, method: "session/request_permission", params: { sessionId: "s1", toolCall: { name: "call_mcp_tool", args: { ServerName: "opencode", ToolName: "read" } }, options } })}\n`);
    w.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9001, method: "fs/read_text_file", params: { path: "/etc/passwd" } })}\n`);
    await tick();
    expect(w.permissions[0]?.toolCall?.args).toEqual({ ServerName: "opencode", ToolName: "read" });
    expect(w.sent.find((m) => m.id === 9000)?.result).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
    expect(w.sent.find((m) => m.id === 9001)?.error).toEqual({ code: -32601, message: "Client capability disabled: fs/read_text_file" });

    const deny = wire(false);
    deny.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/request_permission", params: { sessionId: "s1", options } })}\n`);
    await tick();
    expect(deny.sent.find((m) => m.id === 1)?.result).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
  });

  test("a UTF-8 character cut across two stdout chunks arrives whole (O-5)", async () => {
    const w = wire();
    const seen: string[] = [];
    w.client.onSessionUpdate("s1", (u) => seen.push(u.text ?? ""));
    const line = Buffer.from(
      `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Привіт 👋" } } } })}\n`,
      "utf8",
    );
    const emoji = line.indexOf(Buffer.from("👋", "utf8"));
    w.stdout.write(line.subarray(0, emoji + 2)); // inside the 4-byte emoji
    await tick();
    w.stdout.write(line.subarray(emoji + 2));
    await tick();
    expect(seen).toEqual(["Привіт 👋"]);
  });

  test("permission requests carry toolCall.kind to layer 3 (N-8)", async () => {
    const w = wire(false);
    const params = { sessionId: "s1", toolCall: { kind: "execute", args: { ServerName: "opencode", ToolName: "read", CommandLine: "rm -rf /" } }, options: [] };
    w.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params })}\n`);
    await tick();
    expect(w.permissions[0]?.toolCall?.kind).toBe("execute");
  });

  test("session updates route by session id", async () => {
    const w = wire();
    const seen: string[] = [];
    const off = w.client.onSessionUpdate("s1", (u) => seen.push(`${u.kind}:${u.text ?? ""}`));
    w.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } } } })}\n`);
    w.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s2", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "b" } } } })}\n`);
    await tick();
    off();
    w.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "plan" } } })}\n`);
    await tick();
    expect(seen).toEqual(["agent_message_chunk:a"]);
  });

  test("capabilities from initialize", () => {
    const caps = parseCapabilities({
      agentInfo: { name: "Antigravity ACP Server", version: "1.5.15" },
      agentCapabilities: { sessionCapabilities: { resume: {}, close: {} }, _meta: { antigravity: { systemPrompt: { append: true } } } },
    });
    expect(caps).toEqual({ agentName: "Antigravity ACP Server", agentVersion: "1.5.15", canResume: true, canClose: true, appendsSystemPrompt: true, steers: true });
    expect(parseCapabilities({ agentInfo: { version: "1.4.9" }, agentCapabilities: {} })).toEqual({
      agentName: null,
      agentVersion: "1.4.9",
      canResume: false,
      canClose: false,
      appendsSystemPrompt: false,
      steers: false,
    });
  });
});
