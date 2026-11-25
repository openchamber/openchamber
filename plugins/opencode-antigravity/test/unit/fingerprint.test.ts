import { describe, expect, test } from "bun:test";
import type {
  BindingRecord,
  ClassifiableRequest,
  FreshReason,
  LastTurnRecord,
  OpenAiFunctionTool,
  OpenAiMessage,
  OpenAiToolCall,
  ParkedTurnView,
  RequestPlan,
} from "../../src/contracts.ts";
import {
  canonicalizeMessages,
  chainHash,
  classifyRequest,
  emittedHashes,
  emittedTextHash,
  messageFingerprint,
  toolArgsHash,
} from "../../src/fingerprint.ts";
import { buildSessionAppend, buildTurnPrompt } from "../../src/prompt.ts";

const BUDGETS = { maxSystemPromptBytes: 32_768, maxToolsPromptBytes: 49_152 };
const CWD = "/work/project";
const EPOCH = "3";

const READ: OpenAiFunctionTool = {
  type: "function",
  function: {
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
  },
};
const BASH: OpenAiFunctionTool = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a command",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
};
const TOOLS = [READ, BASH];

const system: OpenAiMessage = { role: "system", content: "You are OpenCode." };
const user = (text: string): OpenAiMessage => ({ role: "user", content: text });
const assistant = (text: string, calls?: OpenAiToolCall[]): OpenAiMessage =>
  calls ? { role: "assistant", content: text, tool_calls: calls } : { role: "assistant", content: text };
const call = (id: string, name: string, args: Record<string, unknown>): OpenAiToolCall => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const toolMsg = (id: string, content: string): OpenAiMessage => ({ role: "tool", tool_call_id: id, content });
const imageMsg = (data: string): OpenAiMessage => ({
  role: "user",
  content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${data}` } }],
});

function fingerprints(messages: readonly OpenAiMessage[]): string[] {
  return canonicalizeMessages(messages).map(messageFingerprint);
}

function appendHashes(messages: readonly OpenAiMessage[], tools: readonly OpenAiFunctionTool[] = TOOLS) {
  const append = buildSessionAppend({ messages, tools, meta: false, config: BUDGETS }, "opencode");
  return { systemHash: append.systemHash, toolsSchemaHash: append.toolsSchemaHash, toolsDescHashes: append.toolsDescHashes };
}

function request(messages: OpenAiMessage[], over: Partial<ClassifiableRequest> = {}): ClassifiableRequest {
  const tools = over.tools ?? TOOLS;
  return {
    kind: null,
    sessionKey: "ses_1",
    messages,
    tools,
    cwd: CWD,
    authEpoch: EPOCH,
    append: appendHashes(messages, tools),
    ...over,
  };
}

interface LastOutput {
  text?: string;
  calls?: OpenAiToolCall[];
  outcome?: LastTurnRecord["outcome"];
  plan?: LastTurnRecord["plan"];
  inputFrom?: number;
}

/** The binding the proxy holds after dispatching `messages` and streaming `last`. */
function bindingAfter(messages: OpenAiMessage[], last: LastOutput, over: Partial<BindingRecord> = {}): BindingRecord {
  const fps = fingerprints(messages);
  const hashes = appendHashes(messages);
  return {
    version: 1,
    sessionKey: "ses_1",
    acpSessionId: "5c1e0000-0000-4000-8000-000000000001",
    authEpoch: EPOCH,
    agyVersion: "1.5.15",
    cwd: CWD,
    model: "gemini-4-neon",
    thoughtLevel: "high",
    ...hashes,
    appendInPrompt: false,
    prefixCount: fps.length,
    prefixHash: chainHash(fps, fps.length),
    state: "dormant",
    taintReason: null,
    lastTurn: {
      outcome: last.outcome ?? "ok",
      plan: last.plan ?? "fresh",
      emittedToolCalls: (last.calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        argsHash: toolArgsHash(c.function.arguments),
      })),
      emittedTextHash: emittedTextHash(last.text ?? ""),
      inputFrom: last.inputFrom ?? Math.max(0, fps.length - 1),
      inputTo: fps.length,
    },
    createdAt: 1,
    updatedAt: 2,
    turns: 1,
    ...over,
  };
}

function parkedAfter(messages: OpenAiMessage[], calls: OpenAiToolCall[], text = ""): ParkedTurnView {
  const fps = fingerprints(messages);
  return {
    prefixCount: fps.length,
    prefixHash: chainHash(fps, fps.length),
    emittedToolCalls: calls.map((c) => ({ id: c.id, name: c.function.name, argsHash: toolArgsHash(c.function.arguments) })),
    emittedTextHash: emittedTextHash(text),
    parkedToolCallIds: calls.map((c) => c.id),
  };
}

function plan(binding: BindingRecord | null, req: ClassifiableRequest, parkedTurn: ParkedTurnView | null = null): RequestPlan {
  return classifyRequest({ binding, request: req, parkedTurn }).plan;
}

function fresh(reason: FreshReason): RequestPlan {
  return { kind: "fresh", reason };
}

describe("canonical messages and fingerprints", () => {
  test("string content and an array of text parts with the same text give one fingerprint", () => {
    const asString = fingerprints([{ role: "user", content: "hello world" }]);
    const asParts = fingerprints([
      { role: "user", content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] },
    ]);
    expect(asParts).toEqual(asString);
  });

  test("cache_control and trailing whitespace are ignored", () => {
    const plain = fingerprints([user("hello")]);
    const cached = fingerprints([
      { role: "user", content: [{ type: "text", text: "hello  \n", cache_control: { type: "ephemeral" } }] },
    ]);
    expect(cached).toEqual(plain);
  });

  test("reasoning fields and provider metadata are ignored", () => {
    const echoed = { role: "assistant" as const, content: "done", reasoning_content: "thinking", reasoning: "x", refusal: null };
    expect(fingerprints([echoed])).toEqual(fingerprints([assistant("done")]));
  });

  test("tool call arguments with reordered keys match", () => {
    const a = assistant("", [{ id: "c1", type: "function", function: { name: "read", arguments: '{"a":1,"b":{"y":2,"x":1}}' } }]);
    const b = assistant("", [{ id: "c1", type: "function", function: { name: "read", arguments: '{ "b": {"x":1,"y":2}, "a": 1 }' } }]);
    expect(fingerprints([b])).toEqual(fingerprints([a]));
    expect(toolArgsHash('{"b":2,"a":1}')).toBe(toolArgsHash('{"a":1,"b":2}'));
    expect(toolArgsHash("not json") === toolArgsHash("not json ")).toBe(false);
  });

  test("assistant messages with no text and no tool calls drop out", () => {
    const withEmpty = canonicalizeMessages([user("hi"), { role: "assistant", content: "", reasoning_content: "note" }, user("again")]);
    expect(withEmpty.length).toBe(2);
    expect(canonicalizeMessages([{ role: "assistant", content: null }]).length).toBe(0);
  });

  test("the leading system run is dropped, a later system message is kept as role system", () => {
    const canon = canonicalizeMessages([system, { role: "developer", content: "dev" }, user("hi"), system]);
    expect(canon.map((m) => m.r)).toEqual(["user", "system"]);
  });

  test("file and video parts change the fingerprint when added, removed or replaced", () => {
    const base: OpenAiMessage = { role: "user", content: [{ type: "text", text: "see" }] };
    const withFile: OpenAiMessage = {
      role: "user",
      content: [{ type: "text", text: "see" }, { type: "file", file: { filename: "a.pdf", file_data: "data:application/pdf;base64,AAAA" } }],
    };
    const otherFile: OpenAiMessage = {
      role: "user",
      content: [{ type: "text", text: "see" }, { type: "file", file: { filename: "a.pdf", file_data: "data:application/pdf;base64,BBBB" } }],
    };
    const withVideo: OpenAiMessage = {
      role: "user",
      content: [{ type: "text", text: "see" }, { type: "video_url", video_url: { url: "https://example.com/v.mp4" } }],
    };
    const otherVideo: OpenAiMessage = {
      role: "user",
      content: [{ type: "text", text: "see" }, { type: "video_url", video_url: { url: "https://example.com/w.mp4" } }],
    };
    const all = [base, withFile, otherFile, withVideo, otherVideo].map((m) => fingerprints([m])[0]);
    expect(new Set(all).size).toBe(5);
  });

  test("unknown part types are fingerprinted by their content", () => {
    const a = fingerprints([{ role: "user", content: [{ type: "audio", data: "AAA" }] }]);
    const b = fingerprints([{ role: "user", content: [{ type: "audio", data: "BBB" }] }]);
    expect(a[0] === b[0]).toBe(false);
  });

  test("chainHash of a prefix equals the stored value after appending messages", () => {
    const first = fingerprints([user("a"), assistant("b")]);
    const stored = chainHash(first, first.length);
    const longer = fingerprints([user("a"), assistant("b"), user("c"), assistant("d")]);
    expect(chainHash(longer, first.length)).toBe(stored);
    expect(chainHash(longer, longer.length) === stored).toBe(false);
  });

  test("emitted text hash is null for empty or whitespace text and matches the echo", () => {
    expect(emittedHashes.emittedTextHash("")).toBeNull();
    expect(emittedHashes.emittedTextHash("  \n")).toBeNull();
    expect(emittedHashes.emittedTextHash("Done.\n")).toBe(emittedHashes.emittedTextHash("Done."));
  });
});

describe("classifyRequest: plans that reuse the session", () => {
  const turn1 = [system, user("hello")];

  test("append-only: a new user message after our own text", () => {
    const binding = bindingAfter(turn1, { text: "Hi there." });
    const next = [...turn1, assistant("Hi there."), user("Read a.ts")];
    const result = classifyRequest({ binding, request: request(next), parkedTurn: null });
    expect(result.plan).toEqual({ kind: "append", input: [user("Read a.ts")], reminders: [] });
    const fps = fingerprints(next);
    expect(result.prefix).toEqual({ count: fps.length, hash: chainHash(fps, fps.length) });
  });

  test("the echo may come as text parts with cache_control and reasoning_content", () => {
    const binding = bindingAfter(turn1, { text: "Hi there.\n" });
    const echo: OpenAiMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hi " }, { type: "text", text: "there.", cache_control: { type: "ephemeral" } }],
      reasoning_content: "I should greet.",
    };
    expect(plan(binding, request([...turn1, echo, user("next")])).kind).toBe("append");
  });

  test("a mid-conversation system message is appended and becomes a <system-update> block", () => {
    const binding = bindingAfter(turn1, { text: "Hi." });
    const update: OpenAiMessage = { role: "system", content: "The date changed." };
    const p = plan(binding, request([...turn1, assistant("Hi."), update, user("go")]));
    expect(p).toEqual({ kind: "append", input: [update, user("go")], reminders: [] });
    if (p.kind !== "append") return;
    const blocks = buildTurnPrompt(p.input, p.reminders);
    expect(blocks[0]).toEqual({ type: "text", text: "<system-update>The date changed.</system-update>" });
  });

  test("description-only tool change appends with one reminder naming only the changed tool", () => {
    const binding = bindingAfter(turn1, { text: "Hi." });
    const changedRead: OpenAiFunctionTool = { type: "function", function: { ...READ.function, description: "Read a file, now with ranges" } };
    const tools = [changedRead, BASH];
    const p = plan(binding, request([...turn1, assistant("Hi."), user("go")], { tools }));
    expect(p.kind).toBe("append");
    if (p.kind !== "append") return;
    expect(p.reminders.length).toBe(1);
    expect(p.reminders[0].startsWith("<system-update>The descriptions of these OpenCode tools changed:\n")).toBe(true);
    expect(p.reminders[0]).toContain('"description":"Read a file, now with ranges"');
    expect(p.reminders[0].includes('"name":"bash"')).toBe(false);
    expect(buildTurnPrompt(p.input, p.reminders)[0]).toEqual({ type: "text", text: p.reminders[0] });
  });

  test("resume: tool results for the parked ids", () => {
    const calls = [call("c1", "read", { filePath: "a.ts" }), call("c2", "bash", { command: "ls" })];
    const start = [system, user("look")];
    const binding = bindingAfter(start, {}, { state: "live" });
    const parked = parkedAfter(start, calls, "Let me look.");
    const next = [...start, assistant("Let me look.", calls), toolMsg("c1", "file body"), toolMsg("c2", "a.ts")];
    expect(plan(binding, request(next), parked)).toEqual({
      kind: "resume",
      results: [
        { toolCallId: "c1", content: "file body" },
        { toolCallId: "c2", content: "a.ts" },
      ],
      media: [],
      steer: [],
    });
  });

  test("resume: partial results still resume", () => {
    const calls = [call("c1", "read", { filePath: "a.ts" }), call("c2", "bash", { command: "ls" })];
    const start = [system, user("look")];
    const parked = parkedAfter(start, calls);
    const next = [...start, assistant("", calls), toolMsg("c2", "a.ts")];
    expect(plan(bindingAfter(start, {}), request(next), parked).kind).toBe("resume");
  });

  test("resume with steer: new user input after the results", () => {
    const calls = [call("c1", "read", { filePath: "a.ts" })];
    const start = [system, user("look")];
    const parked = parkedAfter(start, calls);
    const next = [...start, assistant("", calls), toolMsg("c1", "body"), user("also check b.ts")];
    const p = plan(bindingAfter(start, {}), request(next), parked);
    expect(p).toEqual({ kind: "resume", results: [{ toolCallId: "c1", content: "body" }], media: [], steer: [user("also check b.ts")] });
  });

  test("a media-only user message after the tool messages is tool media, not steering", () => {
    const calls = [call("c1", "read", { filePath: "shot.png" })];
    const start = [system, user("look")];
    const parked = parkedAfter(start, calls);
    const media = imageMsg("iVBOR");
    const p = plan(bindingAfter(start, {}), request([...start, assistant("", calls), toolMsg("c1", "Image read"), media]), parked);
    expect(p).toEqual({
      kind: "resume",
      results: [{ toolCallId: "c1", content: "Image read" }],
      media: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } }],
      steer: [],
    });
  });

  test("a tool schema change while parked still resumes: the running turn keeps its tools", () => {
    const calls = [call("c1", "read", { filePath: "a.ts" })];
    const start = [system, user("look")];
    const parked = parkedAfter(start, calls);
    const write: OpenAiFunctionTool = { type: "function", function: { name: "write", parameters: { type: "object" } } };
    const req = request([...start, assistant("", calls), toolMsg("c1", "body")], { tools: [READ, BASH, write] });
    expect(plan(bindingAfter(start, {}), req, parked).kind).toBe("resume");
  });

  test("redo: the same request again after a clean no-output failure of an append turn", () => {
    const before = [system, user("hello"), assistant("Hi."), user("do it")];
    const binding = bindingAfter(before, { outcome: "failed_no_output", plan: "append", inputFrom: 2 });
    // OpenCode echoes the failed assistant message with the status note as reasoning only.
    const retry = [...before, { role: "assistant" as const, content: "", reasoning_content: "Waiting for the model" }];
    expect(plan(binding, request(retry))).toEqual({ kind: "redo", input: [user("do it")], reminders: [] });
  });

  test("N-1: new input after a clean no-output failure carries the failed turn's input again", () => {
    // Turn 2 sent "Delete temp.txt" and failed with no output; the prefix already covers it.
    const failed = [system, user("hello"), assistant("Hi."), user("Delete temp.txt")];
    const binding = bindingAfter(failed, { outcome: "failed_no_output", plan: "append", inputFrom: 1 });
    const next = [...failed, user("Also rename foo.ts")];
    expect(plan(binding, request(next))).toEqual({
      kind: "append",
      input: [user("Delete temp.txt"), user("Also rename foo.ts")],
      reminders: [],
    });
  });

  test("N-1: an echo of the failed turn's status note is dropped before the new input", () => {
    const failed = [system, user("hello"), assistant("Hi."), user("Delete temp.txt")];
    const binding = bindingAfter(failed, { outcome: "failed_no_output", plan: "append", inputFrom: 2 });
    const next = [...failed, { role: "assistant" as const, content: "", reasoning_content: "Waiting" }, user("Also rename foo.ts")];
    const p = plan(binding, request(next));
    expect(p.kind === "append" ? p.input : null).toEqual([user("Delete temp.txt"), user("Also rename foo.ts")]);
  });

  test("redo also works when the recorded input starts at the previous prefix, before our echo", () => {
    const before = [system, user("hello"), assistant("Hi."), user("do it")];
    // Previous prefix was 1 (just "hello"); the range [1, 3) holds our echo "Hi." and the new input.
    const binding = bindingAfter(before, { outcome: "failed_no_output", plan: "append", inputFrom: 1 });
    expect(plan(binding, request(before))).toEqual({ kind: "redo", input: [user("do it")], reminders: [] });
  });

  test("redo after a failed append that carried a description reminder carries it again", () => {
    const before = [system, user("hello"), assistant("Hi."), user("do it")];
    // The failed turn did not move toolsDescHashes, so the binding still has the old descriptions.
    const binding = bindingAfter(before, { outcome: "failed_no_output", plan: "append", inputFrom: 2 });
    const changedRead: OpenAiFunctionTool = { type: "function", function: { ...READ.function, description: "Read a file, now with ranges" } };
    const p = plan(binding, request(before, { tools: [changedRead, BASH] }));
    expect(p.kind).toBe("redo");
    if (p.kind !== "redo") return;
    expect(p.input).toEqual([user("do it")]);
    expect(p.reminders).toHaveLength(1);
    expect(p.reminders[0]).toContain('"description":"Read a file, now with ranges"');
  });
});

describe("classifyRequest: a whole tool turn as the proxy drives it", () => {
  test("two parks in one turn, then a text answer, then an append", () => {
    const c1 = [call("c1", "read", { filePath: "a.ts" })];
    const c2 = [call("c2", "bash", { command: "ls" })];
    // Request 1: no binding, fresh. The turn parks on c1; the binding holds request 1's prefix.
    const r1 = [system, user("look")];
    expect(plan(null, request(r1))).toEqual(fresh("no-binding"));
    const binding = bindingAfter(r1, { calls: c1, outcome: "parked" }, { state: "live" });
    // Request 2 answers c1. After dispatch the prefix moves to cover request 2, and the turn parks on c2.
    const r2 = [...r1, assistant("", c1), toolMsg("c1", "body")];
    const p2 = classifyRequest({ binding, request: request(r2), parkedTurn: parkedAfter(r1, c1) });
    expect(p2.plan.kind).toBe("resume");
    // Request 3 answers c2 against the moved prefix.
    const r3 = [...r2, assistant("", c2), toolMsg("c2", "a.ts")];
    const moved = parkedAfter(r2, c2);
    expect(moved.prefixCount).toBe(p2.prefix.count);
    expect(classifyRequest({ binding, request: request(r3), parkedTurn: moved }).plan.kind).toBe("resume");
    // Against the turn-start prefix the same request would not resume: the view must move.
    expect(plan(binding, request(r3), parkedAfter(r1, [...c1, ...c2]))).toEqual(fresh("tail-mismatch"));
    // The turn ends with text; the next user message appends.
    const done = bindingAfter(r3, { text: "Both checked.", plan: "resume" });
    expect(plan(done, request([...r3, assistant("Both checked."), user("thanks")])).kind).toBe("append");
  });
});

describe("classifyRequest: plans that start fresh", () => {
  const history = [system, user("first"), assistant("one"), user("second"), assistant("two")];
  const binding = bindingAfter(history.slice(0, 4), { text: "two" });

  test("the unchanged binding appends, as the baseline for the cases below", () => {
    expect(plan(binding, request([...history, user("third")])).kind).toBe("append");
  });

  test("edit of message 2 gives prefix-mismatch", () => {
    const edited = [system, user("first"), assistant("one, edited"), user("second"), assistant("two"), user("third")];
    expect(plan(binding, request(edited))).toEqual(fresh("prefix-mismatch"));
  });

  test("edit of the first user message gives prefix-mismatch", () => {
    const edited = [system, user("first!"), assistant("one"), user("second"), assistant("two"), user("third")];
    expect(plan(binding, request(edited))).toEqual(fresh("prefix-mismatch"));
  });

  test("revert to a shorter history gives prefix-mismatch", () => {
    expect(plan(binding, request([system, user("first"), assistant("one"), user("other")]))).toEqual(fresh("prefix-mismatch"));
  });

  test("compaction: a summary replaces the history", () => {
    const compacted = [system, user("Summary of the conversation so far: ..."), user("third")];
    expect(plan(binding, request(compacted))).toEqual(fresh("prefix-mismatch"));
  });

  test("a fork is a new session key with no binding", () => {
    expect(plan(null, request([...history, user("third")], { sessionKey: "ses_fork" }))).toEqual(fresh("no-binding"));
  });

  test("edited text of our last assistant message gives tail-mismatch", () => {
    const req = request([system, user("first"), assistant("one"), user("second"), assistant("two (edited)"), user("third")]);
    expect(plan(binding, req)).toEqual(fresh("tail-mismatch"));
  });

  test("an empty echo when we emitted text gives tail-mismatch", () => {
    const req = request([system, user("first"), assistant("one"), user("second"), assistant("", [call("x", "read", {})]), user("third")]);
    expect(plan(binding, req)).toEqual(fresh("tail-mismatch"));
  });

  test("two assistant messages in the tail give tail-mismatch", () => {
    const req = request([...history, assistant("inserted"), user("third")]);
    expect(plan(binding, req)).toEqual(fresh("tail-mismatch"));
  });

  test("an inserted assistant message when the last response emitted nothing gives tail-mismatch", () => {
    const silent = bindingAfter(history.slice(0, 4), {});
    expect(plan(silent, request([...history, user("third")]))).toEqual(fresh("tail-mismatch"));
  });

  test("edited tool call arguments give tail-mismatch", () => {
    const calls = [call("c1", "read", { filePath: "a.ts" })];
    const start = [system, user("look")];
    const parked = parkedAfter(start, calls);
    const edited = [call("c1", "read", { filePath: "b.ts" })];
    const req = request([...start, assistant("", edited), toolMsg("c1", "body")]);
    expect(plan(bindingAfter(start, {}), req, parked)).toEqual(fresh("tail-mismatch"));
  });

  test("a tool call id we never emitted gives tail-mismatch", () => {
    const calls = [call("c1", "read", { filePath: "a.ts" })];
    const start = [system, user("look")];
    const req = request([...start, assistant("", [call("c9", "read", { filePath: "a.ts" })]), toolMsg("c9", "body")]);
    expect(plan(bindingAfter(start, {}), req, parkedAfter(start, calls))).toEqual(fresh("tail-mismatch"));
  });

  test("a result for an id that is not parked gives tail-mismatch", () => {
    const calls = [call("c1", "read", { filePath: "a.ts" })];
    const start = [system, user("look")];
    const req = request([...start, assistant("", calls), toolMsg("c1", "body"), toolMsg("c2", "stray")]);
    expect(plan(bindingAfter(start, {}), req, parkedAfter(start, calls))).toEqual(fresh("tail-mismatch"));
  });

  test("a duplicated result gives tail-mismatch", () => {
    const calls = [call("c1", "read", { filePath: "a.ts" })];
    const start = [system, user("look")];
    const req = request([...start, assistant("", calls), toolMsg("c1", "body"), toolMsg("c1", "body")]);
    expect(plan(bindingAfter(start, {}), req, parkedAfter(start, calls))).toEqual(fresh("tail-mismatch"));
  });

  test("a parked turn with only new user input, no results, gives tail-mismatch", () => {
    const calls = [call("c1", "read", { filePath: "a.ts" })];
    const start = [system, user("look")];
    const req = request([...start, assistant("", calls), user("never mind")]);
    expect(plan(bindingAfter(start, {}), req, parkedAfter(start, calls))).toEqual(fresh("tail-mismatch"));
  });

  test("an edit before the parked turn's prefix gives prefix-mismatch", () => {
    const calls = [call("c1", "read", { filePath: "a.ts" })];
    const start = [system, user("look")];
    const req = request([system, user("look!"), assistant("", calls), toolMsg("c1", "body")]);
    expect(plan(bindingAfter(start, {}), req, parkedAfter(start, calls))).toEqual(fresh("prefix-mismatch"));
  });

  test("tool results with no parked turn give tail-mismatch", () => {
    const calls = [call("c1", "read", { filePath: "a.ts" })];
    const start = [system, user("look")];
    const b = bindingAfter(start, { calls });
    expect(plan(b, request([...start, assistant("", calls), toolMsg("c1", "body")]))).toEqual(fresh("tail-mismatch"));
  });

  test("an empty tail after a successful turn gives tail-mismatch", () => {
    const b = bindingAfter(history, {});
    expect(plan(b, request(history))).toEqual(fresh("tail-mismatch"));
  });

  test("a retry after failed_with_output is fresh: the binding is tainted", () => {
    const before = [system, user("hello"), assistant("Hi."), user("do it")];
    const tainted = bindingAfter(before, { outcome: "failed_with_output", plan: "append" }, { state: "tainted", taintReason: "failed" });
    expect(plan(tainted, request([...before, assistant("partial")]))).toEqual(fresh("tainted"));
    const untaintedButBroken = bindingAfter(before, { outcome: "failed_with_output", plan: "append" });
    expect(plan(untaintedButBroken, request(before))).toEqual(fresh("tainted"));
  });

  test("a failed_no_output after a resume turn is fresh", () => {
    const before = [system, user("hello")];
    const b = bindingAfter(before, { outcome: "failed_no_output", plan: "resume" });
    expect(plan(b, request(before))).toEqual(fresh("tainted"));
  });

  test("a cancelled or parked last turn without a live parked turn is fresh", () => {
    const before = [system, user("hello")];
    expect(plan(bindingAfter(before, { outcome: "cancelled" }), request([...before, user("x")]))).toEqual(fresh("tainted"));
    expect(plan(bindingAfter(before, { outcome: "parked" }), request([...before, user("x")]))).toEqual(fresh("tainted"));
  });

  test("system prompt change", () => {
    const req = request([{ role: "system", content: "You are OpenCode, v2." }, user("first"), assistant("one"), user("second"), assistant("two"), user("third")]);
    expect(plan(binding, req)).toEqual(fresh("system-changed"));
  });

  test("tool schema change", () => {
    const changedBash: OpenAiFunctionTool = {
      type: "function",
      function: { ...BASH.function, parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } } } },
    };
    expect(plan(binding, request([...history, user("third")], { tools: [READ, changedBash] }))).toEqual(fresh("tools-changed"));
    expect(plan(binding, request([...history, user("third")], { tools: [READ] }))).toEqual(fresh("tools-changed"));
  });

  test("cwd change and auth epoch change", () => {
    expect(plan(binding, request([...history, user("third")], { cwd: "/elsewhere" }))).toEqual(fresh("cwd-changed"));
    expect(plan(binding, request([...history, user("third")], { authEpoch: "4" }))).toEqual(fresh("auth-changed"));
  });

  test("cwd change while parked cancels the parked turn: fresh", () => {
    const calls = [call("c1", "read", { filePath: "a.ts" })];
    const start = [system, user("look")];
    const req = request([...start, assistant("", calls), toolMsg("c1", "body")], { cwd: "/elsewhere" });
    expect(plan(bindingAfter(start, {}), req, parkedAfter(start, calls))).toEqual(fresh("cwd-changed"));
  });

  test("an assistant or tool message after the new user input gives tail-mismatch", () => {
    expect(plan(binding, request([...history, user("third"), assistant("made up")]))).toEqual(fresh("tail-mismatch"));
  });
});

describe("classifyRequest: requests that never touch the binding", () => {
  const binding = bindingAfter([system, user("hi")], { text: "Hello." });

  test("title, compaction and generate requests are meta", () => {
    for (const kind of ["title", "compaction", "generate"]) {
      expect(plan(binding, request([system, user("hi"), assistant("Hello."), user("x")], { kind }))).toEqual({ kind: "meta" });
    }
  });

  test("a request without tools is meta", () => {
    expect(plan(binding, request([system, user("hi")], { tools: [] }))).toEqual({ kind: "meta" });
  });

  test("no session header gives ephemeral", () => {
    expect(plan(binding, request([system, user("hi")], { sessionKey: null }))).toEqual({ kind: "ephemeral" });
  });
});
