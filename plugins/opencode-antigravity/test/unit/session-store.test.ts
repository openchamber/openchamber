import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import type { BindingRecord } from "../../src/contracts.ts";
import { MemorySessionStore, SessionStore, bindingIdFor, profileIdFor, type SessionStoreOptions } from "../../src/session-store.ts";

const tempDirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agy-store-"));
  tempDirs.push(dir);
  return dir;
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_764_000_000_000;

function makeStore(over: Partial<SessionStoreOptions> = {}): { store: SessionStore; root: string; geminiDir: string } {
  const root = tempDir();
  const geminiDir = path.join(root, "gemini");
  mkdirSync(geminiDir, { recursive: true });
  const store = new SessionStore({
    dataDir: path.join(root, "data"),
    geminiDir,
    poolId: "pool-a",
    authEpoch: () => "3",
    isPluginOwnedProfile: () => true,
    sessionTtlDays: 14,
    maxStoredSessions: 500,
    now: () => NOW,
    ...over,
  });
  return { store, root, geminiDir };
}

let uuidCounter = 0;
function uuid(): string {
  uuidCounter += 1;
  return `5c1e0000-0000-4000-8000-${uuidCounter.toString(16).padStart(12, "0")}`;
}

function record(sessionKey: string, over: Partial<BindingRecord> = {}): BindingRecord {
  return {
    version: 1,
    sessionKey,
    acpSessionId: uuid(),
    authEpoch: "3",
    agyVersion: "1.5.15",
    cwd: "/work",
    model: "gemini-4-neon",
    thoughtLevel: "high",
    systemHash: "s",
    toolsSchemaHash: "t",
    toolsDescHashes: { read: "a1c3" },
    appendInPrompt: false,
    prefixCount: 4,
    prefixHash: "p",
    state: "dormant",
    taintReason: null,
    lastTurn: {
      outcome: "ok",
      plan: "append",
      emittedToolCalls: [{ id: "c1", name: "read", argsHash: "h" }],
      emittedTextHash: null,
      inputFrom: 3,
      inputTo: 4,
    },
    createdAt: NOW - 1000,
    updatedAt: NOW,
    turns: 2,
    ...over,
  };
}

function conversationFiles(geminiDir: string, id: string): string[] {
  const dir = path.join(geminiDir, "antigravity-acp", "conversations");
  mkdirSync(dir, { recursive: true });
  const files = [`${id}.db`, `${id}.db-wal`, `${id}.db-shm`].map((name) => path.join(dir, name));
  for (const file of files) writeFileSync(file, "x");
  return files;
}

function spawnSleeper(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  children.push(child);
  return child;
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid ?? 0;
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  return pid;
}

function writeLock(store: SessionStore, sessionKey: string, pid: number, host = hostname()): string {
  mkdirSync(store.dir, { recursive: true });
  const file = path.join(store.dir, `${bindingIdFor(sessionKey)}.lock`);
  writeFileSync(file, JSON.stringify({ pid, host, poolId: "other-pool", token: "ff".repeat(16), acquiredAt: Date.now() }));
  return file;
}

describe("profileIdFor", () => {
  test("the id is the same before and after the gemini dir exists, also below a symlinked tmpdir", () => {
    const root = tempDir();
    const geminiDir = path.join(root, "not-yet", "gemini");
    const before = profileIdFor(geminiDir);
    mkdirSync(geminiDir, { recursive: true });
    expect(profileIdFor(geminiDir)).toBe(before);
    // The store a restarted process builds finds the records of the first one.
    expect(new SessionStore({
      dataDir: path.join(root, "data"),
      geminiDir,
      poolId: "p",
      authEpoch: () => "1",
      isPluginOwnedProfile: () => true,
      sessionTtlDays: 14,
      maxStoredSessions: 500,
    }).dir.endsWith(before)).toBe(true);
  });
});

describe("records", () => {
  test("save and load round-trip; live is written as dormant; modes 0600 and 0700", async () => {
    const { store } = makeStore();
    await store.save(record("ses_1", { state: "live" }));
    const loaded = await store.load("ses_1", "3");
    expect(loaded).toEqual(record("ses_1", { state: "dormant", acpSessionId: loaded?.acpSessionId ?? "" }));
    const file = path.join(store.dir, `${bindingIdFor("ses_1")}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(store.dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(file, "utf8").includes('"state":"dormant"')).toBe(true);
  });

  test("atomic write leaves no temp files", async () => {
    const { store } = makeStore();
    for (let i = 0; i < 5; i += 1) await store.save(record("ses_1", { turns: i }));
    expect(readdirSync(store.dir)).toEqual([`${bindingIdFor("ses_1")}.json`]);
    expect((await store.load("ses_1", "3"))?.turns).toBe(4);
  });

  test("a corrupt file is renamed and treated as missing", async () => {
    const { store } = makeStore();
    mkdirSync(store.dir, { recursive: true });
    const file = path.join(store.dir, `${bindingIdFor("ses_1")}.json`);
    writeFileSync(file, "{ not json");
    expect(await store.load("ses_1", "3")).toBeNull();
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(store.dir).some((name) => name.startsWith(`${bindingIdFor("ses_1")}.json.corrupt-`))).toBe(true);
  });

  test("an unknown version or a bad field counts as corrupt", async () => {
    const { store } = makeStore();
    mkdirSync(store.dir, { recursive: true });
    const file = path.join(store.dir, `${bindingIdFor("ses_1")}.json`);
    writeFileSync(file, JSON.stringify({ ...record("ses_1"), version: 2 }));
    expect(await store.load("ses_1", "3")).toBeNull();
    writeFileSync(file, JSON.stringify({ ...record("ses_1"), prefixCount: "4" }));
    expect(await store.load("ses_1", "3")).toBeNull();
    writeFileSync(file, JSON.stringify({ ...record("ses_1"), lastTurn: { outcome: "weird" } }));
    expect(await store.load("ses_1", "3")).toBeNull();
  });

  test("a record of another auth epoch is treated as missing and kept for prune", async () => {
    const { store } = makeStore();
    await store.save(record("ses_1"));
    expect(await store.load("ses_1", "4")).toBeNull();
    expect(existsSync(path.join(store.dir, `${bindingIdFor("ses_1")}.json`))).toBe(true);
  });

  test("remove deletes the record and its conversation files", async () => {
    const { store, geminiDir } = makeStore();
    const rec = record("ses_1");
    await store.save(rec);
    const files = conversationFiles(geminiDir, rec.acpSessionId);
    expect((await store.remove("ses_1"))?.acpSessionId).toBe(rec.acpSessionId);
    expect(await store.load("ses_1", "3")).toBeNull();
    expect(files.some((file) => existsSync(file))).toBe(false);
    expect(await store.remove("ses_1")).toBeNull();
  });
});

describe("locks", () => {
  test("a lock from a dead pid is replaced", async () => {
    const { store } = makeStore();
    const file = writeLock(store, "ses_1", await deadPid());
    const lock = await store.lock("ses_1");
    expect(lock?.sessionKey).toBe("ses_1");
    expect(JSON.parse(readFileSync(file, "utf8")).poolId).toBe("pool-a");
    await lock?.release();
    expect(existsSync(file)).toBe(false);
  });

  test("a lock from a live pid is respected", async () => {
    const { store } = makeStore();
    const child = spawnSleeper();
    const file = writeLock(store, "ses_1", child.pid ?? 0);
    expect(await store.lock("ses_1")).toBeNull();
    expect(JSON.parse(readFileSync(file, "utf8")).poolId).toBe("other-pool");
  });

  test("locking twice in one store returns the held lock", async () => {
    const { store } = makeStore();
    const a = await store.lock("ses_1");
    const b = await store.lock("ses_1");
    expect(a === null || b === null).toBe(false);
    await store.close();
    expect(existsSync(path.join(store.dir, `${bindingIdFor("ses_1")}.lock`))).toBe(false);
  });
});

describe("prune", () => {
  test("by TTL and by count, newest kept", async () => {
    const { store } = makeStore({ maxStoredSessions: 2 });
    await store.save(record("old", { updatedAt: NOW - 15 * DAY }));
    await store.save(record("a", { updatedAt: NOW - 3 }));
    await store.save(record("b", { updatedAt: NOW - 2 }));
    await store.save(record("c", { updatedAt: NOW - 1 }));
    await store.prune();
    expect(await store.load("old", "3")).toBeNull();
    expect(await store.load("a", "3")).toBeNull();
    expect((await store.load("b", "3"))?.sessionKey).toBe("b");
    expect((await store.load("c", "3"))?.sessionKey).toBe("c");
  });

  test("records of another auth epoch are removed", async () => {
    const { store } = makeStore();
    await store.save(record("ses_1", { authEpoch: "2" }));
    await store.prune();
    expect(existsSync(path.join(store.dir, `${bindingIdFor("ses_1")}.json`))).toBe(false);
  });

  test("conversation files: only recorded UUID ids, only in a plugin-owned profile", async () => {
    const owned = makeStore();
    const expired = record("gone", { updatedAt: NOW - 20 * DAY });
    const badId = record("bad", { updatedAt: NOW - 20 * DAY, acpSessionId: "../../etc/passwd" });
    await owned.store.save(expired);
    await owned.store.save(badId);
    const expiredFiles = conversationFiles(owned.geminiDir, expired.acpSessionId);
    const unrecorded = conversationFiles(owned.geminiDir, uuid());
    await owned.store.prune();
    expect(expiredFiles.some((file) => existsSync(file))).toBe(false);
    expect(unrecorded.every((file) => existsSync(file))).toBe(true);
    expect(await owned.store.load("bad", "3")).toBeNull();

    const foreign = makeStore({ isPluginOwnedProfile: () => false });
    const rec = record("gone", { updatedAt: NOW - 20 * DAY });
    await foreign.store.save(rec);
    const files = conversationFiles(foreign.geminiDir, rec.acpSessionId);
    await foreign.store.prune();
    expect(await foreign.store.load("gone", "3")).toBeNull();
    expect(files.every((file) => existsSync(file))).toBe(true);
  });

  test("a binding locked by a live process is not pruned", async () => {
    const { store, geminiDir } = makeStore();
    const rec = record("ses_1", { updatedAt: NOW - 20 * DAY });
    await store.save(rec);
    const files = conversationFiles(geminiDir, rec.acpSessionId);
    writeLock(store, "ses_1", spawnSleeper().pid ?? 0);
    await store.prune();
    expect((await store.load("ses_1", "3"))?.sessionKey).toBe("ses_1");
    expect(files.every((file) => existsSync(file))).toBe(true);
  });

  test("ephemeral sessions older than 1 h are deleted and leave the ledger", async () => {
    let now = NOW;
    const { store, geminiDir } = makeStore({ now: () => now });
    const oldId = uuid();
    const newId = uuid();
    await store.recordEphemeral(oldId);
    now += 50 * 60 * 1000;
    await store.recordEphemeral(newId);
    const oldFiles = conversationFiles(geminiDir, oldId);
    const newFiles = conversationFiles(geminiDir, newId);
    now += 20 * 60 * 1000;
    await store.prune();
    expect(oldFiles.some((file) => existsSync(file))).toBe(false);
    expect(newFiles.every((file) => existsSync(file))).toBe(true);
    const ledger = readFileSync(path.join(store.dir, "ephemeral.jsonl"), "utf8");
    expect(ledger.includes(oldId)).toBe(false);
    expect(ledger).toContain(newId);
  });

  test("a record stored under another binding's file name is left alone", async () => {
    const { store, geminiDir } = makeStore();
    const victim = record("victim");
    await store.save(victim);
    const victimFiles = conversationFiles(geminiDir, victim.acpSessionId);
    // A copy of the victim's record, expired, under an unrelated binding id.
    const copy = path.join(store.dir, `${"0".repeat(32)}.json`);
    writeFileSync(copy, JSON.stringify({ ...victim, updatedAt: NOW - 30 * DAY }));
    await store.prune();
    expect((await store.load("victim", "3"))?.sessionKey).toBe("victim");
    expect(victimFiles.every((file) => existsSync(file))).toBe(true);
  });

  test("prune never throws on a missing directory", async () => {
    const { store } = makeStore();
    await store.prune();
    expect(existsSync(store.dir)).toBe(false);
  });
});

describe("memory store", () => {
  test("keeps records in memory, filtered by epoch", async () => {
    const store = new MemorySessionStore();
    await store.save(record("ses_1", { state: "live" }));
    expect((await store.load("ses_1", "3"))?.state).toBe("dormant");
    expect(await store.load("ses_1", "4")).toBeNull();
    expect((await store.lock("ses_1"))?.sessionKey).toBe("ses_1");
    expect((await store.remove("ses_1"))?.sessionKey).toBe("ses_1");
    expect(await store.load("ses_1", "3")).toBeNull();
  });
});
