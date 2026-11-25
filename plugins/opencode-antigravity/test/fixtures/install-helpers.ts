// Shared helpers for the install/auth tests (WP-A): temp dirs, a small tar writer, a fetch that maps
// Google's hosts onto local servers, a fake OpenCode location, and fake runtime hooks.

import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { CreateRunDir, Lease, RunDir, RunDirKind, RuntimeControl } from "../../src/contracts.ts";
import type { ConnectionLike, ConnectionStatusValue, IntegrationDomainLike } from "../../src/auth/manager.ts";
import type { FetchLike } from "../../src/install/download.ts";
import { getField } from "../../src/install/fs-utils.ts";
import { resolveInstallAuthConfig, type InstallAuthConfig } from "../../src/install/config.ts";

export class TempDirs {
  private readonly dirs: string[] = [];

  make(prefix = "oa-test-"): string {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    this.dirs.push(dir);
    return dir;
  }

  cleanup(): void {
    while (this.dirs.length > 0) {
      const dir = this.dirs.pop();
      if (!dir) continue;
      makeWritable(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Managed release dirs are 0500; give them write permission back so they can be removed. */
function makeWritable(p: string): void {
  try {
    const s = lstatSync(p);
    if (s.isSymbolicLink() || !s.isDirectory()) return;
    chmodSync(p, 0o700);
    for (const name of readdirSync(p)) makeWritable(path.join(p, name));
  } catch {
    // already gone
  }
}

export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return undefined;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3_000, stepMs = 10): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(stepMs);
  }
  return check();
}

/** An env with no inherited agy or Google variables, and HOME, PATH and the data dir in `root`. */
export function isolatedEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    HOME: root,
    PATH: path.join(root, "empty-path"),
    OPENCODE_ANTIGRAVITY_DATA_DIR: path.join(root, "data"),
    T3CODE_HOME: path.join(root, "t3"),
    ...extra,
  };
}

export function testConfig(root: string, options: Record<string, unknown> = {}, env: Record<string, string> = {}): InstallAuthConfig {
  return resolveInstallAuthConfig(options, isolatedEnv(root, env)).config;
}

// ---------------------------------------------------------------------------
// Tar writer
// ---------------------------------------------------------------------------

export interface TarEntry {
  name: string;
  /** Default "0". */
  type?: string;
  data?: Buffer | string;
  /** Default "ustar\0" + "00". "gnu" writes "ustar " + " \0". */
  magic?: "ustar" | "gnu";
  prefix?: string;
  /** Overrides the size field; data is still written as given. */
  sizeField?: number;
  /** Writes the size in base-256. */
  base256Size?: boolean;
  /** Corrupts the header checksum. */
  badChecksum?: boolean;
  /** Raw name bytes, for names with NUL. */
  rawName?: Buffer;
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

export function tarHeader(entry: TarEntry): Buffer {
  const block = Buffer.alloc(512);
  const data = entry.data === undefined ? Buffer.alloc(0) : Buffer.from(entry.data);
  (entry.rawName ?? Buffer.from(entry.name)).copy(block, 0, 0, 100);
  block.write(octal(0o755, 8), 100, "latin1");
  block.write(octal(0, 8), 108, "latin1");
  block.write(octal(0, 8), 116, "latin1");
  const size = entry.sizeField ?? data.length;
  if (entry.base256Size) {
    block[124] = 0x80;
    let v = size;
    for (let i = 135; i > 124; i--) {
      block[i] = v & 0xff;
      v = Math.floor(v / 256);
    }
  } else {
    block.write(octal(size, 12), 124, "latin1");
  }
  block.write(octal(0, 12), 136, "latin1");
  block.write(entry.type ?? "0", 156, "latin1");
  if (entry.magic === "gnu") {
    block.write("ustar ", 257, "latin1");
    block.write(" \0", 263, "latin1");
  } else {
    block.write("ustar\0", 257, "latin1");
    block.write("00", 263, "latin1");
  }
  if (entry.prefix) block.write(entry.prefix, 345, "latin1");
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  if (entry.badChecksum) sum += 1;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return block;
}

function pad(data: Buffer): Buffer {
  const rest = data.length % 512;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rest)]);
}

/** A tar stream of `entries` plus two zero blocks (or `trailer` instead). */
export function tarArchive(entries: readonly TarEntry[], trailer: Buffer = Buffer.alloc(1024)): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(tarHeader(entry));
    const data = entry.data === undefined ? Buffer.alloc(0) : Buffer.from(entry.data);
    if (data.length > 0) parts.push(pad(data));
  }
  parts.push(trailer);
  return Buffer.concat(parts);
}

export function paxPayload(records: Record<string, string>): Buffer {
  let out = "";
  for (const [key, value] of Object.entries(records)) {
    const body = ` ${key}=${value}\n`;
    let len = body.length + 1;
    while (`${len}${body}`.length !== len) len = `${len}${body}`.length;
    out += `${len}${body}`;
  }
  return Buffer.from(out);
}

export function tgz(entries: readonly TarEntry[]): Buffer {
  return gzipSync(tarArchive(entries));
}

export function sha512(data: Buffer): string {
  return createHash("sha512").update(data).digest("hex");
}

/** A shell-script `antigravity` that execs mock-agy.ts with the given version and scenario. */
export function mockAgyScript(mockPath: string, opts: { version: string; scenario?: string }): string {
  const q = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;
  const flags = ["--agy-version", opts.version, ...(opts.scenario ? ["--scenario", opts.scenario] : [])];
  return `#!/bin/sh\nexec ${[process.execPath, mockPath, ...flags].map(q).join(" ")} "$@"\n`;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/**
 * A fetch that sends `https://<host>` requests to local servers by origin, unchanged otherwise.
 * Production code still checks the real URL before each hop, so host rules are tested as shipped.
 */
export function mappedFetch(routes: Record<string, string>, calls: string[] = []): FetchLike {
  return async (input, init) => {
    calls.push(input);
    const url = new URL(input);
    const target = routes[url.origin];
    if (!target) throw new Error(`no route for ${url.origin}`);
    return fetch(`${target}${url.pathname}${url.search}`, init);
  };
}

export interface LocalServer {
  url: string;
  hits: string[];
  stop(): void;
}

export function serve(handler: (req: Request, url: URL) => Response | Promise<Response>): LocalServer {
  const hits: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      hits.push(`${url.pathname}${url.search}`);
      return handler(req, url);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------------------
// OpenCode location and runtime fakes
// ---------------------------------------------------------------------------

export interface FakeConnection extends ConnectionLike {
  type: "credential";
  id: string;
  label: string;
  method: "oauth";
  status?: ConnectionStatusValue;
}

export interface StatusCall {
  id: string;
  status: ConnectionStatusValue | undefined;
}

/** A fake `ctx.integration` for one location. Knobs: `connections`, `failActive`, `failGet`, `failStatus`, `notFound`. */
export class FakeLocation implements IntegrationDomainLike {
  connections: FakeConnection[] = [];
  statusCalls: StatusCall[] = [];
  failActive = false;
  failGet = false;
  failStatus = false;
  notFound = false;

  constructor(readonly directory: string) {}

  addCredential(id: string): FakeConnection {
    const c: FakeConnection = { type: "credential", id, label: "Antigravity", method: "oauth" };
    this.connections.push(c);
    return c;
  }

  async get(input: { integrationID: string }): Promise<{ location: { directory: string }; data: { connections: readonly ConnectionLike[] } }> {
    if (this.notFound) throw Object.assign(new Error("not found"), { _tag: "IntegrationNotFoundError" });
    if (this.failGet) throw new Error("location closing");
    void input;
    return { location: { directory: this.directory }, data: { connections: this.connections.map((c) => ({ ...c })) } };
  }

  readonly connection = {
    active: async (integrationID: string): Promise<ConnectionLike | undefined> => {
      void integrationID;
      if (this.notFound) throw Object.assign(new Error("not found"), { _tag: "IntegrationNotFoundError" });
      if (this.failActive) throw new Error("location closing");
      return this.connections[0];
    },
    status: async (input: { integrationID: string; connection: ConnectionLike; status: ConnectionStatusValue | undefined }): Promise<void> => {
      if (this.failStatus) throw new Error("location closing");
      const wanted = getField(input.connection, "id");
      const id = this.connections.find((c) => c.id === wanted)?.id ?? "?";
      this.statusCalls.push({ id, status: input.status });
      const target = this.connections.find((c) => c.id === id);
      if (target) target.status = input.status;
    },
  };
}

export class FakeRuntime implements RuntimeControl {
  readonly events: string[] = [];
  stopCalls = 0;
  holds = 0;
  released = 0;
  stopDelayMs = 0;

  async stop(reason: "auth-changed"): Promise<void> {
    this.stopCalls++;
    this.events.push(`stop:${reason}`);
    if (this.stopDelayMs > 0) await sleep(this.stopDelayMs);
    this.events.push("stopped");
  }

  hold(reason: "login"): Lease {
    this.holds++;
    this.events.push(`hold:${reason}`);
    let done = false;
    return {
      generation: 0,
      release: () => {
        if (done) return;
        done = true;
        this.released++;
        this.events.push("release-hold");
      },
    };
  }

  get liveHolds(): number {
    return this.holds - this.released;
  }
}

export class FakeRunDirs {
  readonly created: Array<{ kind: RunDirKind; path: string }> = [];
  readonly released: string[] = [];

  constructor(private readonly root: string) {}

  readonly create: CreateRunDir = async (kind) => {
    const dir = mkdtempSync(path.join(this.root, `run-${kind}-`));
    this.created.push({ kind, path: dir });
    const handle: RunDir = {
      path: dir,
      release: async () => {
        this.released.push(dir);
        rmSync(dir, { recursive: true, force: true });
      },
    };
    return handle;
  };

  releasedCount(kind: RunDirKind): number {
    return this.created.filter((c) => c.kind === kind && this.released.includes(c.path)).length;
  }

  createdCount(kind: RunDirKind): number {
    return this.created.filter((c) => c.kind === kind).length;
  }
}

/** Writes a token file pair the way agy does in isolated mode. */
export function writeTokenFiles(geminiDir: string, email?: string): void {
  const dir = path.join(geminiDir, "antigravity-acp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "antigravity-oauth-token"), JSON.stringify({ auth_method: "oauth-personal", token: "t", ...(email ? { id_token_email: email } : {}) }));
  writeFileSync(path.join(dir, "acp_token.json"), JSON.stringify({ refresh_token: "r" }));
}
