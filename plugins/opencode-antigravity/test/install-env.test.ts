// buildAgyEnv and agyBaseArgs (IA 9.1, 9.2; the cases IA 17.1 lists under plugin.test.ts).
import { describe, expect, test } from "bun:test";
import { agyArgsFor, agyBaseArgs, buildAgyEnv, SSH_CONNECTION_VALUE, type AgyEnvConfig } from "../src/install/env.ts";

const isolated: AgyEnvConfig = { geminiDir: "/data/gemini", isolatedAuth: true, authMethod: "oauth-personal", auth: {} };
const shared: AgyEnvConfig = { ...isolated, isolatedAuth: false };
const baseEnv = {
  PATH: "/usr/bin",
  HOME: "/home/u",
  DISPLAY: ":0",
  WAYLAND_DISPLAY: "wayland-0",
  Gemini_Api_Key: "secret-1",
  google_api_key: "secret-2",
  GEMINI_HOME: "/elsewhere",
  BROWSER: "firefox",
  SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22",
};

describe("buildAgyEnv", () => {
  test("SSH_CONNECTION is set in both modes; file storage only when isolated", () => {
    const iso = buildAgyEnv({ kind: "runtime", tmpDir: "/t", config: isolated, baseEnv, platform: "darwin" });
    const sh = buildAgyEnv({ kind: "runtime", tmpDir: "/t", config: shared, baseEnv, platform: "darwin" });
    expect(iso.SSH_CONNECTION).toBe(SSH_CONNECTION_VALUE);
    expect(sh.SSH_CONNECTION).toBe(SSH_CONNECTION_VALUE);
    expect(iso.AGY_ACP_FORCE_FILE_STORAGE).toBe("1");
    expect(sh.AGY_ACP_FORCE_FILE_STORAGE).toBeUndefined();
  });

  test("profile and process variables", () => {
    const env = buildAgyEnv({ kind: "probe", tmpDir: "/t", config: isolated, baseEnv, platform: "darwin" });
    expect(env.GEMINI_HOME).toBe("/data/gemini");
    expect(env.TMPDIR).toBe("/t");
    expect(env.TEMP).toBeUndefined();
    expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("1");
    expect(env.PYTHONUNBUFFERED).toBe("1");
    expect(env.BROWSER).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  test("keys are stripped case-insensitively", () => {
    const env = buildAgyEnv({ kind: "runtime", tmpDir: "/t", config: isolated, baseEnv, platform: "darwin" });
    expect(env.Gemini_Api_Key).toBeUndefined();
    expect(env.google_api_key).toBeUndefined();
    expect(Object.values(env).includes("secret-1")).toBe(false);
    expect(Object.values(env).includes("secret-2")).toBe(false);
  });

  test("DISPLAY and WAYLAND_DISPLAY are removed only for login", () => {
    const login = buildAgyEnv({ kind: "login", tmpDir: "/t", config: isolated, baseEnv, platform: "linux", exists: () => false });
    const runtime = buildAgyEnv({ kind: "runtime", tmpDir: "/t", config: isolated, baseEnv, platform: "linux", exists: () => false });
    expect(login.DISPLAY).toBeUndefined();
    expect(login.WAYLAND_DISPLAY).toBeUndefined();
    expect(runtime.DISPLAY).toBe(":0");
    expect(runtime.WAYLAND_DISPLAY).toBe("wayland-0");
  });

  test("Linux CA bundle from a fixture list", () => {
    const present = new Set(["/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/cert.pem"]);
    const env = buildAgyEnv({ kind: "runtime", tmpDir: "/t", config: isolated, baseEnv, platform: "linux", exists: (p) => present.has(p) });
    expect(env.SSL_CERT_FILE).toBe("/etc/ssl/certs/ca-certificates.crt");
    const mac = buildAgyEnv({ kind: "runtime", tmpDir: "/t", config: isolated, baseEnv, platform: "darwin", exists: (p) => present.has(p) });
    expect(mac.SSL_CERT_FILE).toBeUndefined();
    const preset = buildAgyEnv({ kind: "runtime", tmpDir: "/t", config: isolated, baseEnv: { ...baseEnv, SSL_CERT_DIR: "/c" }, platform: "linux", exists: (p) => present.has(p) });
    expect(preset.SSL_CERT_FILE).toBeUndefined();
  });

  test("Windows sets TEMP and TMP", () => {
    const env = buildAgyEnv({ kind: "runtime", tmpDir: "C:\\t", config: isolated, baseEnv: { Path: "C:\\bin", temp: "C:\\old" }, platform: "win32" });
    expect(env.TEMP).toBe("C:\\t");
    expect(env.TMP).toBe("C:\\t");
    expect(env.temp).toBeUndefined();
    expect(env.TMPDIR).toBeUndefined();
    expect(env.Path).toBe("C:\\bin");
  });
});

describe("agyBaseArgs and kind flags", () => {
  test("base args", () => {
    expect(agyBaseArgs("/g")).toEqual(["acp", "--gemini-dir", "/g", "--app-data-dir", "antigravity-acp"]);
  });

  test("verify, probe and logout add the quick-check flags; login only --login; runtime nothing", () => {
    for (const kind of ["verify", "probe", "logout"] as const) {
      expect(agyArgsFor(kind, "/g")).toEqual([...agyBaseArgs("/g"), "--include-default-customizations=false", "--disable-telemetry"]);
    }
    expect(agyArgsFor("login", "/g")).toEqual([...agyBaseArgs("/g"), "--login"]);
    expect(agyArgsFor("runtime", "/g")).toEqual(agyBaseArgs("/g"));
  });
});
