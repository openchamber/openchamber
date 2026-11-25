import { afterEach, describe, expect, test } from "bun:test";
import { SIGNED_OUT_MESSAGE, SIGN_IN_GATE_MESSAGE } from "../../src/auth/errors.ts";
import { HEADER_PROXY_TOKEN } from "../../src/constants.ts";
import type { OpenAiMessage } from "../../src/contracts.ts";
import { SYSTEM, startHarness, summarize, toolRound, user, waitFor, type Harness, type HarnessOptions } from "../fixtures/proxy-harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const h = await startHarness(opts);
  open.push(h);
  return h;
}

describe("install/auth bridge (SR 9, IA 15)", () => {
  test("login: a live turn fails with a retryable 503 and the old epoch's bindings are dropped", async () => {
    const h = await harness({ scenario: "stall-on=WAIT" });
    await h.chat({ messages: [SYSTEM, user("hello")], session: "ses_idle" });
    const pending = h.chat({ messages: [SYSTEM, user("WAIT")], session: "ses_live" });
    await waitFor(() => h.journal().filter((e) => e.method === "session/prompt").length === 2);
    h.bridge.changeAuth("login");
    const r = await pending;
    expect(r.error?.code).toBe(503);
    expect(r.error?.message).toBe("Antigravity sign-in changed. Retrying with the new account.");
    await waitFor(() => h.proxy.process.state === "stopped");
    // The idle binding of epoch 1 is treated as missing now.
    const again = await h.chat({ messages: [SYSTEM, user("hello"), { role: "assistant", content: "PLAIN_TEXT_OK" }, user("more")], session: "ses_idle" });
    expect(again.text).toBe("PLAIN_TEXT_OK");
    expect(h.modules.classified.at(-1)).toEqual({ kind: "fresh", reason: "no-binding" });
  });

  test("logout: the stop AuthManager awaits fails the live turn with 401", async () => {
    const h = await harness({ scenario: "stall-on=WAIT" });
    const pending = h.chat({ messages: [SYSTEM, user("WAIT")] });
    await waitFor(() => h.methods().includes("session/prompt"));
    await h.bridge.simulateLogout();
    const r = await pending;
    expect(r.error?.code).toBe(401);
    expect(r.error?.message).toBe(SIGNED_OUT_MESSAGE);
  });

  test("beforeSpawn rejecting gives 401 auth_required without a spawn", async () => {
    const h = await harness();
    h.bridge.signOut();
    const r = await h.chat({ messages: [SYSTEM, user("hi")] });
    expect(r.status).toBe(401);
    expect(r.headers.get("x-should-retry")).toBe("false");
    expect(r.error?.type).toBe("auth_required");
    expect(h.journal()).toEqual([]);
    expect(h.bridge.calls.resolveBinary).toBe(0);
  });

  test("onBinaryChanged drains: the running turn finishes on the old pid, the next request gets a new pid", async () => {
    const h = await harness({ scenario: "tools" });
    const messages: OpenAiMessage[] = [SYSTEM, user("read")];
    const r1 = await h.chat({ messages });
    h.bridge.setBinary(h.binary, "1.5.16");
    expect(h.proxy.process.state).toBe("draining");
    const r2 = await h.chat({ messages: [...messages, ...toolRound(r1)] });
    expect(r2.text).toBe("TOOL_RESULT:file contents");
    await waitFor(() => h.proxy.process.state === "stopped");
    h.setScenario("text");
    const r3 = await h.chat({ messages: [SYSTEM, user("new")], session: "ses_other" });
    expect(r3.text).toBe("PLAIN_TEXT_OK");
    const pids = h.journal().map((e) => e.pid);
    expect(new Set(pids).size).toBe(2);
  });

  test("auth-url-line: 401 within 1 s and reportSignInRequired is called", async () => {
    const h = await harness({ scenario: "auth-url-line", timings: { earlySseMs: 5000 } });
    const started = Date.now();
    const r = await h.chat({ messages: [SYSTEM, user("hi")] });
    expect(Date.now() - started).toBeLessThan(1000 + 500);
    expect(r.status).toBe(401);
    expect(r.error?.message).toBe(SIGNED_OUT_MESSAGE);
    expect(h.bridge.calls.reportSignInRequired).toEqual([SIGNED_OUT_MESSAGE]);
    expect(h.bridge.authState).toBe("signed_out");
  });

  test("a download in progress sends the download note; a fatal resolveBinary failure after SSE started is code 400", async () => {
    const h = await harness();
    const release = h.bridge.holdResolve({ phase: "downloading", bytes: 10 * 1_048_576, total: 100 * 1_048_576 });
    const pending = h.chat({ messages: [SYSTEM, user("hi")] });
    await new Promise((r) => setTimeout(r, 300));
    h.bridge.setBinaryMissing("Antigravity CLI could not be installed: no network.");
    release();
    const r = await pending;
    expect(r.status).toBe(200);
    expect(r.reasoning).toContain("[Antigravity] Downloading Google's Antigravity CLI (10 of 100 MB). This happens once.");
    expect(r.error).toEqual({ code: 400, type: "invalid_request_error", message: "Antigravity CLI could not be installed: no network." });
  });

  test("a missing binary before the stream is 503 with x-should-retry false", async () => {
    const h = await harness({ noBinary: true });
    const r = await h.chat({ messages: [SYSTEM, user("hi")] });
    expect(r.status).toBe(503);
    expect(r.headers.get("x-should-retry")).toBe("false");
  });

  test("the /v1 gate: proxy token first, then Bearer agy-managed; the old Bearer <secret> fallback is gone", async () => {
    const h = await harness();
    const post = (headers: Record<string, string>) =>
      fetch(`${h.proxy.url}/chat/completions`, { method: "POST", headers, body: JSON.stringify({ messages: [user("x")], tools: [] }) });
    const base = h.headers({ messages: [] });

    const noMarker = await post({ ...base, authorization: "Bearer something-else" });
    expect(noMarker.status).toBe(401);
    expect(noMarker.headers.get("x-should-retry")).toBe("false");
    const body = summarize(noMarker.status, noMarker.headers, await noMarker.text(), false);
    expect(body.error).toEqual({ code: 401, type: "auth_required", message: SIGN_IN_GATE_MESSAGE });

    const { [HEADER_PROXY_TOKEN]: _token, ...withoutToken } = base;
    const noToken = await post(withoutToken);
    expect(noToken.status).toBe(401);
    expect(summarize(401, noToken.headers, await noToken.text(), false).error?.message).toBe("Unauthorized");

    const oldFallback = await post({ ...withoutToken, authorization: `Bearer ${h.proxy.proxyToken}` });
    expect(oldFallback.status).toBe(401);

    const models = await fetch(`${h.proxy.url}/models`, { headers: { [HEADER_PROXY_TOKEN]: h.proxy.proxyToken } });
    expect(models.status).toBe(200);
    const modelsNoToken = await fetch(`${h.proxy.url}/models`);
    expect(modelsNoToken.status).toBe(401);

    const cors = await post({ ...base, origin: "https://evil.example" });
    expect(cors.status).toBe(403);

    // MCP lives under a secret path: the bare path and a wrong token are 404 (moved from e2e-proxy.test.ts).
    const mcpBase = `http://127.0.0.1:${h.proxy.port}/mcp`;
    const mcpBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((await fetch(mcpBase, { method: "POST", body: mcpBody })).status).toBe(404);
    expect((await fetch(`${mcpBase}/wrong-token/scope`, { method: "POST", body: mcpBody })).status).toBe(404);
    expect(h.journal()).toEqual([]);
  });

  test("authenticate failing with ACP -32000 answers 401 and reports sign-in required (moved from e2e-proxy.test.ts)", async () => {
    // A long early-SSE window keeps the failure before the stream, so it is an HTTP status.
    const h = await harness({ scenario: "unauth", timings: { earlySseMs: 5000 } });
    const r = await h.chat({ messages: [SYSTEM, user("hello")] });
    expect(r.status).toBe(401);
    expect(r.error?.type).toBe("auth_required");
    expect(h.bridge.calls.reportSignInRequired.length).toBeGreaterThan(0);
    expect(h.methods()).not.toContain("session/new");
  });

  test("a config issue answers 401 auth_required with the issue text", async () => {
    const h = await harness({ proxy: { configIssue: 'Antigravity sign-in method "gemini-api-key" is not available in this plugin version.' } });
    const r = await h.chat({ messages: [SYSTEM, user("hi")] });
    expect(r.status).toBe(401);
    expect(r.error?.message).toContain("gemini-api-key");
    expect(h.journal()).toEqual([]);
  });

  test("/health has no email, path, token or session id", async () => {
    const h = await harness({ proxy: { authStatus: () => "connected" } });
    await h.chat({ messages: [SYSTEM, user("hi")] });
    const res = await fetch(`http://127.0.0.1:${h.proxy.port}/health`);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, acp: "ready", auth: "connected", binary: { source: "explicit", version: "1.5.15", phase: "ready" } });
    expect(text).not.toContain(h.dir);
    expect(text).not.toContain("@");
    expect(text).not.toContain(h.proxy.proxyToken);
  });

  test("the profile is prepared once at start through the injected module", async () => {
    const h = await harness();
    expect(h.modules.profileCalls).toBe(1);
  });
});
