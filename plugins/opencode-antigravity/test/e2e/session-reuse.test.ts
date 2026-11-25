// Session reuse with the real WP-B2 modules (SR 4, 11.2): the real AntigravityProxy, classification,
// prompts, replay and the file-backed SessionStore, over the fake agy. The journal shows what agy saw.

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import path from "node:path";
import type { BindingRecord, OpenAiFunctionTool, OpenAiMessage } from "../../src/contracts.ts";
import type { JournalEntry } from "../fixtures/mock-agy.ts";
import { READ_TOOL, SYSTEM, startHarness, toolRound, user, waitFor, type ChatResult, type Harness, type HarnessOptions } from "../fixtures/proxy-harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

async function harness(scenario = "text", opts: Omit<HarnessOptions, "scenario" | "realModules"> = {}): Promise<Harness> {
  const h = await startHarness({ scenario, realModules: true, ...opts });
  open.push(h);
  return h;
}

function said(r: ChatResult): OpenAiMessage {
  return { role: "assistant", content: r.text };
}

function entries(h: Harness, method: string): JournalEntry[] {
  return h.journal().filter((e) => e.method === method);
}

function appendOf(e: JournalEntry | undefined): unknown {
  const meta = e?.params._meta;
  if (typeof meta !== "object" || meta === null || !("antigravity" in meta)) return undefined;
  const ag = meta.antigravity;
  if (typeof ag !== "object" || ag === null || !("systemPrompt" in ag)) return undefined;
  const sp = ag.systemPrompt;
  return typeof sp === "object" && sp !== null && "append" in sp ? sp.append : undefined;
}

/** The stored binding once `check` holds; the save after a turn's end is asynchronous. */
async function recordWhen(h: Harness, check: (r: BindingRecord | null) => boolean, key = "ses_test"): Promise<BindingRecord | null> {
  let record = await h.session.store.load(key, h.bridge.authEpoch());
  for (let i = 0; i < 100 && !check(record); i++) {
    await new Promise((r) => setTimeout(r, 20));
    record = await h.session.store.load(key, h.bridge.authEpoch());
  }
  return record;
}

const BASH_TOOL: OpenAiFunctionTool = {
  type: "function",
  function: { name: "bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
};

/** Two finished text turns on `ses_test`; returns the messages OpenCode would send next, minus the new input. */
async function twoTurns(h: Harness, tools: OpenAiFunctionTool[] = [READ_TOOL]): Promise<OpenAiMessage[]> {
  let messages: OpenAiMessage[] = [SYSTEM, user("first question")];
  const r1 = await h.chat({ messages, tools });
  expect(r1.text).toBe("PLAIN_TEXT_OK");
  messages = [...messages, said(r1), user("second question")];
  const r2 = await h.chat({ messages, tools });
  expect(r2.text).toBe("PLAIN_TEXT_OK");
  return [...messages, said(r2)];
}

describe("append-only turns reuse one ACP session (SR 4.3, 4.4)", () => {
  test("two user turns: one session/new, both prompts on the same id, the second carries only the new text", async () => {
    const h = await harness();
    await twoTurns(h);
    expect(entries(h, "session/new")).toHaveLength(1);
    const prompts = entries(h, "session/prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.sessionId).toBe(prompts[0]?.sessionId ?? "");
    // A fresh session with no earlier turns gets the input alone; the replay wraps history only when there is some.
    expect(prompts[0]?.promptText).toBe("first question");
    expect(prompts[1]?.promptText).toBe("second question");
    const record = await recordWhen(h, (r) => r?.turns === 2);
    expect(record?.acpSessionId).toBe(prompts[0]?.sessionId ?? "");
    expect(record?.turns).toBe(2);
    expect(record?.lastTurn?.plan).toBe("append");
  });

  test("a tool turn with two parks resumes twice inside one prompt, then the next user turn appends", async () => {
    const h = await harness("tools,tools=2");
    let messages: OpenAiMessage[] = [SYSTEM, user("read two files")];
    const r1 = await h.chat({ messages });
    expect(r1.finishReason).toBe("tool_calls");
    messages = [...messages, ...toolRound(r1, () => "one")];
    const r2 = await h.chat({ messages });
    expect(r2.finishReason).toBe("tool_calls");
    // The second resume classifies against the prefix the first resume moved to (ParkedTurnView.prefixCount).
    messages = [...messages, ...toolRound(r2, () => "two")];
    const r3 = await h.chat({ messages });
    expect(r3.text).toBe("TOOL_RESULT:two");
    expect(r3.finishReason).toBe("stop");
    expect(entries(h, "session/prompt")).toHaveLength(1);
    messages = [...messages, said(r3), user("thanks")];
    const r4 = await h.chat({ messages });
    expect(r4.status).toBe(200);
    expect(entries(h, "session/new")).toHaveLength(1);
    const prompts = entries(h, "session/prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.sessionId).toBe(prompts[0]?.sessionId ?? "");
    expect(prompts[1]?.promptText).toBe("thanks");
  });
});

describe("divergence opens a fresh session with replay (SR 4.3, 4.7)", () => {
  test("an edit of the first user message: a second session/new whose prompt replays the history", async () => {
    const h = await harness();
    const history = await twoTurns(h);
    const edited = [SYSTEM, user("first question, edited"), ...history.slice(2), user("third question")];
    const r = await h.chat({ messages: edited });
    expect(r.status).toBe(200);
    const news = entries(h, "session/new");
    expect(news).toHaveLength(2);
    const prompts = entries(h, "session/prompt");
    expect(prompts).toHaveLength(3);
    expect(prompts[2]?.sessionId).not.toBe(prompts[0]?.sessionId ?? "");
    expect(prompts[2]?.promptText).toContain("<conversation_history>");
    expect(prompts[2]?.promptText).toContain("first question, edited");
    expect(prompts[2]?.promptText).toContain("second question");
    expect(prompts[2]?.promptText).toContain("third question");
    // The old live session is closed when the binding moves.
    await waitFor(() => entries(h, "session/close").some((e) => e.sessionId === prompts[0]?.sessionId));
    const record = await recordWhen(h, (r) => r?.acpSessionId === prompts[2]?.sessionId);
    expect(record?.acpSessionId).toBe(prompts[2]?.sessionId ?? "");
  });

  test("a revert to a shorter history is fresh", async () => {
    const h = await harness();
    const history = await twoTurns(h);
    const reverted = [...history.slice(0, 2), user("instead, this")];
    await h.chat({ messages: reverted });
    expect(entries(h, "session/new")).toHaveLength(2);
    const last = entries(h, "session/prompt").at(-1);
    expect(last?.sessionId).not.toBe(entries(h, "session/prompt")[0]?.sessionId ?? "");
    expect(last?.promptText).toContain("first question");
    expect(last?.promptText).toContain("instead, this");
    expect(last?.promptText).not.toContain("second question");
  });

  test("a fork is a new session key: fresh with replay, the original binding keeps its session", async () => {
    const h = await harness();
    const history = await twoTurns(h);
    const forked = [...history, user("on the fork")];
    await h.chat({ messages: forked, session: "ses_fork" });
    const news = entries(h, "session/new");
    expect(news).toHaveLength(2);
    expect(entries(h, "session/prompt").at(-1)?.promptText).toContain("<conversation_history>");
    const original = await h.session.store.load("ses_test", h.bridge.authEpoch());
    const fork = await h.session.store.load("ses_fork", h.bridge.authEpoch());
    expect(original?.acpSessionId).toBe(entries(h, "session/prompt")[0]?.sessionId ?? "");
    expect(fork?.acpSessionId).not.toBe(original?.acpSessionId ?? "");
    // The original continues append-only.
    await h.chat({ messages: [...history, user("back on the original")] });
    expect(entries(h, "session/new")).toHaveLength(2);
    expect(entries(h, "session/prompt").at(-1)?.promptText).toBe("back on the original");
  });

  test("compaction: the summary request runs in its own meta session, the next turn is fresh with the summary", async () => {
    const h = await harness();
    const history = await twoTurns(h);
    const summary = await h.chat({ messages: [...history, user("Summarize the conversation.")], kind: "compaction", tools: [] });
    expect(summary.status).toBe(200);
    await waitFor(() => entries(h, "session/close").length > 0);
    const compacted: OpenAiMessage[] = [SYSTEM, user("What did we do so far?"), { role: "assistant", content: "Summary: two questions." }, user("continue")];
    await h.chat({ messages: compacted });
    const news = entries(h, "session/new");
    expect(news).toHaveLength(3);
    expect(news[1]?.params.mcpServers).toEqual([]); // the meta session has no tools
    const last = entries(h, "session/prompt").at(-1);
    expect(last?.promptText).toContain("Summary: two questions.");
    expect(last?.promptText).not.toContain("first question");
    const record = await recordWhen(h, (r) => r?.acpSessionId === last?.sessionId);
    expect(record?.acpSessionId).toBe(last?.sessionId ?? "");
  });

  test("a tool schema change is fresh: the old session is closed and the new one lists the new tools", async () => {
    const h = await harness();
    const history = await twoTurns(h);
    await h.chat({ messages: [...history, user("now with bash")], tools: [READ_TOOL, BASH_TOOL] });
    const news = entries(h, "session/new");
    expect(news).toHaveLength(2);
    expect(entries(h, "session/prompt").at(-1)?.promptText).toContain("<conversation_history>");
    expect(String(appendOf(news[1]))).toContain('"name":"bash"');
    expect(String(appendOf(news[0]))).not.toContain('"name":"bash"');
    const first = entries(h, "session/prompt")[0]?.sessionId;
    await waitFor(() => entries(h, "session/close").some((e) => e.sessionId === first));
  });
});

describe("description-only tool changes keep the session (SR 7.5)", () => {
  const changedRead: OpenAiFunctionTool = { type: "function", function: { ...READ_TOOL.function, description: "Read a file, with line ranges" } };

  test("same session, the next prompt starts with the description note; the note is sent once", async () => {
    const h = await harness();
    const history = await twoTurns(h);
    const third = [...history, user("third")];
    const r3 = await h.chat({ messages: third, tools: [changedRead] });
    expect(r3.status).toBe(200);
    expect(entries(h, "session/new")).toHaveLength(1);
    const prompt3 = entries(h, "session/prompt")[2];
    expect(prompt3?.sessionId).toBe(entries(h, "session/prompt")[0]?.sessionId ?? "");
    expect(prompt3?.promptText?.startsWith("<system-update>The descriptions of these OpenCode tools changed:")).toBe(true);
    expect(prompt3?.promptText).toContain("Read a file, with line ranges");
    expect(prompt3?.promptText?.endsWith("third")).toBe(true);
    // The binding stored the new descriptions with the ok turn: no second note.
    await h.chat({ messages: [...third, said(r3), user("fourth")], tools: [changedRead] });
    expect(entries(h, "session/prompt")[3]?.promptText).toBe("fourth");
  });

  test("an append that carried the note and failed without output is redone with the note", async () => {
    const h = await harness("stall-on=STALL");
    const history = await twoTurns(h);
    const failing = [...history, user("STALL please")];
    const r3 = await h.chat({ messages: failing, tools: [changedRead] });
    expect(r3.error?.code).toBe(504);
    await waitFor(() => entries(h, "session/cancel").length === 1);
    let record = await h.session.store.load("ses_test", h.bridge.authEpoch());
    for (let i = 0; i < 50 && record?.lastTurn?.outcome !== "failed_no_output"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      record = await h.session.store.load("ses_test", h.bridge.authEpoch());
    }
    expect(record?.lastTurn?.outcome).toBe("failed_no_output");
    expect(record?.state).toBe("dormant");
    // OpenCode retries the same request (the failed assistant message carries only the note as reasoning).
    await h.chat({ messages: [...failing, { role: "assistant", content: "", reasoning_content: r3.reasoning }], tools: [changedRead] });
    const prompts = entries(h, "session/prompt");
    expect(prompts).toHaveLength(4);
    expect(new Set(prompts.map((p) => p.sessionId)).size).toBe(1);
    expect(prompts[3]?.promptText?.startsWith("<system-update>The descriptions of these OpenCode tools changed:")).toBe(true);
    expect(prompts[3]?.promptText?.endsWith("STALL please")).toBe(true);
  });
});

describe("restart (SR 4.5)", () => {
  test("a new proxy on the same data dir resumes the stored id with the same append, then appends", async () => {
    const h = await harness();
    const history = await twoTurns(h);
    const sessionId = entries(h, "session/prompt")[0]?.sessionId ?? "";
    const firstAppend = appendOf(entries(h, "session/new")[0]);
    await h.restart();
    const r3 = await h.chat({ messages: [...history, user("after the restart")] });
    expect(r3.text).toBe("PLAIN_TEXT_OK");
    const resumes = entries(h, "session/resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.params.sessionId).toBe(sessionId);
    expect(appendOf(resumes[0])).toBe(firstAppend);
    expect(entries(h, "session/new")).toHaveLength(1);
    const last = entries(h, "session/prompt").at(-1);
    expect(last?.sessionId).toBe(sessionId);
    expect(last?.promptText).toBe("after the restart");
    expect(new Set(h.journal().map((e) => e.pid)).size).toBe(2);
  });

  test("a stored id agy does not know: resume fails twice, then a fresh session with replay replaces the record", async () => {
    const h = await harness();
    const history = await twoTurns(h);
    const oldId = entries(h, "session/prompt")[0]?.sessionId ?? "";
    await h.restart();
    rmSync(path.join(h.geminiDir, "mock-sessions.json"), { force: true }); // agy lost its session files
    const r3 = await h.chat({ messages: [...history, user("after the restart")] });
    expect(r3.text).toBe("PLAIN_TEXT_OK");
    expect(entries(h, "session/resume").map((e) => e.params.sessionId)).toEqual([oldId, oldId]);
    expect(entries(h, "session/new")).toHaveLength(2);
    const last = entries(h, "session/prompt").at(-1);
    expect(last?.promptText).toContain("<conversation_history>");
    expect(last?.promptText).toContain("after the restart");
    const record = await recordWhen(h, (r) => r?.acpSessionId === last?.sessionId);
    expect(record?.acpSessionId).toBe(last?.sessionId ?? "");
    expect(record?.acpSessionId).not.toBe(oldId);
  });

  test("resumeAfterRestart: false goes fresh with replay after a restart", async () => {
    const h = await harness("text", { options: { resumeAfterRestart: false } });
    const history = await twoTurns(h);
    await h.restart();
    await h.chat({ messages: [...history, user("after the restart")] });
    expect(entries(h, "session/resume")).toHaveLength(0);
    expect(entries(h, "session/new")).toHaveLength(2);
    expect(entries(h, "session/prompt").at(-1)?.promptText).toContain("<conversation_history>");
  });
});
