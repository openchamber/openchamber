// Fixes from the live test against the real agy (docs/live-test-fixes.md), driven through the mock agy.

import { afterEach, describe, expect, test } from "bun:test";
import { HEADER_DIRECTORY, HEADER_PROXY_TOKEN, HEADER_SESSION, MARKER_ACCESS } from "../../src/constants.ts";
import type { OpenAiMessage } from "../../src/contracts.ts";
import { READ_TOOL, SYSTEM, startHarness, summarize, toolRound, user, type ChatResult, type Harness, type HarnessOptions } from "../fixtures/proxy-harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

async function harness(opts: HarnessOptions): Promise<Harness> {
  const h = await startHarness(opts);
  open.push(h);
  return h;
}

/** A chat request with no model anywhere: no meta header, no `model` in the body. */
async function chatWithoutModel(h: Harness, messages: OpenAiMessage[], session = "ses_nomodel"): Promise<ChatResult> {
  const res = await fetch(`${h.proxy.url}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [HEADER_PROXY_TOKEN]: h.proxy.proxyToken,
      authorization: `Bearer ${MARKER_ACCESS}`,
      [HEADER_DIRECTORY]: encodeURIComponent(h.dir),
      [HEADER_SESSION]: session,
    },
    body: JSON.stringify({ messages, tools: [READ_TOOL], stream: true }),
  });
  return summarize(res.status, res.headers, await res.text(), (res.headers.get("content-type") ?? "").includes("text/event-stream"));
}

function modelSets(h: Harness): unknown[] {
  return h.journal().filter((e) => e.method === "session/set_config_option" && e.params.configId === "model").map((e) => e.params.value);
}

describe("models (live test fix 4)", () => {
  test("a request without a model and no discovered catalog keeps agy's current model", async () => {
    const h = await harness({ scenario: "strict-models" });
    const r = await chatWithoutModel(h, [SYSTEM, user("hi")]);
    expect(r.status).toBe(200);
    expect(r.text).toBe("PLAIN_TEXT_OK");
    expect(modelSets(h)).toEqual([]);
  });

  test("a model the account lacks answers 400, not retried, naming the model", async () => {
    const h = await harness({ scenario: "strict-models", timings: { earlySseMs: 5000 } });
    const r = await h.chat({ messages: [SYSTEM, user("hi")], model: "gemini-9-unknown" });
    expect(r.status).toBe(400);
    expect(r.headers.get("x-should-retry")).toBe("false");
    expect(r.error?.message).toBe('This Antigravity account has no model "gemini-9-unknown". Pick another Antigravity model.');
  });
});

describe("models after an account change (review L-7)", () => {
  test("the old account's catalog is not used as the default after an account change", async () => {
    const h = await harness({ scenario: "text" });
    await h.chat({ messages: [SYSTEM, user("hi")] });
    expect(await h.proxy.refreshModels(h.dir)).toBe(true);
    await chatWithoutModel(h, [SYSTEM, user("hi")], "ses_before");
    expect(modelSets(h).length).toBeGreaterThan(1); // discovery, then the catalog's first model
    const before = modelSets(h).length;
    await h.bridge.changeAuth("account-changed").delivered;
    const r = await chatWithoutModel(h, [SYSTEM, user("hi")], "ses_after");
    expect(r.text).toBe("PLAIN_TEXT_OK");
    expect(modelSets(h).length).toBe(before);
  });
});

describe("tool calls with the real payload shape (live test fix 1)", () => {
  test("the mock sends agy's real permission payload; the real layer 3 lets it through", async () => {
    const h = await harness({ scenario: "tools", realModules: true });
    const messages: OpenAiMessage[] = [SYSTEM, user("read")];
    const r1 = await h.chat({ messages });
    expect(r1.finishReason).toBe("tool_calls");
    expect(h.logs.some((l) => l.includes("permission allowed name=call_mcp_tool kind=execute keys=Arguments,ServerName,ToolName,raw.Arguments,raw.ServerName,raw.ToolName"))).toBe(true);
    const r2 = await h.chat({ messages: [...messages, ...toolRound(r1, () => "done")] });
    expect(r2.text).toBe("TOOL_RESULT:done");
  });
});

describe("agy already retried (live test fix 5)", () => {
  test("agy 1.5.15's error step with attempt 8 is final even without an attributed retry line (browser run 2)", async () => {
    const h = await harness({ scenario: "error-step=8" });
    const r = await h.chat({ messages: [SYSTEM, user("go")] });
    expect(r.error?.code).toBe(429);
    expect(r.error?.type).toBe("antigravity_rate_limit_exhausted");
    expect(r.error?.message).toBe(
      "Google is rate-limiting Antigravity requests (HTTP 429), and Antigravity already retried on its own. Request limit exhausted for now: try again later or pick another model.",
    );
  });

  test("agy 1.5.15's error step with attempt 1 stays retryable", async () => {
    const h = await harness({ scenario: "error-step=1" });
    const r = await h.chat({ messages: [SYSTEM, user("go")] });
    expect(r.error?.code).toBe(429);
    expect(r.error?.type).toBe("antigravity_rate_limited");
  });

  test("an error step without a retry line for the turn stays retryable (review L-3)", async () => {
    const h = await harness({ scenario: "error-step" });
    const r = await h.chat({ messages: [SYSTEM, user("go")] });
    expect(r.error?.code).toBe(429);
    expect(r.error?.type).toBe("antigravity_rate_limited");
    expect(r.error?.message).not.toContain("already retried");
  });

  test("two waiting turns and a retry line that names neither model: the stalls stay retryable (review L-4)", async () => {
    // The lines come 250 ms into each prompt, when both turns wait.
    const h = await harness({ scenario: "retry-log,retry-log-after=250", options: { stallTimeoutMs: 600, retryStallTimeoutMs: 900 } });
    // Without a model the turns run on agy's default, so the line's model (the mock session's) matches neither.
    const [a, b] = await Promise.all([chatWithoutModel(h, [SYSTEM, user("one")], "ses_a"), chatWithoutModel(h, [SYSTEM, user("two")], "ses_b")]);
    for (const r of [a, b]) {
      expect(r.error?.code).toBe(503);
      expect(r.error?.type).toBe("antigravity_capacity");
    }
    expect(h.logs.some((l) => l.includes("attributed=false"))).toBe(true);
  });

  test("an error step after agy's retries is a 429 OpenCode does not retry, with a try-later text", async () => {
    // The retry line first, then the error step: agy retried this turn and gave up.
    const h = await harness({ scenario: "error-step,retry-log=300" });
    const r = await h.chat({ messages: [SYSTEM, user("go")] });
    expect(r.error?.code).toBe(429);
    expect(r.error?.message).toContain("Antigravity already retried on its own");
    expect(r.error?.message).toContain("try again later or pick another model");
    // OpenCode 2.3.0 reads a 429 with this phrase as a quota error, which it does not retry.
    expect(/quota exceeded|usage limit|limit exhausted|insufficient quota/i.test(r.error?.message ?? "")).toBe(true);
  });

  test("a stall after agy's retry lines is not retried either", async () => {
    const h = await harness({ scenario: "retry-log", options: { stallTimeoutMs: 300, retryStallTimeoutMs: 600 } });
    const r = await h.chat({ messages: [SYSTEM, user("go")] });
    expect(r.error?.code).toBe(429);
    expect(r.error?.type).toBe("antigravity_capacity_exhausted");
  });

  test("a plain stall, where agy did not retry, stays retryable (504)", async () => {
    const h = await harness({ scenario: "stall" });
    const r = await h.chat({ messages: [SYSTEM, user("go")] });
    expect(r.error?.code).toBe(504);
  });
});
