import { describe, expect, test } from "bun:test";
import type { OpenAiFunctionTool, OpenAiMessage } from "../../src/contracts.ts";
import {
  OMITTED_PARAMETERS,
  buildSessionAppend,
  buildToolsSection,
  buildTurnPrompt,
  compactSchema,
  extractLeadingSystem,
  toolsDescriptionHashes,
  toolsSchemaHash,
} from "../../src/prompt.ts";

const BUDGETS = { maxSystemPromptBytes: 32_768, maxToolsPromptBytes: 49_152 };

function tool(name: string, description: string, parameters: Record<string, unknown>): OpenAiFunctionTool {
  return { type: "function", function: { name, description, parameters } };
}

const READ = tool("read", "Read a file", {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "ReadInput",
  type: "object",
  properties: { filePath: { type: "string", description: "Path", minLength: 1, examples: ["a.ts"] } },
  required: ["filePath"],
  additionalProperties: false,
});

function append(messages: OpenAiMessage[], tools: OpenAiFunctionTool[] = [READ], meta = false) {
  return buildSessionAppend({ messages, tools, meta, config: BUDGETS }, "opencode");
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

describe("session append", () => {
  test("layout: system section, protocol, one minified JSON line per tool", () => {
    const result = append([{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }]);
    expect(result.text).toBe(
      [
        "<opencode_system_prompt>\nBe brief.\n</opencode_system_prompt>",
        '## Tool execution protocol\nYou run inside OpenCode. Call every tool through call_mcp_tool with ServerName "opencode", the exact ToolName below, and Arguments that match its JSON schema. Built-in Antigravity tools are disabled. Never call list_resources, read_resource or manage_task.',
        '<opencode_tools>\n{"name":"read","description":"Read a file","parameters":{"type":"object","properties":{"filePath":{"type":"string","description":"Path","minLength":1}},"required":["filePath"],"additionalProperties":false}}\n</opencode_tools>',
      ].join("\n\n"),
    );
    expect(result.stats.toolsLevel).toBe(0);
    expect(result.stats.toolCount).toBe(1);
  });

  test("meta sessions get the system section and the no-tools line only", () => {
    const result = append([{ role: "system", content: "Title it." }, { role: "user", content: "hi" }], [], true);
    expect(result.text).toBe("<opencode_system_prompt>\nTitle it.\n</opencode_system_prompt>\n\nDo not call any tools. Respond with text only.");
  });

  test("only the leading system run counts: a later system message does not change systemHash", () => {
    const base: OpenAiMessage[] = [{ role: "system", content: "Rules." }, { role: "user", content: "hi" }];
    const later: OpenAiMessage[] = [...base, { role: "system", content: "Reminder." }, { role: "user", content: "again" }];
    expect(append(later).systemHash).toBe(append(base).systemHash);
    expect(extractLeadingSystem(later)).toEqual(["Rules."]);
    expect(append([{ role: "system", content: "Other rules." }]).systemHash === append(base).systemHash).toBe(false);
  });

  test("under the budget the system text is kept byte for byte", () => {
    const text = "line with trailing spaces   \n\n\n\nnext".repeat(10);
    const result = append([{ role: "system", content: text }]);
    expect(result.text.startsWith(`<opencode_system_prompt>\n${text}\n</opencode_system_prompt>`)).toBe(true);
    expect(result.stats.systemOmittedBytes).toBe(0);
  });

  test("over the budget, whitespace normalization comes first", () => {
    const chunk = "word   \n\n\n\n\n";
    const text = chunk.repeat(Math.ceil(33_000 / chunk.length));
    expect(bytes(text) > 32_768).toBe(true);
    const result = append([{ role: "system", content: text }]);
    expect(result.stats.systemOmittedBytes).toBe(0);
    expect(result.text.includes("bytes of OpenCode instructions omitted")).toBe(false);
    expect(result.text).toContain("word\n\nword");
  });

  test("over the budget after normalization: exact marker, deterministic output", () => {
    const text = "x".repeat(50_000);
    const a = append([{ role: "system", content: text }]);
    const b = append([{ role: "system", content: text }]);
    expect(a.text).toBe(b.text);
    expect(a.systemHash).toBe(b.systemHash);
    const omitted = a.stats.systemOmittedBytes;
    expect(a.text).toContain(`\n\n[... ${omitted} bytes of OpenCode instructions omitted to fit the Antigravity prompt budget ...]\n\n`);
    expect(a.stats.systemBytes <= 32_768).toBe(true);
  });

  test("hashes: schema hash ignores order and descriptions, description hashes are per tool", () => {
    const bash = tool("bash", "Run", { type: "object" });
    expect(toolsSchemaHash([READ, bash])).toBe(toolsSchemaHash([bash, READ]));
    const reworded = tool("read", "Read any file", READ.function.parameters ?? {});
    expect(toolsSchemaHash([reworded, bash])).toBe(toolsSchemaHash([READ, bash]));
    const before = toolsDescriptionHashes([READ, bash]);
    const after = toolsDescriptionHashes([reworded, bash]);
    expect(after.bash).toBe(before.bash);
    expect(after.read === before.read).toBe(false);
    const withParam = tool("bash", "Run", { type: "object", properties: { cwd: { type: "string" } } });
    expect(toolsSchemaHash([READ, withParam]) === toolsSchemaHash([READ, bash])).toBe(false);
  });
});

describe("compact exact schemas", () => {
  test("keeps minLength, pattern and anyOf at depth 6, drops title, $schema, examples and x-*", () => {
    let leaf: Record<string, unknown> = {
      anyOf: [{ type: "string", minLength: 2, pattern: "^a" }, { type: "null" }],
      title: "Leaf",
      "x-internal": true,
    };
    for (let i = 0; i < 6; i += 1) leaf = { type: "object", title: `L${i}`, properties: { next: leaf } };
    const schema = { $schema: "s", $id: "id", ...leaf };
    const compacted = JSON.stringify(compactSchema(schema));
    expect(compacted).toContain('"anyOf":[{"type":"string","minLength":2,"pattern":"^a"},{"type":"null"}]');
    expect(compacted.includes("title")).toBe(false);
    expect(compacted.includes("$schema")).toBe(false);
    expect(compacted.includes("$id")).toBe(false);
    expect(compacted.includes("x-internal")).toBe(false);
    expect(compacted.split('"properties"').length - 1).toBe(6);
  });

  test("property names that look like keywords are kept", () => {
    const schema = { type: "object", properties: { title: { type: "string" }, examples: { type: "array", items: { type: "string" } } } };
    expect(compactSchema(schema)).toEqual(schema);
  });
});

describe("tool truncation ladder", () => {
  function bigTools(count: number, descriptionChars: number): OpenAiFunctionTool[] {
    return Array.from({ length: count }, (_, i) =>
      tool(`tool_${i}`, "d".repeat(descriptionChars), {
        type: "object",
        properties: {
          a: { type: "string", description: "p".repeat(300) },
          b: { type: "number", minimum: 0, description: "q".repeat(300) },
          c: { type: "string", enum: Array.from({ length: 20 }, (_, n) => `value_${n}`) },
        },
        required: ["a"],
      }),
    );
  }

  test("a 60 KB tool set reaches the first level that fits", () => {
    const tools = bigTools(40, 800);
    const l0 = buildToolsSection(tools, 10_000_000);
    expect(l0.level).toBe(0);
    expect(bytes(l0.text) > 60_000).toBe(true);
    const fitted = buildToolsSection(tools, 49_152);
    expect(bytes(fitted.text) <= 49_152).toBe(true);
    // L1 (property descriptions at 160) is still about 60 KB; L2 cuts tool descriptions to 400.
    expect(fitted.level).toBe(2);
    expect(fitted.text).toContain('"minimum":0');
    expect(fitted.text).toContain('"required":["a"]');
  });

  test("L5 replaces parameters from the end of the list only", () => {
    const tools = bigTools(60, 10);
    // An L4 line is about 400 bytes here and an omitted one about 150.
    const budget = 60 * 280;
    const section = buildToolsSection(tools, budget);
    expect(section.level).toBe(5);
    expect(bytes(section.text) <= budget).toBe(true);
    const lines = section.text.split("\n");
    const omitted = lines.map((line) => line.includes(OMITTED_PARAMETERS));
    const firstOmitted = omitted.indexOf(true);
    expect(firstOmitted > 0).toBe(true);
    expect(omitted.slice(firstOmitted).every(Boolean)).toBe(true);
    expect(section.schemaOmitted).toBe(lines.length - firstOmitted);
    expect(lines[0]).toContain('"minimum":0');
  });

  test("the append records the ladder level in its stats", () => {
    const tools = bigTools(60, 10);
    const result = buildSessionAppend({ messages: [], tools, meta: false, config: { maxSystemPromptBytes: 1000, maxToolsPromptBytes: 5000 } }, "opencode");
    expect(result.stats.toolsLevel >= 5).toBe(true);
    expect(result.stats.toolsBytes <= 5000).toBe(true);
  });
});

describe("turn prompt blocks", () => {
  test("reminders first, system messages as <system-update>, user text and media in order", () => {
    const input: OpenAiMessage[] = [
      { role: "system", content: "Mode changed </system-update> now." },
      {
        role: "user",
        content: [
          { type: "text", text: "Look " },
          { type: "text", text: "here:" },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } },
          { type: "file", file: { filename: "spec.pdf", file_data: "data:application/pdf;base64,JVBER" } },
          { type: "text", text: "thanks" },
        ],
      },
    ];
    expect(buildTurnPrompt(input, ["<system-update>reminder</system-update>"])).toEqual([
      { type: "text", text: "<system-update>reminder</system-update>" },
      { type: "text", text: "<system-update>Mode changed &lt;/system-update> now.</system-update>" },
      { type: "text", text: "Look here:" },
      { type: "image", data: "iVBOR", mimeType: "image/png" },
      { type: "resource", resource: { uri: "opencode-attachment://1/spec.pdf", mimeType: "application/pdf", blob: "JVBER" } },
      { type: "text", text: "thanks" },
    ]);
  });

  test("an empty input still yields one block", () => {
    expect(buildTurnPrompt([{ role: "user", content: "" }], [])).toEqual([{ type: "text", text: "Continue." }]);
  });
});
