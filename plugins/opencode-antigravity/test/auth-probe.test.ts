import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isSignInRequired, SignInUrlLineError } from "../src/auth/errors.ts";
import { probeAuth, readAccountEmail } from "../src/auth/probe.ts";
import { AcpRpcError } from "../src/install/acp-control.ts";
import type { AgyEnvConfig } from "../src/install/env.ts";
import { MOCK_NO_BROWSER_MESSAGE, readJournal, writeMockAgyWrapper } from "./fixtures/mock-agy.ts";
import { writeMockLoginWrapper, type MockLoginScenario } from "./fixtures/mock-agy-login.ts";
import { TempDirs, isolatedEnv } from "./fixtures/install-helpers.ts";

const temps = new TempDirs();
afterEach(() => temps.cleanup());

function setup(scenario: MockLoginScenario[]): { binary: string; config: AgyEnvConfig; tmpDir: string; env: NodeJS.ProcessEnv; journal: string } {
  const root = temps.make();
  const journal = path.join(root, "journal.jsonl");
  const binary = writeMockLoginWrapper(root, { scenario, journal });
  const tmpDir = path.join(root, "tmp");
  mkdirSync(tmpDir);
  return { binary, config: { geminiDir: path.join(root, "gemini"), isolatedAuth: true, authMethod: "oauth-personal", auth: {} }, tmpDir, env: isolatedEnv(root), journal };
}

describe("probeAuth (IA 13.2)", () => {
  test("authenticate result: signed_in, with the probe flags and SSH_CONNECTION", async () => {
    const s = setup(["auth-ok"]);
    expect(await probeAuth({ binary: s.binary, config: s.config, tmpDir: s.tmpDir, baseEnv: s.env, timeoutMs: 5_000 })).toBe("signed_in");
    const start = readJournal(s.journal).find((e) => e.method === "process/start");
    expect(start?.params.argv).toEqual([
      "acp",
      "--gemini-dir",
      s.config.geminiDir,
      "--app-data-dir",
      "antigravity-acp",
      "--include-default-customizations=false",
      "--disable-telemetry",
    ]);
    expect(start?.params.sshConnection).toBe("127.0.0.1 0 127.0.0.1 0");
    expect(readJournal(s.journal).find((e) => e.method === "authenticate")?.params).toEqual({ methodId: "oauth-personal" });
  });

  test("-32603 with the real no-browser text: signed_out", async () => {
    const s = setup(["auth-signed-out"]);
    expect(await probeAuth({ binary: s.binary, config: s.config, tmpDir: s.tmpDir, baseEnv: s.env, timeoutMs: 5_000 })).toBe("signed_out");
  });

  test("-32000: signed_out", async () => {
    const s = setup(["auth-unauth"]);
    expect(await probeAuth({ binary: s.binary, config: s.config, tmpDir: s.tmpDir, baseEnv: s.env, timeoutMs: 5_000 })).toBe("signed_out");
  });

  test("the stdout auth-URL line: signed_out at once, process killed", async () => {
    const s = setup(["auth-url-line"]);
    const started = Date.now();
    expect(await probeAuth({ binary: s.binary, config: s.config, tmpDir: s.tmpDir, baseEnv: s.env, timeoutMs: 4_000 })).toBe("signed_out");
    expect(Date.now() - started < 3_000).toBe(true);
  });

  test("timeout and crash: unknown", async () => {
    const hang = setup(["auth-hang"]);
    expect(await probeAuth({ binary: hang.binary, config: hang.config, tmpDir: hang.tmpDir, baseEnv: hang.env, timeoutMs: 200, killGraceMs: 200 })).toBe("unknown");
    const crash = setup(["auth-crash"]);
    expect(await probeAuth({ binary: crash.binary, config: crash.config, tmpDir: crash.tmpDir, baseEnv: crash.env, timeoutMs: 5_000 })).toBe("unknown");
  });

  test("no binary: unknown", async () => {
    const s = setup([]);
    expect(await probeAuth({ binary: null, config: s.config, tmpDir: s.tmpDir, timeoutMs: 1_000 })).toBe("unknown");
  });

  test("the runtime's shared mock-agy signed-out scenario gives signed_out too", async () => {
    const root = temps.make();
    const binary = writeMockAgyWrapper(root, { scenario: "signed-out" });
    const config: AgyEnvConfig = { geminiDir: path.join(root, "g"), isolatedAuth: true, authMethod: "oauth-personal", auth: {} };
    expect(await probeAuth({ binary, config, tmpDir: root, baseEnv: isolatedEnv(root), timeoutMs: 5_000 })).toBe("signed_out");
  });
});

describe("isSignInRequired on the probe's inputs (IA 15.1)", () => {
  test("truth table", () => {
    expect(isSignInRequired(new AcpRpcError(-32000, "Authentication required"))).toBe(true);
    expect(isSignInRequired(new AcpRpcError(-32603, MOCK_NO_BROWSER_MESSAGE))).toBe(true);
    expect(isSignInRequired(new SignInUrlLineError("stdout"))).toBe(true);
    expect(isSignInRequired(new AcpRpcError(-32603, "Internal error: database is locked"))).toBe(false);
    expect(isSignInRequired(new Error("agy did not answer authenticate in time."))).toBe(false);
  });
});

describe("readAccountEmail (IA 12.3)", () => {
  function tokenFile(): { gemini: string; file: string } {
    const gemini = path.join(temps.make(), "gemini");
    mkdirSync(path.join(gemini, "antigravity-acp"), { recursive: true });
    return { gemini, file: path.join(gemini, "antigravity-acp", "antigravity-oauth-token") };
  }

  test("valid file gives the email", async () => {
    const { gemini, file } = tokenFile();
    writeFileSync(file, JSON.stringify({ auth_method: "oauth-personal", id_token_email: "a@b.c", token: "x" }));
    expect(await readAccountEmail(gemini)).toBe("a@b.c");
  });

  test("missing file, bad JSON, non-string or 400-char email, a symlink: undefined", async () => {
    const { gemini, file } = tokenFile();
    expect(await readAccountEmail(gemini)).toBeUndefined();
    writeFileSync(file, "{bad");
    expect(await readAccountEmail(gemini)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ id_token_email: 42 }));
    expect(await readAccountEmail(gemini)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ id_token_email: `${"a".repeat(396)}@b.c` }));
    expect(await readAccountEmail(gemini)).toBeUndefined();
    const other = tokenFile();
    writeFileSync(other.file, JSON.stringify({ id_token_email: "a@b.c" }));
    const linked = tokenFile();
    symlinkSync(other.file, linked.file);
    expect(await readAccountEmail(linked.gemini)).toBeUndefined();
  });
});
