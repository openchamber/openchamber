// updateProfileSettings and profile dirs (IA 9.3; the cases IA 17.1 lists under plugin.test.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AUTH_METHODS, supportedMethods } from "../src/auth/methods.ts";
import { authSettingsPatch, ensureProfileDirs, isPluginOwnedProfile, updateProfileSettings } from "../src/auth/settings.ts";
import { resolveInstallAuthConfig } from "../src/install/config.ts";
import { PROFILE_MARKER } from "../src/install/paths.ts";
import { TempDirs } from "./fixtures/install-helpers.ts";

const temps = new TempDirs();
afterEach(() => temps.cleanup());

function settingsOf(geminiDir: string): unknown {
  return JSON.parse(readFileSync(path.join(geminiDir, "antigravity-acp", "settings.json"), "utf8"));
}

describe("updateProfileSettings", () => {
  test("two concurrent patches (auth and toolPermission) both survive; mode 0600", async () => {
    const gemini = path.join(temps.make(), "gemini");
    await Promise.all([
      updateProfileSettings(gemini, { auth: { type: "oauth-personal" } }),
      updateProfileSettings(gemini, { toolPermission: "strict" }),
    ]);
    expect(settingsOf(gemini)).toEqual({ auth: { type: "oauth-personal" }, toolPermission: "strict" });
    if (process.platform !== "win32") {
      expect(statSync(path.join(gemini, "antigravity-acp", "settings.json")).mode & 0o777).toBe(0o600);
    }
  });

  test("keeps keys it does not patch; undefined removes a key; a corrupt file is replaced", async () => {
    const gemini = path.join(temps.make(), "gemini");
    mkdirSync(path.join(gemini, "antigravity-acp"), { recursive: true });
    writeFileSync(path.join(gemini, "antigravity-acp", "settings.json"), JSON.stringify({ other: 1, gcp: { project: "p" } }));
    await updateProfileSettings(gemini, { auth: { type: "oauth-personal" }, gcp: undefined });
    expect(settingsOf(gemini)).toEqual({ other: 1, auth: { type: "oauth-personal" } });
    writeFileSync(path.join(gemini, "antigravity-acp", "settings.json"), "{not json");
    await updateProfileSettings(gemini, { toolPermission: "strict" });
    expect(settingsOf(gemini)).toEqual({ toolPermission: "strict" });
  });

  test("authSettingsPatch for oauth-personal and a reserved method", () => {
    const { config } = resolveInstallAuthConfig({ auth: { gcpProject: "p", gcpLocation: "l" } }, { HOME: "/h" });
    expect(authSettingsPatch(AUTH_METHODS["oauth-personal"], config)).toEqual({ auth: { type: "oauth-personal" } });
    expect(authSettingsPatch(AUTH_METHODS["oauth-business"], config)).toEqual({
      auth: { type: "oauth-business" },
      gcp: { project: "p", location: "l" },
    });
  });
});

describe("updateProfileSettings across processes (O-7)", () => {
  test("two processes writing different keys at once lose none", async () => {
    const root = temps.make();
    const gemini = path.join(root, "gemini");
    const settingsModule = fileURLToPath(new URL("../src/auth/settings.ts", import.meta.url));
    const script = path.join(root, "writer.ts");
    writeFileSync(
      script,
      `import { updateProfileSettings } from ${JSON.stringify(settingsModule)};
const [gemini, prefix] = process.argv.slice(2);
for (let i = 0; i < 40; i++) await updateProfileSettings(gemini, { [prefix + i]: i });`,
    );
    const run = (prefix: string): Promise<number | null> =>
      new Promise((resolve) => spawn(process.execPath, [script, gemini, prefix], { stdio: "ignore" }).once("exit", resolve));
    expect(await Promise.all([run("a"), run("b")])).toEqual([0, 0]);
    const settings = settingsOf(gemini);
    const keys = typeof settings === "object" && settings !== null ? Object.keys(settings) : [];
    expect(keys.length).toBe(80);
  });
});

describe("ensureProfileDirs", () => {
  test("POSIX profile dirs are 0700; the marker is written when the dir is created", async () => {
    const data = path.join(temps.make(), "data");
    const gemini = path.join(data, "gemini");
    const result = await ensureProfileDirs(data, gemini);
    expect(result.pluginOwned).toBe(true);
    expect(existsSync(path.join(gemini, PROFILE_MARKER))).toBe(true);
    if (process.platform !== "win32") {
      for (const dir of [data, gemini, path.join(gemini, "antigravity-acp")]) expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  test("an existing user dir gets no marker; the default <data>/gemini always does", async () => {
    const root = temps.make();
    const user = path.join(root, "my-gemini");
    mkdirSync(user, { mode: 0o755 });
    expect((await ensureProfileDirs(path.join(root, "data"), user)).pluginOwned).toBe(false);
    expect(isPluginOwnedProfile(user)).toBe(false);
    if (process.platform !== "win32") expect(statSync(user).mode & 0o777).toBe(0o700);

    const data = path.join(root, "data2");
    mkdirSync(path.join(data, "gemini"), { recursive: true });
    expect((await ensureProfileDirs(data, path.join(data, "gemini"), { defaultGeminiDir: true })).pluginOwned).toBe(true);
  });
});

describe("supportedMethods (IA 10.1, 14)", () => {
  test("oauth-personal only; none with a config issue", () => {
    expect(supportedMethods(resolveInstallAuthConfig({}, { HOME: "/h" }).config).map((m) => m.id)).toEqual(["oauth-personal"]);
    expect(supportedMethods(resolveInstallAuthConfig({ authMethod: "agent-platform" }, { HOME: "/h" }).config)).toEqual([]);
  });

  test("oauth-personal registers id oauth-personal under the antigravity integration", () => {
    const registered: Array<{ integrationID: string; id: string; type: string; label: string }> = [];
    AUTH_METHODS["oauth-personal"].register(
      {
        update: () => {},
        method: {
          update: (input) => {
            registered.push({ integrationID: input.integrationID, ...input.method });
          },
        },
      },
      { authorize: async () => ({ mode: "auto", url: "", instructions: "", callback: new Promise<never>(() => {}) }), label: () => undefined },
    );
    expect(registered).toEqual([{ integrationID: "antigravity", id: "oauth-personal", type: "oauth", label: "Sign in with Google" }]);
  });
});
