// Network access for the managed install (IA 6.3): `safeFetch` with hand-followed redirects and
// origin checks before every hop, and `downloadAsset`, a streamed, size-capped, SHA-512-checked download.

import { createHash } from "node:crypto";
import { mkdir, open, rm, statfs } from "node:fs/promises";
import path from "node:path";
import type { AgyManifest } from "./manifest.ts";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const ASSET_ORIGIN = "https://storage.googleapis.com";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const MIB = 1024 * 1024;

export const DOWNLOAD_LIMITS = {
  maxBytes: 512 * MIB,
  stallMs: 60_000,
  totalMs: 30 * 60_000,
  minFreeBytes: 700 * MIB,
  progressIntervalMs: 250,
} as const;

/** A download or manifest failure with the user text of IA 8. `reason` is for debug logs only. */
export class InstallError extends Error {
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = "InstallError";
    this.reason = reason;
  }
}

export function networkFailureMessage(reason: string): string {
  return `Could not download Antigravity from Google: ${reason}. Check the network connection and proxy settings, or set binaryPath.`;
}

export const CHECKSUM_MESSAGE = "The Antigravity download failed its checksum check. Nothing was installed.";
export const SIZE_MESSAGE = "The Antigravity download is larger than expected. Nothing was installed.";

export function diskSpaceMessage(dir: string): string {
  return `Antigravity needs at least 700 MiB of free space in ${dir} to install.`;
}

function networkError(reason: string): InstallError {
  return new InstallError(networkFailureMessage(reason), reason);
}

/** Stall and total timers over one request and its body. `touch()` re-arms the stall timer. */
export interface FetchTimers {
  readonly signal: AbortSignal;
  touch(): void;
  done(): void;
  /** Why the signal aborted: "stall", "total" or "aborted". */
  reason(): string | null;
}

function createTimers(stallMs: number, totalMs: number | null, outer: AbortSignal | undefined): FetchTimers {
  const controller = new AbortController();
  let why: string | null = null;
  const abort = (reason: string): void => {
    if (controller.signal.aborted) return;
    why = reason;
    controller.abort(new Error(reason));
  };
  let stall = setTimeout(() => abort("stall"), stallMs);
  const total = totalMs === null ? null : setTimeout(() => abort("total"), totalMs);
  const onOuter = (): void => abort("aborted");
  if (outer?.aborted) abort("aborted");
  outer?.addEventListener("abort", onOuter, { once: true });
  return {
    signal: controller.signal,
    touch() {
      clearTimeout(stall);
      if (!controller.signal.aborted) stall = setTimeout(() => abort("stall"), stallMs);
    },
    done() {
      clearTimeout(stall);
      if (total) clearTimeout(total);
      outer?.removeEventListener("abort", onOuter);
    },
    reason: () => why,
  };
}

/** `https:`, default port, no userinfo, and an origin in the allow-list. */
export function checkUrl(raw: string, allowedOrigins: readonly string[]): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return null;
  return allowedOrigins.includes(url.origin) ? url : null;
}

export interface SafeFetchOptions {
  allowedOrigins: readonly string[];
  /** Silence before headers and between body chunks. */
  stallMs: number;
  /** Whole request including the body; null for none. */
  totalMs?: number | null;
  signal?: AbortSignal;
  accept?: string;
  fetch?: FetchLike;
}

export interface SafeFetchResult {
  response: Response;
  url: string;
  timers: FetchTimers;
}

function describeAbort(timers: FetchTimers, err: unknown): InstallError {
  const why = timers.reason();
  if (why === "stall") return networkError("the connection stalled");
  if (why === "total") return networkError("the download took too long");
  if (why === "aborted") return networkError("the download was cancelled");
  const detail = err instanceof Error ? err.message : String(err);
  return networkError(`the request failed (${detail.slice(0, 120)})`);
}

/**
 * GET with `redirect: "manual"`, up to 5 hand-followed hops. Every hop's URL is checked before any
 * request goes there. A `Content-Encoding` other than `identity` is refused. The stall timer is armed
 * before `fetch()` is awaited. On success the caller owns `timers` and must call `done()`.
 */
export async function safeFetch(url: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const doFetch = opts.fetch ?? fetch;
  const timers = createTimers(opts.stallMs, opts.totalMs ?? null, opts.signal);
  let current = url;
  try {
    for (let hop = 0; ; hop++) {
      if (!checkUrl(current, opts.allowedOrigins)) throw networkError("the download location is not a Google server");
      let response: Response;
      try {
        response = await doFetch(current, {
          method: "GET",
          redirect: "manual",
          signal: timers.signal,
          headers: { Accept: opts.accept ?? "*/*", "Accept-Encoding": "identity" },
        });
      } catch (err) {
        throw describeAbort(timers, err);
      }
      timers.touch();
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get("location");
        if (!location) throw networkError(`HTTP ${response.status} without a location`);
        if (hop + 1 > MAX_REDIRECTS) throw networkError("too many redirects");
        current = new URL(location, current).toString();
        continue;
      }
      const encoding = response.headers.get("content-encoding");
      if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
        await response.body?.cancel().catch(() => {});
        throw networkError("the server sent a compressed response");
      }
      return { response, url: current, timers };
    }
  } catch (err) {
    timers.done();
    throw err;
  }
}

/** Reads a whole body of at most `maxBytes`, re-arming the stall timer per chunk. */
export async function readBodyCapped(result: SafeFetchResult, maxBytes: number): Promise<Buffer> {
  const { response, timers } = result;
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (err) {
        throw describeAbort(timers, err);
      }
      if (chunk.done) break;
      timers.touch();
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new InstallError("body too large", "body over cap");
      }
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks);
  } finally {
    timers.done();
  }
}

export interface DownloadProgress {
  bytes: number;
  total: number | null;
}

export interface DownloadDeps {
  fetch?: FetchLike;
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
  stallMs?: number;
  totalMs?: number;
  maxBytes?: number;
  minFreeBytes?: number;
  /** Test seam; default `fs.statfs`. Returning null skips the check. */
  freeBytes?: (dir: string) => Promise<number | null>;
}

async function defaultFreeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * Streams `manifest.url` into `<stagingDir>/download` (opened `wx`, 0600) through SHA-512 and checks
 * the digest. Throws `InstallError` with the IA 8 texts and removes `stagingDir` on any failure.
 */
export async function downloadAsset(
  manifest: AgyManifest,
  stagingDir: string,
  deps: DownloadDeps = {},
): Promise<{ file: string; bytes: number }> {
  try {
    return await downloadInto(manifest, stagingDir, deps);
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

async function downloadInto(manifest: AgyManifest, stagingDir: string, deps: DownloadDeps): Promise<{ file: string; bytes: number }> {
  const maxBytes = deps.maxBytes ?? DOWNLOAD_LIMITS.maxBytes;
  const minFree = deps.minFreeBytes ?? DOWNLOAD_LIMITS.minFreeBytes;
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });

  const free = await (deps.freeBytes ?? defaultFreeBytes)(path.dirname(stagingDir));
  if (free !== null && free < minFree) {
    throw new InstallError(diskSpaceMessage(path.dirname(stagingDir)), "disk space");
  }

  const result = await safeFetch(manifest.url, {
    allowedOrigins: [ASSET_ORIGIN],
    stallMs: deps.stallMs ?? DOWNLOAD_LIMITS.stallMs,
    totalMs: deps.totalMs ?? DOWNLOAD_LIMITS.totalMs,
    signal: deps.signal,
    fetch: deps.fetch,
  });
  const { response, timers } = result;
  const file = path.join(stagingDir, "download");
  try {
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw networkError(`HTTP ${response.status}`);
    }
    const lengthHeader = response.headers.get("content-length");
    let expected: number | null = null;
    if (lengthHeader !== null) {
      if (!/^\d+$/.test(lengthHeader.trim()) || Number(lengthHeader) <= 0) {
        await response.body?.cancel().catch(() => {});
        throw networkError("the server sent an invalid length");
      }
      expected = Number(lengthHeader);
      if (expected > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw new InstallError(SIZE_MESSAGE, "content-length over cap");
      }
    }
    if (!response.body) throw networkError("the server sent no data");

    const hash = createHash("sha512");
    const handle = await open(file, "wx", 0o600);
    let bytes = 0;
    let lastProgress = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          throw describeAbort(timers, err);
        }
        if (chunk.done) break;
        timers.touch();
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes || (expected !== null && bytes > expected)) {
          await reader.cancel().catch(() => {});
          throw new InstallError(SIZE_MESSAGE, "body over cap");
        }
        hash.update(chunk.value);
        await handle.write(chunk.value);
        const now = Date.now();
        if (deps.onProgress && now - lastProgress >= DOWNLOAD_LIMITS.progressIntervalMs) {
          lastProgress = now;
          deps.onProgress({ bytes, total: expected });
        }
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (expected !== null && bytes !== expected) throw networkError("the connection closed before the download finished");
    deps.onProgress?.({ bytes, total: expected });
    if (hash.digest("hex") !== manifest.sha512.toLowerCase()) throw new InstallError(CHECKSUM_MESSAGE, "sha512 mismatch");
    return { file, bytes };
  } finally {
    timers.done();
  }
}
