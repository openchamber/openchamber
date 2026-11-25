import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { OpenAiMessage } from "../../src/contracts.ts";
import { SYSTEM, sleep, startHarness, toolRound, user, waitFor, type Harness } from "../fixtures/proxy-harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

function runDirs(h: Harness): string[] {
  try {
    return readdirSync(h.runRoot).filter((n) => n.startsWith("run-"));
  } catch {
    return [];
  }
}

describe("idle stop (SR 3.3)", () => {
  test("the process stops after a finished turn and its run dir is gone; the next turn respawns and resumes", async () => {
    const h = await startHarness({ options: { idleShutdownMs: 200 } });
    open.push(h);
    const first: OpenAiMessage[] = [SYSTEM, user("hello")];
    const r1 = await h.chat({ messages: first });
    expect(r1.text).toBe("PLAIN_TEXT_OK");
    expect(runDirs(h)).toHaveLength(1);
    await waitFor(() => h.proxy.process.state === "stopped", 3000);
    await waitFor(() => runDirs(h).length === 0);
    const record = h.modules.store.records.get("ses_test");
    expect(record?.state).toBe("dormant");

    const input = user("next");
    h.modules.nextPlans.push({ kind: "append", input: [input], reminders: [] });
    const r2 = await h.chat({ messages: [...first, { role: "assistant", content: "PLAIN_TEXT_OK" }, input] });
    expect(r2.text).toBe("PLAIN_TEXT_OK");
    const journal = h.journal();
    expect(new Set(journal.map((e) => e.pid)).size).toBe(2);
    const resume = journal.find((e) => e.method === "session/resume");
    expect(resume?.sessionId).toBe(record?.acpSessionId ?? "");
    const created = journal.find((e) => e.method === "session/new");
    expect(resume?.params._meta).toEqual(created?.params._meta);
    expect(journal.filter((e) => e.method === "session/new")).toHaveLength(1);
    expect(journal.filter((e) => e.method === "session/prompt").at(-1)?.promptText).toBe("next");
  });

  test("a dormant binding whose id agy does not know: resume fails twice, then a fresh session replaces the record", async () => {
    const h = await startHarness();
    open.push(h);
    const unknown = "00000000-0000-4000-8000-000000000000";
    h.modules.store.records.set("ses_test", {
      version: 1,
      sessionKey: "ses_test",
      acpSessionId: unknown,
      authEpoch: h.bridge.authEpoch(),
      agyVersion: "1.5.15",
      cwd: h.dir,
      model: "gemini-3.8-flash",
      thoughtLevel: null,
      systemHash: "s",
      toolsSchemaHash: "t",
      toolsDescHashes: {},
      appendInPrompt: false,
      prefixCount: 2,
      prefixHash: "p",
      state: "dormant",
      taintReason: null,
      lastTurn: null,
      createdAt: 1,
      updatedAt: 1,
      turns: 1,
    });
    const input = user("next");
    h.modules.nextPlans.push({ kind: "append", input: [input], reminders: [] });
    const r = await h.chat({ messages: [SYSTEM, user("hello"), { role: "assistant", content: "PLAIN_TEXT_OK" }, input] });
    expect(r.text).toBe("PLAIN_TEXT_OK");
    const methods = h.methods();
    expect(methods.filter((m) => m === "session/resume")).toHaveLength(2);
    expect(methods.filter((m) => m === "session/new")).toHaveLength(1);
    const prompt = h.journal().find((e) => e.method === "session/prompt");
    expect(prompt?.promptText).toContain("<conversation_history>");
    await waitFor(() => (h.modules.store.records.get("ses_test")?.acpSessionId ?? unknown) !== unknown);
    expect(h.modules.store.records.get("ses_test")?.lastTurn?.plan).toBe("fresh");
  });

  test("it does not stop while a turn is parked", async () => {
    const h = await startHarness({ scenario: "tools", options: { idleShutdownMs: 150 } });
    open.push(h);
    const messages: OpenAiMessage[] = [SYSTEM, user("read")];
    const r1 = await h.chat({ messages });
    expect(r1.finishReason).toBe("tool_calls");
    await sleep(500);
    expect(h.proxy.process.state).toBe("ready");
    const r2 = await h.chat({ messages: [...messages, ...toolRound(r1)] });
    expect(r2.finishReason).toBe("stop");
    await waitFor(() => h.proxy.process.state === "stopped", 3000);
  });

  test("the parked reaper cancels a turn parked past parkedToolTtlMs and taints the binding", async () => {
    const h = await startHarness({ scenario: "tools", options: { parkedToolTtlMs: 200, idleShutdownMs: 150 } });
    open.push(h);
    const r1 = await h.chat({ messages: [SYSTEM, user("read")] });
    expect(r1.finishReason).toBe("tool_calls");
    await waitFor(() => h.methods().includes("session/cancel"), 3000);
    await waitFor(() => h.modules.store.records.get("ses_test")?.taintReason === "parked-expired");
    await waitFor(() => h.proxy.process.state === "stopped", 3000);
  });

  test("a live session unused for sessionIdleCloseMs gets session/close and stays resumable", async () => {
    // Real modules, so the next turn goes through classification and session/resume (N-14).
    const h = await startHarness({ options: { sessionIdleCloseMs: 150 }, realModules: true });
    open.push(h);
    const messages: OpenAiMessage[] = [SYSTEM, user("hello")];
    const r1 = await h.chat({ messages });
    await waitFor(() => h.methods().includes("session/close"), 3000);
    const firstId = h.journal().find((e) => e.method === "session/prompt")?.sessionId ?? "";
    expect(h.journal().find((e) => e.method === "session/close")?.params.sessionId).toBe(firstId);
    expect(h.proxy.process.state).toBe("ready");
    const r2 = await h.chat({ messages: [...messages, { role: "assistant", content: r1.text }, user("again")] });
    expect(r2.text).toBe("PLAIN_TEXT_OK");
    expect(h.journal().filter((e) => e.method === "session/resume").map((e) => e.params.sessionId)).toEqual([firstId]);
    expect(h.methods().filter((m) => m === "session/new")).toHaveLength(1);
    const last = h.journal().filter((e) => e.method === "session/prompt").at(-1);
    expect(last?.sessionId).toBe(firstId);
    expect(last?.promptText).toBe("again");
  });

  test("model discovery runs only on a ready process, never spawns, and caches the catalog", async () => {
    const h = await startHarness();
    open.push(h);
    expect(await h.proxy.refreshModels(h.dir)).toBe(false);
    expect(h.journal()).toEqual([]);
    await h.chat({ messages: [SYSTEM, user("hi")] });
    expect(await h.proxy.refreshModels(h.dir)).toBe(true);
    expect(h.proxy.catalog.map((m) => [m.id, m.variants])).toEqual([
      ["gemini-3.8-flash", ["low", "high"]],
      ["gemini-4-neon", ["low", "high"]],
    ]);
    expect(existsSync(path.join(h.dataDir, "models.json"))).toBe(true);
    await waitFor(() => h.methods().filter((m) => m === "session/close").length === 1);
    expect(h.modules.store.ephemeral).toHaveLength(1);
  });

  test("slow-start: the streaming request receives the start note before the first model chunk", async () => {
    const h = await startHarness({ scenario: "slow-start=600" });
    open.push(h);
    const r = await h.chat({ messages: [SYSTEM, user("hi")] });
    const note = "[Antigravity] Starting Antigravity CLI. The first start unpacks its runtime and can take a while.";
    expect(r.reasoning.indexOf(note)).toBeGreaterThanOrEqual(0);
    expect(r.reasoning.indexOf(note)).toBeLessThan(r.reasoning.indexOf("planning..."));
    expect(r.pings).toBeGreaterThan(0);
    expect(r.text).toBe("PLAIN_TEXT_OK");
  });
});
