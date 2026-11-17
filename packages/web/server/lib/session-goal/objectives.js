// File-backed goal objectives. Session metadata must stay light (it rides
// every session.updated event), so the objective TEXT lives in a file under
// the OpenChamber data dir, keyed by the SESSION ID: sessions are globally
// unique and carry at most one goal at a time, so the mapping is fully
// deterministic — the metadata only carries an `objectiveFile: true` flag,
// never a path, and user-writable metadata cannot become a file-read vector.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';

export const GOAL_OBJECTIVE_CHAR_LIMIT = 5_000;
// The Settings bounds for both limits below; the upper one also caps a goal
// whose limit the user switched off, so one file stays readable.
const MIN_CHAR_LIMIT = 1_000;
export const GOAL_OBJECTIVE_HARD_CAP = 1_000_000;
// The most bytes a bounded objective read may buffer: the hard cap's chars
// at UTF-8's widest (4 bytes a char), plus one char of slack so a read that
// stops at the bound never splits the sequence of the cap's last char.
const GOAL_OBJECTIVE_MAX_READ_BYTES = GOAL_OBJECTIVE_HARD_CAP * 4 + 4;
// How much of the objective the progress check reads. Above the goal limit by
// default, so a goal within its limit reaches the check whole.
const GOAL_CHECK_OBJECTIVE_CHAR_LIMIT = 20_000;
// How many prior objective versions a session keeps (#1830). Every save that
// changes the text appends a version and the oldest beyond this cap is pruned,
// so the history file stays bounded next to the objective it describes.
export const GOAL_OBJECTIVE_VERSION_CAP = 20;
// The most bytes a bounded versions read may buffer (#2295): the version
// cap entries at the objective read bound each, plus per-entry JSON
// framing - the largest history writeVersionList can ever produce.
const GOAL_VERSIONS_MAX_READ_BYTES =
  GOAL_OBJECTIVE_VERSION_CAP * (GOAL_OBJECTIVE_MAX_READ_BYTES + 256);

const asCharLimit = (value, fallback) => (
  Number.isInteger(value) && value >= MIN_CHAR_LIMIT && value <= GOAL_OBJECTIVE_HARD_CAP ? value : fallback
);

/**
 * The objective limits from Settings: `objective` is the most a goal keeps
 * (`sessionGoalObjectiveCharLimit`), `check` is the most of it the progress
 * check reads (`sessionGoalCheckObjectiveCharLimit`).
 */
export const goalObjectiveLimits = (settings) => ({
  objective: asCharLimit(settings?.sessionGoalObjectiveCharLimit, GOAL_OBJECTIVE_CHAR_LIMIT),
  check: asCharLimit(settings?.sessionGoalCheckObjectiveCharLimit, GOAL_CHECK_OBJECTIVE_CHAR_LIMIT),
});

// OpenCode session ids are URL-safe tokens; anything else is rejected before
// touching the filesystem.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

const goalsDir = () => path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'goals',
);

const objectiveFilePath = (sessionId) => path.join(goalsDir(), `${sessionId}.md`);

const isValidObjectiveKey = (sessionId) =>
  typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId);

// The goal's own limit is applied before the text gets here (the UI and
// `createSessionGoal` condense a longer one); the file only refuses runaway
// sizes, so a goal whose limit was raised or switched off is kept whole.
// The cap cut must not split a surrogate pair: a clamped text ending on a
// high surrogate drops that half, because the text is persisted as UTF-8,
// where a lone surrogate would be stored as U+FFFD permanently.
const clampContent = (content) => {
  const clamped = String(content ?? '').trim().slice(0, GOAL_OBJECTIVE_HARD_CAP);
  const last = clamped.charCodeAt(clamped.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? clamped.slice(0, -1) : clamped;
};

/** Write (or overwrite — a new goal replaces the old one) the session's objective. */
export const writeObjective = async (sessionId, content) => {
  if (!isValidObjectiveKey(sessionId)) {
    throw Object.assign(new Error('invalid session id'), { statusCode: 400 });
  }
  const text = clampContent(content);
  if (!text) {
    throw Object.assign(new Error('objective content is required'), { statusCode: 400 });
  }
  await fs.promises.mkdir(goalsDir(), { recursive: true });
  await fs.promises.writeFile(objectiveFilePath(sessionId), text, 'utf8');
  return { content: text };
};

/** Returns the objective text, or null when missing/invalid. */
export const readObjective = async (sessionId) => {
  if (!isValidObjectiveKey(sessionId)) return null;
  let handle;
  try {
    // The objective file lives in the user's data dir, outside the server's
    // control between writes: it can be far larger than the hard cap, or not
    // a regular file at all (#1582). Open non-blocking (POSIX) so a FIFO
    // with no writer cannot wedge the open, judge the handle's stat, and
    // read at most the byte bound the clamped result can ever need - the
    // cap is enforced during the read, in the shared bounded-read shape
    // (lib/shared/bounded-file-read.js), not after a whole-file buffer.
    const flags = process.platform === 'win32' || fs.constants.O_NONBLOCK === undefined
      ? 'r'
      : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;
    handle = await fs.promises.open(objectiveFilePath(sessionId), flags);
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const chunks = [];
    let total = 0;
    while (total <= GOAL_OBJECTIVE_MAX_READ_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, GOAL_OBJECTIVE_MAX_READ_BYTES + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    return clampContent(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

/** Best-effort delete; missing files are fine. */
export const deleteObjective = async (sessionId) => {
  if (!isValidObjectiveKey(sessionId)) return;
  await fs.promises.unlink(objectiveFilePath(sessionId)).catch(() => undefined);
};

// --- Objective version history (#1830) -------------------------------------
// Every save that changes the text appends a version, so a goal can be listed,
// read back, and restored. The history lives beside the objective it
// describes (`<data-dir>/goals/<sessionId>.versions.json`) and is capped at
// GOAL_OBJECTIVE_VERSION_CAP with the oldest pruned first, so it never grows
// without bound. A restore is an ordinary save of an older text, which appends
// the restored text as a new version rather than rewriting the past.

const versionsFilePath = (sessionId) => path.join(goalsDir(), `${sessionId}.versions.json`);

const VERSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const VersionIdSchema = z.string().regex(VERSION_ID_PATTERN);

const isValidVersionId = (versionId) => VersionIdSchema.safeParse(versionId).success;

const createVersionId = () => `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// A stored version is judged by schema, once: a token id, string text, and a
// finite timestamp. Anything else in the file is dropped rather than trusted.
const StoredVersionSchema = z.object({
  id: z.string().regex(VERSION_ID_PATTERN),
  content: z.string(),
  savedAt: z.number().finite(),
});

// A history file is user-reachable on disk, so a malformed one reads as empty
// history rather than failing the save it accompanies, and one corrupt entry
// drops on its own instead of erasing the good versions beside it: losing the
// past must never lose the present objective or its healthy neighbours.
const readVersionList = async (sessionId) => {
  let raw;
  let handle;
  try {
    // The history file lives in the same user-reachable data dir as the
    // objective, so it gets the same bounded read (#2295): open
    // non-blocking (POSIX) so a FIFO with no writer cannot wedge the
    // open, judge the handle stat, and read at most the byte bound a
    // full history can need. A whole-file readFile hangs on a FIFO and
    // buffers an oversized file whole; an over-bound file reads as
    // empty history, like a malformed one.
    const flags = process.platform === 'win32' || fs.constants.O_NONBLOCK === undefined
      ? 'r'
      : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;
    handle = await fs.promises.open(versionsFilePath(sessionId), flags);
    const stat = await handle.stat();
    if (!stat.isFile()) return [];
    const chunks = [];
    let total = 0;
    while (total <= GOAL_VERSIONS_MAX_READ_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, GOAL_VERSIONS_MAX_READ_BYTES + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > GOAL_VERSIONS_MAX_READ_BYTES) return [];
    raw = Buffer.concat(chunks, total).toString('utf8');
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const versions = [];
  for (const entry of parsed) {
    const result = StoredVersionSchema.safeParse(entry);
    if (result.success) versions.push(result.data);
  }
  return versions;
};

const writeVersionList = async (sessionId, versions) => {
  await fs.promises.mkdir(goalsDir(), { recursive: true });
  await fs.promises.writeFile(versionsFilePath(sessionId), JSON.stringify(versions), 'utf8');
};

/**
 * Appends `content` as a new version of the session's objective and prunes the
 * oldest beyond the cap. A save whose text equals the newest version records
 * nothing new — an unchanged rewrite is not a version. Returns the recorded
 * version id (null when nothing was recorded) and the retained versions,
 * newest first.
 */
export const appendObjectiveVersion = async (sessionId, content, now = Date.now()) => {
  if (!isValidObjectiveKey(sessionId)) {
    throw Object.assign(new Error('invalid session id'), { statusCode: 400 });
  }
  const text = clampContent(content);
  if (!text) {
    throw Object.assign(new Error('objective content is required'), { statusCode: 400 });
  }
  const versions = await readVersionList(sessionId);
  if (versions[0]?.content === text) return { versions, versionId: null };
  const version = { id: createVersionId(), content: text, savedAt: now };
  const next = [version, ...versions].slice(0, GOAL_OBJECTIVE_VERSION_CAP);
  await writeVersionList(sessionId, next);
  return { versions: next, versionId: version.id };
};

/** The retained versions, newest first; empty when the session has none. */
export const listObjectiveVersions = async (sessionId) => {
  if (!isValidObjectiveKey(sessionId)) return [];
  return readVersionList(sessionId);
};

/** One retained version by id, or null when missing. */
export const readObjectiveVersion = async (sessionId, versionId) => {
  if (!isValidObjectiveKey(sessionId) || !isValidVersionId(versionId)) return null;
  const versions = await readVersionList(sessionId);
  return versions.find((version) => version.id === versionId) ?? null;
};

/**
 * Drops one version by id; a missing id is a no-op. Used to undo a version
 * recorded for a write that was then rolled back — the goal never held it, so
 * it must not appear as a prior version.
 */
export const deleteObjectiveVersion = async (sessionId, versionId) => {
  if (!isValidObjectiveKey(sessionId) || !isValidVersionId(versionId)) return;
  const versions = await readVersionList(sessionId);
  const next = versions.filter((version) => version.id !== versionId);
  if (next.length !== versions.length) await writeVersionList(sessionId, next);
};

/** Best-effort delete of the history alongside the objective it describes. */
export const deleteObjectiveVersions = async (sessionId) => {
  if (!isValidObjectiveKey(sessionId)) return;
  await fs.promises.unlink(versionsFilePath(sessionId)).catch(() => undefined);
};
