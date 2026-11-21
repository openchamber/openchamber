
import { createWriteStream } from 'fs';
import { mkdir, rename, rm, stat } from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';

import { getLocalSttModelSpec } from './model-catalog.js';
import type { NodeFetch } from './node-fetch.js';

declare const fetch: NodeFetch;

export type ModelDownloadProgress = (downloadedBytes: number, totalBytes: number | null) => void;

export interface EnsureLocalSttModelOptions {
  modelsDir: string;
  modelId: string;
  onProgress?: ModelDownloadProgress;
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

async function downloadToFile(url: string, outputPath: string, onProgress: ModelDownloadProgress | undefined) {
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
  if (onProgress) {
    nodeStream.on('data', (chunk: Buffer) => {
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

export function describeTarFailure(code: number | null, stderr: string) {
  const detail = String(stderr || '').trim();
  if (/bzip2/i.test(detail)) {
    return 'Extracting voice models needs the bzip2 program. Install it (for example: apt-get install bzip2) and try again.';
  }
  const lastLine = detail.split(/\r?\n/).filter(Boolean).pop();
  return lastLine ? `tar exited with code ${code}: ${lastLine}` : `tar exited with code ${code}`;
}

async function runArchiveTool(command: string, args: string[], describeFailure: (code: number | null, stderr: string) => string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
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

async function extractTarArchive(archivePath: string, destDir: string) {
  await mkdir(destDir, { recursive: true });

  let tarPath = archivePath;
  if (process.platform === 'win32') {
    const { default: sevenZip } = await import('7zip-bin');
    const decoderPath = sevenZip.path7za.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    await runArchiveTool(decoderPath, ['x', '-tbzip2', '-y', '-bso0', '-bsp0', archivePath, `-o${destDir}`], (code, stderr) => {
      const detail = stderr.trim();
      return detail ? `7-Zip exited with code ${code}: ${detail}` : `7-Zip exited with code ${code}`;
    });
    tarPath = path.join(destDir, path.basename(archivePath, '.bz2'));
  }

  await runArchiveTool('tar', ['xf', tarPath, '-C', destDir], describeTarFailure);
}

async function isNonEmptyFile(filePath: string) {
  try {
    const s = await stat(filePath);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

export async function isLocalSttModelInstalled(modelsDir: string, modelId: string) {
  const spec = getLocalSttModelSpec(modelId);
  return hasRequiredFiles(path.join(modelsDir, spec.extractedDir), spec.requiredFiles);
}

export async function ensureLocalSttModel({ modelsDir, modelId, onProgress }: EnsureLocalSttModelOptions) {
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
