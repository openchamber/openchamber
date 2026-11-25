import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BinaryManager } from "../src/install/binary-manager.ts";
import {
  ACTIVATION_FAILED_MESSAGE,
  RECORD_NAME,
  inspectActive,
  installRelease,
  pruneReleases,
  readPointer,
  removeStaleStaging,
  symlinkMessage,
} from "../src/install/release.ts";
import { MIN_AGY_VERSION, verifyAgy } from "../src/install/verify.ts";
import { getField } from "../src/install/fs-utils.ts";
import { TempDirs, messageOf, rejection } from "./fixtures/install-helpers.ts";
import { assetHits, fakeRelease, releaseWorld, type ReleaseWorld } from "./fixtures/release-world.ts";

const temps = new TempDirs();
const worlds: ReleaseWorld[] = [];
afterEach(() => {
  while (worlds.length) worlds.pop()?.stop();
  temps.cleanup();
});

const POSIX = process.platform !== "win32";

function world(options: Record<string, unknown> = {}): ReleaseWorld {
  const w = releaseWorld(temps, options);
  worlds.push(w);
  return w;
}

function manager(w: ReleaseWorld): BinaryManager {
  return new BinaryManager(w.config, { fetch: w.fetch, env: w.env, log: () => {}, timeouts: { lockPollMs: 20 } });
}

function realVerify(w: ReleaseWorld): (exe: string, version: string) => Promise<void> {
  return async (exe, version) => {
    await verifyAgy(exe, version, { baseEnv: w.env });
  };
}

function activeId(w: ReleaseWorld): string | null {
  if (!existsSync(w.dirs.activeFile)) return null;
  const parsed: unknown = JSON.parse(readFileSync(w.dirs.activeFile, "utf8"));
  return typeof parsed === "object" && parsed !== null && "releaseId" in parsed && typeof parsed.releaseId === "string" ? parsed.releaseId : null;
}

function mode(p: string): number {
  return statSync(p).mode & 0o777;
}

describe("managed install (IA 6.7)", () => {
  test("fresh install: active.json, record fields, POSIX modes, staging gone", async () => {
    const w = world();
    const release = fakeRelease("1.5.16");
    w.publish(release);
    const resolved = await manager(w).resolveBinary();
    expect(resolved.source).toBe("managed");
    expect(resolved.version).toBe("1.5.16");
    const dir = path.join(w.dirs.versionsDir, release.releaseId);
    expect(resolved.path).toBe(path.join(dir, w.target.executableName));
    expect(activeId(w)).toBe(release.releaseId);
    const record: unknown = JSON.parse(readFileSync(path.join(dir, RECORD_NAME), "utf8"));
    expect(record).toEqual({
      releaseId: release.releaseId,
      version: "1.5.16",
      sha512: release.manifest.sha512,
      url: release.manifest.url,
      executable: { name: w.target.executableName, bytes: statSync(resolved.path).size },
      installedAt: getField(record, "installedAt"),
    });
    expect(typeof getField(record, "installedAt")).toBe("string");
    if (POSIX) {
      expect(mode(resolved.path)).toBe(0o555);
      expect(mode(path.join(dir, RECORD_NAME))).toBe(0o400);
      expect(mode(dir)).toBe(0o500);
      expect(mode(w.dirs.activeFile)).toBe(0o600);
    }
    expect(readdirSync(w.dirs.versionsDir)).toEqual([release.releaseId]);
    expect(existsSync(w.dirs.lockDir)).toBe(false);
  });

  test("same release twice: no second download", async () => {
    const w = world();
    w.publish(fakeRelease("1.5.16"));
    const first = await manager(w).resolveBinary();
    const second = await manager(w).resolveBinary();
    expect(second.path).toBe(first.path);
    expect(assetHits(w)).toBe(1);
  });

  for (const [name, release] of [
    ["wrong agentInfo.name", () => fakeRelease("1.5.17", { scenario: "wrong-name" })],
    ["wrong version", () => fakeRelease("1.5.17", { scriptVersion: "1.5.18" })],
    ["missing auth.logout", () => fakeRelease("1.5.17", { scenario: "no-logout" })],
  ] as const) {
    test(`identity check fails (${name}): nothing activated, active.json unchanged`, async () => {
      const w = world();
      const good = fakeRelease("1.5.16");
      w.publish(good);
      await manager(w).resolveBinary();
      const bad = release();
      w.publish(bad);
      const err = await rejection(installRelease(bad.manifest, w.dirs, { target: w.target, verify: realVerify(w), download: { fetch: w.fetch } }));
      expect(messageOf(err)).toBe("The downloaded Antigravity runtime could not start on this machine.");
      expect(activeId(w)).toBe(good.releaseId);
      expect(readdirSync(w.dirs.versionsDir)).toEqual([good.releaseId]);
    });
  }

  test(`a manifest below MIN_AGY_VERSION (${MIN_AGY_VERSION}) is refused before download`, async () => {
    const w = world();
    w.publish(fakeRelease("1.5.0"));
    const err = await rejection(manager(w).resolveBinary());
    expect(messageOf(err).includes("needs 1.5.1 or newer")).toBe(true);
    expect(assetHits(w)).toBe(0);
    expect(activeId(w)).toBeNull();
  });

  test("an existing valid release dir reached through step 1 still runs the identity check; one below MIN is not activated", async () => {
    const w = world();
    const good = fakeRelease("1.5.16");
    w.publish(good);
    await manager(w).resolveBinary();
    // Reaching step 1 again: same release, no download, identity check runs (journal-free check: it passes).
    rmSync(w.dirs.activeFile);
    const again = await installRelease(good.manifest, w.dirs, { target: w.target, verify: realVerify(w), download: { fetch: w.fetch } });
    expect(again.releaseId).toBe(good.releaseId);
    expect(assetHits(w)).toBe(1);

    // A valid release dir whose binary is 1.5.0, placed by an install that skipped the check.
    const old = fakeRelease("1.5.0");
    const w2 = world();
    w2.publish(old);
    await installRelease(old.manifest, w2.dirs, { target: w2.target, verify: async () => {}, download: { fetch: w2.fetch } });
    rmSync(w2.dirs.activeFile);
    const err = await rejection(
      installRelease(old.manifest, w2.dirs, { target: w2.target, verify: realVerify(w2), download: { fetch: w2.fetch } }),
    );
    expect(messageOf(err)).toBe("The downloaded Antigravity runtime could not start on this machine.");
    expect(assetHits(w2)).toBe(1);
    expect(activeId(w2)).toBeNull();
  });

  test("active.json pointing at a missing dir: the next resolve reinstalls", async () => {
    const w = world();
    const release = fakeRelease("1.5.16");
    w.publish(release);
    await manager(w).resolveBinary();
    writeFileSync(w.dirs.activeFile, JSON.stringify({ releaseId: "f".repeat(64) }));
    expect((await inspectActive(w.dirs, { executableName: w.target.executableName })).status).toBe("missing");
    const resolved = await manager(w).resolveBinary();
    expect(activeId(w)).toBe(release.releaseId);
    expect(existsSync(resolved.path)).toBe(true);
  });

  test("executable size changed on disk: inspect reports damaged, resolve reinstalls", async () => {
    const w = world();
    const release = fakeRelease("1.5.16");
    w.publish(release);
    const first = await manager(w).resolveBinary();
    if (POSIX) {
      chmodSync(path.dirname(first.path), 0o700);
      chmodSync(first.path, 0o755);
    }
    appendFileSync(first.path, "\n# tampered\n");
    const inspected = await inspectActive(w.dirs, { executableName: w.target.executableName });
    expect(inspected.status === "damaged" && inspected.reason).toBe("executable size changed");
    const again = await manager(w).resolveBinary();
    expect(again.path).toBe(first.path);
    expect(assetHits(w)).toBe(2);
    expect((await inspectActive(w.dirs, { executableName: w.target.executableName })).status).toBe("valid");
  });

  test("symlinked versions/: refused with the symlink message", async () => {
    const w = world();
    const elsewhere = path.join(w.root, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(w.dirs.platformDir, { recursive: true });
    symlinkSync(elsewhere, w.dirs.versionsDir);
    w.publish(fakeRelease("1.5.16"));
    const err = await rejection(manager(w).resolveBinary());
    expect(messageOf(err)).toBe(symlinkMessage(w.dirs.platformDir));
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  test("active.json or the record as a symlink, or grown past 8 KiB: refused", async () => {
    const w = world();
    const release = fakeRelease("1.5.16");
    w.publish(release);
    await manager(w).resolveBinary();
    const opts = { executableName: w.target.executableName };

    const realActive = path.join(w.root, "active-real.json");
    writeFileSync(realActive, readFileSync(w.dirs.activeFile));
    rmSync(w.dirs.activeFile);
    symlinkSync(realActive, w.dirs.activeFile);
    expect((await inspectActive(w.dirs, opts)).status).toBe("symlink");
    expect(messageOf(await rejection(manager(w).resolveBinary()))).toBe(symlinkMessage(w.dirs.platformDir));

    rmSync(w.dirs.activeFile);
    writeFileSync(w.dirs.activeFile, JSON.stringify({ releaseId: release.releaseId, pad: "x".repeat(9000) }));
    expect((await readPointer(w.dirs.activeFile)).status).toBe("invalid");

    writeFileSync(w.dirs.activeFile, JSON.stringify({ releaseId: release.releaseId }));
    const dir = path.join(w.dirs.versionsDir, release.releaseId);
    chmodSync(dir, 0o700);
    const record = path.join(dir, RECORD_NAME);
    const realRecord = path.join(w.root, "record-real.json");
    writeFileSync(realRecord, readFileSync(record));
    chmodSync(record, 0o600);
    rmSync(record);
    symlinkSync(realRecord, record);
    expect((await inspectActive(w.dirs, opts)).status).toBe("symlink");
    rmSync(record);
    writeFileSync(record, JSON.stringify({ releaseId: release.releaseId, version: "1.5.16", executable: { name: "antigravity", bytes: 1 }, pad: "x".repeat(9000) }));
    const big = await inspectActive(w.dirs, opts);
    expect(big.status === "damaged" && big.reason).toBe("record too-large");
  });

  test("activation failure at the active.json rename: new dir removed, displaced dir restored, active.json unchanged", async () => {
    const w = world();
    const good = fakeRelease("1.5.16");
    w.publish(good);
    await manager(w).resolveBinary();
    const next = fakeRelease("1.5.17");
    // A damaged dir already sits where the new release goes.
    const target = path.join(w.dirs.versionsDir, next.releaseId);
    mkdirSync(target);
    writeFileSync(path.join(target, "junk"), "damaged");
    w.publish(next);
    const err = await rejection(
      installRelease(next.manifest, w.dirs, {
        target: w.target,
        verify: realVerify(w),
        download: { fetch: w.fetch },
        rename: async (from, to) => {
          if (to === w.dirs.activeFile) throw Object.assign(new Error("EIO"), { code: "EIO" });
          const { rename } = await import("node:fs/promises");
          await rename(from, to);
        },
      }),
    );
    expect(messageOf(err)).toBe(ACTIVATION_FAILED_MESSAGE);
    expect(activeId(w)).toBe(good.releaseId);
    expect(readFileSync(path.join(target, "junk"), "utf8")).toBe("damaged");
    expect(readdirSync(target)).toEqual(["junk"]);
    expect(readdirSync(w.dirs.versionsDir).sort()).toEqual([good.releaseId, next.releaseId].sort());
  });

  test("two processes install at once: one download, both end with the same active release", async () => {
    const w = world();
    const release = fakeRelease("1.5.16");
    w.publish(release);
    w.assetDelayMs = 300;
    const root = w.root;
    const script = path.join(root, "installer.ts");
    const managerModule = fileURLToPath(new URL("../src/install/binary-manager.ts", import.meta.url));
    const helpers = fileURLToPath(new URL("./fixtures/install-helpers.ts", import.meta.url));
    const manifestModule = fileURLToPath(new URL("../src/install/manifest.ts", import.meta.url));
    const downloadModule = fileURLToPath(new URL("../src/install/download.ts", import.meta.url));
    writeFileSync(
      script,
      `import { BinaryManager } from ${JSON.stringify(managerModule)};
import { mappedFetch, testConfig, isolatedEnv } from ${JSON.stringify(helpers)};
import { MANIFEST_ORIGIN } from ${JSON.stringify(manifestModule)};
import { ASSET_ORIGIN } from ${JSON.stringify(downloadModule)};
const [root, manifestUrl, assetUrl] = process.argv.slice(2);
const fetch = mappedFetch({ [MANIFEST_ORIGIN]: manifestUrl, [ASSET_ORIGIN]: assetUrl });
const m = new BinaryManager(testConfig(root), { fetch, env: isolatedEnv(root), log: () => {}, timeouts: { lockPollMs: 20 } });
const r = await m.resolveBinary();
process.stdout.write(r.path);`,
    );
    const run = (): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, root, w.manifestServer.url, w.assetServer.url], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (d: Buffer) => (out += d.toString()));
        child.stderr.on("data", (d: Buffer) => (err += d.toString()));
        child.once("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err}`))));
      });
    const [a, b] = await Promise.all([run(), run()]);
    expect(a).toBe(b);
    expect(assetHits(w)).toBe(1);
    expect(activeId(w)).toBe(release.releaseId);
  });
});

describe("prune and staging cleanup (IA 6.9)", () => {
  test("prune keeps active, previous.json and in-process releases, removes others, ignores a failing delete", async () => {
    const w = world();
    mkdirSync(w.dirs.versionsDir, { recursive: true });
    const ids = ["a", "b", "c", "d", "e"].map((c) => c.repeat(64));
    for (const id of ids) mkdirSync(path.join(w.dirs.versionsDir, id));
    mkdirSync(path.join(w.dirs.versionsDir, ".install-keep"));
    const failing = ids[4] ?? "";
    const removed = await pruneReleases(w.dirs, new Set([ids[0] ?? "", ids[1] ?? "", ids[2] ?? ""]), {
      removeDir: async (dir) => {
        if (dir.endsWith(failing)) throw new Error("EBUSY");
        rmSync(dir, { recursive: true, force: true });
      },
    });
    expect(removed).toEqual([ids[3] ?? ""]);
    expect(readdirSync(w.dirs.versionsDir).sort()).toEqual([".install-keep", ids[0], ids[1], ids[2], ids[4]].sort());
  });

  test("an update keeps the previous release (previous.json) and prunes the rest", async () => {
    const w = world();
    const r1 = fakeRelease("1.5.16");
    w.publish(r1);
    const m = manager(w);
    await m.resolveBinary();
    // An unrelated old release left behind.
    const stray = "9".repeat(64);
    mkdirSync(path.join(w.dirs.versionsDir, stray));
    const r2 = fakeRelease("1.5.17");
    w.publish(r2);
    await installRelease(r2.manifest, w.dirs, { target: w.target, verify: realVerify(w), download: { fetch: w.fetch } });
    const previous = await readPointer(w.dirs.previousFile);
    expect(previous.status === "ok" && previous.releaseId).toBe(r1.releaseId);
    await pruneReleases(w.dirs, new Set([r2.releaseId, r1.releaseId]));
    expect(readdirSync(w.dirs.versionsDir).sort()).toEqual([r1.releaseId, r2.releaseId].sort());
  });

  test("stale .install-* older than 1 h removed; younger kept", async () => {
    const w = world();
    const oldDir = path.join(w.dirs.versionsDir, ".install-old");
    const newDir = path.join(w.dirs.versionsDir, ".install-new");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    const past = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(oldDir, past, past);
    await removeStaleStaging(w.dirs);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(newDir)).toBe(true);
  });
});
