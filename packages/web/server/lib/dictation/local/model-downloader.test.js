import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sevenZip from '7zip-bin';

import { describeTarFailure } from './model-downloader.js';
import { getLocalSttModelSpec } from './model-catalog.js';

// Real USTAR archives compressed with Python's bz2 module. Model files contain
// short text fixtures; no encoder or system bzip2 is needed to run these tests.
const STT_ARCHIVE = Buffer.from('QlpoOTFBWSZTWYnMogsAATrZgcqQRgv/wH9730AAAwgIMAEYAY00GgBk0BkaaGJowxpoNADJoDI00MTRgVRTSYmgg2o0emkANojTr0jPsKRJN0SInREIh29+iqhyMC8b1jYSWCEhPoSWxnUbDUbTI5FZ6F5pjjF8mBWZZKiGJtKhDHHFWQsjjv4LpTG/oVw0FK6S13HE4KThEVnMwKFRec+CevviWlx9OZaW20Vq5TyNJiZGp3RwORr1+pY0osM1IiiqI1xHQ5nRubI0m4k1F6JP0qL39nPXQZ7y0tiPAvMMLTb2HUsLoimBkQf4u5IpwoSETmUQWA==', 'base64');
const TTS_ARCHIVE = Buffer.from('QlpoOTFBWSZTWVojbVMAAPH/gcqQEABAA++QIAACAOet38AAAYgIMADYBjRo0AyZDRiNNA0wMaNGgGTIaMRpoGmAkkFT9MSTTxCZNo1A9J+qPU2tXXcYRHDUGQk6SBIYyd9rIlUUd3BlK5MgQwLMcGtNOgfEFBdws90nr1KLrg5JRTCS455QSWLonMYkZ8CvldC5os8gOHHYO4Yh1CC9wz+g6OT+IaczxQYOWJq8LLUnYLFQxBnbye88YBpYNpq9TC8pRM965RmrsaKJe+qqfq/ttsA9JBKp7IQf4u5IpwoSC0RtqmA=', 'base64');
const TRUNCATED_TAR_ARCHIVE = Buffer.from('QlpoOTFBWSZTWVw6dJwAADvZgMqARAPfwH5r30AIACAAdBqnoTJo0NGmmgDJkGhTJkNNGgA0aA9pCAnHJ84W01gwDHbG4yVmyrIPmvMhByAhBCCskazdBCnwaDyacypBwRE/FPIxnjDlFRmD4XCcxYnMlrImUIywxNCOH/i7kinChILh06Tg', 'base64');
const MISSING_FILES_ARCHIVE = Buffer.from('QlpoOTFBWSZTWX2dSkYAAI55gMqQEABEA9/Af2vfQAgIIACUhpMUanqBtQ2gCDTan6UGiTRtQAAGgGgPvZQogQDFkCBCc3UoGRG+ACBgNUID7SPFy2wpkO6XuIS5mCEjILauTW5q/HOIScUN8x4C1brT1sN9L2jhPSsksH4dAzCFfZ0IB1DY4pxHV+0qJULMSIgPxdyRThQkH2dSkYA=', 'base64');

const installerScript = `
  import { readdir, readFile, stat } from 'node:fs/promises';
  import path from 'node:path';
  import sevenZip from '7zip-bin';
  import { ensureLocalSttModel, isLocalSttModelInstalled } from ${JSON.stringify(new URL('./model-downloader.js', import.meta.url).href)};
  import { getLocalSttModelSpec } from ${JSON.stringify(new URL('./model-catalog.js', import.meta.url).href)};

  const [modelsDir, modelId, decoderPath, platform] = process.argv.slice(1);
  // Use the host's real native decoder while exercising Windows policy in an
  // isolated process. A packaged-path case puts it only in app.asar.unpacked.
  sevenZip.path7za = decoderPath;
  Object.defineProperty(process, 'platform', { value: platform });
  let modelDir = null;
  let error = null;
  try {
    modelDir = await ensureLocalSttModel({ modelsDir, modelId });
  } catch (failure) {
    error = failure.message;
  }
  const files = {};
  if (modelDir) {
    for (const filename of getLocalSttModelSpec(modelId).requiredFiles) {
      const filePath = path.join(modelDir, filename);
      files[filename] = (await stat(filePath)).isDirectory() ? '<directory>' : await readFile(filePath, 'utf8');
    }
  }
  console.log(JSON.stringify({
    error,
    files,
    installed: await isLocalSttModelInstalled(modelsDir, modelId),
    entries: (await readdir(modelsDir)).sort(),
    downloads: await readdir(path.join(modelsDir, '.downloads')),
  }));
`;

async function runInstaller(archive, modelId = 'parakeet-tdt-0.6b-v3-int8', { packaged = false, missingDecoder = false, platform = 'win32' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'oc-model-extraction-'));
  try {
    const modelsDir = path.join(root, 'speech models');
    const downloadsDir = path.join(modelsDir, '.downloads');
    const binDir = path.join(root, 'bin');
    const spec = getLocalSttModelSpec(modelId);
    await mkdir(downloadsDir, { recursive: true });
    await mkdir(binDir);
    await writeFile(path.join(downloadsDir, path.basename(new URL(spec.archiveUrl).pathname)), archive);

    // Windows cases keep tar available without its external bzip2 filter.
    const tarPath = process.platform === 'win32'
      ? path.join(process.env.SystemRoot, 'System32', 'tar.exe')
      : execFileSync('which', ['tar'], { encoding: 'utf8' }).trim();
    const isolatedTar = path.join(binDir, process.platform === 'win32' ? 'tar.exe' : 'tar');
    if (process.platform === 'darwin') {
      // macOS rejects relocated copies of its signed system executables.
      await symlink(tarPath, isolatedTar);
    } else {
      await copyFile(tarPath, isolatedTar);
      await chmod(isolatedTar, 0o755);
    }
    if (platform === 'linux') {
      const isolatedBzip2 = path.join(binDir, 'bzip2');
      await copyFile(execFileSync('which', ['bzip2'], { encoding: 'utf8' }).trim(), isolatedBzip2);
      await chmod(isolatedBzip2, 0o755);
    }

    const decoderPath = packaged
      ? path.join(root, 'app.asar', 'node_modules', '7zip-bin', 'win', process.arch, '7za.exe')
      : path.join(root, process.platform === 'win32' ? '7za.exe' : '7za');
    const physicalDecoderPath = decoderPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    if (!missingDecoder) {
      await mkdir(path.dirname(physicalDecoderPath), { recursive: true });
      await copyFile(sevenZip.path7za, physicalDecoderPath);
      await chmod(physicalDecoderPath, 0o755);
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path' && key !== 'USE_SYSTEM_7ZA'));
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', installerScript, modelsDir, modelId, decoderPath, platform], {
      cwd: path.resolve(import.meta.dirname, '../../../..'),
      env: { ...env, PATH: binDir },
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    expect(result.status, result.stderr || String(result.error)).toBe(0);
    return JSON.parse(result.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('describeTarFailure', () => {
  it('tells the user to install bzip2 when tar could not run it', () => {
    const stderr = 'tar (child): bzip2: Cannot exec: No such file or directory\ntar: Error is not recoverable: exiting now\n';
    expect(describeTarFailure(2, stderr)).toBe(
      'Extracting voice models needs the bzip2 program. Install it (for example: apt-get install bzip2) and try again.',
    );
  });

  it('keeps the exit code and the last tar message otherwise', () => {
    expect(describeTarFailure(2, 'tar: Unexpected EOF in archive\n')).toBe('tar exited with code 2: tar: Unexpected EOF in archive');
    expect(describeTarFailure(1, '')).toBe('tar exited with code 1');
  });
});

it.skipIf(process.platform !== 'linux')('keeps Linux system-tar installation independent of the Windows decoder', async () => {
  const result = await runInstaller(STT_ARCHIVE, undefined, { platform: 'linux', missingDecoder: true });
  expect(result.error).toBe(null);
  expect(result.installed).toBe(true);
  expect(result.entries).toEqual(['.downloads', 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8']);
  expect(result.downloads).toEqual([]);
});

describe('Windows model installation', () => {
  for (const packaged of [false, true]) {
    it(`installs cached STT without system bzip2${packaged ? ' from an unpacked desktop decoder' : ''}`, async () => {
      const result = await runInstaller(STT_ARCHIVE, undefined, { packaged });
      expect(result.error).toBe(null);
      expect(result.installed).toBe(true);
      expect(result.files).toEqual({
        'encoder.int8.onnx': 'encoder fixture\n',
        'decoder.int8.onnx': 'decoder fixture\n',
        'joiner.int8.onnx': 'joiner fixture\n',
        'tokens.txt': 'tokens fixture\n',
      });
      expect(result.entries).toEqual(['.downloads', 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8']);
      expect(result.downloads).toEqual([]);
    });
  }

  it('installs TTS files and data directories through the same decoder', async () => {
    const result = await runInstaller(TTS_ARCHIVE, 'piper-uk_UA-lada-x_low');
    expect(result.error).toBe(null);
    expect(result.installed).toBe(true);
    expect(result.files).toEqual({
      'uk_UA-lada-x_low.onnx': 'piper fixture\n',
      'tokens.txt': 'tokens fixture\n',
      'espeak-ng-data': '<directory>',
    });
    expect(result.entries).toEqual(['.downloads', 'vits-piper-uk_UA-lada-x_low']);
    expect(result.downloads).toEqual([]);
  });

  for (const [name, archive, errorPattern] of [
    ['corrupt bzip2', Buffer.from('not a bzip2 archive'), /7-Zip exited with code/],
    ['truncated bzip2', STT_ARCHIVE.subarray(0, 100), /7-Zip exited with code/],
    ['truncated tar inside valid bzip2', TRUNCATED_TAR_ARCHIVE, /tar exited with code/],
    ['missing required files', MISSING_FILES_ARCHIVE, /required model files are missing or empty/],
  ]) {
    it(`removes staged files and the cached archive after ${name}`, async () => {
      const result = await runInstaller(archive);
      expect(result.error).toMatch(errorPattern);
      expect(result.error).not.toContain('apt-get');
      expect(result.installed).toBe(false);
      expect(result.entries).toEqual(['.downloads']);
      expect(result.downloads).toEqual([]);
    });
  }

  it('rejects a missing decoder without promoting a model', async () => {
    const result = await runInstaller(STT_ARCHIVE, undefined, { missingDecoder: true });
    expect(result.error).toContain('ENOENT');
    expect(result.installed).toBe(false);
    expect(result.entries).toEqual(['.downloads']);
    expect(result.downloads).toEqual([]);
  });
});
