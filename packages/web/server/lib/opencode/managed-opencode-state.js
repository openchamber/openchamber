import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renameSyncWithRetry } from '../shared/atomic-rename.js';
import { readBoundedFileSync } from '../shared/bounded-file-read.js';

const STATE_VERSION = 1;
// These files contain a handful of state fields and a small draining-process list.
// Keep enough room for long executable and instance paths while bounding sync reads.
const MANAGED_OPENCODE_STATE_MAX_BYTES = 64 * 1024;
const MANAGED_OPENCODE_DRAINING_MAX_BYTES = 64 * 1024;

export const resolveManagedOpenCodePaths = (dataDir) => {
  const dir = path.join(dataDir, 'managed-opencode');
  return {
    dir,
    statePath: path.join(dir, 'state.json'),
    logPath: path.join(dir, 'opencode.log'),
    drainingPath: path.join(dir, 'draining.json'),
  };
};

const isText = (value) => Object.prototype.toString.call(value) === '[object String]';

const canonicalize = (value) => JSON.stringify(value, (_key, item) => {
  if (item == null || Object.getPrototypeOf(item) !== Object.prototype) return item;
  return Object.fromEntries(Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
});

export const hashLaunchSecret = (value) => createHash('sha256').update(String(value ?? '')).digest('hex');

export const createLaunchFingerprint = (launch) => createHash('sha256').update(canonicalize(launch)).digest('hex');

const readBoundedJsonFileSync = (filePath, maxBytes) => {
  try {
    const result = readBoundedFileSync(filePath, maxBytes);
    if (!result.ok) return null;
    return JSON.parse(result.buffer.toString('utf8'));
  } catch {
    return null;
  }
};

export const readManagedOpenCodeState = (statePath) => {
  const parsed = readBoundedJsonFileSync(statePath, MANAGED_OPENCODE_STATE_MAX_BYTES);
  const valid = parsed?.version === STATE_VERSION
    && Number.isInteger(parsed.pid) && parsed.pid > 0
    && Number.isInteger(parsed.port) && parsed.port > 0
    && isText(parsed.binary) && parsed.binary.length > 0
    && isText(parsed.fingerprint)
    && isText(parsed.password) && parsed.password.length > 0
    && (parsed.agentToolToken === null || isText(parsed.agentToolToken))
    && (parsed.args === undefined || (Array.isArray(parsed.args) && parsed.args.every(isText)));
  return valid ? parsed : null;
};

// Replaced OpenCode processes that are still finishing their sessions. Kept apart from
// state.json, which describes only the current process and is cleared when that one exits.
export const readDrainingOpenCodeRecords = (drainingPath) => {
  const parsed = readBoundedJsonFileSync(drainingPath, MANAGED_OPENCODE_DRAINING_MAX_BYTES);
  if (parsed?.version !== STATE_VERSION || !Array.isArray(parsed.draining)) return [];
  return parsed.draining.filter((record) => (
    Number.isInteger(record?.pid) && record.pid > 0
    && Number.isInteger(record?.port) && record.port > 0
    && isText(record?.binary) && record.binary.length > 0
    && Number.isFinite(record?.drainStartedAt)
  ));
};

export const writeDrainingOpenCodeRecords = (drainingPath, records) => {
  if (records.length === 0) {
    rmSync(drainingPath, { force: true });
    return;
  }
  mkdirSync(path.dirname(drainingPath), { recursive: true, mode: 0o700 });
  const tmpPath = `${drainingPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify({ version: STATE_VERSION, draining: records }, null, 2)}\n`, { mode: 0o600 });
  renameSyncWithRetry((from, to) => renameSync(from, to), tmpPath, drainingPath);
};

// Holds the managed password and agent-tool token, so the file is 0600 and never logged.
export const writeManagedOpenCodeState = (statePath, state) => {
  mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify({ version: STATE_VERSION, ...state }, null, 2)}\n`, { mode: 0o600 });
  renameSyncWithRetry((from, to) => renameSync(from, to), tmpPath, statePath);
};

export const clearManagedOpenCodeState = (statePath) => {
  rmSync(statePath, { force: true });
};

export const sameOpenCodeArgs = (recorded, current) => recorded === undefined
  || (recorded.length === current.length && recorded.every((value, index) => value === current[index]));

// `ownsPid` must be verified against the process command before any signal is sent: a recorded pid can be reused.
// A changed launch keeps the recorded process serving until its replacement is ready (`handoff`); only an
// unhealthy recorded process is replaced in place, because it is not serving anything to hand over.
export const decideManagedOpenCodeLaunch = ({ state, ownsPid, binary, args, fingerprint, port, healthy }) => {
  if (!state) return { action: 'start', reason: 'no-state' };
  if (!ownsPid) return { action: 'start', reason: 'recorded-process-gone' };
  if (!healthy) return { action: 'replace', reason: 'unhealthy' };
  if (state.binary !== binary) return { action: 'handoff', reason: 'binary-changed' };
  if (!sameOpenCodeArgs(state.args, args)) return { action: 'handoff', reason: 'args-changed' };
  if (state.port !== port) return { action: 'handoff', reason: 'port-changed' };
  if (state.fingerprint !== fingerprint) return { action: 'handoff', reason: 'launch-config-changed' };
  return { action: 'adopt', reason: 'matches-state' };
};

// ---- v2 versioned store (issue #82) ----
// One document { schema_version: 2, generations: [...], handoffs: [...] },
// written atomically on every transition. Replaces the v1 state.json +
// draining.json pair for reads/writes once lifecycle.js is wired to it.
export const MANAGED_OPENCODE_STORE_VERSION = 2;
const MANAGED_OPENCODE_STORE_MAX_BYTES = 256 * 1024;

const GENERATION_STATES = ['starting', 'active', 'draining', 'closed'];
const HANDOFF_STEPS = ['prepared', 'switched', 'confirmed', 'aborted'];

export const resolveManagedOpenCodeStorePaths = (dataDir) => {
  const base = resolveManagedOpenCodePaths(dataDir);
  return { ...base, storePath: path.join(base.dir, 'store.json') };
};

export const createEmptyManagedOpenCodeStore = () => ({
  schema_version: MANAGED_OPENCODE_STORE_VERSION,
  generations: [],
  handoffs: [],
});

const isStoreRecord = (value) => value !== null && Object.getPrototypeOf(value) === Object.prototype;

const isValidGeneration = (generation) => isStoreRecord(generation)
  && Number.isInteger(generation.generation_id) && generation.generation_id > 0
  && Number.isInteger(generation.pid) && generation.pid > 0
  && Number.isInteger(generation.port) && generation.port > 0
  && isText(generation.binary) && generation.binary.length > 0
  && (generation.args === undefined || (Array.isArray(generation.args) && generation.args.every(isText)))
  && isText(generation.fingerprint)
  && GENERATION_STATES.includes(generation.state)
  && isText(generation.started_at)
  && (generation.ended_at === null || isText(generation.ended_at));

const isValidHandoff = (handoff) => isStoreRecord(handoff)
  && isText(handoff.handoff_id) && handoff.handoff_id.length > 0
  && Number.isInteger(handoff.predecessor) && handoff.predecessor > 0
  && Number.isInteger(handoff.successor) && handoff.successor > 0
  && Array.isArray(handoff.busy_set) && handoff.busy_set.every(isText)
  && HANDOFF_STEPS.includes(handoff.step)
  && (handoff.outcome === null || isText(handoff.outcome))
  && isText(handoff.at);

export const readManagedOpenCodeStore = (storePath) => {
  const parsed = readBoundedJsonFileSync(storePath, MANAGED_OPENCODE_STORE_MAX_BYTES);
  if (parsed?.schema_version !== MANAGED_OPENCODE_STORE_VERSION) return null;
  if (!Array.isArray(parsed.generations) || !Array.isArray(parsed.handoffs)) return null;
  if (!parsed.generations.every(isValidGeneration) || !parsed.handoffs.every(isValidHandoff)) return null;
  return parsed;
};

export const writeManagedOpenCodeStore = (storePath, store) => {
  mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${storePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify({ ...store, schema_version: MANAGED_OPENCODE_STORE_VERSION }, null, 2)}\n`, { mode: 0o600 });
  renameSyncWithRetry((from, to) => renameSync(from, to), tmpPath, storePath);
};

// Generations are append-only: history is never rewritten, only advanced.
export const appendGeneration = (store, generation) => {
  const ids = store.generations.map((entry) => entry.generation_id);
  const record = {
    args: [],
    ended_at: null,
    ...generation,
    generation_id: ids.length === 0 ? 1 : Math.max(...ids) + 1,
  };
  if (!isValidGeneration(record)) throw new Error('invalid generation record');
  return { ...store, generations: [...store.generations, record] };
};

const GENERATION_TRANSITIONS = {
  starting: ['active', 'closed'],
  active: ['draining', 'closed'],
  draining: ['closed'],
  closed: [],
};

export const transitionGenerationState = (store, generationId, toState, endedAt = null) => {
  const index = store.generations.findIndex((entry) => entry.generation_id === generationId);
  if (index === -1) throw new Error(`unknown generation ${generationId}`);
  const current = store.generations[index];
  if (!GENERATION_TRANSITIONS[current.state].includes(toState)) {
    throw new Error(`invalid generation transition ${current.state} -> ${toState}`);
  }
  const updated = {
    ...current,
    state: toState,
    ended_at: toState === 'closed' ? (endedAt ?? new Date().toISOString()) : current.ended_at,
  };
  const generations = [...store.generations];
  generations[index] = updated;
  return { ...store, generations };
};

// Write-ahead: the record for a step is persisted BEFORE that step is
// attempted, so a crash between any two steps has a defined resume path.
// `at` and fresh handoff ids are injectable for deterministic replay tests.
export const recordHandoffStep = (store, {
  handoff_id,
  predecessor,
  successor,
  busy_set = [],
  step,
  outcome = null,
  at = new Date().toISOString(),
}) => {
  const record = { handoff_id, predecessor, successor, busy_set, step, outcome, at };
  if (!isValidHandoff(record)) throw new Error('invalid handoff record');
  const index = store.handoffs.findIndex((entry) => entry.handoff_id === handoff_id);
  const handoffs = index === -1
    ? [...store.handoffs, record]
    : store.handoffs.map((entry, entryIndex) => (entryIndex === index ? record : entry));
  return { ...store, handoffs };
};

// Recovery: given the last persisted step of a handoff, decide whether the
// restarted server resumes the handoff or settles it as aborted.
export const replayHandoffStep = (handoff) => {
  switch (handoff?.step) {
    case 'prepared': return { action: 'resume', reason: 'successor-never-started' };
    case 'switched': return { action: 'resume', reason: 'successor-readiness-unconfirmed' };
    case 'confirmed': return { action: 'resume', reason: 'predecessor-drain-unconfirmed' };
    case 'aborted': return { action: 'settle', reason: 'already-aborted' };
    default: return { action: 'abort', reason: 'unknown-step' };
  }
};

// v1 -> v2 migration: every v1 generation is imported with its state
// preserved (current state.json becomes active, draining.json entries become
// draining). The v1 files are left untouched in place — they stay read-only
// for one release once lifecycle.js stops writing them. The oracle is "no
// lost generations": count and pids before/after must match exactly.
export const migrateV1StoreToV2 = ({ statePath, drainingPath, now = () => new Date().toISOString() }) => {
  const current = readManagedOpenCodeState(statePath);
  const draining = readDrainingOpenCodeRecords(drainingPath);
  let next = createEmptyManagedOpenCodeStore();
  if (current) {
    next = appendGeneration(next, {
      pid: current.pid,
      port: current.port,
      binary: current.binary,
      args: current.args ?? [],
      fingerprint: current.fingerprint,
      state: 'active',
      started_at: current.startedAt ?? now(),
    });
  }
  for (const record of draining) {
    next = appendGeneration(next, {
      pid: record.pid,
      port: record.port,
      binary: record.binary,
      args: [],
      fingerprint: '',
      state: 'draining',
      started_at: now(),
    });
  }
  return next;
};

export const defaultManagedOpenCodePidLiveness = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

// Store-only reaper: a recorded pid that is gone closes its generation with
// the outcome recorded. Ownership is never inferred from `ps` output —
// liveness is signal-0 (or the managed-process registry's answer, injected
// as `isPidAlive`), and a dead pid is a closed generation, never a guess.
export const reapManagedOpenCodeStore = (store, { isPidAlive = defaultManagedOpenCodePidLiveness, now = () => new Date().toISOString() } = {}) => {
  let next = store;
  const reaped = [];
  for (const generation of store.generations) {
    if (generation.state === 'closed' || isPidAlive(generation.pid)) continue;
    next = transitionGenerationState(next, generation.generation_id, 'closed', now());
    reaped.push({ generation_id: generation.generation_id, pid: generation.pid, outcome: 'pid-gone' });
  }
  return { store: next, reaped };
};

// Length of a trailing incomplete UTF-8 sequence in buffer[0, length), i.e. a
// valid lead byte followed by fewer continuation bytes than it declares.
// Invalid bytes (lone continuations, overlong leads 0xC0/0xC1, never-valid
// leads 0xF5-0xFF) are not a prefix of any sequence and return 0 — they decode
// to U+FFFD exactly as before. Holding one back would never complete: no later
// byte can turn it into a character, so the cursor would stall on it forever.
const incompleteUtf8TailLength = (buffer, length) => {
  for (let i = length - 1, scanned = 0; i >= 0 && scanned < 4; i--, scanned++) {
    const byte = buffer[i];
    if ((byte & 0xc0) === 0x80) continue;
    if (byte < 0x80) return 0;
    // Valid lead ranges only: 0xC2-0xDF, 0xE0-0xEF, 0xF0-0xF4.
    const needed = byte >= 0xf0 ? (byte <= 0xf4 ? 4 : 0) : byte >= 0xe0 ? 3 : byte >= 0xc2 ? 2 : 0;
    if (needed === 0) return 0;
    const have = length - i;
    return have < needed ? have : 0;
  }
  return 0;
};

// The managed child writes stdout and stderr to this file, not a pipe, so it outlives OpenChamber.
// One drain never buffers the whole growth: a single call consumes at most
// this many bytes, and later polls reach the rest through the returned
// offset. The chunks keep a small file from pinning a cap-sized buffer.
export const MANAGED_OPENCODE_LOG_READ_MAX_BYTES = 1024 * 1024;
const LOG_READ_CHUNK_BYTES = 64 * 1024;

export const readLogSince = (logPath, offset) => {
  let fd = null;
  try {
    // O_NONBLOCK (POSIX only) keeps the open itself from blocking on a FIFO
    // with no writer, and the opened handle is judged regular before any
    // read — the bounded-file-read pattern. A non-regular path (a FIFO, a
    // device) is no output, never a hang: this runs synchronously on the
    // readiness drain, so a blocking open would freeze the whole server.
    fd = openSync(logPath, process.platform === 'win32' ? 'r' : fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { text: '', offset };
    const length = Math.min(stat.size - offset, MANAGED_OPENCODE_LOG_READ_MAX_BYTES);
    if (length <= 0) return { text: '', offset };
    const chunks = [];
    let total = 0;
    while (total < length) {
      const chunk = Buffer.alloc(Math.min(LOG_READ_CHUNK_BYTES, length - total));
      const bytesRead = readSync(fd, chunk, 0, chunk.length, offset + total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    const buffer = Buffer.concat(chunks, total);
    const bytesRead = total;
    // Hold back a trailing incomplete UTF-8 sequence: the returned offset
    // stops before it, so the next poll re-reads those bytes together with
    // their continuation instead of corrupting the character to U+FFFD and
    // advancing past it for good.
    const consumed = bytesRead - incompleteUtf8TailLength(buffer, bytesRead);
    return { text: buffer.toString('utf8', 0, consumed), offset: offset + consumed };
  } catch {
    return { text: '', offset };
  } finally {
    if (fd !== null) closeSync(fd);
  }
};

const MANAGED_OPENCODE_LOG_MAX_BYTES = 5 * 1024 * 1024;

// Bounds the managed log at spawn time: an oversized log is renamed to a single
// retained generation (`<log>.1`, replaced on each rotation) so the total kept is
// roughly twice the cap. Spawn is the only safe trigger — it runs before the new
// child's fd opens, so the spawn's logOffset is taken from the fresh file and the
// readiness drain (readLogSince) never sees an offset past the end of a shrunken
// file, and an in-flight readiness drain follows its child into the `.1`
// generation when it notices the rotation. A still-running adopted or other-server OpenCode may hold the old fd: on
// POSIX it keeps writing to the renamed file (bounded, and its output stops
// appearing in this log), and on Windows renaming an open file fails — so every
// failure here is a no-op and rotation simply retries at the next spawn. Rotation
// must never block a spawn.
export const rotateManagedLogIfOversized = (logPath, maxBytes = MANAGED_OPENCODE_LOG_MAX_BYTES) => {
  try {
    if (statSync(logPath).size <= maxBytes) return false;
    renameSync(logPath, `${logPath}.1`);
    return true;
  } catch {
    return false;
  }
};

export const readLogTail = (logPath, offset, maxBytes) => {
  let size = 0;
  try {
    size = statSync(logPath).size;
  } catch {
    return '';
  }
  let start = Math.max(offset, size - maxBytes);
  if (start > 0) {
    // Align the tail start to a UTF-8 boundary (#2033): the
    // size - maxBytes jump can land inside a multi-byte character,
    // whose continuation bytes would decode to U+FFFD at the head of
    // the diagnostic tail. Peek at the bytes at the start and advance
    // past leading continuation bytes (at most 3 — a valid sequence
    // has no more), so the tail loses at most the one straddling
    // character. This only chooses readLogTail's own start;
    // readLogSince's offset and trailing-hold-back contract for its
    // streaming callers is untouched. A peek failure falls through to
    // the unaligned start: readLogSince answers '' for an
    // unreadable or non-regular file anyway.
    try {
      const fd = openSync(logPath, process.platform === 'win32' ? 'r' : fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      try {
        const peek = Buffer.alloc(3);
        const read = readSync(fd, peek, 0, peek.length, start);
        let skipped = 0;
        while (skipped < read && (peek[skipped] & 0xc0) === 0x80) skipped++;
        start += skipped;
      } finally {
        closeSync(fd);
      }
    } catch {
      // fall through with the unaligned start
    }
  }
  return readLogSince(logPath, start).text;
};
