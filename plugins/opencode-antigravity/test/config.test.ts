// Install and auth keys only (IA 3, 17.1). The runtime keys belong to src/config.ts (WP-B1).
import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { getAuthManager } from "../src/auth/manager.ts";
import { parseEnvBoolean, resolveInstallAuthConfig, unsupportedMethodIssue } from "../src/install/config.ts";
import { resetProcessSingletons, TWO_CONFIGS_MESSAGE } from "../src/install/singletons.ts";
import { TempDirs } from "./fixtures/install-helpers.ts";

const temps = new TempDirs();
afterEach(() => {
  temps.cleanup();
  resetProcessSingletons();
});

const HOME = "/home/someone";
const base = { HOME };

describe("resolveInstallAuthConfig", () => {
  test("defaults", () => {
    const { config, issues } = resolveInstallAuthConfig(undefined, base);
    expect(issues).toEqual([]);
    expect(config.isolatedAuth).toBe(true);
    expect(config.binarySource).toBe("managed");
    expect(config.autoUpdate).toBe(true);
    expect(config.offline).toBe(false);
    expect(config.offlineFallback).toBe(true);
    expect(config.authMethod).toBe("oauth-personal");
    expect(config.binaryPath).toBeNull();
    expect(config.dataDir).toBe(path.join(HOME, ".local", "share", "opencode-antigravity"));
    expect(config.geminiDir).toBe(path.join(config.dataDir, "gemini"));
    expect(config.defaultGeminiDir).toBe(true);
  });

  test("data dir: env, then XDG_DATA_HOME", () => {
    expect(resolveInstallAuthConfig({}, { ...base, XDG_DATA_HOME: "/xdg" }).config.dataDir).toBe("/xdg/opencode-antigravity");
    expect(resolveInstallAuthConfig({}, { ...base, XDG_DATA_HOME: "/xdg", OPENCODE_ANTIGRAVITY_DATA_DIR: "/d" }).config.dataDir).toBe("/d");
  });

  test("unsupported authMethod keeps the value and yields the issue text", () => {
    const { config, issues } = resolveInstallAuthConfig({ authMethod: "gemini-api-key" }, base);
    expect(config.authMethod).toBe("gemini-api-key");
    expect(issues).toEqual([unsupportedMethodIssue("gemini-api-key")]);
    expect(issues[0]).toBe(
      'Antigravity sign-in method "gemini-api-key" is not available in this plugin version. Use "oauth-personal" or remove authMethod.',
    );
  });

  test("unknown authMethod and binarySource fall back with an issue", () => {
    const { config, issues } = resolveInstallAuthConfig({ authMethod: "magic", binarySource: "brew" }, base);
    expect(config.authMethod).toBe("oauth-personal");
    expect(config.binarySource).toBe("managed");
    expect(issues.length).toBe(2);
  });

  test("env overrides apply when the option is unset", () => {
    const { config, issues } = resolveInstallAuthConfig(
      {},
      {
        ...base,
        OPENCODE_ANTIGRAVITY_BIN: "/opt/agy",
        OPENCODE_ANTIGRAVITY_BINARY_SOURCE: "path",
        OPENCODE_ANTIGRAVITY_AUTO_UPDATE: "0",
        OPENCODE_ANTIGRAVITY_OFFLINE: "1",
        OPENCODE_ANTIGRAVITY_ISOLATED_AUTH: "no",
        OPENCODE_ANTIGRAVITY_GEMINI_DIR: "/g",
      },
    );
    expect(issues).toEqual([]);
    expect(config.binaryPath).toBe("/opt/agy");
    expect(config.binarySource).toBe("path");
    expect(config.autoUpdate).toBe(false);
    expect(config.offline).toBe(true);
    expect(config.isolatedAuth).toBe(false);
    expect(config.geminiDir).toBe("/g");
    expect(config.defaultGeminiDir).toBe(false);
  });

  test("option beats env for every key", () => {
    const { config } = resolveInstallAuthConfig(
      { binaryPath: "/a/agy", binarySource: "t3code", autoUpdate: true, offline: false, isolatedAuth: true, geminiDir: "/opt-g" },
      {
        ...base,
        OPENCODE_ANTIGRAVITY_BIN: "/env/agy",
        OPENCODE_ANTIGRAVITY_BINARY_SOURCE: "path",
        OPENCODE_ANTIGRAVITY_AUTO_UPDATE: "0",
        OPENCODE_ANTIGRAVITY_OFFLINE: "1",
        OPENCODE_ANTIGRAVITY_ISOLATED_AUTH: "0",
        OPENCODE_ANTIGRAVITY_GEMINI_DIR: "/env-g",
      },
    );
    expect(config.binaryPath).toBe("/a/agy");
    expect(config.binarySource).toBe("t3code");
    expect(config.autoUpdate).toBe(true);
    expect(config.offline).toBe(false);
    expect(config.isolatedAuth).toBe(true);
    expect(config.geminiDir).toBe("/opt-g");
  });

  test("env booleans in any case; maybe is an issue and the default applies", () => {
    for (const v of ["1", "true", "TRUE", "Yes"]) expect(parseEnvBoolean(v)).toBe(true);
    for (const v of ["0", "false", "False", "NO"]) expect(parseEnvBoolean(v)).toBe(false);
    expect(parseEnvBoolean("maybe")).toBeNull();
    const { config, issues } = resolveInstallAuthConfig({}, { ...base, OPENCODE_ANTIGRAVITY_OFFLINE: "maybe" });
    expect(config.offline).toBe(false);
    expect(issues.length).toBe(1);
  });

  test("binaryPath: ~/ expands, a relative path stays as given", () => {
    expect(resolveInstallAuthConfig({ binaryPath: "~/bin/agy" }, base).config.binaryPath).toBe(path.join(HOME, "bin", "agy"));
    expect(resolveInstallAuthConfig({ binaryPath: "bin/agy" }, base).config.binaryPath).toBe("bin/agy");
  });

  test("wrong option types are issues, never throws", () => {
    const { config, issues } = resolveInstallAuthConfig({ autoUpdate: "yes", binaryPath: 3, auth: "x" }, base);
    expect(config.autoUpdate).toBe(true);
    expect(config.binaryPath).toBeNull();
    expect(issues.length).toBe(3);
    expect(resolveInstallAuthConfig("not an object", base).issues).toEqual([]);
  });
});

describe("singletons (IA 3)", () => {
  test("two configurations with different geminiDir: two AuthManager instances and one log line", () => {
    const root = temps.make();
    const env = { HOME: root, OPENCODE_ANTIGRAVITY_DATA_DIR: path.join(root, "data") };
    const lines: string[] = [];
    const log = (l: string): void => {
      lines.push(l);
    };
    const a = resolveInstallAuthConfig({ geminiDir: path.join(root, "g1") }, env).config;
    const b = resolveInstallAuthConfig({ geminiDir: path.join(root, "g2") }, env).config;
    const first = getAuthManager(a, { env, log });
    const again = getAuthManager(a, { env, log });
    const second = getAuthManager(b, { env, log });
    getAuthManager(resolveInstallAuthConfig({ geminiDir: path.join(root, "g3") }, env).config, { env, log });
    expect(first === again).toBe(true);
    expect(first === second).toBe(false);
    expect(lines.filter((l) => l === TWO_CONFIGS_MESSAGE).length).toBe(1);
  });
});
