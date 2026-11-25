import { describe, expect, test } from "bun:test";
import type { OpenAiFunctionTool } from "../../src/contracts.ts";
import { budgetSystemText, buildToolsSection } from "../../src/prompt.ts";

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

const MARKER_RE = /\n\n\[\.\.\. (\d+) bytes of OpenCode instructions omitted to fit the Antigravity prompt budget \.\.\.\]\n\n/;

function splitAtMarker(text: string): { head: string; tail: string; omitted: number } {
  const match = MARKER_RE.exec(text);
  if (!match) throw new Error("no marker");
  return { head: text.slice(0, match.index), tail: text.slice(match.index + match[0].length), omitted: Number(match[1]) };
}

/** Distinct lines so a head or tail can be located in the original. */
function numbered(totalBytes: number, prefix = "line"): string {
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; size < totalBytes; i += 1) {
    const line = `${prefix} ${i} ${"z".repeat(40)}`;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n").slice(0, totalBytes);
}

describe("base system truncation", () => {
  test("one 40 KB message keeps a 24 KB head and the rest of 32 KB as tail, with the marker", () => {
    const text = numbered(40 * 1024);
    const result = budgetSystemText([text], 32_768);
    expect(bytes(result.text) <= 32_768).toBe(true);
    const { head, tail, omitted } = splitAtMarker(result.text);
    expect(bytes(head)).toBe(24 * 1024);
    expect(text.startsWith(head)).toBe(true);
    expect(text.endsWith(tail)).toBe(true);
    // The tail gets the 8 KB that is left after the head, minus the marker.
    expect(bytes(tail) > 8 * 1024 - 120 && bytes(tail) <= 8 * 1024).toBe(true);
    expect(omitted).toBe(bytes(text) - bytes(head) - bytes(tail));
    expect(result.omittedBytes).toBe(omitted);
    expect(bytes(result.text)).toBe(32_768);
  });

  test("multi-byte text is never split inside a code point", () => {
    const text = `${"Привіт 👋🏽 世界 ".repeat(4000)}end`;
    for (const budget of [32_768, 32_767, 32_766, 1001, 1002, 1003]) {
      const result = budgetSystemText([text], budget);
      expect(bytes(result.text) <= budget).toBe(true);
      expect(result.text.includes("�")).toBe(false);
      const { head, tail } = splitAtMarker(result.text);
      expect(text.startsWith(head)).toBe(true);
      expect(text.endsWith(tail)).toBe(true);
    }
  });

  test("several messages: the first gets 20/32, the last 8/32, the middle 4/32", () => {
    const first = numbered(30_000, "first");
    const middle = numbered(10_000, "middle");
    const last = numbered(12_000, "last");
    const result = budgetSystemText([first, middle, last], 32_768);
    expect(bytes(result.text) <= 32_768).toBe(true);
    const [a, b, c] = result.text.split(/\n\n(?=first|middle|last)/);
    const available = 32_768 - 4;
    expect(bytes(a) <= Math.floor((available * 20) / 32)).toBe(true);
    expect(bytes(a) > Math.floor((available * 20) / 32) - 200).toBe(true);
    expect(bytes(b) <= Math.floor((available * 4) / 32)).toBe(true);
    expect(bytes(c) <= available - Math.floor((available * 20) / 32) - Math.floor((available * 4) / 32)).toBe(true);
    expect(a.startsWith("first 0")).toBe(true);
    expect(b.startsWith("middle 0")).toBe(true);
    expect(c.startsWith("last 0")).toBe(true);
  });

  test("a 16 KB budget scales the shares", () => {
    const first = numbered(30_000, "first");
    const last = numbered(12_000, "last");
    const result = budgetSystemText([first, last], 16_384);
    expect(bytes(result.text) <= 16_384).toBe(true);
    const [a, c] = result.text.split(/\n\n(?=last 0)/);
    const available = 16_384 - 2;
    expect(bytes(a) <= Math.floor((available * 20) / 32)).toBe(true);
    expect(bytes(a) > Math.floor((available * 20) / 32) - 200).toBe(true);
    expect(bytes(c) <= available - Math.floor((available * 20) / 32)).toBe(true);
    expect(bytes(c) > available - Math.floor((available * 20) / 32) - 200).toBe(true);
  });

  test("a short message passes its unused share to an over-share message", () => {
    const first = numbered(40_000, "first");
    const last = "last: short project rules";
    const result = budgetSystemText([first, last], 32_768);
    expect(result.text.endsWith(`\n\n${last}`)).toBe(true);
    // The first message uses more than its 20/32 share because the last one needs almost nothing.
    expect(bytes(result.text) > 32_000).toBe(true);
    expect(bytes(result.text) <= 32_768).toBe(true);
  });
});

describe("tool ladder L6", () => {
  test("hundreds of tools collapse into a more_tools line, names that do not fit are dropped", () => {
    const tools: OpenAiFunctionTool[] = Array.from({ length: 400 }, (_, i) => ({
      type: "function",
      function: { name: `mcp_server_tool_${i}`, description: "x", parameters: { type: "object" } },
    }));
    const section = buildToolsSection(tools, 12_000);
    expect(section.level).toBe(6);
    expect(bytes(section.text) <= 12_000).toBe(true);
    const lines = section.text.split("\n");
    const more: unknown = JSON.parse(lines[lines.length - 1]);
    expect(typeof more === "object" && more !== null && "more_tools" in more).toBe(true);
    const kept = lines.length - 1;
    expect(section.schemaOmitted).toBe(kept);
    const listed = JSON.stringify(more).split("mcp_server_tool_").length - 1;
    expect(kept + listed + section.dropped).toBe(400);
    expect(kept > 0).toBe(true);
    expect(lines[0]).toContain('"name":"mcp_server_tool_0"');
  });

  test("when even the names do not fit, the last ones are dropped and counted", () => {
    const tools: OpenAiFunctionTool[] = Array.from({ length: 400 }, (_, i) => ({
      type: "function",
      function: { name: `mcp_server_tool_${i}`, parameters: { type: "object" } },
    }));
    const section = buildToolsSection(tools, 4000);
    expect(bytes(section.text) <= 4000).toBe(true);
    expect(section.text.startsWith('{"more_tools":["mcp_server_tool_0",')).toBe(true);
    const listed = section.text.split("mcp_server_tool_").length - 1;
    expect(listed + section.dropped).toBe(400);
    expect(section.dropped > 0).toBe(true);
  });
});
