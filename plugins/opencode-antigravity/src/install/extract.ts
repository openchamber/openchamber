// Single-executable extraction (IA 6.4). A built-in streaming tar reader over gunzip, read to gzip EOF
// so the CRC32 and ISIZE trailer are checked. Exactly one regular entry named like the executable.

import { constants as fsConstants, createReadStream } from "node:fs";
import { copyFile, open, rm, type FileHandle } from "node:fs/promises";
import { createGunzip } from "node:zlib";

const BLOCK = 512;
const MIB = 1024 * 1024;

export const EXACTLY_ONE_MESSAGE = "The Antigravity archive must contain exactly one executable.";
export const EXTRACT_FAILED_MESSAGE = "Could not extract the Antigravity executable.";

/** `message` is one of the two texts above; `detail` is for debug logs. */
export class TarFormatError extends Error {
  readonly detail: string;

  constructor(kind: "layout" | "corrupt", detail: string) {
    super(kind === "layout" ? EXACTLY_ONE_MESSAGE : EXTRACT_FAILED_MESSAGE);
    this.name = "TarFormatError";
    this.detail = detail;
  }
}

export interface ExtractLimits {
  /** Default 512 MiB. */
  maxEntryBytes?: number;
  /** Decompressed bytes over the whole stream. Default 513 MiB. */
  maxTotalBytes?: number;
  /** pax `x` and GNU `L` payloads. Default 64 KiB. */
  maxMetaBytes?: number;
}

/** pax keys that only describe the entry; anything else changes it and is refused. */
const HARMLESS_PAX_KEYS = new Set(["path", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname", "comment"]);

function layout(detail: string): TarFormatError {
  return new TarFormatError("layout", detail);
}

function corrupt(detail: string): TarFormatError {
  return new TarFormatError("corrupt", detail);
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}

function headerChecksumOk(block: Buffer): boolean {
  const field = block.subarray(148, 156).toString("latin1").replace(/\0.*$/s, "").trim();
  if (!/^[0-7]+$/.test(field)) return false;
  const stored = Number.parseInt(field, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
  return sum === stored;
}

function parseSize(block: Buffer): number {
  const field = block.subarray(124, 136);
  const first = field[0] ?? 0;
  if (first & 0x80) {
    if (first & 0x40) throw corrupt("negative base-256 size");
    let value = first & 0x3f;
    for (let i = 1; i < field.length; i++) {
      value = value * 256 + (field[i] ?? 0);
      if (!Number.isSafeInteger(value)) throw corrupt("size overflow");
    }
    return value;
  }
  const text = field.toString("latin1").replace(/\0.*$/s, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw corrupt("bad octal size");
  return Number.parseInt(text, 8);
}

/** NUL-terminated string field; bytes after the first NUL must be NUL too. */
function cString(field: Buffer, what: string): string {
  const nul = field.indexOf(0);
  if (nul >= 0) {
    for (let i = nul; i < field.length; i++) if (field[i] !== 0) throw layout(`${what} contains NUL`);
  }
  return field.subarray(0, nul >= 0 ? nul : field.length).toString("utf8");
}

function checkName(raw: string, executableName: string): void {
  if (raw.includes("\0")) throw layout("name contains NUL");
  if (raw.includes("\\")) throw layout("name contains a backslash");
  if (raw.startsWith("/")) throw layout("absolute name");
  if (raw.split("/").includes("..")) throw layout("name contains ..");
  const name = raw.startsWith("./") ? raw.slice(2) : raw;
  if (name !== executableName) throw layout("unexpected entry name");
}

function parsePax(payload: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    if (space < 0) throw corrupt("pax record without length");
    const lenText = payload.subarray(offset, space).toString("latin1");
    if (!/^\d+$/.test(lenText)) throw corrupt("pax record length");
    const len = Number(lenText);
    if (len <= 0 || offset + len > payload.length) throw corrupt("pax record overflow");
    const record = payload.subarray(space + 1, offset + len);
    if (record[record.length - 1] !== 0x0a) throw corrupt("pax record terminator");
    const text = record.subarray(0, record.length - 1).toString("utf8");
    const eq = text.indexOf("=");
    if (eq <= 0) throw corrupt("pax record key");
    records.set(text.slice(0, eq), text.slice(eq + 1));
    offset += len;
  }
  return records;
}

type Phase =
  | { kind: "header" }
  | { kind: "meta"; type: "x" | "L"; remaining: number; padding: number; chunks: Buffer[] }
  | { kind: "data"; remaining: number; padding: number }
  | { kind: "padding"; remaining: number }
  | { kind: "trailer" };

class TarReader {
  private phase: Phase = { kind: "header" };
  private pending: Buffer = Buffer.alloc(0);
  private paxPath: string | null = null;
  private longName: string | null = null;
  private entryDone = false;
  private entryStarted = false;
  private total = 0;
  private written = 0;

  constructor(
    private readonly out: FileHandle,
    private readonly executableName: string,
    private readonly limits: Required<ExtractLimits>,
  ) {}

  async push(chunk: Buffer): Promise<void> {
    this.total += chunk.length;
    if (this.total > this.limits.maxTotalBytes) throw corrupt("decompressed size over cap");
    const buf = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    let offset = 0;
    for (;;) {
      const phase = this.phase;
      if (phase.kind === "data") {
        if (offset >= buf.length) break;
        const take = Math.min(phase.remaining, buf.length - offset);
        if (take > 0) {
          await this.out.write(buf.subarray(offset, offset + take));
          this.written += take;
          offset += take;
          phase.remaining -= take;
        }
        if (phase.remaining === 0) {
          this.entryDone = true;
          this.phase = phase.padding > 0 ? { kind: "padding", remaining: phase.padding } : { kind: "trailer" };
        }
        continue;
      }
      if (phase.kind === "padding") {
        if (offset >= buf.length) break;
        const take = Math.min(phase.remaining, buf.length - offset);
        for (let i = offset; i < offset + take; i++) if (buf[i] !== 0) throw corrupt("non-zero padding");
        offset += take;
        phase.remaining -= take;
        if (phase.remaining === 0) this.phase = this.entryDone ? { kind: "trailer" } : { kind: "header" };
        continue;
      }
      if (phase.kind === "meta") {
        if (offset >= buf.length) break;
        const take = Math.min(phase.remaining, buf.length - offset);
        phase.chunks.push(Buffer.from(buf.subarray(offset, offset + take)));
        offset += take;
        phase.remaining -= take;
        if (phase.remaining === 0) {
          this.finishMeta(phase.type, Buffer.concat(phase.chunks));
          this.phase = phase.padding > 0 ? { kind: "padding", remaining: phase.padding } : { kind: "header" };
        }
        continue;
      }
      // header or trailer: whole blocks
      if (buf.length - offset < BLOCK) break;
      const block = buf.subarray(offset, offset + BLOCK);
      offset += BLOCK;
      if (phase.kind === "trailer") {
        if (!isZeroBlock(block)) throw this.entryDone ? layout("data after the executable") : corrupt("data after end of archive");
        continue;
      }
      if (isZeroBlock(block)) {
        this.phase = { kind: "trailer" };
        continue;
      }
      this.header(block);
    }
    this.pending = offset < buf.length ? Buffer.from(buf.subarray(offset)) : Buffer.alloc(0);
  }

  private header(block: Buffer): void {
    if (!headerChecksumOk(block)) throw corrupt("header checksum");
    const magic = block.subarray(257, 263).toString("latin1");
    const posix = magic === "ustar\0";
    const gnu = magic === "ustar " && block[263] === 0x20 && block[264] === 0;
    if (!posix && !gnu) throw corrupt("unknown tar magic");
    // GNU headers keep atime and ctime in this area; only POSIX ustar uses it as a name prefix.
    if (posix && !isZeroBlock(block.subarray(345, 500))) throw layout("ustar prefix field is set");
    const type = String.fromCharCode(block[156] ?? 0);
    const size = parseSize(block);
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;

    if (type === "x" || type === "L") {
      if (this.entryStarted || this.entryDone) throw layout("metadata after the executable");
      if (size > this.limits.maxMetaBytes) throw corrupt(`${type} payload over cap`);
      this.phase = size === 0 ? { kind: "header" } : { kind: "meta", type, remaining: size, padding, chunks: [] };
      return;
    }
    if (type === "g") throw corrupt("pax global header");
    if (type !== "0" && type !== "\0") throw layout(`entry of type ${JSON.stringify(type)}`);
    if (this.entryDone || this.entryStarted) throw layout("second regular entry");

    const name = this.paxPath ?? this.longName ?? cString(block.subarray(0, 100), "name");
    this.paxPath = null;
    this.longName = null;
    checkName(name, this.executableName);
    if (size <= 0) throw layout("empty executable");
    if (size > this.limits.maxEntryBytes) throw corrupt("executable over cap");
    this.entryStarted = true;
    this.phase = { kind: "data", remaining: size, padding };
  }

  private finishMeta(type: "x" | "L", payload: Buffer): void {
    if (type === "L") {
      this.longName = cString(payload, "long name");
      return;
    }
    const records = parsePax(payload);
    for (const key of records.keys()) {
      if (!HARMLESS_PAX_KEYS.has(key)) throw corrupt(`pax key ${key}`);
    }
    const p = records.get("path");
    if (p !== undefined) this.paxPath = p;
  }

  finish(): void {
    // A partial zero block after the end-of-archive marker is tolerated; anything else left over is not.
    if (this.pending.length > 0 && !(this.phase.kind === "trailer" && isZeroBlock(this.pending))) throw corrupt("truncated archive");
    if (this.phase.kind !== "trailer" && this.phase.kind !== "header") throw corrupt("truncated archive");
    if (!this.entryDone) throw layout("no executable entry");
    if (this.written <= 0) throw layout("empty executable");
  }
}

/**
 * Extracts the only entry of a tar.gz archive into `dest` (opened `wx`, mode 0700). The file counts
 * as extracted only after gzip EOF passes; on any failure `dest` is removed.
 */
export async function extractSingleExecutable(
  archive: string,
  dest: string,
  executableName: string,
  limits: ExtractLimits = {},
): Promise<{ bytes: number }> {
  const resolved: Required<ExtractLimits> = {
    maxEntryBytes: limits.maxEntryBytes ?? 512 * MIB,
    maxTotalBytes: limits.maxTotalBytes ?? 513 * MIB,
    maxMetaBytes: limits.maxMetaBytes ?? 64 * 1024,
  };
  const out = await open(dest, "wx", 0o700);
  let ok = false;
  try {
    const reader = new TarReader(out, executableName, resolved);
    const gunzip = createGunzip();
    const input = createReadStream(archive);
    input.on("error", (err) => gunzip.destroy(err));
    input.pipe(gunzip);
    try {
      for await (const chunk of gunzip) {
        if (!Buffer.isBuffer(chunk)) throw corrupt("unexpected stream chunk");
        await reader.push(chunk);
      }
    } catch (err) {
      input.destroy();
      gunzip.destroy();
      if (err instanceof TarFormatError) throw err;
      throw corrupt(`gzip: ${err instanceof Error ? err.message : String(err)}`);
    }
    reader.finish();
    await out.sync();
    ok = true;
    const { size } = await out.stat();
    return { bytes: size };
  } finally {
    await out.close();
    if (!ok) await rm(dest, { force: true }).catch(() => {});
  }
}

/** Windows asset: the `.exe` itself (IA 6.4). */
export async function copyExecutable(download: string, dest: string): Promise<{ bytes: number }> {
  await copyFile(download, dest, fsConstants.COPYFILE_EXCL);
  const handle = await open(dest, "r");
  try {
    return { bytes: (await handle.stat()).size };
  } finally {
    await handle.close();
  }
}
