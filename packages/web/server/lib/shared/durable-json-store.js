// One durable-store contract for the web server's JSON state files
// (design #976, phase 1 — #977). Sixteen server modules used to hand-write
// this machinery around atomic-rename.js, with three divergent spellings
// of the preservation name (one of them collision-prone), strict readers
// private to each module, and write modes stated in some stores and
// silently omitted in others. This module is the shared spelling:
//
// 1. A strict reader answers missing | valid | malformed — never a
//    lenient "malformed reads as empty". The caller supplies the value
//    judgement (isJsonObject for an object-shaped store); a parsed value
//    the caller rejects is malformed, the routing stores' rule.
// 2. A malformed file is preserved aside before it is replaced, under
//    the collision-proof name the later per-store fixes converged on.
//    The preserve step re-reads and re-judges the on-disk bytes first,
//    re-judges them again after the preserve-name check, and verifies
//    the preserved bytes after the rename — a valid replacement that
//    lands in any of those windows is restored to the live path
//    atomically (hard link, never an overwriting rename), so a valid
//    replacement written concurrently is never renamed away.
//    The result distinguishes preserved from preservation-failed, and
//    the contract is fail-closed: a caller whose preservation failed
//    must refuse the write. Raw parse errors are never attached to a
//    result or logged — they can quote the file, and these files hold
//    credentials and user data.
// 3. Writes are atomic and permission-explicit: a unique temp file in
//    the same directory, written with a caller-stated mode, renamed over
//    the destination through atomic-rename.js.
//
// Each piece ships in async and sync spellings (the atomic-rename.js
// precedent) and takes the caller's fs surface by injection, so a store
// that receives fsPromises today keeps its test seam. The module knows
// paths, bytes, JSON and modes only; shapes, defaults and domain errors
// stay with the callers. Divergent policies (relay/key-store.js
// throw-and-stop, agent-memory/runtime.js malformed-is-failure,
// walkthrough/store.js corrupt-is-a-miss) are not this contract and stay
// local — see DOCUMENTATION.md.

import fsSync from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

import { renameSyncWithRetry, renameWithRetry } from './atomic-rename.js';

const PRESERVE_ATTEMPTS = 10;

/**
 * Default byte cap for every read in this module (#1649).
 *
 * Derived from the write-side inventory of the fifteen caller stores,
 * not copied from an unrelated reader: the credential and config
 * stores (pairing, remote-clients, voice-keys, passkeys, push/APNs
 * tokens, route settings/overrides, tunnels, magic-prompts) are
 * KiB-scale by construction; the message-queue snapshot is bounded by
 * its 50-session x 20-item retention; the archive store prunes by
 * count and age. The one store with no write-side bound is the
 * session-metadata index, which grows by one small record per session
 * (thousands of sessions are still single-digit MiB) — it is named
 * here as the unbounded caller, and this cap sits at generous headroom
 * over that plausible maximum. A caller that legitimately outgrows
 * the default passes `options.maxBytes` at its call sites.
 */
export const DEFAULT_DURABLE_JSON_MAX_BYTES = 32 * 1024 * 1024;

const READ_CHUNK_BYTES = 64 * 1024;

const resolveMaxBytes = (options) => {
  const maxBytes = options.maxBytes ?? DEFAULT_DURABLE_JSON_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative integer, got ${maxBytes}`);
  }
  return maxBytes;
};

const tooLargeError = (filePath, size, maxBytes) =>
  Object.assign(new Error(`durable JSON store file is too large: ${filePath} exceeds the ${maxBytes}-byte limit`), {
    code: 'DURABLE_JSON_STORE_TOO_LARGE',
    path: filePath,
    size,
    limit: maxBytes,
  });

const notRegularError = (filePath, stat) => {
  // A directory at the store path historically failed the plain read
  // with EISDIR, and callers match on that code — keep that answer for
  // directories; other non-regular files (FIFO, device, socket) get
  // the module's own coded refusal.
  if (stat && typeof stat.isDirectory === 'function' && stat.isDirectory()) {
    return Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${filePath}'`), {
      code: 'EISDIR',
      path: filePath,
    });
  }
  return Object.assign(new Error(`durable JSON store file is not a regular file: ${filePath}`), {
    code: 'DURABLE_JSON_STORE_NOT_REGULAR',
    path: filePath,
  });
};

const openFlags = () =>
  process.platform === 'win32' ? 'r' : fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK;

// Bounded, regular-file-checked read (#1649): open once and judge from
// the handle (O_NONBLOCK so a FIFO with no writer cannot wedge the
// open), enforce the cap in flight (at most maxBytes + 1 bytes are
// read). When the caller's injected fs surface has no handle API (the
// unit-test seam), fall back to its readFile and enforce the cap on
// the bytes returned — the seam is preserved, never silently dropped.
// Over-cap and non-regular refusals are thrown errors with codes, so
// they land in the readers' existing throw branch and in preserve's
// 'failed' outcome — never in 'malformed'.
const readBoundedRaw = async (filePath, options) => {
  const fs = options.fs ?? fsPromises;
  const maxBytes = resolveMaxBytes(options);
  // An injected surface that intercepts readFile (a spread of the real
  // promises fs with a wrapped readFile is how callers' tests simulate
  // read failures and races) intends reads to go through that
  // interception — respect it and enforce the cap on what it returns.
  if (typeof fs.open !== 'function' || (options.fs && fs.readFile !== fsPromises.readFile)) {
    const raw = await fs.readFile(filePath, 'utf8');
    const size = Buffer.byteLength(String(raw), 'utf8');
    if (size > maxBytes) throw tooLargeError(filePath, size, maxBytes);
    return raw;
  }
  const handle = await fs.open(filePath, openFlags());
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw notRegularError(filePath, stat);
    if (stat.size > maxBytes) throw tooLargeError(filePath, stat.size, maxBytes);
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) throw tooLargeError(filePath, total, maxBytes);
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    await handle.close();
  }
};

const readBoundedRawSync = (filePath, options) => {
  const fs = options.fs ?? fsSync;
  const maxBytes = resolveMaxBytes(options);
  if (
    typeof fs.openSync !== 'function' ||
    typeof fs.fstatSync !== 'function' ||
    (options.fs && fs.readFileSync !== fsSync.readFileSync)
  ) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const size = Buffer.byteLength(String(raw), 'utf8');
    if (size > maxBytes) throw tooLargeError(filePath, size, maxBytes);
    return raw;
  }
  const fd = fs.openSync(filePath, openFlags());
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw notRegularError(filePath, stat);
    if (stat.size > maxBytes) throw tooLargeError(filePath, stat.size, maxBytes);
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total));
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) throw tooLargeError(filePath, total, maxBytes);
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
};

/**
 * The object judgement for an object-shaped store: a parsed JSON value
 * that is an object (not null, not an array). Pass it as `validateValue`
 * to the reader or the preserve helper; stores with another shape pass
 * their own predicate.
 */
export const isJsonObject = (value) =>
  value !== null && !Array.isArray(value) && Object.prototype.toString.call(value) === '[object Object]';

const judgeRaw = (raw, validateValue) => {
  const text = String(raw);
  if (text.trim() === '') return { state: 'missing' };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { state: 'malformed', raw: text };
  }
  if (validateValue && !validateValue(value)) return { state: 'malformed', raw: text };
  return { state: 'valid', value, raw: text };
};

const isMissingError = (error) => Boolean(error) && error.code === 'ENOENT';

// The preserve step's judging is fail-closed (CodeRabbit review, PR
// #981): a caller-supplied validateValue that throws is a check
// failure, and the documented answer for any failure to read, check,
// or rename is the 'failed' outcome — never a thrown error that a
// caller could mistake for a reason to write anyway. null = failed.
const judgeForPreserve = (raw, validateValue) => {
  try {
    return judgeRaw(raw, validateValue);
  } catch {
    return null;
  }
};

/**
 * Async strict read. Answers `{ state: 'missing' }` for an absent or
 * empty file (the first-run case), `{ state: 'valid', value, raw }`, or
 * `{ state: 'malformed', raw }`. A read failure other than absence
 * throws: a caller that cannot see the current contents must not
 * replace them. Reads are bounded (#1649): a file over
 * `options.maxBytes` (default DEFAULT_DURABLE_JSON_MAX_BYTES) or not a
 * regular file throws a coded refusal, never a 'malformed' answer.
 */
export const readDurableJsonFile = async (filePath, options = {}) => {
  let raw;
  try {
    raw = await readBoundedRaw(filePath, options);
  } catch (error) {
    if (isMissingError(error)) return { state: 'missing' };
    throw error;
  }
  return judgeRaw(raw, options.validateValue);
};

/** Sync spelling of readDurableJsonFile; the answers are identical. */
export const readDurableJsonFileSync = (filePath, options = {}) => {
  let raw;
  try {
    raw = readBoundedRawSync(filePath, options);
  } catch (error) {
    if (isMissingError(error)) return { state: 'missing' };
    throw error;
  }
  return judgeRaw(raw, options.validateValue);
};

const preservedCandidate = (filePath) =>
  `${filePath}.corrupt-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Async preserve-aside. Re-reads the file and re-judges the bytes that
 * are on disk now: a valid replacement is left in place
 * (`{ preserved: false, outcome: 'replaced' }`), an absent or empty
 * file needs nothing (`outcome: 'missing'`), and a still-malformed file
 * is renamed to a collision-proof sibling (`{ preserved: true,
 * outcome: 'preserved', preservedPath }`). The bytes are re-judged
 * after the preserve-name check and the preserved bytes are verified
 * after the rename; a valid replacement caught in either window is
 * restored to the live path and answers 'replaced'. Any failure to
 * read, check, or rename answers `{ preserved: false,
 * outcome: 'failed' }` — the fail-closed answer, on which the caller
 * must refuse its write.
 */
export const preserveMalformedJsonFile = async (filePath, options = {}) => {
  const fs = options.fs ?? fsPromises;
  let raw;
  try {
    raw = await readBoundedRaw(filePath, options);
  } catch (error) {
    if (isMissingError(error)) return { preserved: false, outcome: 'missing' };
    return { preserved: false, outcome: 'failed' };
  }
  const judged = judgeForPreserve(raw, options.validateValue);
  if (!judged) return { preserved: false, outcome: 'failed' };
  if (judged.state === 'valid') return { preserved: false, outcome: 'replaced' };
  if (judged.state === 'missing') return { preserved: false, outcome: 'missing' };
  for (let attempt = 0; attempt < PRESERVE_ATTEMPTS; attempt += 1) {
    const candidate = preservedCandidate(filePath);
    if (fs.access) {
      let taken = true;
      try {
        await fs.access(candidate);
      } catch (error) {
        if (isMissingError(error)) taken = false;
        else return { preserved: false, outcome: 'failed' };
      }
      if (taken) continue;
    }
    // Re-read and re-judge AFTER the preserve-name check, immediately
    // before the rename (Codex review, PR #981): a valid replacement
    // installed during the awaited access check above must be seen
    // here, not moved to the preserve name by the rename below.
    let rawNow;
    try {
      rawNow = await readBoundedRaw(filePath, options);
    } catch (error) {
      if (isMissingError(error)) return { preserved: false, outcome: 'missing' };
      return { preserved: false, outcome: 'failed' };
    }
    const judgedNow = judgeForPreserve(rawNow, options.validateValue);
    if (!judgedNow) return { preserved: false, outcome: 'failed' };
    if (judgedNow.state === 'valid') return { preserved: false, outcome: 'replaced' };
    if (judgedNow.state === 'missing') return { preserved: false, outcome: 'missing' };
    try {
      await renameWithRetry((from, to) => fs.rename(from, to), filePath, candidate);
    } catch {
      return { preserved: false, outcome: 'failed' };
    }
    // Verify what the rename actually moved. A replacement can still
    // land between the re-read above and the rename; if the preserved
    // bytes judge valid, they were never ours to move: restore them
    // to the live path with a hard link (atomic, and it fails rather
    // than overwriting if a newer file has since taken the path) and
    // answer 'replaced'. If a valid file cannot be verified or safely
    // restored, answer 'failed' — fail-closed, with the bytes still
    // intact under the preserve name.
    let movedRaw;
    try {
      movedRaw = await readBoundedRaw(candidate, options);
    } catch {
      return { preserved: false, outcome: 'failed' };
    }
    const judgedMoved = judgeForPreserve(movedRaw, options.validateValue);
    if (!judgedMoved) return { preserved: false, outcome: 'failed' };
    if (judgedMoved.state !== 'valid') {
      return { preserved: true, outcome: 'preserved', preservedPath: candidate };
    }
    // Restoration requires an atomic no-clobber operation (Codex
    // review, PR #981, second round): without fs.link there is no way
    // to put the valid bytes back without risking an overwriting
    // rename over a newer concurrent file, so fail closed - the
    // valid bytes stay intact under the preserve name.
    if (!fs.link) return { preserved: false, outcome: 'failed' };
    try {
      await fs.link(candidate, filePath);
    } catch {
      return { preserved: false, outcome: 'failed' };
    }
    try {
      if (fs.unlink) await fs.unlink(candidate);
      else if (fs.rm) await fs.rm(candidate, { force: true });
    } catch {
      // The valid bytes are live again; a leftover preserve copy of
      // them must not turn this answer into a failure.
    }
    return { preserved: false, outcome: 'replaced' };
  }
  return { preserved: false, outcome: 'failed' };
};

/** Sync spelling of preserveMalformedJsonFile; the answers are identical. */
export const preserveMalformedJsonFileSync = (filePath, options = {}) => {
  const fs = options.fs ?? fsSync;
  let raw;
  try {
    raw = readBoundedRawSync(filePath, options);
  } catch (error) {
    if (isMissingError(error)) return { preserved: false, outcome: 'missing' };
    return { preserved: false, outcome: 'failed' };
  }
  const judged = judgeForPreserve(raw, options.validateValue);
  if (!judged) return { preserved: false, outcome: 'failed' };
  if (judged.state === 'valid') return { preserved: false, outcome: 'replaced' };
  if (judged.state === 'missing') return { preserved: false, outcome: 'missing' };
  for (let attempt = 0; attempt < PRESERVE_ATTEMPTS; attempt += 1) {
    const candidate = preservedCandidate(filePath);
    if (fs.existsSync && fs.existsSync(candidate)) continue;
    // Sync mirror of the async re-read/re-judge and the post-rename
    // verification above; the answers are identical.
    let rawNow;
    try {
      rawNow = readBoundedRawSync(filePath, options);
    } catch (error) {
      if (isMissingError(error)) return { preserved: false, outcome: 'missing' };
      return { preserved: false, outcome: 'failed' };
    }
    const judgedNow = judgeForPreserve(rawNow, options.validateValue);
    if (!judgedNow) return { preserved: false, outcome: 'failed' };
    if (judgedNow.state === 'valid') return { preserved: false, outcome: 'replaced' };
    if (judgedNow.state === 'missing') return { preserved: false, outcome: 'missing' };
    try {
      renameSyncWithRetry((from, to) => fs.renameSync(from, to), filePath, candidate);
    } catch {
      return { preserved: false, outcome: 'failed' };
    }
    let movedRaw;
    try {
      movedRaw = readBoundedRawSync(candidate, options);
    } catch {
      return { preserved: false, outcome: 'failed' };
    }
    const judgedMoved = judgeForPreserve(movedRaw, options.validateValue);
    if (!judgedMoved) return { preserved: false, outcome: 'failed' };
    if (judgedMoved.state !== 'valid') {
      return { preserved: true, outcome: 'preserved', preservedPath: candidate };
    }
    // Sync mirror: no linkSync, no restoration - fail closed.
    if (!fs.linkSync) return { preserved: false, outcome: 'failed' };
    try {
      fs.linkSync(candidate, filePath);
    } catch {
      return { preserved: false, outcome: 'failed' };
    }
    try {
      if (fs.unlinkSync) fs.unlinkSync(candidate);
      else if (fs.rmSync) fs.rmSync(candidate, { force: true });
    } catch {
      // As in the async spelling: the valid bytes are live again.
    }
    return { preserved: false, outcome: 'replaced' };
  }
  return { preserved: false, outcome: 'failed' };
};

const requireStatedMode = (mode, caller) => {
  if (!Number.isInteger(mode)) {
    throw new TypeError(
      `${caller}: a stated integer mode is required (for example 0o600 for a secret-bearing store); ` +
        'the write mode is part of the contract, never an accident of the call site',
    );
  }
};

const tempCandidate = (filePath) =>
  `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Async mode-explicit atomic write. `contents` is the serialized file
 * the caller wants on disk (serialization and formatting stay with the
 * caller); `options.mode` is required and is the mode the written file
 * carries. The temp file is unique per write (pid + time + random, in
 * the same directory) and reaches the destination through
 * renameWithRetry; a failed write removes its temp file before the
 * error surfaces.
 */
export const writeDurableJsonFile = async (filePath, contents, options = {}) => {
  requireStatedMode(options.mode, 'writeDurableJsonFile');
  const fs = options.fs ?? fsPromises;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = tempCandidate(filePath);
  try {
    await fs.writeFile(tempPath, contents, { encoding: 'utf8', mode: options.mode });
    await renameWithRetry((from, to) => fs.rename(from, to), tempPath, filePath);
  } catch (error) {
    try {
      await (fs.rm ? fs.rm(tempPath, { force: true }) : fs.unlink(tempPath));
    } catch {
      // The write error is the one the caller needs; a failed temp
      // cleanup must not mask it.
    }
    throw error;
  }
};

/** Sync spelling of writeDurableJsonFile; the behaviour is identical. */
export const writeDurableJsonFileSync = (filePath, contents, options = {}) => {
  requireStatedMode(options.mode, 'writeDurableJsonFileSync');
  const fs = options.fs ?? fsSync;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = tempCandidate(filePath);
  try {
    fs.writeFileSync(tempPath, contents, { encoding: 'utf8', mode: options.mode });
    renameSyncWithRetry((from, to) => fs.renameSync(from, to), tempPath, filePath);
  } catch (error) {
    try {
      if (fs.rmSync) fs.rmSync(tempPath, { force: true });
      else fs.unlinkSync(tempPath);
    } catch {
      // The write error is the one the caller needs.
    }
    throw error;
  }
};
