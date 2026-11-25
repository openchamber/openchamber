import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { InstallError, networkFailureMessage } from "../src/install/download.ts";
import {
  MANIFEST_BASE,
  MANIFEST_UNREADABLE_MESSAGE,
  fetchManifest,
  parseManifest,
  readManifestCache,
  refreshManifest,
  writeManifestCache,
} from "../src/install/manifest.ts";
import { agyTarget, type AgyTarget } from "../src/install/platform.ts";
import { TempDirs, mappedFetch, messageOf, rejection, serve, type LocalServer } from "./fixtures/install-helpers.ts";

function target(platform: NodeJS.Platform, arch: string): AgyTarget {
  const t = agyTarget(platform, arch, false);
  if (!t) throw new Error("no target");
  return t;
}

const DARWIN = target("darwin", "arm64");
const WIN = target("win32", "x64");
const SHA = "33f5617dc74f".padEnd(128, "a");
/** The live darwin_arm64 manifest shape (IA 2.1). */
const LIVE = {
  version: "1.5.16",
  url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.16-5250855658717184/darwin-arm/cli_mac_arm64.tar.gz",
  sha512: SHA,
};

const temps = new TempDirs();
const servers: LocalServer[] = [];
afterEach(() => {
  temps.cleanup();
  while (servers.length) servers.pop()?.stop();
});

describe("parseManifest (IA 6.2)", () => {
  test("accepts the live darwin_arm64 manifest verbatim", () => {
    expect(parseManifest(LIVE, DARWIN)).toEqual(LIVE);
  });

  test("lowercases an uppercase sha512 and ignores extra fields", () => {
    expect(parseManifest({ ...LIVE, sha512: SHA.toUpperCase(), extra: 1 }, DARWIN)).toEqual(LIVE);
  });

  const rejected: Array<[string, unknown]> = [
    ["version 1.5", { ...LIVE, version: "1.5" }],
    ["sha512 of 127 chars", { ...LIVE, sha512: SHA.slice(1) }],
    ["URL on another host", { ...LIVE, url: LIVE.url.replace("storage.googleapis.com", "evil.example") }],
    ["another folder", { ...LIVE, url: LIVE.url.replace("/darwin-arm/", "/darwin-x64/") }],
    ["another asset name", { ...LIVE, url: LIVE.url.replace("cli_mac_arm64", "cli_mac_x64") }],
    ["non-numeric build segment", { ...LIVE, url: LIVE.url.replace("5250855658717184", "52508x") }],
    ["URL for another version", { ...LIVE, url: LIVE.url.replace("1.5.16-", "1.5.15-") }],
    ["array body", [LIVE]],
    ["string body", "LIVE"],
    ["null body", null],
  ];
  for (const [name, body] of rejected) {
    test(`rejects ${name}`, () => {
      expect(parseManifest(body, DARWIN)).toBeNull();
    });
  }

  test("rejects a win32 manifest pointing at a tar.gz", () => {
    const url = "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.16-1/windows-x64/cli_windows_x64.tar.gz";
    expect(parseManifest({ ...LIVE, url }, WIN)).toBeNull();
    expect(parseManifest({ ...LIVE, url: url.replace(".tar.gz", ".exe") }, WIN)?.version).toBe("1.5.16");
  });
});

describe("fetchManifest and the cache", () => {
  function manifestServer(body: () => Response): { fetch: ReturnType<typeof mappedFetch>; server: LocalServer } {
    const server = serve(() => body());
    servers.push(server);
    return { fetch: mappedFetch({ [new URL(MANIFEST_BASE).origin]: server.url }), server };
  }

  test("fetches <base>/<key>.json and parses it", async () => {
    const { fetch, server } = manifestServer(() => Response.json(LIVE));
    expect(await fetchManifest(DARWIN, { fetch })).toEqual(LIVE);
    expect(server.hits).toEqual(["/manifests/darwin_arm64.json"]);
  });

  test("a body over 16 KiB is refused", async () => {
    const { fetch } = manifestServer(() => new Response(JSON.stringify({ ...LIVE, pad: "x".repeat(17 * 1024) })));
    const err = await rejection(fetchManifest(DARWIN, { fetch }));
    expect(messageOf(err)).toBe(MANIFEST_UNREADABLE_MESSAGE);
  });

  test("a bad shape and a 500 give the unreadable text; no network gives the download text", async () => {
    const bad = manifestServer(() => Response.json({ version: "x" }));
    expect(messageOf(await rejection(fetchManifest(DARWIN, { fetch: bad.fetch })))).toBe(MANIFEST_UNREADABLE_MESSAGE);
    const down = manifestServer(() => new Response("no", { status: 500 }));
    expect(messageOf(await rejection(fetchManifest(DARWIN, { fetch: down.fetch })))).toBe(MANIFEST_UNREADABLE_MESSAGE);
    const offline = await rejection(
      fetchManifest(DARWIN, {
        fetch: async () => {
          throw new TypeError("connect ECONNREFUSED");
        },
      }),
    );
    expect(offline instanceof InstallError).toBe(true);
    expect(messageOf(offline).startsWith(networkFailureMessage("x").split(":")[0] ?? "")).toBe(true);
  });

  test("a failed fetch leaves the cached good manifest in place and records error", async () => {
    const file = path.join(temps.make(), "manifest.json");
    await writeManifestCache(file, { target: DARWIN.key, fetchedAt: 1000, checkedAt: 1000, manifest: LIVE });
    const { fetch } = manifestServer(() => new Response("oops", { status: 503 }));
    await rejection(refreshManifest(file, DARWIN, { fetch, now: () => 5000 }));
    const cache = await readManifestCache(file, DARWIN);
    expect(cache?.manifest).toEqual(LIVE);
    expect(cache?.fetchedAt).toBe(1000);
    expect(cache?.checkedAt).toBe(5000);
    expect(cache?.error).toBe("manifest HTTP 503");
  });

  test("a good fetch replaces the cache and clears error", async () => {
    const file = path.join(temps.make(), "manifest.json");
    await writeManifestCache(file, { target: DARWIN.key, fetchedAt: null, checkedAt: 1, manifest: null, error: "x" });
    const { fetch } = manifestServer(() => Response.json(LIVE));
    await refreshManifest(file, DARWIN, { fetch, now: () => 7 });
    expect(await readManifestCache(file, DARWIN)).toEqual({ target: DARWIN.key, fetchedAt: 7, checkedAt: 7, manifest: LIVE });
  });
});
