// Structured history replay for a fresh ACP session (SR 4.7). The caller passes the request's messages
// as they are; the leading system run is dropped here because it travels in the session append.

import type { OpenAiMessage, PromptBlock } from "./contracts.ts";
import {
  buildTurnPrompt,
  contentParts,
  contentText,
  contentToBlocks,
  escapeClosingTags,
  isMediaOnlyMessage,
  isRecord,
  isSystemRole,
  leadingSystemCount,
  normalizePart,
  parseDataUrl,
  safeCharIndex,
  sha256Hex,
  type NormalizedPart,
} from "./prompt.ts";

const ESCAPED_TAGS = ["turn", "tool_call", "conversation_history", "tool_results", "system-update"] as const;

export const HISTORY_INTRO =
  "The messages below happened earlier in this conversation, before this Antigravity session started. They are context. The tool calls listed already ran in OpenCode; do not run them again unless the user asks.";
export const CONTINUE_WITH_RESULTS = "Continue the task using these tool results.";

/** Messages at the end that the ladder leaves alone until its last step. */
const RECENT_COUNT = 6;

type ItemKind = "user" | "assistant" | "tool" | "system";

interface ReplayCall {
  id: string;
  name: string;
  args: string;
}

interface Item {
  kind: ItemKind;
  /** 1-based position among the non-system items, stable when earlier items are dropped. */
  n: number;
  body: string;
  /** Placeholders for user media when the item is rendered as history. */
  media: string[];
  calls: ReplayCall[];
  callId: string | null;
  name: string | null;
  message: OpenAiMessage;
  dropped: boolean;
  /** Set once the body was cut, so the latest input is rebuilt from it. */
  cut: boolean;
  rendered: string | null;
}

function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function esc(text: string): string {
  return escapeClosingTags(text, ESCAPED_TAGS);
}

function mediaPlaceholder(part: Exclude<NormalizedPart, { kind: "text" }>): string {
  const hash = (value: string): string => sha256Hex(value).slice(0, 12);
  switch (part.kind) {
    case "image": {
      const data = parseDataUrl(part.url);
      return data ? `[image ${data.mimeType}, ${hash(data.data)}]` : `[image ${part.url}]`;
    }
    case "file": {
      const data = parseDataUrl(part.data);
      const mime = data ? `, ${data.mimeType}` : "";
      return `[file ${part.filename ?? "attachment"}${mime}, ${hash(part.data)}]`;
    }
    case "video":
      return `[video, ${hash(part.url)}]`;
    case "other":
      return `[attachment ${part.type}]`;
  }
}

function toItems(messages: readonly OpenAiMessage[]): Item[] {
  const items: Item[] = [];
  const callNames = new Map<string, string>();
  let n = 0;
  for (const message of messages.slice(leadingSystemCount(messages))) {
    const kind: ItemKind = isSystemRole(message.role) ? "system" : message.role;
    const media: string[] = [];
    for (const part of contentParts(message.content)) {
      if (part.kind !== "text") media.push(mediaPlaceholder(part));
    }
    const calls: ReplayCall[] = [];
    if (kind === "assistant") {
      for (const call of message.tool_calls ?? []) {
        const id = typeof call?.id === "string" ? call.id : "";
        const name = typeof call?.function?.name === "string" ? call.function.name : "";
        if (id) callNames.set(id, name);
        calls.push({ id, name, args: typeof call?.function?.arguments === "string" ? call.function.arguments : "" });
      }
    }
    const body = contentText(message.content);
    if (kind === "assistant" && body.trim().length === 0 && calls.length === 0 && media.length === 0) continue;
    const callId = kind === "tool" && typeof message.tool_call_id === "string" ? message.tool_call_id : null;
    const name =
      kind === "tool" ? (typeof message.name === "string" && message.name ? message.name : callNames.get(callId ?? "") ?? null) : null;
    if (kind !== "system") n += 1;
    items.push({ kind, n, body, media, calls, callId, name, message, dropped: false, cut: false, rendered: null });
  }
  return items;
}

function renderItem(item: Item): string {
  if (item.rendered !== null) return item.rendered;
  let out: string;
  switch (item.kind) {
    case "system":
      out = `<system-update>${esc(item.body)}</system-update>`;
      break;
    case "user": {
      const media = esc(item.media.join(" "));
      const sep = item.body.length > 0 && media.length > 0 ? "\n" : "";
      out = `<turn n="${item.n}" role="user">${esc(item.body)}${sep}${media}</turn>`;
      break;
    }
    case "assistant": {
      const calls = item.calls
        .map((call) => `\n<tool_call id="${attr(call.id)}" name="${attr(call.name)}">${esc(call.args)}</tool_call>`)
        .join("");
      out = `<turn n="${item.n}" role="assistant">${esc(item.body)}${calls}${calls ? "\n" : ""}</turn>`;
      break;
    }
    case "tool": {
      const name = item.name !== null ? ` name="${attr(item.name)}"` : "";
      const callId = item.callId !== null ? ` call_id="${attr(item.callId)}"` : "";
      out = `<turn n="${item.n}" role="tool"${name}${callId}>${esc(item.body)}</turn>`;
      break;
    }
  }
  item.rendered = out;
  return out;
}

/** The trailing items that form the latest input, and whether they are tool results. */
function splitLatest(items: readonly Item[]): { start: number; tools: boolean } {
  let i = items.length;
  while (i > 0 && (items[i - 1].kind === "user" || items[i - 1].kind === "system")) i -= 1;
  const trailing = items.slice(i);
  const mediaAfterTools =
    trailing.length > 0 && i > 0 && items[i - 1].kind === "tool" && trailing.every((item) => isMediaOnlyMessage(item.message));
  if (trailing.length > 0 && !mediaAfterTools) return { start: i, tools: false };
  let j = i;
  while (j > 0 && items[j - 1].kind === "tool") j -= 1;
  return j < i || mediaAfterTools ? { start: j, tools: true } : { start: items.length, tools: false };
}

interface Layout {
  items: Item[];
  latestStart: number;
  latestTools: boolean;
  /** Text characters of `latestBlocks`; null after the latest items changed. */
  latestChars: number | null;
}

function historyLines(layout: Layout): string[] {
  const lines: string[] = [];
  let dropped = 0;
  for (const item of layout.items.slice(0, layout.latestStart)) {
    if (item.dropped) {
      dropped += 1;
      continue;
    }
    if (dropped > 0) lines.push(`[${dropped} earlier messages omitted]`);
    dropped = 0;
    lines.push(renderItem(item));
  }
  if (dropped > 0) lines.push(`[${dropped} earlier messages omitted]`);
  return lines;
}

function historyText(layout: Layout): string | null {
  const lines = historyLines(layout);
  if (lines.length === 0) return null;
  return `<conversation_history>\n${HISTORY_INTRO}\n\n${lines.join("\n")}\n</conversation_history>`;
}

function toolResultsText(layout: Layout): string {
  const results = layout.items
    .slice(layout.latestStart)
    .filter((item) => item.kind === "tool")
    .map(renderItem);
  return `<tool_results>\n${results.join("\n")}\n</tool_results>\n${CONTINUE_WITH_RESULTS}`;
}

/** The latest user messages, rebuilt from their bodies when the ladder cut them. */
function latestUserMessages(layout: Layout): OpenAiMessage[] {
  return layout.items.slice(layout.latestStart).map((item) => {
    if (!item.cut) return item.message;
    const media = Array.isArray(item.message.content)
      ? item.message.content.filter((part) => isRecord(part) && normalizePart(part).kind !== "text")
      : [];
    return { role: item.message.role, content: [{ type: "text", text: item.body }, ...media] };
  });
}

function latestBlocks(layout: Layout): PromptBlock[] {
  if (layout.latestTools) {
    const media = layout.items
      .slice(layout.latestStart)
      .filter((item) => item.kind === "user")
      .flatMap((item) => contentToBlocks(item.message.content, { next: 1 }));
    return [{ type: "text", text: toolResultsText(layout) }, ...media];
  }
  if (layout.latestStart >= layout.items.length) return [{ type: "text", text: "Continue." }];
  return buildTurnPrompt(latestUserMessages(layout), []);
}

function render(layout: Layout): PromptBlock[] {
  const history = historyText(layout);
  const blocks = latestBlocks(layout);
  return history === null ? blocks : [{ type: "text", text: history }, ...blocks];
}

/** Characters of `historyText` without building it, so the ladder can check the budget after each step. */
function historySize(layout: Layout): number {
  let lines = 0;
  let total = 0;
  let dropped = 0;
  const marker = (count: number): number => `[${count} earlier messages omitted]`.length;
  for (const item of layout.items.slice(0, layout.latestStart)) {
    if (item.dropped) {
      dropped += 1;
      continue;
    }
    if (dropped > 0) {
      total += marker(dropped);
      lines += 1;
    }
    dropped = 0;
    total += renderItem(item).length;
    lines += 1;
  }
  if (dropped > 0) {
    total += marker(dropped);
    lines += 1;
  }
  if (lines === 0) return 0;
  const wrapper = `<conversation_history>\n${HISTORY_INTRO}\n\n\n</conversation_history>`.length;
  return wrapper + total + (lines - 1);
}

/** Characters the budget counts: the history block and the text blocks of the latest input as rendered. */
function size(layout: Layout): number {
  if (layout.latestChars === null) {
    layout.latestChars = latestBlocks(layout).reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
  }
  return historySize(layout) + layout.latestChars;
}

function omissionMarker(count: number): string {
  return `\n[... ${count} characters omitted ...]\n`;
}

/** Head and tail with the marker between them, never longer than `max`; a plain head when the marker does not fit. */
function cutMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const markerChars = omissionMarker(text.length).length;
  if (max < markerChars + 2) return text.slice(0, safeCharIndex(text, Math.max(0, max)));
  const keep = max - markerChars;
  const head = safeCharIndex(text, Math.floor(keep * 0.75));
  const tailStart = Math.min(text.length, safeCharIndex(text, text.length - (keep - head)) + 1);
  return `${text.slice(0, head)}${omissionMarker(tailStart - head)}${text.slice(tailStart)}`;
}

function setBody(item: Item, body: string): void {
  if (body === item.body) return;
  item.body = body;
  item.cut = true;
  item.rendered = null;
}

function setArgs(item: Item, args: readonly string[], max: number): void {
  item.calls.forEach((call, i) => {
    const next = cutMiddle(args[i] ?? call.args, max);
    if (next !== call.args) {
      call.args = next;
      item.rendered = null;
    }
  });
}

/**
 * SR 4.7. Returns the history block (when there is history) followed by the latest input: the trailing
 * user messages as text, image and file blocks, or the trailing tool results with the continue line.
 */
export function buildReplayPrompt(messages: readonly OpenAiMessage[], budgetChars: number): PromptBlock[] {
  const items = toItems(messages);
  const latest = splitLatest(items);
  const layout: Layout = { items, latestStart: latest.start, latestTools: latest.tools, latestChars: null };
  const fits = (): boolean => size(layout) <= budgetChars;
  if (fits()) return render(layout);

  // The latest input is never "old", however many tool results it has.
  const recentStart = Math.min(layout.latestStart, Math.max(0, items.length - RECENT_COUNT));
  const old = items.slice(0, recentStart);
  const oldOf = (kind: ItemKind): Item[] => old.filter((item) => item.kind === kind && !item.dropped);
  const originalLength = new Map(items.map((item) => [item, item.body.length]));

  // Steps 1 to 3: old tool results to 2 000, then 300, then a one-line stub.
  for (const max of [2000, 300]) {
    for (const item of oldOf("tool")) setBody(item, cutMiddle(item.body, max));
    if (fits()) return render(layout);
  }
  for (const item of oldOf("tool")) setBody(item, `[tool result omitted, ${originalLength.get(item) ?? 0} characters]`);
  if (fits()) return render(layout);

  // Step 4: old assistant text and tool call arguments to 1 000.
  for (const item of oldOf("assistant")) {
    setBody(item, cutMiddle(item.body, 1000));
    setArgs(item, item.calls.map((c) => c.args), 1000);
  }
  if (fits()) return render(layout);

  // Step 5: old user messages to 4 000.
  for (const item of oldOf("user")) setBody(item, cutMiddle(item.body, 4000));
  if (fits()) return render(layout);

  // Step 6: drop old messages whole, oldest first; user messages go last.
  for (const keepUsers of [true, false]) {
    for (const item of old) {
      if (item.dropped || (keepUsers && item.kind === "user")) continue;
      item.dropped = true;
      if (fits()) return render(layout);
    }
  }

  // Step 7: the recent messages share the budget, tool results first, then assistant, then user text.
  // Every pass cuts from the original text with a smaller share, so markers never nest. An assistant
  // message splits its share between its text and its tool call arguments.
  const recent = items.slice(recentStart);
  const originals = new Map(recent.map((item) => [item, { body: item.body, args: item.calls.map((c) => c.args) }]));
  const shrinkRecent = (): boolean => {
    let share = Math.floor(budgetChars / Math.max(1, recent.length));
    for (let pass = 0; pass < 12; pass += 1, share = Math.floor(share * 0.7)) {
      for (const kind of ["tool", "assistant", "user", "system"] as const) {
        for (const item of recent) {
          const original = originals.get(item);
          if (item.kind !== kind || item.dropped || !original) continue;
          if (item.calls.length === 0) {
            setBody(item, cutMiddle(original.body, share));
            continue;
          }
          setBody(item, cutMiddle(original.body, Math.floor(share / 2)));
          setArgs(item, original.args, Math.floor(share / 2 / item.calls.length));
        }
        layout.latestChars = null;
        if (fits()) return true;
      }
    }
    return false;
  };
  if (shrinkRecent()) return render(layout);

  // Still over: the call wrappers alone are too many. Recent tool calls collapse into one count line.
  for (const item of recent) {
    const original = originals.get(item);
    if (item.kind !== "assistant" || item.calls.length === 0 || !original) continue;
    const note = `[${item.calls.length} tool calls omitted]`;
    item.calls = [];
    originals.set(item, { body: original.body ? `${original.body}\n${note}` : note, args: [] });
    item.rendered = null;
  }
  if (shrinkRecent()) return render(layout);

  // Last: drop the recent history before the latest input, oldest first, then cut the latest input.
  for (const item of recent) {
    if (items.indexOf(item) >= layout.latestStart) break;
    item.dropped = true;
    if (fits()) return render(layout);
  }
  shrinkRecent();
  return render(layout);
}
