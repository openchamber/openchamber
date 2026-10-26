import fs from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const LOCAL_FILE = 0x04034b50;
const CENTRAL_DIR = 0x02014b50;
const MAX_FILES = 500;
const MAX_UNCOMPRESSED = 40 * 1024 * 1024;
const COMPRESSION_STORE = 0;
const COMPRESSION_DEFLATE = 8;

const readU16 = (buffer, offset) => buffer.readUInt16LE(offset);
const readU32 = (buffer, offset) => buffer.readUInt32LE(offset);

const isSafeZipName = (name) => {
  if (!name || name.includes('\0') || name.includes('\\')) {
    return false;
  }
  if (name.startsWith('/') || name.startsWith('./')) {
    return false;
  }
  const segments = name.split('/');
  return !segments.some((segment) => segment === '..');
};

/** Extract a zip buffer into dest. Rejects traversal, zip64, encryption, and data descriptors. */
export const extractZipBuffer = async (buffer, destRoot) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    return { ok: false, code: 'extract-failed' };
  }
  await fs.mkdir(destRoot, { recursive: true });
  const destReal = await fs.realpath(destRoot);
  let offset = 0;
  let files = 0;
  let uncompressedTotal = 0;

  while (offset + 4 <= buffer.length) {
    const signature = readU32(buffer, offset);
    if (signature === CENTRAL_DIR) {
      return { ok: true };
    }
    if (signature !== LOCAL_FILE) {
      return { ok: false, code: 'extract-failed' };
    }
    if (offset + 30 > buffer.length) {
      return { ok: false, code: 'extract-failed' };
    }
    const flags = readU16(buffer, offset + 6);
    const method = readU16(buffer, offset + 8);
    const compressedSize = readU32(buffer, offset + 18);
    const uncompressedSize = readU32(buffer, offset + 22);
    const nameLen = readU16(buffer, offset + 26);
    const extraLen = readU16(buffer, offset + 28);
    if ((flags & 0x0001) !== 0 || (flags & 0x0008) !== 0) {
      return { ok: false, code: 'extract-failed' };
    }
    if (method !== COMPRESSION_STORE && method !== COMPRESSION_DEFLATE) {
      return { ok: false, code: 'extract-failed' };
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      return { ok: false, code: 'extract-failed' };
    }
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLen;
    const dataStart = nameEnd + extraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) {
      return { ok: false, code: 'extract-failed' };
    }
    const name = buffer.subarray(nameStart, nameEnd).toString('utf8');
    offset = dataEnd;
    if (name.endsWith('/')) {
      continue;
    }
    if (!isSafeZipName(name)) {
      return { ok: false, code: 'extract-failed' };
    }
    files += 1;
    uncompressedTotal += uncompressedSize;
    if (files > MAX_FILES || uncompressedTotal > MAX_UNCOMPRESSED) {
      return { ok: false, code: 'extract-failed' };
    }
    let data;
    try {
      const payload = buffer.subarray(dataStart, dataEnd);
      // The declared size is already within the archive budget; capping the
      // inflate at that size keeps a tiny deflate stream from expanding into
      // gigabytes before the length check below can reject it.
      data = method === COMPRESSION_STORE
        ? payload
        : inflateRawSync(payload, { maxOutputLength: Math.max(1, uncompressedSize) });
    } catch {
      return { ok: false, code: 'extract-failed' };
    }
    if (data.length !== uncompressedSize) {
      return { ok: false, code: 'extract-failed' };
    }
    const target = path.resolve(destReal, ...name.split('/'));
    if (target !== destReal && !target.startsWith(destReal + path.sep)) {
      return { ok: false, code: 'extract-failed' };
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  }
  return { ok: false, code: 'extract-failed' };
};

const exists = async (filePath) => {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
};

/** If the extract has one root folder and package.json is inside it, use that folder. */
export const unwrapGuestRoot = async (extracted) => {
  if (await exists(path.join(extracted, 'package.json'))) {
    return extracted;
  }
  const names = await fs.readdir(extracted);
  if (names.length !== 1) {
    return extracted;
  }
  const inner = path.join(extracted, names[0]);
  try {
    const stat = await fs.stat(inner);
    if (stat.isDirectory() && await exists(path.join(inner, 'package.json'))) {
      return inner;
    }
  } catch {
    return extracted;
  }
  return extracted;
};
