import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { EXACTLY_ONE_MESSAGE, EXTRACT_FAILED_MESSAGE, TarFormatError, extractSingleExecutable, type ExtractLimits } from "../src/install/extract.ts";
import { TempDirs, paxPayload, rejection, tarArchive, tarHeader, tgz, type TarEntry } from "./fixtures/install-helpers.ts";

const temps = new TempDirs();
afterEach(() => temps.cleanup());

const BODY = Buffer.from("#!/bin/sh\necho antigravity\n".repeat(50));

async function extract(archive: Buffer, limits: ExtractLimits = {}): Promise<{ dest: string; result: Promise<{ bytes: number }> }> {
  const dir = temps.make();
  const file = path.join(dir, "download");
  writeFileSync(file, archive);
  const dest = path.join(dir, "antigravity");
  return { dest, result: extractSingleExecutable(file, dest, "antigravity", limits) };
}

async function expectOk(archive: Buffer, limits: ExtractLimits = {}): Promise<string> {
  const { dest, result } = await extract(archive, limits);
  expect((await result).bytes).toBe(BODY.length);
  expect(readFileSync(dest).equals(BODY)).toBe(true);
  return dest;
}

async function expectRefused(archive: Buffer, message: string, limits: ExtractLimits = {}): Promise<void> {
  const { dest, result } = await extract(archive, limits);
  const err = await rejection(result);
  expect(err instanceof TarFormatError).toBe(true);
  expect(err instanceof Error ? err.message : "").toBe(message);
  expect(existsSync(dest)).toBe(false);
}

const exe: TarEntry = { name: "antigravity", data: BODY };

describe("accepted archives", () => {
  test("ustar\\0 magic: byte-exact, mode 0700 before chmod", async () => {
    const dest = await expectOk(tgz([exe]));
    if (process.platform !== "win32") expect(statSync(dest).mode & 0o777).toBe(0o700);
  });

  test("GNU `ustar ` magic, as in the real asset", async () => {
    await expectOk(tgz([{ ...exe, magic: "gnu" }]));
  });

  test("./ prefix on the name", async () => {
    await expectOk(tgz([{ ...exe, name: "./antigravity" }]));
  });

  test("a pax x header with only path before the entry", async () => {
    const pax = paxPayload({ path: "antigravity" });
    await expectOk(tgz([{ name: "PaxHeader", type: "x", data: pax }, { ...exe, name: "ignored-by-pax" }]));
  });

  test("a GNU L long name antigravity", async () => {
    await expectOk(tgz([{ name: "././@LongLink", type: "L", data: Buffer.from("antigravity\0"), magic: "gnu" }, { ...exe, name: "x", magic: "gnu" }]));
  });

  test("a base-256 size field", async () => {
    await expectOk(tgz([{ ...exe, base256Size: true }]));
  });

  test("an archive without the two trailing zero blocks", async () => {
    await expectOk(gzipSync(tarArchive([exe], Buffer.alloc(0))));
  });
});

describe("refused archives", () => {
  const layout: Array<[string, TarEntry[]]> = [
    ["two regular files", [exe, { name: "antigravity", data: "x" }]],
    ["a second, differently named file", [exe, { name: "README", data: "x" }]],
    ["a directory entry", [{ name: "antigravity/", type: "5" }, exe]],
    ["a symlink entry", [{ name: "antigravity", type: "2" }]],
    ["../antigravity", [{ ...exe, name: "../antigravity" }]],
    ["/antigravity", [{ ...exe, name: "/antigravity" }]],
    ["a name with a backslash", [{ ...exe, name: "a\\antigravity" }]],
    ["a name with NUL inside", [{ ...exe, rawName: Buffer.from("anti\0gravity") }]],
    ["another file name", [{ ...exe, name: "agy" }]],
    ["a non-empty ustar prefix field", [{ ...exe, prefix: "bin" }]],
    ["a 0-byte antigravity", [{ name: "antigravity", data: "" }]],
    ["no entry at all", []],
  ];
  for (const [name, entries] of layout) {
    test(name, async () => {
      await expectRefused(tgz(entries), EXACTLY_ONE_MESSAGE);
    });
  }

  test("a bad header checksum", async () => {
    await expectRefused(tgz([{ ...exe, badChecksum: true }]), EXTRACT_FAILED_MESSAGE);
  });

  test("a non-zero block after the entry", async () => {
    const trailer = Buffer.alloc(1024);
    trailer[600] = 1;
    await expectRefused(gzipSync(tarArchive([exe], trailer)), EXACTLY_ONE_MESSAGE);
  });

  test("truncated gzip", async () => {
    const full = tgz([exe]);
    await expectRefused(full.subarray(0, full.length - 12), EXTRACT_FAILED_MESSAGE);
  });

  test("a corrupted gzip CRC", async () => {
    const full = Buffer.from(tgz([exe]));
    const at = full.length - 8;
    full[at] = (full[at] ?? 0) ^ 0xff;
    await expectRefused(full, EXTRACT_FAILED_MESSAGE);
  });

  test("an entry larger than an injected cap", async () => {
    await expectRefused(tgz([exe]), EXTRACT_FAILED_MESSAGE, { maxEntryBytes: BODY.length - 1 });
  });

  test("zero blocks past the total cap (injected small cap)", async () => {
    await expectRefused(gzipSync(tarArchive([exe], Buffer.alloc(64 * 1024))), EXTRACT_FAILED_MESSAGE, { maxTotalBytes: 8 * 1024 });
  });

  test("a pax size override", async () => {
    const pax = paxPayload({ path: "antigravity", size: "10" });
    await expectRefused(tgz([{ name: "PaxHeader", type: "x", data: pax }, exe]), EXTRACT_FAILED_MESSAGE);
  });

  test("a pax g header", async () => {
    await expectRefused(tgz([{ name: "GlobalHead", type: "g", data: paxPayload({ comment: "x" }) }, exe]), EXTRACT_FAILED_MESSAGE);
  });

  test("a pax payload over 64 KiB", async () => {
    const pax = paxPayload({ path: "antigravity", comment: "x".repeat(65 * 1024) });
    await expectRefused(tgz([{ name: "PaxHeader", type: "x", data: pax }, exe]), EXTRACT_FAILED_MESSAGE);
  });

  test("a GNU L payload over 64 KiB", async () => {
    const long = Buffer.alloc(65 * 1024, 0x61);
    await expectRefused(tgz([{ name: "././@LongLink", type: "L", data: long, magic: "gnu" }, exe]), EXTRACT_FAILED_MESSAGE);
  });

  test("a pax header after the entry", async () => {
    await expectRefused(tgz([exe, { name: "PaxHeader", type: "x", data: paxPayload({ path: "antigravity" }) }]), EXACTLY_ONE_MESSAGE);
  });

  test("a tar header without a known magic", async () => {
    const header = tarHeader(exe);
    header.write("xxxxxx", 257, "latin1");
    // Recompute the checksum so only the magic is wrong.
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    const body = Buffer.concat([header, BODY, Buffer.alloc(512 - (BODY.length % 512)), Buffer.alloc(1024)]);
    await expectRefused(gzipSync(body), EXTRACT_FAILED_MESSAGE);
  });

  test("513 zero bytes: a zero block and a partial one are not an executable (N-12)", async () => {
    await expectRefused(gzipSync(Buffer.alloc(513)), EXACTLY_ONE_MESSAGE);
  });

  test("an archive cut inside the entry's padding (N-12)", async () => {
    const cut = Buffer.concat([tarHeader(exe), BODY, Buffer.alloc(10)]);
    expect(BODY.length % 512 === 0).toBe(false);
    await expectRefused(gzipSync(cut), EXTRACT_FAILED_MESSAGE);
  });
});
