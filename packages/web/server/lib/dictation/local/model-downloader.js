/**
 * Downloads and extracts local sherpa-onnx STT model archives.
 * Archives (.tar.bz2) come from the k2-fsa GitHub releases and are extracted
 * with a pure-JS pipeline (unbzip2-stream + tar-stream) so extraction never
 * depends on a system `tar`/`bzip2` pair being installed.
 */

import { createReadStream, createWriteStream } from 'fs';
import { mkdir, rename, rm, stat } from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

import unbzip2Stream from 'unbzip2-stream';
import tar from 'tar-stream';

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

async function extractTarArchive(archivePath, destDir) {
  await mkdir(destDir, { recursive: true });

  // Pure-JS extraction: bzip2 decompression (unbzip2-stream) feeds the tar
  // parser (tar-stream). Avoids the system `tar`/`bzip2` dependency that
  // breaks downloads on minimal Linux hosts (issue #2887). Entries are
  // confined to destDir (path traversal is rejected via path.relative) and
  // only regular files/directories are materialized — links, devices and
  // FIFOs are skipped so a hostile or broken archive cannot escape the
  // staging dir or leave broken entries behind.
  const resolvedDest = path.resolve(destDir);
  const readStream = createReadStream(archivePath);
  const bz2 = unbzip2Stream();
  const extract = tar.extract();

  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      // Tear the whole pipeline down: tar-stream requires next() per entry,
      // and a write failure without destroying the extract stream would
      // leave the pipeline hanging with the archive fd open.
      readStream.destroy();
      bz2.destroy();
      extract.destroy();
      reject(error);
    };

    extract.on('entry', (header, stream, next) => {
      const resolvedTarget = path.resolve(resolvedDest, header.name);
      const rel = path.relative(resolvedDest, resolvedTarget);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        stream.resume();
        next();
        return;
      }
      if (header.type === 'directory') {
        stream.resume();
        void mkdir(resolvedTarget, { recursive: true }).then(() => next(), (e) => fail(new Error('mkdir-dir: ' + String(e))));
        return;
      }
      if (header.type !== 'file') {
        // Symlink/hardlink/device/FIFO entries: never materialize links from
        // archives (unvalidated link targets could escape destDir).
        stream.resume();
        next();
        return;
      }
      void mkdir(path.dirname(resolvedTarget), { recursive: true })
        .then(() => {
          const out = createWriteStream(resolvedTarget);
          out.on('error', fail);
          stream.on('error', fail);
          out.on('finish', () => {
            // Drop this entry's listeners before proceeding: a late error
            // from a finished entry must not destroy the extraction of the
            // next one.
            out.removeListener('error', fail);
            stream.removeListener('error', fail);
            next();
          });
          stream.pipe(out);
        }, fail);
    });
    extract.on('error', fail);
    extract.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    pipeline(readStream, bz2, extract).catch(fail);
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

  // A directory that exists but fails the required-files check is a partial
  // extraction from an earlier interrupted attempt — remove it before retrying.
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
      // Bad archive (truncated download / corrupt cache): drop it so the next
      // attempt re-downloads instead of re-extracting the same broken bytes.
      await rm(archivePath, { force: true }).catch(() => undefined);
      throw new Error(
        `Extracted ${archiveFilename}, but required model files are missing or empty. The archive was discarded; retry to re-download.`,
      );
    }

    await rename(stagedModelDir, modelDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    // Any extraction failure means the cached archive can't be trusted
    // (corrupt bz2, truncated download). Discard it so retry re-downloads.
    await rm(archivePath, { force: true }).catch(() => undefined);
    throw error;
  }
  await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);

  await rm(archivePath, { force: true }).catch(() => undefined);

  return modelDir;
}
