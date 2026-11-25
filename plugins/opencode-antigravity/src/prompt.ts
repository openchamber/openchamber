// System prompt append (SR 7.1 to 7.3), per-turn prompt blocks (SR 4.4), and the content and JSON
// helpers that fingerprint.ts and replay.ts share. Pure functions: the same input always gives the
// same text and hashes. Nothing here logs.

import { createHash } from "node:crypto";
import type {
  OpenAiContentPart,
  OpenAiFunctionTool,
  OpenAiMessage,
  PromptBlock,
  SessionAppend,
  SessionAppendInput,
  ToolsCompactionLevel,
} from "./contracts.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** JSON with object keys sorted at every depth and no whitespace. `undefined` members are left out. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return `[${items.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries: Array<[string, unknown]> = Object.entries(value);
    const members = entries
      .filter(([, v]) => v !== undefined && typeof v !== "function" && typeof v !== "symbol")
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${members.join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

/** A content part reduced to what the plugin reads from it. */
export type NormalizedPart =
  | { kind: "text"; text: string }
  | { kind: "image"; url: string }
  | { kind: "video"; url: string }
  | { kind: "file"; filename: string | null; data: string }
  | { kind: "other"; type: string; part: OpenAiContentPart };

export function normalizePart(part: OpenAiContentPart): NormalizedPart {
  if (part.type === "text" && "text" in part && typeof part.text === "string") {
    return { kind: "text", text: part.text };
  }
  if (part.type === "image_url" && "image_url" in part) {
    const image = part.image_url;
    if (isRecord(image) && typeof image.url === "string") return { kind: "image", url: image.url };
  }
  if (part.type === "video_url" && "video_url" in part) {
    const video = part.video_url;
    if (isRecord(video) && typeof video.url === "string") return { kind: "video", url: video.url };
  }
  if (part.type === "file" && "file" in part) {
    const file = part.file;
    if (isRecord(file) && typeof file.file_data === "string") {
      return {
        kind: "file",
        filename: typeof file.filename === "string" ? file.filename : null,
        data: file.file_data,
      };
    }
  }
  return { kind: "other", type: typeof part.type === "string" ? part.type : "unknown", part };
}

export function contentParts(content: OpenAiMessage["content"]): NormalizedPart[] {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const parts: NormalizedPart[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    parts.push(normalizePart(part));
  }
  return parts;
}

/** All text parts joined with "", which is how OpenCode collapses plain text parts (SR 4.2). */
export function contentText(content: OpenAiMessage["content"]): string {
  let text = "";
  for (const part of contentParts(content)) {
    if (part.kind === "text") text += part.text;
  }
  return text;
}

/** A user message with at least one part and no text part: the attachment message OpenCode emits after tool messages. */
export function isMediaOnlyMessage(message: OpenAiMessage): boolean {
  if (message.role !== "user" || !Array.isArray(message.content)) return false;
  const parts = contentParts(message.content);
  return parts.length > 0 && parts.every((part) => part.kind !== "text");
}

/** The leading run of system and developer messages. */
export function leadingSystemCount(messages: readonly OpenAiMessage[]): number {
  let count = 0;
  while (count < messages.length && isSystemRole(messages[count].role)) count += 1;
  return count;
}

export function isSystemRole(role: OpenAiMessage["role"]): role is "system" | "developer" {
  return role === "system" || role === "developer";
}

export interface DataUrl {
  mimeType: string;
  base64: boolean;
  data: string;
}

export function parseDataUrl(url: string): DataUrl | null {
  const match = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(url);
  if (!match) return null;
  const params = match[2].split(";").filter(Boolean);
  return {
    mimeType: match[1] || "application/octet-stream",
    base64: params.includes("base64"),
    data: match[3],
  };
}

/** Writes `</tag` as `&lt;/tag` for each tag, case-insensitive, so content cannot close a wrapper. */
export function escapeClosingTags(text: string, tags: readonly string[]): string {
  let out = text;
  for (const tag of tags) {
    out = out.replace(new RegExp(`</(${tag})>`, "gi"), "&lt;/$1>");
  }
  return out;
}

/** Cut position at or below `index` that does not split a surrogate pair. */
export function safeCharIndex(text: string, index: number): number {
  if (index <= 0) return 0;
  if (index >= text.length) return text.length;
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}

function cutChars(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, safeCharIndex(text, Math.max(0, max - 3)))}...`;
}

// ---------------------------------------------------------------------------
// UTF-8 byte budgets (SR 7.1, 7.2)
// ---------------------------------------------------------------------------

function utf8(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/** The longest prefix of `buf` within `maxBytes` that ends on a code point boundary. */
function headBytes(buf: Buffer, maxBytes: number): Buffer {
  let end = Math.max(0, Math.min(maxBytes, buf.length));
  while (end > 0 && end < buf.length && isContinuationByte(buf[end])) end -= 1;
  return buf.subarray(0, end);
}

/** The longest suffix of `buf` within `maxBytes` that starts on a code point boundary. */
function tailBytes(buf: Buffer, maxBytes: number): Buffer {
  let start = Math.max(0, buf.length - Math.max(0, maxBytes));
  while (start < buf.length && isContinuationByte(buf[start])) start += 1;
  return buf.subarray(start);
}

function systemMarker(omittedBytes: number): string {
  return `\n\n[... ${omittedBytes} bytes of OpenCode instructions omitted to fit the Antigravity prompt budget ...]\n\n`;
}

/** Head up to 75 percent of `budget`, the marker, then the tail in what is left. Never over `budget`. */
function cutHeadTail(text: string, budget: number): { text: string; omitted: number } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= budget) return { text, omitted: 0 };
  const head = headBytes(buf, Math.floor(budget * 0.75));
  // The marker's length depends on the omitted count, which depends on the tail; settle it.
  let markerBytes = utf8(systemMarker(buf.length - head.length));
  if (head.length + markerBytes > budget) {
    return { text: "", omitted: buf.length };
  }
  let tail = tailBytes(buf, budget - head.length - markerBytes);
  for (let i = 0; i < 4; i += 1) {
    const next = utf8(systemMarker(buf.length - head.length - tail.length));
    if (next === markerBytes) break;
    markerBytes = next;
    tail = tailBytes(buf, Math.max(0, budget - head.length - markerBytes));
  }
  const omitted = buf.length - head.length - tail.length;
  const out = `${head.toString("utf8")}${systemMarker(omitted)}${tail.toString("utf8")}`;
  return { text: out, omitted };
}

function normalizeWhitespace(text: string): string {
  return text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
}

export interface BudgetedSystem {
  text: string;
  omittedBytes: number;
}

/** SR 7.2 steps 1 to 4. `texts` are the leading system messages in order. */
export function budgetSystemText(texts: readonly string[], maxBytes: number): BudgetedSystem {
  const separator = "\n\n";
  const joined = texts.join(separator);
  if (utf8(joined) <= maxBytes) return { text: joined, omittedBytes: 0 };

  const normalized = texts.map(normalizeWhitespace);
  const joinedNormalized = normalized.join(separator);
  if (utf8(joinedNormalized) <= maxBytes) return { text: joinedNormalized, omittedBytes: 0 };

  if (normalized.length === 1) {
    const cut = cutHeadTail(normalized[0], maxBytes);
    return { text: cut.text, omittedBytes: cut.omitted };
  }

  // Several messages: first 20/32, last 8/32, the middle ones share 4/32. A message under its share
  // gives the rest to the over-share messages, earliest first.
  const available = Math.max(0, maxBytes - utf8(separator) * (normalized.length - 1));
  const sizes = normalized.map(utf8);
  const middleCount = normalized.length - 2;
  const first = Math.floor((available * 20) / 32);
  const middleEach = middleCount > 0 ? Math.floor((available * 4) / 32 / middleCount) : 0;
  const last = available - first - middleEach * middleCount;
  const shares = normalized.map((_, i) => (i === 0 ? first : i === normalized.length - 1 ? last : middleEach));
  let surplus = 0;
  for (let i = 0; i < sizes.length; i += 1) surplus += Math.max(0, shares[i] - sizes[i]);

  let omittedBytes = 0;
  const out: string[] = [];
  for (let i = 0; i < normalized.length; i += 1) {
    if (sizes[i] <= shares[i]) {
      out.push(normalized[i]);
      continue;
    }
    const extra = Math.min(surplus, sizes[i] - shares[i]);
    surplus -= extra;
    const cut = cutHeadTail(normalized[i], shares[i] + extra);
    omittedBytes += cut.omitted;
    out.push(cut.text);
  }
  return { text: out.join(separator), omittedBytes };
}

/** Texts of the leading run of system and developer messages; later system messages are conversation items. */
export function extractLeadingSystem(messages: readonly OpenAiMessage[]): string[] {
  const texts: string[] = [];
  for (const message of messages.slice(0, leadingSystemCount(messages))) {
    const text = contentText(message.content);
    if (text.trim().length > 0) texts.push(text);
  }
  return texts;
}

// ---------------------------------------------------------------------------
// Tool schemas (SR 7.3)
// ---------------------------------------------------------------------------

const VALUE_KEYWORDS = new Set([
  "type",
  "required",
  "enum",
  "const",
  "$ref",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "default",
  "nullable",
]);
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs", "definitions"]);
const SCHEMA_LIST_KEYWORDS = new Set(["prefixItems", "anyOf", "oneOf", "allOf"]);
const SCHEMA_KEYWORDS = new Set(["not", "additionalProperties", "items"]);

type PropertyDescriptions = "full" | "cut" | "none";

const PROPERTY_DESCRIPTION_CHARS = 160;

/** Keeps the allowlisted keywords at every depth; drops `$schema`, `$id`, `title`, `examples`, `x-*` and the rest. */
export function compactSchema(schema: unknown, descriptions: PropertyDescriptions = "full"): unknown {
  if (Array.isArray(schema)) {
    const items: readonly unknown[] = schema;
    return items.map((item) => compactSchema(item, descriptions));
  }
  if (!isRecord(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (VALUE_KEYWORDS.has(key)) {
      out[key] = value;
    } else if (key === "description") {
      if (typeof value !== "string" || descriptions === "none") continue;
      out[key] = descriptions === "cut" ? cutChars(value, PROPERTY_DESCRIPTION_CHARS) : value;
    } else if (SCHEMA_MAP_KEYWORDS.has(key)) {
      if (!isRecord(value)) continue;
      const map: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value)) map[name] = compactSchema(sub, descriptions);
      out[key] = map;
    } else if (SCHEMA_LIST_KEYWORDS.has(key) || SCHEMA_KEYWORDS.has(key)) {
      out[key] = compactSchema(value, descriptions);
    }
  }
  return out;
}

interface NamedTool {
  name: string;
  description: string | null;
  parameters: Record<string, unknown> | null;
}

function namedTools(tools: readonly OpenAiFunctionTool[]): NamedTool[] {
  const out: NamedTool[] = [];
  for (const tool of tools) {
    const fn = tool?.function;
    if (!fn || typeof fn.name !== "string" || fn.name.length === 0) continue;
    out.push({
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : null,
      parameters: isRecord(fn.parameters) ? fn.parameters : null,
    });
  }
  return out;
}

const DEFAULT_PARAMETERS = { type: "object", properties: {} };
export const OMITTED_PARAMETERS =
  "omitted: over the prompt budget; call with your best arguments and read the validation error";

interface LevelSpec {
  level: ToolsCompactionLevel;
  toolDescription: "full" | number | "none";
  propertyDescriptions: PropertyDescriptions;
}

const LEVELS: readonly LevelSpec[] = [
  { level: 0, toolDescription: "full", propertyDescriptions: "full" },
  { level: 1, toolDescription: "full", propertyDescriptions: "cut" },
  { level: 2, toolDescription: 400, propertyDescriptions: "cut" },
  { level: 3, toolDescription: 160, propertyDescriptions: "none" },
  { level: 4, toolDescription: "none", propertyDescriptions: "none" },
];

function toolLine(tool: NamedTool, spec: LevelSpec, omitParameters: boolean): string {
  const line: Record<string, unknown> = { name: tool.name };
  if (tool.description !== null && spec.toolDescription !== "none") {
    line.description =
      spec.toolDescription === "full" ? tool.description : cutChars(tool.description, spec.toolDescription);
  }
  line.parameters = omitParameters
    ? OMITTED_PARAMETERS
    : compactSchema(tool.parameters ?? DEFAULT_PARAMETERS, spec.propertyDescriptions);
  return JSON.stringify(line);
}

export interface ToolsSection {
  /** One minified JSON object per line, in the order OpenCode sent the tools. */
  text: string;
  level: ToolsCompactionLevel;
  schemaOmitted: number;
  dropped: number;
}

function linesBytes(lines: readonly string[]): number {
  if (lines.length === 0) return 0;
  let total = lines.length - 1;
  for (const line of lines) total += utf8(line);
  return total;
}

/** SR 7.3: the first level of L0 to L6 whose lines fit in `maxBytes`. */
export function buildToolsSection(tools: readonly OpenAiFunctionTool[], maxBytes: number): ToolsSection {
  const named = namedTools(tools);
  for (const spec of LEVELS) {
    const lines = named.map((tool) => toolLine(tool, spec, false));
    if (linesBytes(lines) <= maxBytes) return { text: lines.join("\n"), level: spec.level, schemaOmitted: 0, dropped: 0 };
  }

  // L5: replace parameters from the end of the list.
  const l4 = LEVELS[4];
  const lines = named.map((tool) => toolLine(tool, l4, false));
  for (let i = named.length - 1; i >= 0; i -= 1) {
    lines[i] = toolLine(named[i], l4, true);
    if (linesBytes(lines) <= maxBytes) {
      return { text: lines.join("\n"), level: 5, schemaOmitted: named.length - i, dropped: 0 };
    }
  }

  // L6: collapse tools from the end into one names-only line; names that still do not fit are dropped.
  const kept = [...lines];
  const collapsed: string[] = [];
  const moreLine = (): string[] => (collapsed.length > 0 ? [JSON.stringify({ more_tools: collapsed })] : []);
  while (kept.length > 0 && linesBytes([...kept, ...moreLine()]) > maxBytes) {
    kept.pop();
    collapsed.unshift(named[kept.length].name);
  }
  let dropped = 0;
  while (collapsed.length > 0 && linesBytes([...kept, ...moreLine()]) > maxBytes) {
    collapsed.pop();
    dropped += 1;
  }
  return { text: [...kept, ...moreLine()].join("\n"), level: 6, schemaOmitted: kept.length, dropped };
}

/** `sha256(sorted lines "name\tcanonical(parameters)")` over the raw parameters (SR 4.2). */
export function toolsSchemaHash(tools: readonly OpenAiFunctionTool[]): string {
  const lines = namedTools(tools)
    .map((tool) => `${tool.name}\t${canonicalJson(tool.parameters)}`)
    .sort();
  return sha256Hex(lines.join("\n"));
}

/** `Record<name, sha256(description).slice(0, 16)>` (SR 4.2, 7.5). */
export function toolsDescriptionHashes(tools: readonly OpenAiFunctionTool[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tool of namedTools(tools)) out[tool.name] = sha256Hex(tool.description ?? "").slice(0, 16);
  return out;
}

const SYSTEM_UPDATE_TAGS = ["system-update"] as const;

/** SR 7.5: the note that starts the next prompt when only tool descriptions changed. */
export function buildToolDescriptionReminder(
  tools: readonly OpenAiFunctionTool[],
  changedNames: ReadonlySet<string>,
): string {
  const lines = namedTools(tools)
    .filter((tool) => changedNames.has(tool.name))
    .map((tool) => toolLine(tool, LEVELS[0], false));
  const body = escapeClosingTags(lines.join("\n"), SYSTEM_UPDATE_TAGS);
  return `<system-update>The descriptions of these OpenCode tools changed:\n${body}\n</system-update>`;
}

// ---------------------------------------------------------------------------
// Session append (SR 7.1)
// ---------------------------------------------------------------------------

function toolProtocol(mcpServerName: string): string {
  return [
    "## Tool execution protocol",
    `You run inside OpenCode. Call every tool through call_mcp_tool with ServerName "${mcpServerName}", the exact ToolName below, and Arguments that match its JSON schema. Built-in Antigravity tools are disabled. Never call list_resources, read_resource or manage_task.`,
  ].join("\n");
}

const META_NO_TOOLS_LINE = "Do not call any tools. Respond with text only.";

/**
 * SR 7.1. `mcpServerName` is the server name the MCP bridge registers (`MCP_SERVER_NAME`); the caller
 * passes it so this module does not import the runtime's constants.
 */
export function buildSessionAppend(input: SessionAppendInput, mcpServerName: string): SessionAppend {
  const systemTexts = extractLeadingSystem(input.messages);
  const system = budgetSystemText(systemTexts, input.config.maxSystemPromptBytes);
  const sections: string[] = [];
  if (system.text.length > 0) {
    sections.push(`<opencode_system_prompt>\n${system.text}\n</opencode_system_prompt>`);
  }

  const toolCount = namedTools(input.tools).length;
  let toolsBytes = 0;
  let toolsLevel: ToolsCompactionLevel = 0;
  let toolsSchemaOmitted = 0;
  let toolsDropped = 0;
  if (input.meta) {
    sections.push(META_NO_TOOLS_LINE);
  } else {
    const section = buildToolsSection(input.tools, input.config.maxToolsPromptBytes);
    toolsBytes = utf8(section.text);
    toolsLevel = section.level;
    toolsSchemaOmitted = section.schemaOmitted;
    toolsDropped = section.dropped;
    sections.push(toolProtocol(mcpServerName));
    sections.push(`<opencode_tools>\n${section.text}\n</opencode_tools>`);
  }

  return {
    text: sections.join("\n\n"),
    systemHash: sha256Hex(system.text),
    toolsSchemaHash: toolsSchemaHash(input.tools),
    toolsDescHashes: toolsDescriptionHashes(input.tools),
    stats: {
      systemMessages: systemTexts.length,
      systemBytes: utf8(system.text),
      systemOmittedBytes: system.omittedBytes,
      toolCount,
      toolsBytes,
      toolsLevel,
      toolsSchemaOmitted,
      toolsDropped,
    },
  };
}

// ---------------------------------------------------------------------------
// Per-turn prompt blocks (SR 4.4)
// ---------------------------------------------------------------------------

/** User content as ACP blocks: text, images, files (`opencode-attachment://<n>`); the rest as short text. */
export function contentToBlocks(content: OpenAiMessage["content"], attachmentCounter: { next: number }): PromptBlock[] {
  const blocks: PromptBlock[] = [];
  let text = "";
  const flush = (): void => {
    if (text.length > 0) blocks.push({ type: "text", text });
    text = "";
  };
  for (const part of contentParts(content)) {
    if (part.kind === "text") {
      text += part.text;
      continue;
    }
    flush();
    blocks.push(mediaBlock(part, attachmentCounter));
  }
  flush();
  return blocks;
}

function mediaBlock(part: Exclude<NormalizedPart, { kind: "text" }>, counter: { next: number }): PromptBlock {
  if (part.kind === "image") {
    const data = parseDataUrl(part.url);
    if (data?.base64) return { type: "image", data: data.data, mimeType: data.mimeType };
    return { type: "text", text: data ? "[image attachment that could not be forwarded]" : `[image: ${part.url}]` };
  }
  if (part.kind === "video") {
    const data = parseDataUrl(part.url);
    if (!data?.base64) return { type: "text", text: `[video: ${data ? "inline" : part.url}]` };
    return { type: "resource", resource: { uri: attachmentUri(counter, null), mimeType: data.mimeType, blob: data.data } };
  }
  if (part.kind === "file") {
    const uri = attachmentUri(counter, part.filename);
    const data = parseDataUrl(part.data);
    // OpenCode sends `file_data` as a data URL; a bare value is taken as base64.
    if (!data) return { type: "resource", resource: { uri, blob: part.data } };
    if (data.base64) return { type: "resource", resource: { uri, mimeType: data.mimeType, blob: data.data } };
    return { type: "resource", resource: { uri, mimeType: data.mimeType, text: decodeText(data.data) } };
  }
  return { type: "text", text: `[unsupported attachment: ${part.type}]` };
}

/** `opencode-attachment://<n>`, plus the file name when OpenCode sent one (SR 4.4). */
function attachmentUri(counter: { next: number }, filename: string | null): string {
  const n = counter.next;
  counter.next += 1;
  return `opencode-attachment://${n}${filename ? `/${encodeURIComponent(filename)}` : ""}`;
}

function decodeText(data: string): string {
  try {
    return decodeURIComponent(data);
  } catch {
    return data;
  }
}

/** `<system-update>` block for a system message inside the conversation. */
function systemUpdateText(message: OpenAiMessage): string {
  return `<system-update>${escapeClosingTags(contentText(message.content), SYSTEM_UPDATE_TAGS)}</system-update>`;
}

/**
 * SR 4.4 `append`, `redo` and steering: reminders first, then each message. System messages become
 * `<system-update>` text blocks; user content keeps text, image and file parts.
 */
export function buildTurnPrompt(input: readonly OpenAiMessage[], reminders: readonly string[]): PromptBlock[] {
  const blocks: PromptBlock[] = reminders.map((text) => ({ type: "text", text }));
  const counter = { next: 1 };
  for (const message of input) {
    if (isSystemRole(message.role)) {
      blocks.push({ type: "text", text: systemUpdateText(message) });
    } else {
      blocks.push(...contentToBlocks(message.content, counter));
    }
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: "Continue." });
  return blocks;
}
