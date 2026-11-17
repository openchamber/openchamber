import { createHash } from 'crypto';
import { EventEmitter } from 'node:events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { archiveMatchesPins, describeTarFailure, downloadToFile, ensureLocalSttModel, extractTarArchive } from './model-downloader.js';

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
      await expect(
        ensureLocalSttModel({ modelsDir, modelId: 'fake-model', spec: HUNG_SPEC, extractTimeoutMs: 100 }),
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
