// Opt-in end to end against Google's real manifest and binary (IA 17.2). Never part of the default run.
//
//   AGY_E2E=1 bun test --timeout 900000 test/e2e-install.test.ts
//
// Downloads about 86 MB into a temp data dir. No real sign-in happens: step 4 pastes a bad code.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LOGIN_MESSAGES } from "../src/auth/constants.ts";
import { parseAuthUrl, startCodeLogin } from "../src/auth/login.ts";
import { probeAuth } from "../src/auth/probe.ts";
import { BinaryManager } from "../src/install/binary-manager.ts";
import { agyArgsFor, buildAgyEnv } from "../src/install/env.ts";
import { TempDirs, isolatedEnv, messageOf, rejection, testConfig } from "./fixtures/install-helpers.ts";

const temps = new TempDirs();
afterEach(() => {
  if (process.env.AGY_E2E_KEEP !== "1") temps.cleanup();
});

if (process.env.AGY_E2E !== "1") {
  test("e2e-install is opt-in: set AGY_E2E=1", () => {
    expect(process.env.AGY_E2E === "1").toBe(false);
  });
} else {
  describe("real agy (IA 17.2)", () => {
    const root = temps.make("oa-e2e-");
    const env = isolatedEnv(root, { PATH: process.env.PATH ?? "" });
    const config = testConfig(root, { binarySource: "managed", offlineFallback: false }, { PATH: process.env.PATH ?? "" });
    let binary = "";

    test("1. real manifest and download: verified, extracted, identity check, resolveBinary returns it", async () => {
      const started = Date.now();
      const manager = new BinaryManager(config, { env });
      const resolved = await manager.resolveBinary();
      binary = resolved.path;
      expect(resolved.source).toBe("managed");
      process.stderr.write(`[e2e] installed agy ${resolved.version} in ${Date.now() - started} ms at ${resolved.path}\n`);
    });

    test("2. same data dir, second run: no download", async () => {
      const calls: string[] = [];
      const manager = new BinaryManager({ ...config, autoUpdate: false }, {
        env,
        fetch: async (url, init) => {
          calls.push(url);
          return fetch(url, init);
        },
      });
      expect((await manager.resolveBinary()).path).toBe(binary);
      expect(calls).toEqual([]);
    });

    test("3. empty profile: probeAuth returns signed_out in under 5 s", async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), "oa-e2e-probe-"));
      const started = Date.now();
      const result = await probeAuth({ binary, config: { ...config, geminiDir: path.join(tmp, "gemini") }, tmpDir: tmp, baseEnv: env, timeoutMs: 30_000 });
      expect(result).toBe("signed_out");
      expect(Date.now() - started < 5_000).toBe(true);
    });

    for (const [name, extra] of [
      ["4. --login", [] as string[]],
      ["5. --login --disable-telemetry", ["--disable-telemetry"]],
    ] as const) {
      test(`${name}: the URL parses; a bad code exits 1 with the invalid_grant mapping`, async () => {
        const tmp = mkdtempSync(path.join(tmpdir(), "oa-e2e-login-"));
        const geminiDir = path.join(tmp, "gemini");
        const child = await startCodeLogin({
          binary,
          args: [...agyArgsFor("login", geminiDir), ...extra],
          env: buildAgyEnv({ kind: "login", tmpDir: tmp, config: { ...config, geminiDir }, baseEnv: env }),
          urlTimeoutMs: 60_000,
          killGraceMs: 3_000,
        });
        expect(parseAuthUrl(child.authUrl.url) !== null).toBe(true);
        expect(messageOf(await rejection(child.submit("bad", 60_000)))).toBe(LOGIN_MESSAGES.invalidGrant);
      });
    }
  });
}
