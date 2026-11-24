import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// The version OpenCode downloads when it finds none. A stand has no network,
// so the runner fetches it once and puts it where OpenCode looks.
const VERSION = "15.1.0"
const TARGETS = {
  "darwin-arm64": "aarch64-apple-darwin.tar.gz",
  "darwin-x64": "x86_64-apple-darwin.tar.gz",
  "linux-arm64": "aarch64-unknown-linux-gnu.tar.gz",
  "linux-x64": "x86_64-unknown-linux-musl.tar.gz",
  "win32-arm64": "aarch64-pc-windows-msvc.zip",
  "win32-x64": "x86_64-pc-windows-msvc.zip",
}
// Git for Windows puts a GNU tar on PATH that cannot read a zip.
const TAR = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32/tar.exe") : "tar"
const BINARY = process.platform === "win32" ? "rg.exe" : "rg"

const download = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

export const fetchRipgrep = async (toolsDir) => {
  const platform = `${process.platform}-${process.arch}`
  const target = TARGETS[platform]
  if (!target) throw new Error(`The verify stand has no ripgrep for ${platform}`)
  const cached = join(toolsDir, `ripgrep-${VERSION}-${platform}`, BINARY)
  if (existsSync(cached)) return cached
  const archive = `ripgrep-${VERSION}-${target}`
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${archive}`
  mkdirSync(toolsDir, { recursive: true })
  const work = mkdtempSync(join(toolsDir, "ripgrep-"))
  try {
    const [bytes, checksum] = await Promise.all([download(url), download(`${url}.sha256`)])
    const digest = createHash("sha256").update(bytes).digest("hex")
    if (!checksum.toString("utf8").toLowerCase().includes(digest)) throw new Error(`${archive} does not match its published checksum`)
    writeFileSync(join(work, archive), bytes)
    const unpacked = spawnSync(TAR, ["-xf", archive], { cwd: work, encoding: "utf8" })
    if (unpacked.status !== 0) throw new Error(`Could not unpack ${archive}: ${unpacked.stderr}`)
    mkdirSync(join(toolsDir, `ripgrep-${VERSION}-${platform}`), { recursive: true })
    renameSync(join(work, archive.replace(/\.(tar\.gz|zip)$/, ""), BINARY), cached)
    return cached
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

export const installRipgrep = async ({ toolsDir, cacheDir }) => {
  const bin = join(cacheDir, "opencode/bin")
  mkdirSync(bin, { recursive: true })
  copyFileSync(await fetchRipgrep(toolsDir), join(bin, BINARY))
}
