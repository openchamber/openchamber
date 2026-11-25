import { afterEach, describe, expect, test } from "bun:test";
import type { OpenAiMessage } from "../../src/contracts.ts";
import { startHarness, toolRound, user, type Harness } from "../fixtures/proxy-harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

describe("privacy (architecture constraints, SR 10)", () => {
  test("debug: true, debugContent: false logs no prompt text, tool arguments, tool result, bearer secret or MCP token", async () => {
    const captured: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      const h = await startHarness({ scenario: "tools", options: { debug: true, debugContent: false } });
      open.push(h);
      const messages: OpenAiMessage[] = [{ role: "system", content: "SYSTEM_SECRET_TEXT" }, user("PROMPT_SECRET_TEXT")];
      const r1 = await h.chat({ messages });
      const r2 = await h.chat({ messages: [...messages, ...toolRound(r1, () => "RESULT_SECRET_TEXT")] });
      expect(r2.text).toBe("TOOL_RESULT:RESULT_SECRET_TEXT");

      const mcpUrl = h.journal().find((e) => e.method === "session/new")?.params.mcpServers;
      const mcpToken = /\/mcp\/([0-9a-f]+)\//.exec(JSON.stringify(mcpUrl))?.[1] ?? "missing";
      expect(mcpToken).not.toBe("missing");

      const logs = [...h.logs, ...captured].join("\n");
      expect(h.logs.length).toBeGreaterThan(5);
      for (const secret of ["SYSTEM_SECRET_TEXT", "PROMPT_SECRET_TEXT", "RESULT_SECRET_TEXT", "file-0.ts", h.proxy.proxyToken, mcpToken, "agy-managed", h.dir]) {
        expect(logs).not.toContain(secret);
      }
    } finally {
      console.error = original;
    }
  });

  test("an agy error quoting the MCP URL reaches neither the response nor the logs with the token (N-14, N-9)", async () => {
    const captured: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      const h = await startHarness({ scenario: "error-mcp-url", realModules: true, options: { debug: true } });
      open.push(h);
      const res = await h.fetchChat({ messages: [user("PROMPT_SECRET_TEXT")] });
      const body = await res.text();
      // The prompt fails after the stream started: a mid-stream error event with code 502.
      expect(res.status).toBe(200);
      expect(body).toContain('"code":502');
      const mcpUrl = h.journal().find((e) => e.method === "session/new")?.params.mcpServers;
      const mcpToken = /\/mcp\/([0-9a-f]+)\//.exec(JSON.stringify(mcpUrl))?.[1] ?? "missing";
      expect(mcpToken).not.toBe("missing");
      for (const text of [body, ...h.logs, ...captured]) {
        expect(text).not.toContain(mcpToken);
        expect(text).not.toContain("PROMPT_SECRET_TEXT");
      }
    } finally {
      console.error = original;
    }
  });
});
