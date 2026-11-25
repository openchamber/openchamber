import { describe, expect, test } from "bun:test";
import { agyTarget, detectMusl, linuxCaBundle } from "../src/install/platform.ts";

describe("agyTarget (IA 6.1)", () => {
  const cases: Array<[NodeJS.Platform, string, boolean, string, string, string, string, string]> = [
    ["darwin", "arm64", false, "darwin_arm64", "darwin-arm", "cli_mac_arm64.tar.gz", "tar.gz", "antigravity"],
    ["darwin", "x64", false, "darwin_amd64", "darwin-x64", "cli_mac_x64.tar.gz", "tar.gz", "antigravity"],
    ["linux", "x64", false, "linux_amd64", "linux-x64", "cli_linux_x64.tar.gz", "tar.gz", "antigravity"],
    ["linux", "arm64", false, "linux_arm64", "linux-arm", "cli_linux_arm64.tar.gz", "tar.gz", "antigravity"],
    ["linux", "x64", true, "linux_amd64_musl", "linux-x64-musl", "cli_linux_x64_musl.tar.gz", "tar.gz", "antigravity"],
    ["linux", "arm64", true, "linux_arm64_musl", "linux-arm-musl", "cli_linux_arm64_musl.tar.gz", "tar.gz", "antigravity"],
    ["win32", "x64", false, "windows_amd64", "windows-x64", "cli_windows_x64.exe", "executable", "agy.exe"],
    ["win32", "arm64", false, "windows_arm64", "windows-arm", "cli_windows_arm64.exe", "executable", "agy.exe"],
  ];
  for (const [platform, arch, musl, key, folder, assetName, format, exe] of cases) {
    test(`${platform} ${arch}${musl ? " musl" : ""}`, () => {
      expect(agyTarget(platform, arch, musl)).toEqual({
        key,
        folder,
        assetName,
        format,
        executableName: exe,
        dirKey: `${platform}-${arch}`,
      });
    });
  }

  test("musl only matters on Linux", () => {
    expect(agyTarget("darwin", "arm64", true)?.key).toBe("darwin_arm64");
  });

  test("unsupported platforms and arches give null", () => {
    expect(agyTarget("freebsd", "x64", false)).toBeNull();
    expect(agyTarget("linux", "ia32", false)).toBeNull();
    expect(agyTarget("linux", "riscv64", false)).toBeNull();
  });
});

describe("detectMusl and linuxCaBundle (IA 7)", () => {
  test("musl loader present on Linux only", () => {
    const exists = (p: string): boolean => p === "/lib/libc.musl-aarch64.so.1";
    expect(detectMusl("linux", exists)).toBe(true);
    expect(detectMusl("darwin", exists)).toBe(false);
    expect(detectMusl("linux", () => false)).toBe(false);
  });

  test("first existing bundle, NIX first, none when SSL_CERT_* is set", () => {
    const present = new Set(["/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/cert.pem", "/nix/certs.pem"]);
    const exists = (p: string): boolean => present.has(p);
    expect(linuxCaBundle({}, exists)).toBe("/etc/pki/tls/certs/ca-bundle.crt");
    expect(linuxCaBundle({ NIX_SSL_CERT_FILE: "/nix/certs.pem" }, exists)).toBe("/nix/certs.pem");
    expect(linuxCaBundle({ SSL_CERT_FILE: "/x" }, exists)).toBeNull();
    expect(linuxCaBundle({ SSL_CERT_DIR: "/x" }, exists)).toBeNull();
    expect(linuxCaBundle({}, () => false)).toBeNull();
  });
});
