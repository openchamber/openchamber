// redactAgyOutput on the lines review N-9 found leaking (MCP URL with its secret, auth headers).
import { describe, expect, test } from "bun:test";
import { redactAgyOutput } from "../src/auth/errors.ts";

const MCP_SECRET = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

describe("redactAgyOutput (N-9)", () => {
  test("drops lines with an http:// URL, an MCP path, bearer or an Authorization header; keeps ordinary lines", () => {
    const text = [
      `MCP server opencode failed: Post "http://127.0.0.1:54321/mcp/${MCP_SECRET}/cafebabe": dial tcp 127.0.0.1:54321: connection refused`,
      `retrying /mcp/${MCP_SECRET}/cafebabe`,
      "request header Authorization: xyz",
      "sent Bearer abc123",
      "ws://127.0.0.1:9/socket closed",
      "authorization=abc",
      "agy: database is locked",
      "login cancelled: no authorization code was entered",
    ].join("\n");
    const out = redactAgyOutput(text);
    expect(out).toBe("agy: database is locked\nlogin cancelled: no authorization code was entered");
    expect(out.includes(MCP_SECRET)).toBe(false);
  });
});
