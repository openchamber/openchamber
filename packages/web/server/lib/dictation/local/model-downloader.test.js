import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir, readdir, chmod } from 'fs/promises';
import os from 'os';
import path from 'path';

import { ensureLocalSttModel } from './model-downloader.js';

// Real .tar.bz2 archive containing sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/
// with the four required files (generated with python3 tarfile w:bz2).
const TAR_BZ2_BASE64 =
  'QlpoOTFBWSZTWZWtWmYAAllZgP6QRgv/wH9730AMCDABGCglSjeoAARgAEaMCDAyDIADEaDIZAYFSiaSPTUHqaaNDQDQAzUz3z9rNQpfxYXCY8aJF8glNfV2bLH4VNIpjMi+VKCDO+QTO7ovFJBOeQS101EJSOjQb/apcZGs9D+LG4wNU9ZjQ7Sx5yhHicpUR4eDxsRlNs0bcys2d+yU3UOOleI0TCYbqnqVy65LHA+thYuNJZ1PpYMhzt2BgF+4iCbg0GV4NyKuB3FQgyoQ/rpLpWSumTgb3DnYzAtrKmJjKFDB2fNGZ9W1mgrJqMCvX082ZeXyZbYH+LuSKcKEhK1q0zA=';

const ARCHIVE_NAME = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2';
const MODEL_ID = 'parakeet-tdt-0.6b-v2-int8';
const REQUIRED_FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'].sort();

let tempRoot;
let fakeBinDir;
let originalPath;

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'model-downloader-test-'));
  fakeBinDir = path.join(tempRoot, 'fakebin');
  await mkdir(fakeBinDir, { recursive: true });
  // Shims that behave exactly like missing binaries (shell reports not
  // found, child exits 127). With the pre-fix implementation the extractor
  // spawned `tar` and failed; the pure-JS pipeline spawns nothing, so the
  // extraction succeeds regardless of PATH.
  await writeFile(
    path.join(fakeBinDir, 'bzip2'),
    '#!/bin/sh\necho "/bin/sh: 1: bzip2: not found" >&2\nexit 127\n',
  );
  await writeFile(
    path.join(fakeBinDir, 'tar'),
    '#!/bin/sh\necho "tar: not found" >&2\nexit 127\n',
  );
  await chmod(path.join(fakeBinDir, 'bzip2'), 0o755);
  await chmod(path.join(fakeBinDir, 'tar'), 0o755);
  originalPath = process.env.PATH;
  // Keep the shims first so any spawn('tar'/'bzip2') resolves to them.
  process.env.PATH = `${fakeBinDir}:${originalPath}`;
});

afterAll(async () => {
  process.env.PATH = originalPath;
  await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe('ensureLocalSttModel extraction (issue #2887)', () => {
  it('extracts a .tar.bz2 model with no system bzip2/tar available', async () => {
    const modelsDir = path.join(tempRoot, 'models-nobzip2');
    await mkdir(path.join(modelsDir, '.downloads'), { recursive: true });
    await writeFile(
      path.join(modelsDir, '.downloads', ARCHIVE_NAME),
      Buffer.from(TAR_BZ2_BASE64, 'base64'),
    );

    const dir = await ensureLocalSttModel({ modelsDir, modelId: MODEL_ID });

    const files = (await readdir(dir)).sort();
    expect(files).toEqual(REQUIRED_FILES);
  });

  it('still fails cleanly on a corrupt archive (bounded, no partial files at final path)', async () => {
    const modelsDir = path.join(tempRoot, 'models-corrupt');
    await mkdir(path.join(modelsDir, '.downloads'), { recursive: true });
    await writeFile(path.join(modelsDir, '.downloads', ARCHIVE_NAME), 'not a bz2 archive');

    await expect(ensureLocalSttModel({ modelsDir, modelId: MODEL_ID })).rejects.toThrow();

    // The failed extraction must not leave partial files at the final path
    // (installed check would treat them as a valid model forever).
    const finalPath = path.join(modelsDir, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8');
    const entries = await readdir(modelsDir);
    expect(entries).not.toContain('sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8');
    await expect(readdir(finalPath)).rejects.toThrow();
  });
});
