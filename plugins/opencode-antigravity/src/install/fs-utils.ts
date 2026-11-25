// File helpers shared by the install and auth modules: atomic writes, size-capped reads of
// non-symlink files, and the Windows rename/remove retry (IA 6.7).

import { randomBytes } from "node:crypto";
import { lstatSync, type Stats } from "node:fs";
import { chmod, lstat, open, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

const WINDOWS_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const WINDOWS_RETRIES = 40;
const WINDOWS_RETRY_MS = 250;

export function errnoCode(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") return err.code;
  return null;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomToken(bytes = 8): string {
  return randomBytes(bytes).toString("hex");
}

/** Retries `fn` on Windows while an antivirus scanner or a running process holds the file (IA 6.7). */
export async function retryWhileWindowsHolds<T>(fn: () => Promise<T>, platform: NodeJS.Platform = process.platform): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = errnoCode(err);
      if (platform !== "win32" || code === null || !WINDOWS_RETRY_CODES.has(code) || attempt >= WINDOWS_RETRIES - 1) throw err;
      await sleep(WINDOWS_RETRY_MS);
    }
  }
}

export type RenameFn = (from: string, to: string) => Promise<void>;

export const defaultRename: RenameFn = (from, to) => retryWhileWindowsHolds(() => rename(from, to));

/**
 * Writes `contents` to `<file>.<rand>.tmp` opened `wx` with `mode`, fsyncs, and renames it over `file`.
 * The temp file is removed when anything fails.
 */
export async function writeFileAtomic(
  file: string,
  contents: string,
  opts: { mode?: number; rename?: RenameFn } = {},
): Promise<void> {
  const tmp = `${file}.${randomToken()}.tmp`;
  const handle = await open(tmp, "wx", opts.mode ?? 0o600);
  try {
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await (opts.rename ?? defaultRename)(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export type SmallFileResult =
  | { ok: true; text: string; stats: Stats }
  | { ok: false; reason: "missing" | "symlink" | "not-file" | "too-large" | "unreadable" };

/** Reads a regular, non-symlink file of at most `maxBytes` (IA 5 step 3, 5 step 4.1, 12.3). */
export async function readSmallRegularFile(file: string, maxBytes: number): Promise<SmallFileResult> {
  let stats: Stats;
  try {
    stats = await lstat(file);
  } catch (err) {
    return { ok: false, reason: errnoCode(err) === "ENOENT" ? "missing" : "unreadable" };
  }
  if (stats.isSymbolicLink()) return { ok: false, reason: "symlink" };
  if (!stats.isFile()) return { ok: false, reason: "not-file" };
  if (stats.size > maxBytes) return { ok: false, reason: "too-large" };
  try {
    const text = await readFile(file, "utf8");
    if (Buffer.byteLength(text) > maxBytes) return { ok: false, reason: "too-large" };
    return { ok: true, text, stats };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return { ...value };
    return null;
  } catch {
    return null;
  }
}

/** True when `file` exists and is a symbolic link. Missing paths are not links. */
export function isSymlinkSync(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/** True when `child` is `parent` or inside it, after `path.resolve`. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** `chmod -R 0700` then `rm -rf`, so a read-only release dir can be removed. Errors propagate. */
export async function removeTree(dir: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== "win32") await chmodTree(dir).catch(() => {});
  await retryWhileWindowsHolds(() => rm(dir, { recursive: true, force: true }), platform);
}

async function chmodTree(dir: string): Promise<void> {
  const stats = await lstat(dir);
  if (stats.isSymbolicLink()) return;
  if (stats.isDirectory()) {
    await chmod(dir, 0o700);
    for (const name of await readdir(dir)) await chmodTree(path.join(dir, name));
  } else if (stats.isFile()) {
    await chmod(dir, 0o600);
  }
}

/** Own property `key` of an object, or undefined. For reading untyped JSON without casts. */
export function getField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
}
