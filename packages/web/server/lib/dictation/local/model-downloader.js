/**
 * Downloads and extracts local sherpa-onnx STT model archives.
 * Archives (.tar.bz2) come from the k2-fsa GitHub releases and are extracted
 * with the system `tar` into the speech-models directory.
 */

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

async function downloadToFile(url, outputPath) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error(`Failed to download ${url}: missing response body`);
  }

  const tmpPath = `${outputPath}.tmp-${Date.now()}`;
  await mkdir(path.dirname(outputPath), { recursive: true });

  const nodeStream = Readable.fromWeb(res.body);

  try {
    await pipeline(nodeStream, createWriteStream(tmpPath));
    await rename(tmpPath, outputPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function extractTarArchive(archivePath, destDir) {
  await mkdir(destDir, { recursive: true });

  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['xf', archivePath, '-C', destDir], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar exited with code ${code}`));
      }
    });
  });
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
 * @param {{ modelsDir: string, modelId: string }} options
 * @returns {Promise<string>}
 */
export async function ensureLocalSttModel({ modelsDir, modelId }) {
  const spec = getLocalSttModelSpec(modelId);
  const modelDir = path.join(modelsDir, spec.extractedDir);
  if (await hasRequiredFiles(modelDir, spec.requiredFiles)) {
    return modelDir;
  }

  const downloadsDir = path.join(modelsDir, '.downloads');
  const archiveFilename = path.basename(new URL(spec.archiveUrl).pathname);
  const archivePath = path.join(downloadsDir, archiveFilename);

  if (!(await isNonEmptyFile(archivePath))) {
    await downloadToFile(spec.archiveUrl, archivePath);
  }

  await extractTarArchive(archivePath, modelsDir);

  if (!(await hasRequiredFiles(modelDir, spec.requiredFiles))) {
    throw new Error(
      `Downloaded and extracted ${archiveFilename}, but required files are still missing in ${modelDir}`,
    );
  }

  await rm(archivePath, { force: true }).catch(() => undefined);

  return modelDir;
}
