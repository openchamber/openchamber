// Canonical messages, fingerprints and request classification (SR 4.2, 4.3).
//
// The costly mistake here is reading an edit as an append: agy would then answer a conversation
// that is not the one OpenCode shows. Every check below therefore falls back to `fresh`, and only
// an exact match of the stored prefix and of our own echoed output reuses the ACP session.
//
// Index space: `prefixCount`, `inputFrom` and `inputTo` count canonical messages, that is the request's
// messages after the leading system run and after empty assistant messages are dropped. The proxy
// records a turn's input as `[inputFrom, inputTo)` with `inputTo = prefix.count`; `inputFrom` may be the
// previous prefix, since `redo` skips the echoed assistant message at its start.
//
// Turn views: `ParkedTurnView.prefixCount/prefixHash` is the prefix the binding moved to with the latest
// request of the parked turn, and `emittedToolCalls`/`emittedTextHash` (in the view and in `lastTurn`)
// describe the latest OpenAI response, since that is the one assistant message the next request echoes.

import type {
  BindingRecord,
  ClassifyInput,
  ClassifyResult,
  EmittedHashes,
  EmittedToolCall,
  MediaPart,
  OpenAiContentPart,
  OpenAiMessage,
  ParkedTurnView,
  RequestPlan,
  ToolResult,
} from "./contracts.ts";
import {
  buildToolDescriptionReminder,
  canonicalJson,
  contentParts,
  contentText,
  isMediaOnlyMessage,
  isSystemRole,
  leadingSystemCount,
  normalizePart,
  parseDataUrl,
  sha256Hex,
  type NormalizedPart,
} from "./prompt.ts";

export interface CanonicalToolCall {
  id: string;
  name: string;
  /** Arguments re-serialized with sorted keys; the raw string when it does not parse. */
  args: string;
}

/** `{ r, t, m, c, k, n }` of SR 4.2. `c` only on assistant messages, `k` and `n` only on tool messages. */
export interface CanonicalMessage {
  r: "user" | "assistant" | "tool" | "system";
  t: string;
  m: string[];
  c?: CanonicalToolCall[];
  k?: string;
  n?: string;
}

/** A canonical message with the request message it came from. */
interface CanonicalEntry {
  canonical: CanonicalMessage;
  message: OpenAiMessage;
  fingerprint: string;
}

const HASH_PREFIX_HEX = 16;

function shortHash(input: string): string {
  return sha256Hex(input).slice(0, HASH_PREFIX_HEX);
}

function mediaToken(part: Exclude<NormalizedPart, { kind: "text" }>): string {
  switch (part.kind) {
    case "image": {
      const data = parseDataUrl(part.url);
      return data ? `img:${shortHash(data.data)}` : `imgurl:${shortHash(part.url)}`;
    }
    case "file":
      return `file:${part.filename ?? ""}:${shortHash(part.data)}`;
    case "video":
      return `video:${shortHash(part.url)}`;
    case "other":
      return `other:${part.type}:${shortHash(canonicalJson(withoutCacheControl(part.part)))}`;
  }
}

function withoutCacheControl(part: OpenAiContentPart): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(part)) {
    if (key !== "cache_control") out[key] = value;
  }
  return out;
}

/** `JSON.parse(arguments)` re-serialized with sorted keys, or the raw string when it does not parse. */
function canonicalToolArgs(argumentsJson: string): string {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    return canonicalJson(parsed);
  } catch {
    return argumentsJson;
  }
}

/** Trailing whitespace on the whole text is trimmed (SR 4.2 `t`). */
function canonicalText(text: string): string {
  return text.trimEnd();
}

/** One message to its canonical form; null for an assistant message with no text, media or tool calls. */
function canonicalizeMessage(message: OpenAiMessage): CanonicalMessage | null {
  const parts = contentParts(message.content);
  let text = "";
  const media: string[] = [];
  for (const part of parts) {
    if (part.kind === "text") text += part.text;
    else media.push(mediaToken(part));
  }
  const t = canonicalText(text);
  const r = isSystemRole(message.role) ? "system" : message.role;
  const canonical: CanonicalMessage = { r, t, m: media };
  if (r === "assistant") {
    const calls: CanonicalToolCall[] = [];
    for (const call of message.tool_calls ?? []) {
      calls.push({
        id: typeof call?.id === "string" ? call.id : "",
        name: typeof call?.function?.name === "string" ? call.function.name : "",
        args: canonicalToolArgs(typeof call?.function?.arguments === "string" ? call.function.arguments : ""),
      });
    }
    if (t.length === 0 && media.length === 0 && calls.length === 0) return null;
    canonical.c = calls;
  }
  if (r === "tool") {
    if (typeof message.tool_call_id === "string") canonical.k = message.tool_call_id;
    if (typeof message.name === "string" && message.name.length > 0) canonical.n = message.name;
  }
  return canonical;
}

/**
 * SR 4.3 step 2: drops the leading system run, canonicalizes, drops empty assistant messages and
 * fingerprints what is left.
 */
function canonicalEntries(messages: readonly OpenAiMessage[]): CanonicalEntry[] {
  const entries: CanonicalEntry[] = [];
  for (const message of messages.slice(leadingSystemCount(messages))) {
    const canonical = canonicalizeMessage(message);
    if (canonical) entries.push({ canonical, message, fingerprint: messageFingerprint(canonical) });
  }
  return entries;
}

export function canonicalizeMessages(messages: readonly OpenAiMessage[]): CanonicalMessage[] {
  return canonicalEntries(messages).map((entry) => entry.canonical);
}

export function messageFingerprint(message: CanonicalMessage): string {
  return sha256Hex(canonicalJson(message)).slice(0, 32);
}

const CHAIN_SEED = sha256Hex("agy-binding-v1");

/** Fold over `fps[0..count)`: `h = sha256(h + ":" + fp)`, starting from `sha256("agy-binding-v1")`. */
export function chainHash(fps: readonly string[], count: number): string {
  let h = CHAIN_SEED;
  for (let i = 0; i < count && i < fps.length; i += 1) h = sha256Hex(`${h}:${fps[i]}`);
  return h;
}

export function emittedTextHash(text: string): string | null {
  const t = canonicalText(text);
  return t.length === 0 ? null : sha256Hex(t);
}

export function toolArgsHash(argumentsJson: string): string {
  return canonicalArgsHash(canonicalToolArgs(argumentsJson));
}

function canonicalArgsHash(args: string): string {
  return sha256Hex(args).slice(0, 32);
}

export const emittedHashes: EmittedHashes = { emittedTextHash, toolArgsHash };

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const META_KINDS = new Set(["title", "compaction", "generate"]);

interface TailSplit {
  assistants: CanonicalEntry[];
  /** Tool messages after the assistants, plus the media-only user messages right after them. */
  results: CanonicalEntry[];
  rest: CanonicalEntry[];
}

function splitTail(tail: readonly CanonicalEntry[]): TailSplit {
  let i = 0;
  const assistants: CanonicalEntry[] = [];
  while (i < tail.length && tail[i].canonical.r === "assistant") assistants.push(tail[i++]);
  const results: CanonicalEntry[] = [];
  let sawTool = false;
  while (i < tail.length) {
    const entry = tail[i];
    if (entry.canonical.r === "tool") sawTool = true;
    else if (!(sawTool && isMediaOnlyMessage(entry.message))) break;
    results.push(entry);
    i += 1;
  }
  return { assistants, results, rest: tail.slice(i) };
}

interface ExpectedOutput {
  toolCalls: readonly EmittedToolCall[];
  textHash: string | null;
  /** Parked turns: text in the echo may also be empty (SR 4.3 step 5b). */
  textMayBeEmpty: boolean;
}

/** The echoed assistant messages must be exactly our last response (SR 4.3 steps 5b and 9). */
function echoMatches(assistants: readonly CanonicalEntry[], expected: ExpectedOutput): boolean {
  if (assistants.length > 1) return false;
  const echo = assistants[0];
  if (!echo) return expected.textHash === null && expected.toolCalls.length === 0;
  const { canonical } = echo;
  if (canonical.m.length > 0) return false;
  const calls = canonical.c ?? [];
  if (calls.length !== expected.toolCalls.length) return false;
  for (let i = 0; i < calls.length; i += 1) {
    const want = expected.toolCalls[i];
    const got = calls[i];
    if (got.id !== want.id || got.name !== want.name) return false;
    if (canonicalArgsHash(got.args) !== want.argsHash) return false;
  }
  const textHash = emittedTextHash(canonical.t);
  if (textHash === expected.textHash) return true;
  return expected.textMayBeEmpty && textHash === null;
}

function isInputMessage(entry: CanonicalEntry): boolean {
  return entry.canonical.r === "user" || entry.canonical.r === "system";
}

function toolResultsOf(results: readonly CanonicalEntry[]): { results: ToolResult[]; media: MediaPart[] } {
  const toolResults: ToolResult[] = [];
  const media: MediaPart[] = [];
  for (const entry of results) {
    if (entry.canonical.r === "tool") {
      const result: ToolResult = { toolCallId: entry.canonical.k ?? "", content: contentText(entry.message.content) };
      if (entry.canonical.n !== undefined) result.name = entry.canonical.n;
      toolResults.push(result);
      continue;
    }
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (isMediaPart(part)) media.push(part);
    }
  }
  return { results: toolResults, media };
}

function isMediaPart(part: OpenAiContentPart): part is MediaPart {
  return normalizePart(part).kind !== "text";
}

/** SR 4.3 step 5, for a live turn in phase `parked`. */
function classifyParked(entries: readonly CanonicalEntry[], fps: readonly string[], parked: ParkedTurnView): RequestPlan {
  if (entries.length < parked.prefixCount || chainHash(fps, parked.prefixCount) !== parked.prefixHash) {
    return { kind: "fresh", reason: "prefix-mismatch" };
  }
  const tail = splitTail(entries.slice(parked.prefixCount));
  const expected: ExpectedOutput = {
    toolCalls: parked.emittedToolCalls,
    textHash: parked.emittedTextHash,
    textMayBeEmpty: true,
  };
  if (!echoMatches(tail.assistants, expected)) return { kind: "fresh", reason: "tail-mismatch" };

  const parkedIds = new Set(parked.parkedToolCallIds);
  const answered = new Set<string>();
  for (const entry of tail.results) {
    if (entry.canonical.r !== "tool") continue;
    const id = entry.canonical.k;
    if (id === undefined || !parkedIds.has(id) || answered.has(id)) return { kind: "fresh", reason: "tail-mismatch" };
    answered.add(id);
  }
  if (answered.size === 0 || !tail.rest.every(isInputMessage)) return { kind: "fresh", reason: "tail-mismatch" };

  const { results, media } = toolResultsOf(tail.results);
  return { kind: "resume", results, media, steer: tail.rest.map((entry) => entry.message) };
}

/** Outcomes that mean agy's history and OpenCode's no longer agree about the last turn (SR 4.1). */
const BROKEN_OUTCOMES = new Set(["parked", "failed_with_output", "cancelled"]);

function changedDescriptions(binding: BindingRecord, current: Record<string, string>): Set<string> {
  const changed = new Set<string>();
  for (const [name, hash] of Object.entries(current)) {
    if (binding.toolsDescHashes[name] !== hash) changed.add(name);
  }
  return changed;
}

/** One reminder naming the tools whose descriptions differ from the binding's, or none (SR 7.5). */
function descriptionReminders(binding: BindingRecord, request: ClassifyInput["request"]): string[] {
  const changed = changedDescriptions(binding, request.append.toolsDescHashes);
  return changed.size > 0 ? [buildToolDescriptionReminder(request.tools, changed)] : [];
}

/**
 * The input of the failed turn, `[inputFrom, inputTo)` without the echo of our earlier output at its
 * start (that echo was checked when the failed turn was classified). Null when the range is unusable.
 */
function failedInput(binding: BindingRecord, entries: readonly CanonicalEntry[]): OpenAiMessage[] | null {
  const last = binding.lastTurn;
  if (!last) return null;
  const { inputFrom: from, inputTo: to } = last;
  if (from < 0 || from >= to || to !== binding.prefixCount || to > entries.length) return null;
  let start = from;
  while (start < to && entries[start].canonical.r === "assistant") start += 1;
  const input = entries.slice(start, to);
  if (input.length === 0 || !input.every(isInputMessage)) return null;
  return input.map((entry) => entry.message);
}

function classifyBound(
  binding: BindingRecord,
  entries: readonly CanonicalEntry[],
  fps: readonly string[],
  input: ClassifyInput,
): RequestPlan {
  const { request } = input;
  // Step 3.
  if (binding.authEpoch !== request.authEpoch) return { kind: "fresh", reason: "auth-changed" };
  if (binding.cwd !== request.cwd) return { kind: "fresh", reason: "cwd-changed" };
  // Step 5.
  if (input.parkedTurn) return classifyParked(entries, fps, input.parkedTurn);
  // Step 6. The outcome check is defensive: the proxy taints these bindings itself.
  const last = binding.lastTurn;
  if (binding.state === "tainted" || (last !== null && BROKEN_OUTCOMES.has(last.outcome))) {
    return { kind: "fresh", reason: "tainted" };
  }
  const failedClean = last !== null && last.outcome === "failed_no_output";
  if (failedClean && last.plan !== "append" && last.plan !== "redo") return { kind: "fresh", reason: "tainted" };
  // Step 7.
  if (binding.systemHash !== request.append.systemHash) return { kind: "fresh", reason: "system-changed" };
  if (binding.toolsSchemaHash !== request.append.toolsSchemaHash) return { kind: "fresh", reason: "tools-changed" };
  // Step 8.
  if (entries.length < binding.prefixCount || chainHash(fps, binding.prefixCount) !== binding.prefixHash) {
    return { kind: "fresh", reason: "prefix-mismatch" };
  }
  // Step 9.
  const tail = entries.slice(binding.prefixCount);
  const split = splitTail(tail);
  const expected: ExpectedOutput = {
    toolCalls: last?.emittedToolCalls ?? [],
    textHash: last?.emittedTextHash ?? null,
    textMayBeEmpty: false,
  };
  if (!echoMatches(split.assistants, expected)) return { kind: "fresh", reason: "tail-mismatch" };
  // Step 10: results with no parked turn to take them.
  if (split.results.length > 0) return { kind: "fresh", reason: "tail-mismatch" };
  if (!split.rest.every(isInputMessage)) return { kind: "fresh", reason: "tail-mismatch" };
  // Step 11. A clean no-output failure: agy may or may not have recorded that turn's input, so it is
  // sent again, alone when OpenCode retries the same request (`redo`), or before the new input.
  const retried = failedClean ? failedInput(binding, entries) : [];
  if (retried === null) return { kind: "fresh", reason: "tail-mismatch" };
  if (tail.length === 0 && failedClean) {
    return { kind: "redo", input: retried, reminders: descriptionReminders(binding, request) };
  }
  // Step 12.
  if (split.rest.length > 0) {
    const input = [...retried, ...split.rest.map((entry) => entry.message)];
    return { kind: "append", input, reminders: descriptionReminders(binding, request) };
  }
  // Step 13.
  return { kind: "fresh", reason: "tail-mismatch" };
}

/** SR 4.3. Pure: reads no store and no clock. */
export function classifyRequest(input: ClassifyInput): ClassifyResult {
  const { request } = input;
  const entries = canonicalEntries(request.messages);
  const fps = entries.map((entry) => entry.fingerprint);
  const prefix = { count: fps.length, hash: chainHash(fps, fps.length) };

  // Step 1.
  if ((request.kind !== null && META_KINDS.has(request.kind)) || request.tools.length === 0) {
    return { plan: { kind: "meta" }, prefix };
  }
  if (request.sessionKey === null) return { plan: { kind: "ephemeral" }, prefix };
  // Step 3.
  if (!input.binding) return { plan: { kind: "fresh", reason: "no-binding" }, prefix };
  return { plan: classifyBound(input.binding, entries, fps, input), prefix };
}
