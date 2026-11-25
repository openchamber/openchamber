// Google's release target for this machine (IA 6.1, 7).

import { existsSync } from "node:fs";

export interface AgyTarget {
  /** Manifest key: "darwin_arm64", "linux_amd64_musl", "windows_amd64", ... */
  key: string;
  /** Folder in the asset URL: "darwin-arm", "linux-x64-musl", "windows-x64", ... */
  folder: string;
  /** "cli_mac_arm64.tar.gz", "cli_linux_x64_musl.tar.gz", "cli_windows_x64.exe" */
  assetName: string;
  format: "tar.gz" | "executable";
  executableName: "antigravity" | "agy.exe";
  /** `${platform}-${arch}`, the `bin/` subdir. */
  dirKey: string;
}

const OS_TOKEN: Partial<Record<NodeJS.Platform, { os: string; key: string; folder: string }>> = {
  darwin: { os: "mac", key: "darwin", folder: "darwin" },
  linux: { os: "linux", key: "linux", folder: "linux" },
  win32: { os: "windows", key: "windows", folder: "windows" },
};

const ARCH_TOKEN: Record<string, { cpu: string; target: string; folder: string } | undefined> = {
  x64: { cpu: "x64", target: "amd64", folder: "x64" },
  arm64: { cpu: "arm64", target: "arm64", folder: "arm" },
};

export function agyTarget(platform: NodeJS.Platform, arch: string, musl: boolean): AgyTarget | null {
  const os = OS_TOKEN[platform];
  const cpu = Object.hasOwn(ARCH_TOKEN, arch) ? ARCH_TOKEN[arch] : undefined;
  if (!os || !cpu) return null;
  const useMusl = platform === "linux" && musl;
  const suffix = useMusl ? "_musl" : "";
  const windows = platform === "win32";
  return {
    key: `${os.key}_${cpu.target}${suffix}`,
    folder: `${os.folder}-${cpu.folder}${useMusl ? "-musl" : ""}`,
    assetName: `cli_${os.os}_${cpu.cpu}${suffix}.${windows ? "exe" : "tar.gz"}`,
    format: windows ? "executable" : "tar.gz",
    executableName: windows ? "agy.exe" : "antigravity",
    dirKey: `${platform}-${arch}`,
  };
}

const MUSL_LOADERS = ["/lib/libc.musl-x86_64.so.1", "/lib/libc.musl-aarch64.so.1"];

export function detectMusl(platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): boolean {
  return platform === "linux" && MUSL_LOADERS.some((p) => exists(p));
}

const LINUX_CA_BUNDLES = [
  "/etc/ssl/certs/ca-bundle.crt",
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/cert.pem",
];

/** First existing CA bundle when neither `SSL_CERT_FILE` nor `SSL_CERT_DIR` is set (IA 7, NixOS). */
export function linuxCaBundle(env: NodeJS.ProcessEnv, exists: (p: string) => boolean = existsSync): string | null {
  if (env.SSL_CERT_FILE || env.SSL_CERT_DIR) return null;
  const candidates = env.NIX_SSL_CERT_FILE ? [env.NIX_SSL_CERT_FILE, ...LINUX_CA_BUNDLES] : LINUX_CA_BUNDLES;
  return candidates.find((p) => exists(p)) ?? null;
}

export function unsupportedPlatformMessage(platform: string, arch: string): string {
  return `Google does not publish an Antigravity CLI for ${platform}-${arch}. Set binaryPath to an agy executable.`;
}
