// Google's release manifest: fetch, strict parse, and the `manifest.json` cache (IA 6.2).

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { InstallError, readBodyCapped, safeFetch, type FetchLike } from "./download.ts";
import { parseJsonObject, readSmallRegularFile, writeFileAtomic } from "./fs-utils.ts";
import type { AgyTarget } from "./platform.ts";

export const MANIFEST_BASE = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
export const MANIFEST_ORIGIN = new URL(MANIFEST_BASE).origin;
const ASSET_PREFIX = "https://storage.googleapis.com/antigravity-public/antigravity-cli/";
const MANIFEST_MAX_BYTES = 16 * 1024;
const MANIFEST_TIMEOUT_MS = 10_000;
const CACHE_MAX_BYTES = 64 * 1024;

export const MANIFEST_UNREADABLE_MESSAGE =
  "Google's Antigravity update service returned an unexpected answer. Try again later, or set binaryPath.";

export interface AgyManifest {
  version: string;
  url: string;
  /** Lowercase, 128 hex chars. */
  sha512: string;
}

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SHA512_RE = /^[a-fA-F0-9]{128}$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Accepts exactly T3 Code's shape (IA 6.2); extra fields are ignored. Anything else is null. */
export function parseManifest(json: unknown, target: AgyTarget): AgyManifest | null {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const version = "version" in json ? json.version : undefined;
  const url = "url" in json ? json.url : undefined;
  const sha512 = "sha512" in json ? json.sha512 : undefined;
  if (typeof version !== "string" || !VERSION_RE.test(version)) return null;
  if (typeof sha512 !== "string" || !SHA512_RE.test(sha512)) return null;
  if (typeof url !== "string") return null;
  const urlRe = new RegExp(
    `^${escapeRegExp(`${ASSET_PREFIX}${version}-`)}\\d+${escapeRegExp(`/${target.folder}/${target.assetName}`)}$`,
  );
  if (!urlRe.test(url)) return null;
  return { version, url, sha512: sha512.toLowerCase() };
}

export interface FetchManifestDeps {
  fetch?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** GET `<base>/<target.key>.json`, body cap 16 KiB, 10 s. Throws `InstallError` on any failure. */
export async function fetchManifest(target: AgyTarget, deps: FetchManifestDeps = {}): Promise<AgyManifest> {
  const result = await safeFetch(`${MANIFEST_BASE}/${target.key}.json`, {
    allowedOrigins: [MANIFEST_ORIGIN],
    stallMs: deps.timeoutMs ?? MANIFEST_TIMEOUT_MS,
    totalMs: deps.timeoutMs ?? MANIFEST_TIMEOUT_MS,
    accept: "application/json",
    signal: deps.signal,
    fetch: deps.fetch,
  });
  if (result.response.status !== 200) {
    result.timers.done();
    await result.response.body?.cancel().catch(() => {});
    throw new InstallError(MANIFEST_UNREADABLE_MESSAGE, `manifest HTTP ${result.response.status}`);
  }
  let body: Buffer;
  try {
    body = await readBodyCapped(result, MANIFEST_MAX_BYTES);
  } catch (err) {
    if (err instanceof InstallError && err.reason === "body over cap") {
      throw new InstallError(MANIFEST_UNREADABLE_MESSAGE, "manifest over 16 KiB");
    }
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch {
    throw new InstallError(MANIFEST_UNREADABLE_MESSAGE, "manifest is not JSON");
  }
  const manifest = parseManifest(json, target);
  if (!manifest) throw new InstallError(MANIFEST_UNREADABLE_MESSAGE, "manifest shape");
  return manifest;
}

/** `manifest.json` (IA 4): the last good manifest plus the last attempt. */
export interface ManifestCache {
  target: string;
  /** When `manifest` was fetched; null when no fetch ever succeeded. */
  fetchedAt: number | null;
  /** Last attempt, good or failed. */
  checkedAt: number;
  manifest: AgyManifest | null;
  /** Reason of the last failed attempt; absent after a good one. */
  error?: string;
}

export async function readManifestCache(file: string, target: AgyTarget): Promise<ManifestCache | null> {
  const read = await readSmallRegularFile(file, CACHE_MAX_BYTES);
  if (!read.ok) return null;
  const obj = parseJsonObject(read.text);
  if (!obj || obj.target !== target.key || typeof obj.checkedAt !== "number") return null;
  const manifest = obj.manifest === null ? null : parseManifest(obj.manifest, target);
  return {
    target: target.key,
    fetchedAt: typeof obj.fetchedAt === "number" ? obj.fetchedAt : null,
    checkedAt: obj.checkedAt,
    manifest,
    ...(typeof obj.error === "string" ? { error: obj.error } : {}),
  };
}

export async function writeManifestCache(file: string, cache: ManifestCache): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
}

/**
 * Fetches the manifest and records the attempt. A failure never overwrites the last good manifest:
 * it records `error` and `checkedAt`, and rethrows (IA 6.2).
 */
export async function refreshManifest(
  file: string,
  target: AgyTarget,
  deps: FetchManifestDeps & { now?: () => number } = {},
): Promise<AgyManifest> {
  const now = deps.now ?? Date.now;
  const previous = await readManifestCache(file, target);
  try {
    const manifest = await fetchManifest(target, deps);
    await writeManifestCache(file, { target: target.key, fetchedAt: now(), checkedAt: now(), manifest }).catch(() => {});
    return manifest;
  } catch (err) {
    const reason = err instanceof InstallError ? err.reason : "fetch failed";
    await writeManifestCache(file, {
      target: target.key,
      fetchedAt: previous?.fetchedAt ?? null,
      checkedAt: now(),
      manifest: previous?.manifest ?? null,
      error: reason,
    }).catch(() => {});
    throw err;
  }
}
