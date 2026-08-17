/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/2887
 *
 * [Bug] Voice packages fail on download because no unpacker (bzip2) missing
 *
 * All 5 local STT/TTS model archives in model-catalog.js are `.tar.bz2`
 * (e.g. sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2). The downloader
 * (packages/web/server/lib/dictation/local/model-downloader.js) extracts them
 * with a pure-JS pipeline (unbzip2-stream + tar-stream) so extraction never
 * depends on a system `tar`/`bzip2` pair being installed.
 *
 * This script verifies the fixed behavior through the real
 * `ensureLocalSttModel()` code path: extraction succeeds even when `bzip2`
 * and `tar` are absent from PATH (bzip2-absent case) and when they are
 * available (control case). It fails (non-zero exit) if extraction breaks.
 *
 * Run with: bun scripts/reproduce-issue-2887.mjs  (or `node`)
 */

import { mkdir, writeFile, rm, chmod } from 'fs/promises';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const downloaderPath = path.join(
  repoRoot,
  'packages/web/server/lib/dictation/local/model-downloader.js',
);
const modelId = 'parakeet-tdt-0.6b-v2-int8';
const extractedDir = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8';
const archiveName = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2';
const requiredFiles = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'];

const work = path.join(path.dirname(fileURLToPath(import.meta.url)), '.repro-issue-2887');

async function buildFixture(modelsDir) {
  await rm(work, { recursive: true, force: true });
  await mkdir(path.join(modelsDir, '.downloads'), { recursive: true });
  const payloadDir = path.join(work, 'payload');
  await mkdir(path.join(payloadDir, extractedDir), { recursive: true });
  for (const f of requiredFiles) {
    await writeFile(path.join(payloadDir, extractedDir, f), `fake ${f} content\n`);
  }
  const archive = path.join(modelsDir, '.downloads', archiveName);
  const packed = spawnSync(
    'python3',
    ['-c',
      'import tarfile, sys; t=tarfile.open(sys.argv[1], "w:bz2"); t.add(sys.argv[2], arcname=sys.argv[3], recursive=True); t.close()',
      archive, path.join(payloadDir, extractedDir), extractedDir],
    { encoding: 'utf8' },
  );
  if (packed.status !== 0) {
    throw new Error(`failed to build fixture archive: ${packed.stderr}`);
  }
  return archive;
}

async function runDownloader(modelsDir, env) {
  const isBun = typeof Bun !== 'undefined';
  const result = spawnSync(
    process.execPath,
    (isBun ? ['-e'] : ['--input-type=module', '-e']).concat([
      `
        import { ensureLocalSttModel } from ${JSON.stringify('file://' + downloaderPath)};
        try {
          const dir = await ensureLocalSttModel({ modelsDir: ${JSON.stringify(modelsDir)}, modelId: ${JSON.stringify(modelId)} });
          console.log('RESULT: OK ' + dir);
        } catch (err) {
          console.log('RESULT: ERROR: ' + err.message);
        }
      `,
    ]),
    {
      env,
      encoding: 'utf8',
      // The pure-JS extraction deps (unbzip2-stream, tar-stream) live in the
      // web workspace — resolve them from there.
      cwd: path.join(repoRoot, 'packages/web'),
    },
  );
  if (result.status !== 0) {
    throw new Error(`downloader process failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

// --- Case 1: bzip2 absent from PATH (reporter's environment) ---------------
{
  const modelsDir = path.join(work, 'models-nobzip2');
  await buildFixture(modelsDir);

  // Shim that behaves exactly like a missing `bzip2` (shell reports not found,
  // child exits 127) while keeping the real `tar` available.
  const fakeBin = path.join(work, 'fakebin');
  await mkdir(fakeBin, { recursive: true });
  // Shim BOTH tools: the pure-JS pipeline must not depend on a system
  // `tar`/`bzip2` pair, so neither may be reachable.
  await writeFile(
    path.join(fakeBin, 'bzip2'),
    '#!/bin/sh\necho "/bin/sh: 1: bzip2: not found" >&2\nexit 127\n',
  );
  await writeFile(
    path.join(fakeBin, 'tar'),
    '#!/bin/sh\necho "tar: not found" >&2\nexit 127\n',
  );
  await chmod(path.join(fakeBin, 'bzip2'), 0o755);
  await chmod(path.join(fakeBin, 'tar'), 0o755);

  const env = { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin` };
  const out = await runDownloader(modelsDir, env);
  console.log('[bzip2 ABSENT ]', out);
  if (!out.startsWith('RESULT: OK')) {
    throw new Error(`Expected extraction to succeed without bzip2/tar, got: ${out}`);
  }
}

// --- Case 2 (control): bzip2 available on PATH ------------------------------
{
  const modelsDir = path.join(work, 'models-bzip2');
  await buildFixture(modelsDir);
  const out = await runDownloader(modelsDir, process.env);
  console.log('[bzip2 PRESENT]', out);
  if (!out.startsWith('RESULT: OK')) {
    throw new Error(`Expected extraction to succeed with bzip2/tar, got: ${out}`);
  }
}
