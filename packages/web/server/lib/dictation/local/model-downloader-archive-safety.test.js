/**
 * Hostile-archive safety tests for the pure-JS .tar.bz2 extraction in
 * model-downloader.js (fix for issue #2887: extraction must not depend on a
 * system tar/bzip2 pair).
 *
 * Fixtures are generated programmatically: tar-stream's pack() writes the tar
 * entries, then python3's stdlib bz2 module compresses them. A system `bzip2`
 * binary is therefore not needed to build fixtures either; python3 is the same
 * fixture prerequisite scripts/reproduce-issue-2887.mjs already documents.
 * python3 is resolved once in beforeAll and invoked by absolute path.
 *
 * Extraction runs in a child process whose PATH contains only failing shims
 * named `tar` and `bzip2` (explicit `env`, so both the Bun and Node test
 * runners honor it; Bun freezes the inherited PATH for spawned children at
 * process start). A spawn-based extractor cannot succeed in that child on any
 * host, so these tests fail if the pipeline regresses to spawning `tar`
 * instead of parsing the archive in process.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';

import tar from 'tar-stream';
import unbzip2Stream from 'unbzip2-stream';

import { ensureLocalSttModel } from './model-downloader.js';

const MODEL_ID = 'parakeet-tdt-0.6b-v2-int8';
const EXTRACTED_DIR = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8';
const ARCHIVE_NAME = `${EXTRACTED_DIR}.tar.bz2`;
const MODEL_DIR_PREFIX = `${EXTRACTED_DIR}/`;
// Sorted, because the installed model dir is compared with readdir().sort().
const REQUIRED_FILES = ['decoder.int8.onnx', 'encoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'];
const SPECIAL_ENTRY_NAMES = ['evil-device', 'evil-fifo', 'evil-hardlink', 'evil-symlink'];

const here = path.dirname(fileURLToPath(import.meta.url));
const packagesWebDir = path.resolve(here, '../../../..');
const downloaderUrl = new URL('./model-downloader.js', import.meta.url).href;

let tempRoot;
let fakeBinDir;
let python3;
let originalPath;

const fileContent = (name) => `fixture bytes for ${name}\n`;

/** Model entries as a real k2-fsa archive lays them out: one dir, four files. */
function modelEntries() {
  return [
    { name: MODEL_DIR_PREFIX, type: 'directory' },
    ...REQUIRED_FILES.map((name) => ({ name: MODEL_DIR_PREFIX + name, content: fileContent(name) })),
  ];
}

/** Build raw tar bytes from { name, type?, linkname?, devmajor?, devminor?, content? } entries. */
function packTar(entries) {
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    const chunks = [];
    pack.on('data', (chunk) => chunks.push(chunk));
    pack.on('error', reject);
    pack.on('end', () => resolve(Buffer.concat(chunks)));

    const addNext = (index) => {
      if (index >= entries.length) {
        pack.finalize();
        return;
      }
      const entry = entries[index];
      const header = { name: entry.name, type: entry.type ?? 'file', mode: 0o644, size: 0 };
      if (entry.linkname !== undefined) header.linkname = entry.linkname;
      if (entry.devmajor !== undefined) {
        header.devmajor = entry.devmajor;
        header.devminor = entry.devminor;
      }
      const done = (error) => (error ? reject(error) : addNext(index + 1));
      if (entry.content !== undefined) {
        header.size = Buffer.byteLength(entry.content);
        pack.entry(header, Buffer.from(entry.content), done);
      } else {
        pack.entry(header, done);
      }
    };
    addNext(0);
  });
}

/** Read back an archive through the real unbzip2 + tar pipeline to prove a fixture carries what a test asserts. */
async function readArchiveEntries(archiveBytes) {
  const entries = [];
  await new Promise((resolve, reject) => {
    const extract = tar.extract();
    extract.on('entry', (header, stream, next) => {
      entries.push({ name: header.name, type: header.type, linkname: header.linkname });
      stream.resume();
      next();
    });
    extract.on('error', reject);
    extract.on('finish', resolve);
    Readable.from([archiveBytes]).pipe(unbzip2Stream()).pipe(extract);
  });
  return entries;
}

function compressBz2(tarBytes) {
  const result = spawnSync(
    python3,
    ['-c', 'import bz2, sys; sys.stdout.buffer.write(bz2.compress(sys.stdin.buffer.read(), 9))'],
    { input: tarBytes, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`bz2 fixture compression failed: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout;
}

async function writeArchive(modelsDir, archiveBytes) {
  await mkdir(path.join(modelsDir, '.downloads'), { recursive: true });
  await writeFile(path.join(modelsDir, '.downloads', ARCHIVE_NAME), archiveBytes);
}

/**
 * Valid bz2 around a tar cut mid-file-data: the bz2 wrapper is complete (it
 * wraps the exact bytes handed to it), but tar-stream sees a file header that
 * declares more bytes than the tar actually contains. That makes the failure
 * arrive on the tar entry stream, not on the bzip2 decompressor as in the
 * truncated-.tar.bz2 case above.
 */
async function truncatedEntryArchive() {
  const tarBytes = await packTar(modelEntries());
  const dataStart = tarBytes.indexOf(Buffer.from(fileContent(REQUIRED_FILES[0])));
  expect(dataStart).toBeGreaterThan(0);
  const cut = tarBytes.subarray(0, dataStart + 4);
  expect(cut.length).toBeLessThan(tarBytes.length);
  return compressBz2(cut);
}

/** Environment for extraction: no real tar/bzip2 reachable, only failing shims. */
function extractionEnv() {
  return { ...process.env, PATH: fakeBinDir };
}

/**
 * Run ensureLocalSttModel in a child process with extractionEnv() active.
 * Returns { ok: true, dir } or { ok: false, error }.
 */
function runExtraction(modelsDir) {
  const childSource = `
    import { ensureLocalSttModel } from ${JSON.stringify(downloaderUrl)};
    try {
      const dir = await ensureLocalSttModel({ modelsDir: ${JSON.stringify(modelsDir)}, modelId: ${JSON.stringify(MODEL_ID)} });
      console.log('RESULT:' + JSON.stringify({ ok: true, dir }));
    } catch (error) {
      console.log('RESULT:' + JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
    }
  `;
  const isBun = Boolean(process.versions.bun);
  const args = (isBun ? ['-e'] : ['--input-type=module', '-e']).concat([childSource]);
  const child = spawnSync(process.execPath, args, {
    cwd: packagesWebDir,
    env: extractionEnv(),
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (child.error) {
    throw child.error;
  }
  if (child.status !== 0) {
    throw new Error(`extraction child failed (status ${child.status}): ${child.stderr}`);
  }
  const line = child.stdout.split('\n').find((entry) => entry.startsWith('RESULT:'));
  if (!line) {
    throw new Error(`extraction child produced no result:\n${child.stdout}\n${child.stderr}`);
  }
  return JSON.parse(line.slice('RESULT:'.length));
}

/** A failed extraction must not leave a partial final model, staging dir, or cached archive. */
async function expectCleanFailure(modelsDir) {
  const entries = await readdir(modelsDir);
  expect(entries.filter((name) => name.startsWith('.staging-'))).toEqual([]);
  expect(entries).not.toContain(EXTRACTED_DIR);
  await expect(stat(path.join(modelsDir, EXTRACTED_DIR))).rejects.toThrow();
  expect(await readdir(path.join(modelsDir, '.downloads'))).not.toContain(ARCHIVE_NAME);
}

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'model-downloader-hostile-'));
  fakeBinDir = path.join(tempRoot, 'fakebin');
  await mkdir(fakeBinDir, { recursive: true });
  for (const tool of ['tar', 'bzip2']) {
    const shimPath = path.join(fakeBinDir, tool);
    await writeFile(shimPath, `#!/bin/sh\necho "${tool}: not found" >&2\nexit 127\n`);
    await chmod(shimPath, 0o755);
  }

  const probe = spawnSync('python3', ['-c', 'import bz2, sys; print(sys.executable)']);
  if (probe.error || probe.status !== 0) {
    throw new Error(
      `python3 with bz2 is required to build .tar.bz2 fixtures (same prerequisite as scripts/reproduce-issue-2887.mjs): ${probe.error?.message ?? probe.stderr}`,
    );
  }
  python3 = probe.stdout.toString().trim();
  originalPath = process.env.PATH;
});

afterAll(async () => {
  if (originalPath !== undefined) {
    process.env.PATH = originalPath;
  }
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('extractTarArchive hostile archives', () => {
  it('extracts a generated .tar.bz2 exactly with no system tar/bzip2 on PATH', async () => {
    const modelsDir = path.join(tempRoot, 'success');
    await writeArchive(modelsDir, compressBz2(await packTar(modelEntries())));

    // The restricted PATH must not expose a working extractor; a spawn-based
    // implementation cannot pass any test in this file.
    for (const tool of ['tar', 'bzip2']) {
      const probe = spawnSync(tool, ['--version'], { env: extractionEnv(), encoding: 'utf8' });
      expect(probe.error?.code ?? probe.status).not.toBe(0);
    }

    const result = runExtraction(modelsDir);
    expect(result).toEqual({ ok: true, dir: path.join(modelsDir, EXTRACTED_DIR) });

    const dir = path.join(modelsDir, EXTRACTED_DIR);
    expect((await readdir(dir)).sort()).toEqual(REQUIRED_FILES);
    expect(await readFile(path.join(dir, 'tokens.txt'), 'utf8')).toBe(fileContent('tokens.txt'));
  });

  it('skips ../ and nested traversal entries, installing only the model', async () => {
    const caseRoot = path.join(tempRoot, 'traversal');
    const modelsDir = path.join(caseRoot, 'models');
    const outsideTargets = [
      path.join(modelsDir, 'escape.txt'),
      path.join(modelsDir, 'escape2.txt'),
      path.join(caseRoot, 'escape3.txt'),
    ];
    const hostileNames = [
      '../escape.txt',
      `${MODEL_DIR_PREFIX}../../escape2.txt`,
      `${MODEL_DIR_PREFIX}../../../escape3.txt`,
    ];
    const entries = [
      ...modelEntries(),
      ...hostileNames.map((name) => ({ name, content: 'escaped\n' })),
    ];
    const archiveBytes = compressBz2(await packTar(entries));

    const fixtureNames = (await readArchiveEntries(archiveBytes)).map((entry) => entry.name);
    for (const name of hostileNames) {
      expect(fixtureNames).toContain(name);
    }
    await writeArchive(modelsDir, archiveBytes);

    expect(runExtraction(modelsDir).ok).toBe(true);

    const dir = path.join(modelsDir, EXTRACTED_DIR);
    expect((await readdir(dir)).sort()).toEqual(REQUIRED_FILES);
    for (const target of outsideTargets) {
      await expect(stat(target)).rejects.toThrow();
    }
  });

  it('skips absolute-path entries', async () => {
    const caseRoot = path.join(tempRoot, 'absolute');
    const modelsDir = path.join(caseRoot, 'models');
    const absoluteTarget = path.join(caseRoot, 'absolute-escape.txt');
    const archiveBytes = compressBz2(
      await packTar([...modelEntries(), { name: absoluteTarget, content: 'absolute\n' }]),
    );
    expect((await readArchiveEntries(archiveBytes)).map((entry) => entry.name)).toContain(absoluteTarget);
    await writeArchive(modelsDir, archiveBytes);

    expect(runExtraction(modelsDir).ok).toBe(true);

    const dir = path.join(modelsDir, EXTRACTED_DIR);
    expect((await readdir(dir)).sort()).toEqual(REQUIRED_FILES);
    await expect(stat(absoluteTarget)).rejects.toThrow();
  });

  it('skips symlink, hardlink, device and FIFO entries', async () => {
    const caseRoot = path.join(tempRoot, 'special');
    const modelsDir = path.join(caseRoot, 'models');
    const entries = [
      ...modelEntries(),
      { name: MODEL_DIR_PREFIX + 'evil-symlink', type: 'symlink', linkname: '/etc/passwd' },
      { name: MODEL_DIR_PREFIX + 'evil-hardlink', type: 'link', linkname: '/etc/passwd' },
      { name: MODEL_DIR_PREFIX + 'evil-device', type: 'character-device', devmajor: 1, devminor: 3 },
      { name: MODEL_DIR_PREFIX + 'evil-fifo', type: 'fifo' },
    ];
    const archiveBytes = compressBz2(await packTar(entries));

    const fixtureTypes = new Map(
      (await readArchiveEntries(archiveBytes)).map((entry) => [entry.name, entry.type]),
    );
    expect(fixtureTypes.get(MODEL_DIR_PREFIX + 'evil-symlink')).toBe('symlink');
    expect(fixtureTypes.get(MODEL_DIR_PREFIX + 'evil-hardlink')).toBe('link');
    expect(fixtureTypes.get(MODEL_DIR_PREFIX + 'evil-device')).toBe('character-device');
    expect(fixtureTypes.get(MODEL_DIR_PREFIX + 'evil-fifo')).toBe('fifo');
    await writeArchive(modelsDir, archiveBytes);

    expect(runExtraction(modelsDir).ok).toBe(true);

    const dir = path.join(modelsDir, EXTRACTED_DIR);
    const installed = await readdir(dir, { withFileTypes: true });
    expect(installed.map((entry) => entry.name).sort()).toEqual(REQUIRED_FILES);
    expect(installed.every((entry) => entry.isFile())).toBe(true);
    for (const name of SPECIAL_ENTRY_NAMES) {
      await expect(stat(path.join(dir, name))).rejects.toThrow();
    }
  });

  it('discards a truncated .tar.bz2 and leaves no partial model, staging dir, or archive', async () => {
    const modelsDir = path.join(tempRoot, 'truncated');
    const archiveBytes = compressBz2(await packTar(modelEntries()));
    await writeArchive(modelsDir, archiveBytes.subarray(0, Math.floor(archiveBytes.length / 2)));

    expect(runExtraction(modelsDir).ok).toBe(false);

    await expectCleanFailure(modelsDir);
  });

  it('rejects a valid .tar.bz2 whose tar is cut mid-file without an uncaught exception', async () => {
    const modelsDir = path.join(tempRoot, 'truncated-entry');
    await writeArchive(modelsDir, await truncatedEntryArchive());

    // The child exits non-zero when the tar entry stream's 'error' event has
    // no listener (uncaught exception), and runExtraction() turns that into a
    // test failure. A contained rejection comes back as ok:false instead.
    const result = runExtraction(modelsDir);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();

    await expectCleanFailure(modelsDir);
  });

  it('discards a corrupt archive and leaves no partial model, staging dir, or archive', async () => {
    const modelsDir = path.join(tempRoot, 'corrupt');
    await writeArchive(modelsDir, Buffer.from('this is not a bzip2 stream'));

    expect(runExtraction(modelsDir).ok).toBe(false);

    await expectCleanFailure(modelsDir);
  });
});
