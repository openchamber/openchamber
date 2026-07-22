import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_BLOB_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_CACHE_COUNT = 20;
const MAX_CACHE_BYTES = 80 * 1024 * 1024;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_REVIEW_BYTES = 4 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const FILE_KINDS = new Set(['add', 'modify', 'delete', 'rename', 'mode']);
const ENTRY_TYPES = new Set(['file', 'symlink', 'directory']);

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function fail(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}

function nonEmpty(value, name) {
  if (typeof value !== 'string' || !value) fail(`Workspace export artifact ${name} is required`);
  return value;
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value)) {
    fail('Workspace export contains an unsafe path');
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '..' || normalized.startsWith('../')) fail('Workspace export contains an unsafe path');
  return value;
}

function safeSymlinkTarget(filePath, target) {
  if (typeof target !== 'string' || !target || target.includes('\0') || target.includes('\\') || path.posix.isAbsolute(target)) {
    fail('Workspace export contains an unsafe symlink target');
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(filePath), target));
  if (resolved === '..' || resolved.startsWith('../')) fail('Workspace export contains an escaping symlink target');
}

function parseEntry(value, label) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !ENTRY_TYPES.has(value.type)) fail(`Workspace export ${label} entry is invalid`);
  safeRelativePath(value.path);
  if (!Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o7777) fail(`Workspace export ${label} mode is invalid`);
  if (value.type === 'file') {
    if (!HASH.test(value.hash) || !Number.isInteger(value.size) || value.size < 0 || value.size > MAX_BLOB_BYTES || typeof value.binary !== 'boolean') {
      fail(`Workspace export ${label} file metadata is invalid`);
    }
  } else if (value.type === 'symlink') {
    if (!HASH.test(value.hash) || typeof value.target !== 'string') fail(`Workspace export ${label} symlink metadata is invalid`);
    safeSymlinkTarget(value.path, value.target);
    if (sha256(Buffer.from(value.target)) !== value.hash) fail(`Workspace export ${label} symlink hash is inconsistent`);
  }
  return value;
}

function artifactHash(artifact) {
  const unsigned = { ...artifact };
  delete unsigned.integrityHash;
  return sha256(JSON.stringify(unsigned));
}

function blobText(blob) {
  if (!blob) return undefined;
  const content = Buffer.from(blob.contentBase64, 'base64');
  if (content.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
}

function textLines(content) {
  if (content.length === 0) return [];
  return content.toString('utf8').split('\n');
}

function applyTextHunks(baseline, hunks) {
  const lines = textLines(baseline);
  for (const hunk of [...hunks].sort((a, b) => b.oldStart - a.oldStart)) {
    const index = hunk.oldStart - 1;
    if (JSON.stringify(lines.slice(index, index + hunk.oldCount)) !== JSON.stringify(hunk.removed)) fail('Workspace text hunk does not match its artifact baseline', 409);
    lines.splice(index, hunk.oldCount, ...hunk.added);
  }
  return Buffer.from(lines.join('\n'));
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function parseWorkspaceArtifact(raw, expected, now = Date.now()) {
  const serialized = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (!serialized || Buffer.byteLength(serialized) > MAX_ARTIFACT_BYTES) fail('Workspace export artifact is empty or oversized');
  let artifact;
  try {
    artifact = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw);
  } catch {
    fail('Workspace export artifact is malformed');
  }
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact) || artifact.version !== 1) fail('Workspace export artifact version 1 is required');
  for (const key of ['id', 'controlPlaneWorkspaceID', 'providerResourceID', 'projectID', 'provider', 'baselineGeneration', 'targetDirectory', 'createdAt', 'expiresAt', 'integrityHash']) nonEmpty(artifact[key], key);
  if (!Array.isArray(artifact.files) || !Array.isArray(artifact.blobs) || artifact.files.length === 0) fail('Workspace export contains no file changes', 422);
  if (artifact.files.length > MAX_FILES) fail('Workspace export contains too many files');
  const createdAt = Date.parse(artifact.createdAt);
  const expiresAt = Date.parse(artifact.expiresAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt) fail('Workspace export artifact expiration is invalid');
  if (expiresAt <= now) fail('Workspace export artifact has expired', 410);
  if (!HASH.test(artifact.integrityHash) || artifactHash(artifact) !== artifact.integrityHash) fail('Workspace export artifact integrity check failed');
  for (const [key, value] of Object.entries(expected)) {
    if (artifact[key] !== value) fail(`Workspace export artifact ${key} does not match the authoritative workspace`, 409);
  }

  let totalBytes = 0;
  const blobs = new Map();
  for (const blob of artifact.blobs) {
    if (!blob || typeof blob !== 'object' || !HASH.test(blob.hash) || !Number.isInteger(blob.size) || blob.size < 0 || blob.size > MAX_BLOB_BYTES || typeof blob.contentBase64 !== 'string') fail('Workspace export blob is invalid');
    const content = Buffer.from(blob.contentBase64, 'base64');
    if (content.toString('base64') !== blob.contentBase64 || content.length !== blob.size || sha256(content) !== blob.hash || blobs.has(blob.hash)) fail('Workspace export blob integrity check failed');
    totalBytes += content.length;
    if (totalBytes > MAX_TOTAL_BYTES) fail('Workspace export exceeds the total content limit');
    blobs.set(blob.hash, { ...blob, content });
  }

  const ids = new Set();
  const logicalPaths = [];
  for (const file of artifact.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file) || !nonEmpty(file.id, 'file id') || ids.has(file.id) || !FILE_KINDS.has(file.kind) || typeof file.binary !== 'boolean') fail('Workspace export file operation is invalid');
    ids.add(file.id);
    const oldEntry = parseEntry(file.old, 'baseline');
    const nextEntry = parseEntry(file.next, 'result');
    if (file.oldPath !== undefined && safeRelativePath(file.oldPath) !== oldEntry?.path) fail('Workspace export baseline path is inconsistent');
    if (file.newPath !== undefined && safeRelativePath(file.newPath) !== nextEntry?.path) fail('Workspace export result path is inconsistent');
    if ((file.oldPath ?? null) !== (oldEntry?.path ?? null) || (file.newPath ?? null) !== (nextEntry?.path ?? null)) fail('Workspace export operation paths are invalid');
    if (file.kind === 'add' && (oldEntry || !nextEntry)) fail('Workspace export add operation is invalid');
    if (file.kind === 'delete' && (!oldEntry || nextEntry)) fail('Workspace export delete operation is invalid');
    if (file.kind === 'rename' && (!oldEntry || !nextEntry || oldEntry.path === nextEntry.path)) fail('Workspace export rename operation is invalid');
    if ((file.kind === 'modify' || file.kind === 'mode') && (!oldEntry || !nextEntry || oldEntry.path !== nextEntry.path)) fail('Workspace export modification operation is invalid');
    const operationPaths = [...new Set([oldEntry?.path, nextEntry?.path].filter(Boolean))];
    if (operationPaths.length === 2 && pathsOverlap(operationPaths[0], operationPaths[1])) fail('Workspace export operation paths overlap');
    for (const operationPath of operationPaths) {
      if (logicalPaths.some((existing) => pathsOverlap(existing, operationPath))) fail('Workspace export contains duplicate or overlapping operation paths');
      logicalPaths.push(operationPath);
    }
    if (file.baselineHash !== undefined && file.baselineHash !== oldEntry?.hash) fail('Workspace export baseline hash is inconsistent');
    if (file.resultHash !== undefined && file.resultHash !== nextEntry?.hash) fail('Workspace export result hash is inconsistent');
    if (file.oldMode !== undefined && file.oldMode !== oldEntry?.mode) fail('Workspace export baseline mode is inconsistent');
    if (file.newMode !== undefined && file.newMode !== nextEntry?.mode) fail('Workspace export result mode is inconsistent');
    for (const [entry, blobHash, label] of [[oldEntry, file.baselineBlob, 'baseline'], [nextEntry, file.resultBlob, 'result']]) {
      if (entry?.type === 'file') {
        const blob = blobs.get(blobHash);
        if (!blob || blob.hash !== entry.hash || blob.size !== entry.size) fail(`Workspace export ${label} blob is missing or inconsistent`);
        const blobIsBinary = blobText(blob) === undefined;
        if (entry.binary !== file.binary || entry.binary !== blobIsBinary) fail(`Workspace export ${label} binary metadata is inconsistent`);
      } else if (blobHash !== null && blobHash !== undefined) fail(`Workspace export ${label} blob is invalid`);
    }
    if (!Array.isArray(file.textHunks)) fail('Workspace export text hunks are invalid');
    const hunkIDs = new Set();
    for (const hunk of file.textHunks) {
      if (!hunk || typeof hunk !== 'object' || !nonEmpty(hunk.id, 'hunk id') || hunkIDs.has(hunk.id) || !Number.isInteger(hunk.oldStart) || hunk.oldStart < 1 || !Number.isInteger(hunk.oldCount) || hunk.oldCount < 0 || !Number.isInteger(hunk.newStart) || hunk.newStart < 1 || !Number.isInteger(hunk.newCount) || hunk.newCount < 0 || !HASH.test(hunk.contextHash) || !Array.isArray(hunk.removed) || !Array.isArray(hunk.added) || hunk.removed.length !== hunk.oldCount || hunk.added.length !== hunk.newCount || hunk.removed.some((line) => typeof line !== 'string' || line.includes('\n')) || hunk.added.some((line) => typeof line !== 'string' || line.includes('\n'))) fail('Workspace export text hunk is invalid');
      hunkIDs.add(hunk.id);
    }
    const textEntries = (!oldEntry || oldEntry.type === 'file') && (!nextEntry || nextEntry.type === 'file');
    const wholeOnly = file.binary || file.kind === 'rename' || file.kind === 'mode' || !textEntries || (oldEntry && nextEntry && oldEntry.mode !== nextEntry.mode);
    if (wholeOnly && file.textHunks.length > 0) fail('Workspace export whole-file operation contains text hunks');
    if (file.textHunks.length > 0) {
      const baseline = blobs.get(file.baselineBlob)?.content ?? Buffer.alloc(0);
      const result = blobs.get(file.resultBlob)?.content ?? Buffer.alloc(0);
      const baselineLines = textLines(baseline);
      const resultLines = textLines(result);
      let previousOldEnd = 0;
      let previousNewEnd = 0;
      let hasPrevious = false;
      for (const hunk of file.textHunks) {
        const oldIndex = hunk.oldStart - 1;
        const newIndex = hunk.newStart - 1;
        if (oldIndex > baselineLines.length || oldIndex + hunk.oldCount > baselineLines.length || newIndex > resultLines.length || newIndex + hunk.newCount > resultLines.length) fail('Workspace export text hunk is out of bounds');
        if (oldIndex < previousOldEnd || newIndex < previousNewEnd || (hasPrevious && oldIndex === previousOldEnd && hunk.oldCount === 0) || (hasPrevious && newIndex === previousNewEnd && hunk.newCount === 0)) fail('Workspace export text hunks overlap or are out of order');
        if (JSON.stringify(baselineLines.slice(oldIndex, oldIndex + hunk.oldCount)) !== JSON.stringify(hunk.removed) || JSON.stringify(resultLines.slice(newIndex, newIndex + hunk.newCount)) !== JSON.stringify(hunk.added)) fail('Workspace export text hunk content is inconsistent');
        previousOldEnd = oldIndex + hunk.oldCount;
        previousNewEnd = newIndex + hunk.newCount;
        hasPrevious = true;
      }
      if (!applyTextHunks(baseline, file.textHunks).equals(result)) fail('Workspace export text hunks do not reproduce the result blob');
    }
  }
  return { artifact, blobs, bytes: Buffer.byteLength(serialized), serialized };
}

export function createArtifactReview(parsed) {
  const files = parsed.artifact.files.map((file) => {
    const beforeText = file.old?.type === 'file' && !file.old.binary && file.old.size <= MAX_TEXT_BYTES ? blobText(parsed.blobs.get(file.baselineBlob)) : undefined;
    const afterText = file.next?.type === 'file' && !file.next.binary && file.next.size <= MAX_TEXT_BYTES ? blobText(parsed.blobs.get(file.resultBlob)) : undefined;
    return {
      id: file.id,
      kind: file.kind,
      oldPath: file.oldPath ?? null,
      newPath: file.newPath ?? null,
      binary: Boolean(file.binary),
      entryType: file.next?.type ?? file.old?.type,
      oldMode: file.oldMode ?? null,
      newMode: file.newMode ?? null,
      beforeText,
      afterText,
      textHunks: file.textHunks.map((hunk) => ({ id: hunk.id, oldStart: hunk.oldStart, oldCount: hunk.oldCount, newStart: hunk.newStart, newCount: hunk.newCount, removed: hunk.removed, added: hunk.added })),
    };
  });
  const review = { files, totalFiles: files.length };
  if (Buffer.byteLength(JSON.stringify(review)) > MAX_REVIEW_BYTES) fail('Workspace export review exceeds the server review limit', 413);
  return review;
}

export class WorkspaceArtifactCache {
  constructor({
    rootDirectory = path.join(process.cwd(), '.openchamber', 'workspace-exports'),
    now = () => Date.now(),
    ttlMs = DEFAULT_CACHE_TTL_MS,
    maxCount = MAX_CACHE_COUNT,
    maxBytes = MAX_CACHE_BYTES,
    filesystem = fs.promises,
  } = {}) {
    this.rootDirectory = rootDirectory;
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxCount = maxCount;
    this.maxBytes = maxBytes;
    this.fs = filesystem;
    this.entries = new Map();
    this.totalBytes = 0;
    this.queue = Promise.resolve();
    this.cleanupTimer = null;
    this.initialization = this.initialize();
    this.initialization.catch(() => undefined);
  }

  run(operation) {
    const result = this.queue.then(async () => {
      await this.initialization;
      return operation();
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async initialize() {
    await this.fs.mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    let rootHandle;
    try {
      rootHandle = await this.fs.open(this.rootDirectory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const rootStat = await rootHandle.stat();
      if (!rootStat.isDirectory()) fail('Workspace export storage root is unsafe', 500);
      await rootHandle.chmod(0o700);
    } catch (error) {
      if (error?.statusCode === 500) throw error;
      throw Object.assign(new Error('Workspace export storage root is unsafe'), { statusCode: 500, cause: error });
    } finally {
      await rootHandle?.close();
    }
    for (const entry of await this.fs.readdir(this.rootDirectory, { withFileTypes: true })) {
      const entryPath = path.join(this.rootDirectory, entry.name);
      const entryStat = await this.fs.lstat(entryPath);
      if (!entryStat.isFile() || entryStat.isSymbolicLink() || (!/^[a-f0-9]{64}\.json$/.test(entry.name) && !/^\.tmp-[A-Za-z0-9-]+$/.test(entry.name))) {
        fail('Workspace export storage contains an unsafe stale entry', 500);
      }
      await this.fs.unlink(entryPath);
    }
    await syncDirectoryWith(this.fs, this.rootDirectory);
  }

  artifactPath(id) {
    return path.join(this.rootDirectory, `${sha256(id)}.json`);
  }

  async set(parsed) {
    return this.run(async () => {
      await this.prune();
      if (this.entries.has(parsed.artifact.id)) fail('Workspace export artifact ID is already cached', 409);
      const serialized = Buffer.from(parsed.serialized, 'utf8');
      const temporaryPath = path.join(this.rootDirectory, `.tmp-${crypto.randomUUID()}`);
      const destination = this.artifactPath(parsed.artifact.id);
      let handle;
      let renamed = false;
      let committed = false;
      try {
        handle = await this.fs.open(temporaryPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        await handle.chmod(0o600);
        await handle.writeFile(serialized);
        await handle.sync();
        const stored = await handle.stat();
        if (!stored.isFile() || stored.size !== serialized.length) fail('Workspace export artifact write verification failed', 500);
        if (stored.size > this.maxBytes) fail('Workspace export artifact exceeds the server cache quota', 413);
        await handle.close();
        handle = null;
        await this.fs.rename(temporaryPath, destination);
        renamed = true;
        await syncDirectoryWith(this.fs, this.rootDirectory);
        committed = true;
      } finally {
        await handle?.close().catch(() => undefined);
        if (!committed) await this.fs.unlink(renamed ? destination : temporaryPath).catch(() => undefined);
      }
      const expiresAt = Math.min(Date.parse(parsed.artifact.expiresAt), this.now() + this.ttlMs);
      this.entries.set(parsed.artifact.id, {
        path: destination,
        bytes: serialized.length,
        expiresAt,
      });
      this.totalBytes += serialized.length;
      await this.prune();
      this.scheduleCleanup();
      return { expiresAt: new Date(expiresAt).toISOString() };
    });
  }

  async get(id) {
    return this.run(async () => {
      await this.prune(id);
      const entry = this.entries.get(id);
      if (!entry) return null;
      if (entry.expiresAt <= this.now()) {
        await this.deleteEntry(id, entry);
        return null;
      }
      let handle;
      try {
        handle = await this.fs.open(entry.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const before = await handle.stat();
        if (!before.isFile() || (before.mode & 0o777) !== 0o600 || before.size !== entry.bytes) throw new Error('stored file metadata changed');
        const serialized = await handle.readFile();
        const after = await handle.stat();
        if (!sameEntryIdentity(after, before) || serialized.length !== entry.bytes) throw new Error('stored file changed while reading');
        const parsed = parseWorkspaceArtifact(serialized.toString('utf8'), {}, this.now());
        this.entries.delete(id);
        this.entries.set(id, entry);
        this.scheduleCleanup();
        return { ...parsed, serialized };
      } catch (error) {
        if (error?.statusCode === 410) {
          await this.deleteEntry(id, entry);
          return null;
        }
        throw Object.assign(new Error('Workspace export artifact storage is corrupt or unreadable'), { statusCode: 500, cause: error });
      } finally {
        await handle?.close();
      }
    });
  }

  async delete(id) {
    return this.run(async () => {
      const entry = this.entries.get(id);
      if (!entry) return false;
      await this.deleteEntry(id, entry);
      this.scheduleCleanup();
      return true;
    });
  }

  async deleteEntry(id, entry) {
    let entryStat;
    try {
      entryStat = await this.fs.lstat(entry.path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (entryStat && (!entryStat.isFile() || entryStat.isSymbolicLink())) fail('Workspace export storage entry is unsafe', 500);
    if (entryStat) await this.fs.unlink(entry.path);
    this.entries.delete(id);
    this.totalBytes -= entry.bytes;
    await syncDirectoryWith(this.fs, this.rootDirectory);
  }

  async prune(excludedID) {
    for (const [id, entry] of this.entries) {
      if (id !== excludedID && entry.expiresAt <= this.now()) await this.deleteEntry(id, entry);
    }
    while (this.entries.size > this.maxCount || this.totalBytes > this.maxBytes) {
      const id = this.entries.keys().next().value;
      await this.deleteEntry(id, this.entries.get(id));
    }
  }

  scheduleCleanup() {
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = null;
    let expiresAt = Infinity;
    for (const entry of this.entries.values()) expiresAt = Math.min(expiresAt, entry.expiresAt);
    if (!Number.isFinite(expiresAt)) return;
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = null;
      this.run(async () => {
        await this.prune();
        this.scheduleCleanup();
      }).catch(() => undefined);
    }, Math.max(0, expiresAt - this.now()));
    this.cleanupTimer.unref?.();
  }
}

async function syncDirectoryWith(filesystem, directory) {
  let handle;
  try {
    handle = await filesystem.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function fingerprint(target) {
  let stat;
  try { stat = await fs.promises.lstat(target); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  const mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) {
    const targetValue = await fs.promises.readlink(target);
    const after = await fs.promises.lstat(target);
    if (!sameEntryIdentity(after, stat) || !after.isSymbolicLink()) throw new Error(`Workspace entry changed while fingerprinting: ${target}`);
    return { type: 'symlink', mode, target: targetValue, hash: sha256(Buffer.from(targetValue)) };
  }
  if (stat.isFile()) {
    const handle = await fs.promises.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!sameEntryIdentity(opened, stat) || !opened.isFile()) throw new Error(`Workspace entry changed while fingerprinting: ${target}`);
      const content = await handle.readFile();
      if (!sameEntryIdentity(await handle.stat(), opened)) throw new Error(`Workspace entry changed while fingerprinting: ${target}`);
      return { type: 'file', mode: opened.mode & 0o7777, size: content.length, hash: sha256(content) };
    } finally { await handle.close(); }
  }
  if (stat.isDirectory()) {
    const entries = [];
    for (const name of (await fs.promises.readdir(target)).sort()) entries.push([name, await fingerprint(path.join(target, name))]);
    const after = await fs.promises.lstat(target);
    if (!sameEntryIdentity(after, stat) || !after.isDirectory()) throw new Error(`Workspace entry changed while fingerprinting: ${target}`);
    return { type: 'directory', mode, entries };
  }
  return { type: 'unsupported', mode };
}

function sameBaseline(actual, expected) {
  if (!actual || !expected || actual.type !== expected.type || actual.mode !== expected.mode) return actual === expected;
  if (expected.type === 'file') return actual.hash === expected.hash && actual.size === expected.size;
  if (expected.type === 'symlink') return actual.hash === expected.hash && actual.target === expected.target;
  return expected.type === 'directory' ? actual.entries.length === 0 : true;
}


const sameFingerprint = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sameEntryIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

async function assertNoParentSymlink(root, relativePath) {
  let current = root;
  for (const segment of relativePath.split('/').slice(0, -1)) {
    current = path.join(current, segment);
    try { if ((await fs.promises.lstat(current)).isSymbolicLink()) fail(`Workspace export path escapes through a symlink: ${relativePath}`, 409); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.promises.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function copyEntry(source, destination) {
  const stat = await fs.promises.lstat(source);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  if (stat.isSymbolicLink()) await fs.promises.symlink(await fs.promises.readlink(source), destination);
  else if (stat.isDirectory()) {
    await fs.promises.mkdir(destination, { mode: stat.mode & 0o7777 });
    for (const name of await fs.promises.readdir(source)) await copyEntry(path.join(source, name), path.join(destination, name));
    await fs.promises.chmod(destination, stat.mode & 0o7777);
    await syncDirectory(destination);
  } else {
    await fs.promises.copyFile(source, destination);
    await fs.promises.chmod(destination, stat.mode & 0o7777);
    const handle = await fs.promises.open(destination, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  await syncDirectory(path.dirname(destination));
}

async function writeJournal(journalPath, journal) {
  const temporary = `${journalPath}.tmp`;
  const handle = await fs.promises.open(temporary, 'w', 0o600);
  try { await handle.writeFile(`${JSON.stringify(journal)}\n`); await handle.sync(); } finally { await handle.close(); }
  await fs.promises.rename(temporary, journalPath);
  await syncDirectory(path.dirname(journalPath));
}

async function rollback(journalPath, journal) {
  const failures = [];
  for (const record of [...journal.records].reverse()) {
    if (!record.touched) continue;
    const target = path.join(journal.directory, record.path);
    try {
      await assertNoParentSymlink(journal.directory, record.path);
      await fs.promises.rm(target, { recursive: true, force: true });
      if (record.existed) await copyEntry(path.join(journal.backupDirectory, record.backup), target);
      await syncDirectory(path.dirname(target));
      if (!sameFingerprint(await fingerprint(target), record.fingerprint)) throw new Error('restoration verification failed');
    } catch (error) { failures.push(`${record.path}: ${error instanceof Error ? error.message : 'restore failed'}`); }
  }
  journal.state = failures.length ? 'rollback-incomplete' : 'rolled-back';
  journal.rollbackErrors = failures;
  await writeJournal(journalPath, journal);
  if (failures.length) throw new Error(failures.join('; '));
}

function validateJournal(journal, operationDirectory, directory) {
  const backupDirectory = path.join(operationDirectory, 'backups');
  if (!journal || journal.version !== 2 || journal.directory !== directory || journal.backupDirectory !== backupDirectory || !['applying', 'committed', 'rollback-incomplete', 'rolled-back'].includes(journal.state) || !Array.isArray(journal.records) || journal.records.length === 0 || journal.records.length > MAX_FILES * 2) fail('Workspace apply recovery journal is invalid', 500);
  const paths = new Set();
  for (const record of journal.records) {
    let validPath = false;
    try { validPath = safeRelativePath(record?.path) === record.path; } catch {}
    if (!record || !validPath || [...paths].some((existing) => pathsOverlap(existing, record.path)) || typeof record.existed !== 'boolean' || record.existed !== (record.fingerprint !== null) || typeof record.backup !== 'string' || record.backup !== String(paths.size) || typeof record.touched !== 'boolean' || !Object.hasOwn(record, 'fingerprint') || !Object.hasOwn(record, 'finalFingerprint') || record.finalFingerprint === undefined) fail('Workspace apply recovery journal is invalid', 500);
    paths.add(record.path);
  }
  if (journal.state === 'committed' && journal.records.some((record) => !record.touched)) fail('Workspace apply recovery journal is invalid', 500);
}

async function recover(projectTransactionRoot, directory) {
  await fs.promises.mkdir(projectTransactionRoot, { recursive: true, mode: 0o700 });
  for (const entry of await fs.promises.readdir(projectTransactionRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('txn-')) continue;
    const operationDirectory = path.join(projectTransactionRoot, entry.name);
    const journalPath = path.join(operationDirectory, 'journal.json');
    let journal;
    try { journal = JSON.parse(await fs.promises.readFile(journalPath, 'utf8')); } catch (error) {
      if (error?.code === 'ENOENT') continue;
      fail(`Workspace apply recovery journal is unreadable: ${entry.name}`, 500);
    }
    validateJournal(journal, operationDirectory, directory);
    if (journal.state === 'committed') {
      const valid = (await Promise.all(journal.records.map(async (record) => sameFingerprint(await fingerprint(path.join(directory, record.path)), record.finalFingerprint)))).every(Boolean);
      if (!valid) await rollback(journalPath, journal);
    } else if (journal.state !== 'rolled-back') await rollback(journalPath, journal);
    if (journal.state === 'committed' || journal.state === 'rolled-back') {
      await fs.promises.rm(operationDirectory, { recursive: true, force: true });
      await syncDirectory(projectTransactionRoot);
    }
  }
}

async function acquireLock(lockRoot, directory) {
  await fs.promises.mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const lockPath = path.join(lockRoot, sha256(directory));
  try { await fs.promises.mkdir(lockPath, { mode: 0o700 }); } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let pid = 0;
    try { pid = Number.parseInt(await fs.promises.readFile(path.join(lockPath, 'owner'), 'utf8'), 10); } catch {}
    try { if (pid > 0) process.kill(pid, 0); fail('Another workspace apply is already mutating this project', 423); } catch (ownerError) { if (ownerError?.statusCode === 423 || ownerError?.code === 'EPERM') throw ownerError; }
    await fs.promises.rm(lockPath, { recursive: true, force: true });
    return acquireLock(lockRoot, directory);
  }
  await fs.promises.writeFile(path.join(lockPath, 'owner'), `${process.pid}\n`, { mode: 0o600 });
  return () => fs.promises.rm(lockPath, { recursive: true, force: true });
}

function selectedResult(file, selectedHunkIDs, blobs) {
  const textEntries = (!file.old || file.old.type === 'file') && (!file.next || file.next.type === 'file');
  const wholeOnly = file.binary || file.kind === 'rename' || file.kind === 'mode' || !textEntries || (file.old && file.next && file.old.mode !== file.next.mode) || file.textHunks.length === 0;
  if (wholeOnly) {
    if (selectedHunkIDs?.length) fail('This workspace operation must be applied as a whole');
    return file.next?.type === 'file' ? blobs.get(file.resultBlob).content : null;
  }
  const requested = new Set(selectedHunkIDs ?? file.textHunks.map((hunk) => hunk.id));
  if (!requested.size || requested.size !== selectedHunkIDs?.length && selectedHunkIDs) fail('Select at least one valid text hunk');
  const hunks = file.textHunks.filter((hunk) => requested.has(hunk.id));
  if (hunks.length !== requested.size) fail('Selected workspace hunk is no longer available');
  const baseline = blobs.get(file.baselineBlob)?.content ?? Buffer.alloc(0);
  const result = applyTextHunks(baseline, hunks);
  if (hunks.length === file.textHunks.length) {
    const expected = blobs.get(file.resultBlob)?.content ?? Buffer.alloc(0);
    if (!result.equals(expected)) fail('Selected workspace hunks do not match the artifact result', 409);
  }
  return result;
}

async function materialize(staging, nextEntry, result, resultBlob, blobs) {
  if (!nextEntry) return;
  const target = path.join(staging, nextEntry.path);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  if (nextEntry.type === 'directory') await fs.promises.mkdir(target, { recursive: true, mode: nextEntry.mode });
  else if (nextEntry.type === 'symlink') await fs.promises.symlink(nextEntry.target, target);
  else {
    const handle = await fs.promises.open(target, 'w', nextEntry.mode);
    try { await handle.writeFile(result ?? blobs.get(resultBlob).content); await handle.sync(); } finally { await handle.close(); }
  }
  if (nextEntry.type !== 'symlink') await fs.promises.chmod(target, nextEntry.mode);
  if (nextEntry.type === 'directory') await syncDirectory(target);
  else if (nextEntry.type === 'file') {
    const handle = await fs.promises.open(target, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  await syncDirectory(path.dirname(target));
}

export async function applyWorkspaceArtifact({ parsed, directory, selections, checkOnly, transactionRoot, lockRoot, beforeReplace, afterReplace }) {
  if (!Array.isArray(selections) || selections.length === 0) fail('Select at least one file to apply');
  const requested = new Map();
  for (const selection of selections) {
    if (!selection || typeof selection.fileID !== 'string' || requested.has(selection.fileID) || (selection.hunkIDs !== undefined && (!Array.isArray(selection.hunkIDs) || selection.hunkIDs.some((id) => typeof id !== 'string')))) fail('Workspace apply selection is invalid');
    requested.set(selection.fileID, selection.hunkIDs);
  }
  const files = parsed.artifact.files.filter((file) => requested.has(file.id));
  if (files.length !== requested.size) fail('Selected workspace file is no longer available');
  const root = await fs.promises.realpath(directory);
  const release = await acquireLock(lockRoot, root);
  try {
    const projectTransactionRoot = path.join(transactionRoot, sha256(root));
    await recover(projectTransactionRoot, root);
    if (Date.parse(parsed.artifact.expiresAt) <= Date.now()) fail('Workspace export artifact has expired', 410);
    const paths = [...new Set(files.flatMap((file) => [file.oldPath, file.newPath]).filter(Boolean))];
    for (const relativePath of paths) await assertNoParentSymlink(root, relativePath);
    const checkedFingerprints = new Map();
    for (const file of files) {
      const targetPath = file.old?.path ?? file.next?.path;
      if (!targetPath) fail('Workspace export operation has no target path');
      const target = path.join(root, targetPath);
      const actual = await fingerprint(target);
      if (!sameBaseline(actual, file.old)) fail(`Workspace export conflicts with the current project entry: ${targetPath}`, 409);
      checkedFingerprints.set(targetPath, actual);
      if (file.kind === 'rename') {
        const renameTarget = await fingerprint(path.join(root, file.next.path));
        if (renameTarget) fail(`Workspace rename target already exists: ${file.next.path}`, 409);
        checkedFingerprints.set(file.next.path, null);
      }
    }
    const results = new Map(files.map((file) => [file.id, selectedResult(file, requested.get(file.id), parsed.blobs)]));
    const nextEntries = new Map(files.map((file) => {
      const selectedHunks = requested.get(file.id);
      const partialDelete = file.kind === 'delete' && Array.isArray(selectedHunks) && selectedHunks.length < file.textHunks.length;
      return [file.id, partialDelete ? { ...file.old } : file.next];
    }));
    if (checkOnly) return { applied: false, checkOnly: true, files: files.map((file) => file.id) };

    const operationDirectory = await fs.promises.mkdtemp(path.join(projectTransactionRoot, 'txn-'));
    await syncDirectory(projectTransactionRoot);
    const staging = path.join(operationDirectory, 'staging');
    const backups = path.join(operationDirectory, 'backups');
    await fs.promises.mkdir(staging, { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(backups, { recursive: true, mode: 0o700 });
    const stagedFingerprints = new Map();
    for (const file of files) {
      const nextEntry = nextEntries.get(file.id);
      const result = results.get(file.id);
      await materialize(staging, nextEntry, result, file.resultBlob, parsed.blobs);
      if (!nextEntry) continue;
      const stagedFingerprint = await fingerprint(path.join(staging, nextEntry.path));
      let expectedFingerprint;
      if (nextEntry.type === 'file') {
        const content = result ?? parsed.blobs.get(file.resultBlob).content;
        expectedFingerprint = { type: 'file', mode: nextEntry.mode, size: content.length, hash: sha256(content) };
      } else if (nextEntry.type === 'symlink') expectedFingerprint = { type: 'symlink', mode: nextEntry.mode, target: nextEntry.target, hash: sha256(Buffer.from(nextEntry.target)) };
      else expectedFingerprint = { type: 'directory', mode: nextEntry.mode, entries: [] };
      if (!sameFingerprint(stagedFingerprint, expectedFingerprint)) throw new Error(`Workspace export staged output verification failed: ${nextEntry.path}`);
      stagedFingerprints.set(nextEntry.path, expectedFingerprint);
    }
    await syncDirectory(staging);
    const records = [];
    for (const [index, relativePath] of paths.entries()) {
      const target = path.join(root, relativePath);
      await assertNoParentSymlink(root, relativePath);
      const initialFingerprint = await fingerprint(target);
      if (!sameFingerprint(initialFingerprint, checkedFingerprints.get(relativePath))) fail(`Workspace export entry changed before backup: ${relativePath}`, 409);
      const existed = initialFingerprint !== null;
      if (existed) {
        const backup = path.join(backups, String(index));
        await copyEntry(target, backup);
        if (!sameFingerprint(await fingerprint(backup), initialFingerprint) || !sameFingerprint(await fingerprint(target), initialFingerprint)) fail(`Workspace export entry changed while it was backed up: ${relativePath}`, 409);
      }
      records.push({ path: relativePath, existed, backup: String(index), fingerprint: initialFingerprint, finalFingerprint: null, touched: false });
    }
    for (const record of records) {
      const nextEntry = files.map((file) => nextEntries.get(file.id)).find((entry) => entry?.path === record.path);
      record.finalFingerprint = nextEntry ? stagedFingerprints.get(record.path) : null;
    }
    const journal = { version: 2, state: 'applying', directory: root, backupDirectory: backups, records };
    const journalPath = path.join(operationDirectory, 'journal.json');
    await writeJournal(journalPath, journal);
    try {
      for (const [index, file] of files.entries()) {
        if (beforeReplace) await beforeReplace({ index, file });
        const nextEntry = nextEntries.get(file.id);
        const mutationPaths = [...new Set([file.old?.path, nextEntry?.path].filter(Boolean))];
        for (const relativePath of mutationPaths) {
          const record = records.find((candidate) => candidate.path === relativePath);
          await assertNoParentSymlink(root, relativePath);
          if (!sameFingerprint(await fingerprint(path.join(root, relativePath)), record.fingerprint)) fail(`Workspace export entry changed before replacement: ${relativePath}`, 409);
          record.touched = true;
          await writeJournal(journalPath, journal);
          try {
            await assertNoParentSymlink(root, relativePath);
            if (!sameFingerprint(await fingerprint(path.join(root, relativePath)), record.fingerprint)) fail(`Workspace export entry changed before replacement: ${relativePath}`, 409);
          } catch (error) {
            record.touched = false;
            await writeJournal(journalPath, journal);
            throw error;
          }
          const target = path.join(root, relativePath);
          await fs.promises.rm(target, { recursive: true, force: true });
          if (nextEntry?.path === relativePath) await copyEntry(path.join(staging, relativePath), target);
          await syncDirectory(path.dirname(target));
          if (!sameFingerprint(await fingerprint(target), record.finalFingerprint)) throw new Error(`Workspace export replacement verification failed: ${relativePath}`);
        }
        if (afterReplace) await afterReplace({ index, file });
      }
      for (const record of records) {
        await assertNoParentSymlink(root, record.path);
        if (!sameFingerprint(await fingerprint(path.join(root, record.path)), record.finalFingerprint)) throw new Error(`Workspace export final verification failed: ${record.path}`);
      }
      journal.state = 'committed';
      await writeJournal(journalPath, journal);
    } catch (error) {
      try { await rollback(journalPath, journal); } catch (rollbackError) { error.rollbackError = rollbackError; }
      throw error;
    }
    await fs.promises.rm(operationDirectory, { recursive: true, force: true }).catch(() => undefined);
    await syncDirectory(projectTransactionRoot);
    return { applied: true, checkOnly: false, files: files.map((file) => file.id) };
  } finally { await release(); }
}
