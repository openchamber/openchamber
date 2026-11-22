
import { createHash } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, rename, rm, stat } from 'fs/promises';
import path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';
import { StringDecoder } from 'node:string_decoder';

import { getLocalSttModelSpec } from './model-catalog.js';
import type { NodeFetch } from './node-fetch.js';

// A download that delivers no bytes for this long is stalled, not slow:
// model archives are large, so the bound is on silence, not on total time —
// a slow connection that keeps delivering bytes is never cut off.
const DOWNLOAD_STALL_TIMEOUT_MS = 60_000;

// Extraction gets a total bound, not a stall bound: unlike the download,
// it produces no progress signal this process can watch (tar writes files
// directly and stays silent on success), so silence cannot tell a hung
// tar from a slow one. The bound is set far above any real extraction -
// the largest catalog archives unpack in well under a minute on slow
// hardware - so only a genuinely wedged tar (or its bzip2 child) ever
// reaches it. Without it a hung tar never settles ensureLocalSttModel,
// and the dictation service keeps the model in "downloading" state until
// the server restarts.
const TAR_EXTRACT_TIMEOUT_MS = 600_000;

declare const fetch: NodeFetch;

export type ModelDownloadProgress = (downloadedBytes: number, totalBytes: number | null) => void;

export interface EnsureLocalSttModelOptions {
  modelsDir: string;
  modelId: string;
  onProgress?: ModelDownloadProgress;
  fetchImpl?: NodeFetch;
  spec?: ReturnType<typeof getLocalSttModelSpec>;
  extractImpl?: (archivePath: string, destDir: string, extractTimeoutMs?: number) => Promise<void>;
  extractTimeoutMs?: number;
}

async function hasRequiredFiles(modelDir: string, requiredFiles: string[]) {
  const results = await Promise.all(
    requiredFiles.map(async (rel) => {
      try {
        const s = await stat(path.join(modelDir, rel));
        if (s.isDirectory()) {
          return true;
        }
        return s.isFile() && s.size > 0;
      } catch {
        return false;
      }
    }),
  );
  return results.every(Boolean);
}

/**
 * Downloads `url` to `outputPath`, enforcing the catalog's pinned size and
 * SHA-256 for the archive. The pinned size is known before the fetch, so an
 * over-long body is refused the moment it passes that size instead of being
 * written to disk in full: a broken or hostile endpoint could otherwise fill
 * the disk without bound. The file lands at `outputPath` only when its size
 * and digest both match the pins; anything else is discarded. A model with
 * no pins is never downloaded.
 *
 * @param {string} url
 * @param {string} outputPath
 * @param {((downloadedBytes: number, totalBytes: number | null) => void) | undefined} onProgress
 * @param {{ bytes?: number, sha256?: string, fetchImpl?: typeof fetch, stallTimeoutMs?: number }} [expected]
 */
export async function downloadToFile(
  url: string,
  outputPath: string,
  onProgress: ((downloadedBytes: number, totalBytes: number | null) => void) | undefined,
  expected: { bytes?: number | undefined; sha256?: string | undefined; fetchImpl?: (url: string, init: { signal: AbortSignal }) => Promise<Response>; stallTimeoutMs?: number } = {},
) {
  const { bytes, sha256, fetchImpl = fetch, stallTimeoutMs = DOWNLOAD_STALL_TIMEOUT_MS } = expected;
  if (bytes === undefined || !Number.isInteger(bytes) || bytes <= 0 || !/^[0-9a-f]{64}$/.test(sha256 ?? '')) {
    throw new Error(`No pinned size and checksum for ${url}, so it cannot be downloaded safely`);
  }

  let downloadedBytes = 0;
  const digest = createHash('sha256');

  // Stall bound for the whole transfer: the timer is armed before the
  // fetch (so a response that never arrives counts) and re-armed on every
  // chunk. Firing aborts the fetch through its signal and destroys the
  // verify stream, so the pipeline rejects even when a body ignores its
  // signal. A local timer is used instead of a fixed overall deadline
  // because these archives are large: total time is legitimately
  // unbounded, silence is not.
  const controller = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let streaming = false;
  const verify = new Transform({
    transform(chunk, _encoding, callback) {
      armStallTimer();
      downloadedBytes += chunk.length;
      if (downloadedBytes > bytes) {
        callback(new Error(`The download from ${url} was larger than the expected ${bytes} bytes, so it was discarded; try again`));
        return;
      }
      digest.update(chunk);
      if (typeof onProgress === 'function') {
        onProgress(downloadedBytes, bytes);
      }
      callback(null, chunk);
    },
  });
  const armStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      const error = new Error(
        `The download from ${url} timed out after ${Math.round(stallTimeoutMs / 1000)} seconds without receiving data, so it was discarded; try again`,
      );
      controller.abort(error);
      // Destroying a stream nothing is consuming yet would surface as an
      // unhandled 'error' event; before the pipeline starts, the abort
      // alone ends the fetch.
      if (streaming) verify.destroy(error);
    }, stallTimeoutMs);
    stallTimer.unref?.();
  };

  try {
    armStallTimer();
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
    }
    if (!res.body) {
      throw new Error(`Failed to download ${url}: missing response body`);
    }

    const tmpPath = `${outputPath}.tmp-${Date.now()}`;
    await mkdir(path.dirname(outputPath), { recursive: true });

    try {
      streaming = true;
      await pipeline(Readable.fromWeb(res.body), verify, createWriteStream(tmpPath));
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }
    if (downloadedBytes !== bytes) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw new Error(`The download from ${url} was incomplete (${downloadedBytes} of ${bytes} bytes), so it was discarded; try again`);
    }
    if (digest.digest('hex') !== sha256) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw new Error(`The download from ${url} did not match its pinned checksum, so it was discarded; try again`);
    }
    await rename(tmpPath, outputPath);
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
  }
}

/**
 * Whether a previously downloaded archive still matches its pins. A cached
 * archive that does not is discarded by the caller and re-downloaded: bytes
 * cached before the pins existed, or written by anything else, are not
 * trusted just because the file is non-empty.
 *
 * @param {string} archivePath
 * @param {{ bytes?: number, sha256?: string }} expected
 * @returns {Promise<boolean>}
 */
export async function archiveMatchesPins(archivePath: string, expected: { bytes?: number | undefined; sha256?: string | undefined }) {
  try {
    const s = await stat(archivePath);
    if (!s.isFile() || s.size !== expected.bytes) {
      return false;
    }
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(archivePath)) {
      digest.update(chunk);
    }
    return digest.digest('hex') === expected.sha256;
  } catch {
    return false;
  }
}

export function describeTarFailure(code: number | null, stderr: string) {
  const detail = String(stderr || '').trim();
  if (/bzip2/i.test(detail)) {
    return 'Extracting voice models needs the bzip2 program. Install it (for example: apt-get install bzip2) and try again.';
  }
  const lastLine = detail.split(/\r?\n/).filter(Boolean).pop();
  return lastLine ? `tar exited with code ${code}: ${lastLine}` : `tar exited with code ${code}`;
}

function appendStderrTail(stderr: string, decoded: string) {
  const combined = stderr + decoded;
  let start = Math.max(0, combined.length - 4096);
  const firstCodeUnit = combined.charCodeAt(start);
  if (start > 0 && firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff) {
    start += 1;
  }
  return combined.slice(start);
}

async function runArchiveTool(
  command: string,
  args: string[],
  describeFailure: (code: number | null, stderr: string) => string,
  archivePath: string,
  timeoutMs: number,
  spawnImpl: typeof spawn,
) {
  await new Promise<void>((resolve, reject) => {
    const child = spawnImpl(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      // Own process group (where the platform has them) so the timeout
      // kill takes tar's decompressor child with it instead of leaving
      // an orphaned bzip2 behind.
      detached: process.platform !== 'win32',
    });
    let stderr = '';
    const stderrDecoder = new StringDecoder('utf8');
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid === undefined) throw new Error('no pid');
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone; the close handler settles the promise.
        }
      }
    }, timeoutMs);
    timer.unref?.();
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendStderrTail(stderr, stderrDecoder.write(chunk));
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      stderr = appendStderrTail(stderr, stderrDecoder.end());
      if (timedOut) {
        reject(
          new Error(
            `Extracting ${path.basename(archivePath)} timed out after ${Math.round(timeoutMs / 1000)} seconds and was killed; try again`,
          ),
        );
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(describeFailure(code, stderr)));
      }
    });
  });
}

export async function extractTarArchive(archivePath: string, destDir: string, timeoutMs = TAR_EXTRACT_TIMEOUT_MS, spawnImpl: typeof spawn = spawn) {
  await mkdir(destDir, { recursive: true });

  let tarPath = archivePath;
  if (process.platform === 'win32') {
    const { default: sevenZip } = await import('7zip-bin');
    const decoderPath = sevenZip.path7za.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    await runArchiveTool(decoderPath, ['x', '-tbzip2', '-y', '-bso0', '-bsp0', archivePath, `-o${destDir}`], (code, stderr) => {
      const detail = stderr.trim();
      return detail ? `7-Zip exited with code ${code}: ${detail}` : `7-Zip exited with code ${code}`;
    }, archivePath, timeoutMs, spawnImpl);
    tarPath = path.join(destDir, path.basename(archivePath, '.bz2'));
  }

  await runArchiveTool('tar', ['xf', tarPath, '-C', destDir], describeTarFailure, archivePath, timeoutMs, spawnImpl);
}

export async function isLocalSttModelInstalled(modelsDir: string, modelId: string) {
  const spec = getLocalSttModelSpec(modelId);
  return hasRequiredFiles(path.join(modelsDir, spec.extractedDir), spec.requiredFiles);
}

/**
 * Ensure a model is downloaded and extracted. Resolves with the model dir.
 *
 * Extraction is staged: the archive unpacks into a temporary directory and is
 * verified before being renamed into place. An interrupted or failed tar must
 * never leave partial files at the final path — the installed check only
 * verifies file presence, so a truncated .onnx there would be treated as an
 * installed model forever ("Protobuf parsing failed" at load time).
 *
 * `fetchImpl`, `spec`, `extractImpl` and `extractTimeoutMs` are test seams:
 * production callers omit them and get the global fetch, the catalog spec and
 * the system tar extraction.
 */
export async function ensureLocalSttModel({ modelsDir, modelId, onProgress, fetchImpl, spec: specOverride, extractImpl = extractTarArchive, extractTimeoutMs = TAR_EXTRACT_TIMEOUT_MS }: EnsureLocalSttModelOptions) {
  const spec = specOverride ?? getLocalSttModelSpec(modelId);
  const modelDir = path.join(modelsDir, spec.extractedDir);
  if (await hasRequiredFiles(modelDir, spec.requiredFiles)) {
    return modelDir;
  }

  await rm(modelDir, { recursive: true, force: true }).catch(() => undefined);

  const downloadsDir = path.join(modelsDir, '.downloads');
  const archiveFilename = path.basename(new URL(spec.archiveUrl).pathname);
  const archivePath = path.join(downloadsDir, archiveFilename);

  if (!(await archiveMatchesPins(archivePath, spec))) {
    await rm(archivePath, { force: true }).catch(() => undefined);
    await downloadToFile(spec.archiveUrl, archivePath, onProgress, { bytes: spec.bytes, sha256: spec.sha256, ...(fetchImpl ? { fetchImpl } : {}) });
  }

  const stagingDir = path.join(modelsDir, `.staging-${spec.extractedDir}-${Date.now()}`);
  try {
    await extractImpl(archivePath, stagingDir, extractTimeoutMs);

    const stagedModelDir = path.join(stagingDir, spec.extractedDir);
    if (!(await hasRequiredFiles(stagedModelDir, spec.requiredFiles))) {
      await rm(archivePath, { force: true }).catch(() => undefined);
      throw new Error(
        `Extracted ${archiveFilename}, but required model files are missing or empty. The archive was discarded; retry to re-download.`,
      );
    }

    await rename(stagedModelDir, modelDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(archivePath, { force: true }).catch(() => undefined);
    throw error;
  }
  await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);

  await rm(archivePath, { force: true }).catch(() => undefined);

  return modelDir;
}
