import { createHash } from 'crypto';
import { EventEmitter } from 'node:events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ReadableStream } from 'node:stream/web';
import sevenZip from '7zip-bin';
import { getLocalSttModelSpec } from './model-catalog.js';
import { archiveMatchesPins, describeTarFailure, downloadToFile, ensureLocalSttModel, extractTarArchive, isLocalSttModelInstalled } from './model-downloader.js';

const CONTENT = Buffer.from('a fake model archive');
const PINS = { bytes: CONTENT.length, sha256: createHash('sha256').update(CONTENT).digest('hex') };

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-downloader-'));
  return path.join(dir, 'archive.tar.bz2');
}

function fetchReturning(body) {
  return async () => new Response(body, { status: 200 });
}

function fakeTarSpawn(stderrChunks, exitCode) {
  return () => {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.pid = process.pid;
    child.kill = () => {};
    queueMicrotask(() => {
      for (const chunk of stderrChunks) child.stderr.write(chunk);
      child.emit('close', exitCode);
    });
    return child;
  };
}

describe('downloadToFile', () => {
  it('accepts a download whose size and checksum match the pins', async () => {
    const file = tempFile();
    const progress = [];
    await downloadToFile('https://example.test/archive.tar.bz2', file, (done, total) => progress.push([done, total]), {
      ...PINS,
      fetchImpl: fetchReturning(CONTENT),
    });
    expect(fs.readFileSync(file)).toEqual(CONTENT);
    expect(progress.at(-1)).toEqual([CONTENT.length, CONTENT.length]);
  });

  it('aborts a download larger than the pinned size without consuming the whole body', async () => {
    const file = tempFile();
    let pulls = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls > 50) {
          controller.close();
          return;
        }
        controller.enqueue(Buffer.from('y'.repeat(CONTENT.length)));
      },
    });
    await expect(
      downloadToFile('https://example.test/archive.tar.bz2', file, undefined, { ...PINS, fetchImpl: fetchReturning(body) }),
    ).rejects.toThrow(/larger than the expected/);
    expect(pulls).toBeLessThan(50);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(path.dirname(file))).toEqual([]);
  });

  it('refuses a download whose checksum differs from the pin', async () => {
    const file = tempFile();
    await expect(
      downloadToFile('https://example.test/archive.tar.bz2', file, undefined, {
        ...PINS,
        sha256: '0'.repeat(64),
        fetchImpl: fetchReturning(CONTENT),
      }),
    ).rejects.toThrow(/did not match its pinned checksum/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses a download shorter than the pinned size', async () => {
    const file = tempFile();
    await expect(
      downloadToFile('https://example.test/archive.tar.bz2', file, undefined, { ...PINS, fetchImpl: fetchReturning(CONTENT.subarray(0, 4)) }),
    ).rejects.toThrow(/incomplete/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('rejects a download whose body stalls, and discards the temp file', async () => {
    const file = tempFile();
    // Sends one chunk, then silence: the stream never ends and never
    // errors, the way a stalled endpoint behaves.
    const body = new ReadableStream({
      start(streamController) {
        streamController.enqueue(CONTENT.subarray(0, 4));
      },
    });
    const started = Date.now();
    await expect(
      downloadToFile('https://example.test/archive.tar.bz2', file, undefined, {
        ...PINS,
        fetchImpl: fetchReturning(body),
        stallTimeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(path.dirname(file))).toEqual([]);
  });

  it('rejects a download whose response never arrives', async () => {
    const file = tempFile();
    const fetchImpl = (_url, { signal } = {}) => new Promise((_resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    await expect(
      downloadToFile('https://example.test/archive.tar.bz2', file, undefined, { ...PINS, fetchImpl, stallTimeoutMs: 50 }),
    ).rejects.toThrow(/timed out/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('discards the verified temp file when the final rename fails', async () => {
    const file = tempFile();
    await mkdir(file, { recursive: true });
    await expect(
      downloadToFile('https://example.test/archive.tar.bz2', file, undefined, { ...PINS, fetchImpl: fetchReturning(CONTENT) }),
    ).rejects.toThrow();
    const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('refuses to download a model with no pins, before fetching', async () => {
    const file = tempFile();
    let fetched = false;
    await expect(
      downloadToFile('https://example.test/archive.tar.bz2', file, undefined, {
        fetchImpl: async () => {
          fetched = true;
          return new Response(CONTENT, { status: 200 });
        },
      }),
    ).rejects.toThrow(/No pinned size and checksum/);
    expect(fetched).toBe(false);
  });
});

// Real USTAR archives compressed with Python's bz2 module. Model files contain
// short text fixtures; no encoder or system bzip2 is needed to run these tests.
const STT_ARCHIVE = Buffer.from('QlpoOTFBWSZTWYnMogsAATrZgcqQRgv/wH9730AAAwgIMAEYAY00GgBk0BkaaGJowxpoNADJoDI00MTRgVRTSYmgg2o0emkANojTr0jPsKRJN0SInREIh29+iqhyMC8b1jYSWCEhPoSWxnUbDUbTI5FZ6F5pjjF8mBWZZKiGJtKhDHHFWQsjjv4LpTG/oVw0FK6S13HE4KThEVnMwKFRec+CevviWlx9OZaW20Vq5TyNJiZGp3RwORr1+pY0osM1IiiqI1xHQ5nRubI0m4k1F6JP0qL39nPXQZ7y0tiPAvMMLTb2HUsLoimBkQf4u5IpwoSETmUQWA==', 'base64');
const TTS_ARCHIVE = Buffer.from('QlpoOTFBWSZTWVojbVMAAPH/gcqQEABAA++QIAACAOet38AAAYgIMADYBjRo0AyZDRiNNA0wMaNGgGTIaMRpoGmAkkFT9MSTTxCZNo1A9J+qPU2tXXcYRHDUGQk6SBIYyd9rIlUUd3BlK5MgQwLMcGtNOgfEFBdws90nr1KLrg5JRTCS455QSWLonMYkZ8CvldC5os8gOHHYO4Yh1CC9wz+g6OT+IaczxQYOWJq8LLUnYLFQxBnbye88YBpYNpq9TC8pRM965RmrsaKJe+qqfq/ttsA9JBKp7IQf4u5IpwoSC0RtqmA=', 'base64');
const TRUNCATED_TAR_ARCHIVE = Buffer.from('QlpoOTFBWSZTWVw6dJwAADvZgMqARAPfwH5r30AIACAAdBqnoTJo0NGmmgDJkGhTJkNNGgA0aA9pCAnHJ84W01gwDHbG4yVmyrIPmvMhByAhBCCskazdBCnwaDyacypBwRE/FPIxnjDlFRmD4XCcxYnMlrImUIywxNCOH/i7kinChILh06Tg', 'base64');
const MISSING_FILES_ARCHIVE = Buffer.from('QlpoOTFBWSZTWX2dSkYAAI55gMqQEABEA9/Af2vfQAgIIACUhpMUanqBtQ2gCDTan6UGiTRtQAAGgGgPvZQogQDFkCBCc3UoGRG+ACBgNUID7SPFy2wpkO6XuIS5mCEjILauTW5q/HOIScUN8x4C1brT1sN9L2jhPSsksH4dAzCFfZ0IB1DY4pxHV+0qJULMSIgPxdyRThQkH2dSkYA=', 'base64');

const installerScript = `
  import { createHash } from 'node:crypto';
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
  // The cached fixture stands in for the real archive; pin it so the
  // installer reuses it instead of downloading the real one.
  const catalogSpec = getLocalSttModelSpec(modelId);
  const cached = await readFile(path.join(modelsDir, '.downloads', path.basename(new URL(catalogSpec.archiveUrl).pathname)));
  const spec = { ...catalogSpec, bytes: cached.length, sha256: createHash('sha256').update(cached).digest('hex') };
  try {
    modelDir = await ensureLocalSttModel({ modelsDir, modelId, spec });
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
    const result = spawnSync(process.execPath, ['--import', new URL('../../../../scripts/register-server-sources.mjs', import.meta.url).href, '--input-type=module', '-e', installerScript, modelsDir, modelId, decoderPath, platform], {
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

describe('extractTarArchive', () => {
  it('preserves UTF-8 characters split across stderr chunks', async () => {
    const archive = tempFile();
    const text = 'tar: failed to extract "model-€-name.onnx"\n';
    const bytes = Buffer.from(text);
    const euro = bytes.indexOf(Buffer.from('€'));
    const spawnImpl = fakeTarSpawn([bytes.subarray(0, euro + 1), bytes.subarray(euro + 1)], 2);

    await expect(extractTarArchive(archive, `${archive}-output`, 1_000, spawnImpl))
      .rejects.toThrow('tar exited with code 2: tar: failed to extract "model-€-name.onnx"');
  });

  it('bounds the stderr tail without retaining half of a surrogate pair', async () => {
    const archive = tempFile();
    const stderr = `a💩${'x'.repeat(4095)}`;
    const spawnImpl = fakeTarSpawn([Buffer.from(stderr)], 2);
    let failure;
    try {
      await extractTarArchive(archive, `${archive}-output`, 1_000, spawnImpl);
    } catch (error) {
      failure = error;
    }

    expect(failure?.message).toBe(`tar exited with code 2: ${'x'.repeat(4095)}`);
    expect(failure?.message).not.toMatch(/[\uD800-\uDFFF]/);
  });
});

describe('archiveMatchesPins', () => {
  it('returns true when size and checksum both match the pins', async () => {
    const file = tempFile();
    fs.writeFileSync(file, CONTENT);
    await expect(archiveMatchesPins(file, PINS)).resolves.toBe(true);
  });

  it('returns false when the size differs from the pin', async () => {
    const file = tempFile();
    fs.writeFileSync(file, CONTENT.subarray(0, 4));
    await expect(archiveMatchesPins(file, PINS)).resolves.toBe(false);
  });

  it('returns false when the size matches but the checksum differs', async () => {
    const file = tempFile();
    fs.writeFileSync(file, Buffer.from('x'.repeat(CONTENT.length)));
    await expect(archiveMatchesPins(file, PINS)).resolves.toBe(false);
  });

  it('returns false for a missing file', async () => {
    const file = tempFile();
    await expect(archiveMatchesPins(file, PINS)).resolves.toBe(false);
  });
});

describe('ensureLocalSttModel cached archive', () => {
  const FAKE_SPEC = {
    archiveUrl: 'https://example.test/fake-model.tar.bz2',
    extractedDir: 'fake-model',
    requiredFiles: ['model.onnx'],
    ...PINS,
  };

  function setup(cachedBytes) {
    const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-downloader-models-'));
    const downloadsDir = path.join(modelsDir, '.downloads');
    fs.mkdirSync(downloadsDir, { recursive: true });
    if (cachedBytes) {
      fs.writeFileSync(path.join(downloadsDir, 'fake-model.tar.bz2'), cachedBytes);
    }
    return modelsDir;
  }

  async function fakeExtract(_archivePath, destDir) {
    const dir = path.join(destDir, FAKE_SPEC.extractedDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'model.onnx'), 'fake weights');
  }

  it('reuses a cached archive that matches the pins without fetching', async () => {
    const modelsDir = setup(CONTENT);
    let fetched = false;
    const modelDir = await ensureLocalSttModel({
      modelsDir,
      modelId: 'fake-model',
      spec: FAKE_SPEC,
      extractImpl: fakeExtract,
      fetchImpl: async () => {
        fetched = true;
        return new Response(CONTENT, { status: 200 });
      },
    });
    expect(modelDir).toBe(path.join(modelsDir, 'fake-model'));
    expect(fetched).toBe(false);
    expect(fs.readFileSync(path.join(modelDir, 'model.onnx'), 'utf8')).toBe('fake weights');
  });

  it('discards a cached archive that fails the pins and re-downloads it', async () => {
    const modelsDir = setup(Buffer.from('corrupt cached bytes'));
    let fetched = false;
    const modelDir = await ensureLocalSttModel({
      modelsDir,
      modelId: 'fake-model',
      spec: FAKE_SPEC,
      extractImpl: fakeExtract,
      fetchImpl: async () => {
        fetched = true;
        return new Response(CONTENT, { status: 200 });
      },
    });
    expect(modelDir).toBe(path.join(modelsDir, 'fake-model'));
    expect(fetched).toBe(true);
    expect(fs.readFileSync(path.join(modelDir, 'model.onnx'), 'utf8')).toBe('fake weights');
  });
});

describe.skipIf(process.platform === 'win32')('ensureLocalSttModel hung tar', () => {
  const HUNG_SPEC = {
    archiveUrl: 'https://example.test/fake-model.tar.bz2',
    extractedDir: 'fake-model',
    requiredFiles: ['model.onnx'],
    ...PINS,
  };

  function setupWithCachedArchive() {
    const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-downloader-hung-'));
    const downloadsDir = path.join(modelsDir, '.downloads');
    fs.mkdirSync(downloadsDir, { recursive: true });
    fs.writeFileSync(path.join(downloadsDir, 'fake-model.tar.bz2'), CONTENT);
    return modelsDir;
  }

  function installFakeTar(scriptBody) {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-tar-bin-'));
    fs.writeFileSync(path.join(binDir, 'tar'), `#!/bin/sh\n${scriptBody}\n`, { mode: 0o755 });
    return binDir;
  }

  async function withFakeTar(binDir, extraEnv, run) {
    const prevPath = process.env.PATH;
    const prevEnv = {};
    for (const key of Object.keys(extraEnv)) {
      prevEnv[key] = process.env[key];
      process.env[key] = extraEnv[key];
    }
    process.env.PATH = `${binDir}:${prevPath}`;
    try {
      await run();
    } finally {
      process.env.PATH = prevPath;
      for (const [key, value] of Object.entries(prevEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  it('kills a tar that never exits and rejects within the bound', async () => {
    const modelsDir = setupWithCachedArchive();
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-tar-pid-')), 'tar.pid');
    const binDir = installFakeTar('echo $$ > "$FAKE_TAR_PIDFILE"\nexec sleep 60');
    await withFakeTar(binDir, { FAKE_TAR_PIDFILE: pidFile }, async () => {
      const started = Date.now();
      // Long enough for the fake tar to start and record its pid before the
      // kill; 100ms lost that race under load.
      await expect(
        ensureLocalSttModel({ modelsDir, modelId: 'fake-model', spec: HUNG_SPEC, extractTimeoutMs: 1_000 }),
      ).rejects.toThrow(/timed out/);
      expect(Date.now() - started).toBeLessThan(5_000);
    });
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('recovers after a hung-tar rejection: a retry re-downloads and installs', async () => {
    const modelsDir = setupWithCachedArchive();
    const binDir = installFakeTar('exec sleep 60');
    await withFakeTar(binDir, {}, async () => {
      await expect(
        ensureLocalSttModel({ modelsDir, modelId: 'fake-model', spec: HUNG_SPEC, extractTimeoutMs: 100 }),
      ).rejects.toThrow(/timed out/);
    });
    // The timed-out extraction discarded the cached archive, so the retry
    // (the dictation service clears its download state on rejection) goes
    // back to the download and can succeed with a working extraction.
    let fetched = false;
    const modelDir = await ensureLocalSttModel({
      modelsDir,
      modelId: 'fake-model',
      spec: HUNG_SPEC,
      extractImpl: async (_archivePath, destDir) => {
        const dir = path.join(destDir, HUNG_SPEC.extractedDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'model.onnx'), 'fake weights');
      },
      fetchImpl: async () => {
        fetched = true;
        return new Response(CONTENT, { status: 200 });
      },
    });
    expect(fetched).toBe(true);
    expect(fs.readFileSync(path.join(modelDir, 'model.onnx'), 'utf8')).toBe('fake weights');
  });
});
it('downloads a Node fetch body through fromWeb and reports byte progress', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'oc-model-download-'));
  const modelId = 'parakeet-tdt-0.6b-v3-int8';
  // The fixture stands in for the real archive, so the pins are the fixture's.
  const spec = { ...getLocalSttModelSpec(modelId), bytes: STT_ARCHIVE.length, sha256: createHash('sha256').update(STT_ARCHIVE).digest('hex') };
  const nativeFetch = globalThis.fetch;
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const response = await nativeFetch(`data:application/octet-stream;base64,${STT_ARCHIVE.toString('base64')}`);
    expect(response.body).toBeInstanceOf(ReadableStream);
    return response;
  });
  try {
    const progress = [];
    const modelDir = await ensureLocalSttModel({
      modelsDir: root,
      modelId,
      spec,
      onProgress: (downloadedBytes, totalBytes) => progress.push([downloadedBytes, totalBytes]),
    });
    expect(modelDir).toBe(path.join(root, spec.extractedDir));
    expect(await isLocalSttModelInstalled(root, modelId)).toBe(true);
    expect(progress.at(-1)).toEqual([STT_ARCHIVE.length, STT_ARCHIVE.length]);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(spec.archiveUrl, { signal: expect.any(AbortSignal) });
  } finally {
    fetchMock.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
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
