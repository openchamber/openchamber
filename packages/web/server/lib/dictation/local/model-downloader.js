
import { createWriteStream } from 'fs';
import { mkdir, rename, rm, stat } from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';

import { getLocalSttModelSpec } from './model-catalog.js';

async function hasRequiredFiles(modelDir, requiredFiles) {
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

async function downloadToFile(url, outputPath, onProgress) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error(`Failed to download ${url}: missing response body`);
  }

  const totalBytes = Number.parseInt(res.headers.get('content-length') || '', 10) || null;
  let downloadedBytes = 0;

  const tmpPath = `${outputPath}.tmp-${Date.now()}`;
  await mkdir(path.dirname(outputPath), { recursive: true });

  const nodeStream = Readable.fromWeb(res.body);
  if (typeof onProgress === 'function') {
    nodeStream.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      onProgress(downloadedBytes, totalBytes);
    });
  }

  try {
    await pipeline(nodeStream, createWriteStream(tmpPath));
    await rename(tmpPath, outputPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

// external: #2887 GNU tar can require an absent bzip2 executable; report that dependency when extraction fails.
export function describeTarFailure(code, stderr) {
  const detail = String(stderr || '').trim();
  if (/bzip2/i.test(detail)) {
    return 'Extracting voice models needs the bzip2 program. Install it (for example: apt-get install bzip2) and try again.';
  }
  const lastLine = detail.split(/\r?\n/).filter(Boolean).pop();
  return lastLine ? `tar exited with code ${code}: ${lastLine}` : `tar exited with code ${code}`;
}

async function runArchiveTool(command, args, describeFailure) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4096);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(describeFailure(code, stderr)));
      }
    });
  });
}

async function extractTarArchive(archivePath, destDir) {
  await mkdir(destDir, { recursive: true });

  let tarPath = archivePath;
  if (process.platform === 'win32') {
    const { default: sevenZip } = await import('7zip-bin');
    // external: https://www.electronjs.org/docs/latest/tutorial/asar-archives#executing-binaries-inside-asar-archive Spawned executables must be outside app.asar.
    const decoderPath = sevenZip.path7za.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    await runArchiveTool(decoderPath, ['x', '-tbzip2', '-y', '-bso0', '-bsp0', archivePath, `-o${destDir}`], (code, stderr) => {
      const detail = stderr.trim();
      return detail ? `7-Zip exited with code ${code}: ${detail}` : `7-Zip exited with code ${code}`;
    });
    tarPath = path.join(destDir, path.basename(archivePath, '.bz2'));
  }

  await runArchiveTool('tar', ['xf', tarPath, '-C', destDir], describeTarFailure);
}

async function isNonEmptyFile(filePath) {
  try {
    const s = await stat(filePath);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

/**
 * Check whether a model is fully installed (all required files present).
 * @param {string} modelsDir
 * @param {string} modelId
 * @returns {Promise<boolean>}
 */
export async function isLocalSttModelInstalled(modelsDir, modelId) {
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
 * @param {{ modelsDir: string, modelId: string,
 *           onProgress?: (downloadedBytes: number, totalBytes: number | null) => void }} options
 * @returns {Promise<string>}
 */
export async function ensureLocalSttModel({ modelsDir, modelId, onProgress }) {
  const spec = getLocalSttModelSpec(modelId);
  const modelDir = path.join(modelsDir, spec.extractedDir);
  if (await hasRequiredFiles(modelDir, spec.requiredFiles)) {
    return modelDir;
  }

  await rm(modelDir, { recursive: true, force: true }).catch(() => undefined);

  const downloadsDir = path.join(modelsDir, '.downloads');
  const archiveFilename = path.basename(new URL(spec.archiveUrl).pathname);
  const archivePath = path.join(downloadsDir, archiveFilename);

  if (!(await isNonEmptyFile(archivePath))) {
    await downloadToFile(spec.archiveUrl, archivePath, onProgress);
  }

  const stagingDir = path.join(modelsDir, `.staging-${spec.extractedDir}-${Date.now()}`);
  try {
    await extractTarArchive(archivePath, stagingDir);

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
