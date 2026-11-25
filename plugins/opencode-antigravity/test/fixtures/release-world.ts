// A fake Google release service for BinaryManager tests: a manifest server and an asset server whose
// tar.gz wraps test/fixtures/mock-agy.ts with a chosen version and scenario.

import { ASSET_ORIGIN } from "../../src/install/download.ts";
import { MANIFEST_ORIGIN, type AgyManifest } from "../../src/install/manifest.ts";
import { managedDirs, type ManagedDirs } from "../../src/install/paths.ts";
import { agyTarget, type AgyTarget } from "../../src/install/platform.ts";
import type { InstallAuthConfig } from "../../src/install/config.ts";
import type { FetchLike } from "../../src/install/download.ts";
import { MOCK_AGY_PATH } from "./mock-agy.ts";
import { TempDirs, isolatedEnv, mappedFetch, mockAgyScript, serve, sha512, sleep, testConfig, tgz, type LocalServer } from "./install-helpers.ts";

export interface FakeRelease {
  manifest: AgyManifest;
  asset: Buffer;
  releaseId: string;
}

export function hostTarget(): AgyTarget {
  const t = agyTarget(process.platform, process.arch, false);
  if (!t) throw new Error(`no agy target for ${process.platform}-${process.arch}`);
  return t;
}

export function fakeRelease(version: string, opts: { scenario?: string; scriptVersion?: string; build?: string } = {}): FakeRelease {
  const target = hostTarget();
  const script = mockAgyScript(MOCK_AGY_PATH, { version: opts.scriptVersion ?? version, scenario: opts.scenario });
  const asset = tgz([{ name: target.executableName, data: script, magic: "gnu" }]);
  const sha = sha512(asset);
  return {
    asset,
    releaseId: sha.slice(0, 64),
    manifest: {
      version,
      url: `${ASSET_ORIGIN}/antigravity-public/antigravity-cli/${version}-${opts.build ?? "4242"}/${target.folder}/${target.assetName}`,
      sha512: sha,
    },
  };
}

export interface ReleaseWorld {
  root: string;
  config: InstallAuthConfig;
  env: NodeJS.ProcessEnv;
  dirs: ManagedDirs;
  target: AgyTarget;
  fetch: FetchLike;
  fetchCalls: string[];
  manifestServer: LocalServer;
  assetServer: LocalServer;
  /** What the servers answer now. */
  publish(release: FakeRelease): void;
  failManifest(status: number): void;
  assetDelayMs: number;
  stop(): void;
}

export function releaseWorld(temps: TempDirs, options: Record<string, unknown> = {}): ReleaseWorld {
  const root = temps.make("oa-release-");
  const env = isolatedEnv(root);
  const config = testConfig(root, options);
  const target = hostTarget();
  let current: FakeRelease | null = null;
  let manifestStatus = 200;
  const world: ReleaseWorld = {
    root,
    config,
    env,
    dirs: managedDirs(config.dataDir, target),
    target,
    fetchCalls: [],
    fetch: async () => {
      throw new Error("not ready");
    },
    manifestServer: serve(() => {
      if (manifestStatus !== 200 || !current) return new Response("down", { status: manifestStatus === 200 ? 404 : manifestStatus });
      return Response.json(current.manifest);
    }),
    assetServer: serve(async () => {
      if (world.assetDelayMs > 0) await sleep(world.assetDelayMs);
      return current ? new Response(current.asset) : new Response("none", { status: 404 });
    }),
    publish(release) {
      current = release;
      manifestStatus = 200;
    },
    failManifest(status) {
      manifestStatus = status;
    },
    assetDelayMs: 0,
    stop() {
      world.manifestServer.stop();
      world.assetServer.stop();
    },
  };
  world.fetch = mappedFetch({ [MANIFEST_ORIGIN]: world.manifestServer.url, [ASSET_ORIGIN]: world.assetServer.url }, world.fetchCalls);
  return world;
}

/** Requests the asset server saw for the asset path. */
export function assetHits(world: ReleaseWorld): number {
  return world.assetServer.hits.length;
}
