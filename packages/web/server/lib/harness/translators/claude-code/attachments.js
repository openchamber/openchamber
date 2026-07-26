/**
 * Map OpenChamber attached files → Claude Agent SDK content blocks.
 * Supports data: URLs and sandboxed file:// paths under the project cwd.
 * Rejects opaque binaries; never logs attachment contents.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TURN_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

const TEXT_LIKE_MIME_PREFIXES = ['text/'];
const TEXT_LIKE_MIME = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/x-sh',
  'application/ld+json',
  'image/svg+xml',
]);

const EXTENSION_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.json', 'application/json'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
  ['.ts', 'text/plain'],
  ['.tsx', 'text/plain'],
  ['.js', 'text/plain'],
  ['.jsx', 'text/plain'],
  ['.py', 'text/plain'],
  ['.rs', 'text/plain'],
  ['.go', 'text/plain'],
  ['.css', 'text/css'],
  ['.html', 'text/html'],
  ['.svg', 'image/svg+xml'],
  ['.sh', 'text/x-sh'],
  ['.toml', 'application/toml'],
  ['.xml', 'application/xml'],
]);

/**
 * @typedef {{ mime?: string, url?: string, filename?: string }} AttachedFile
 */

/**
 * @param {string} mime
 * @returns {boolean}
 */
export function isImageMime(mime) {
  return IMAGE_MIME.has(String(mime || '').toLowerCase());
}

/**
 * @param {string} mime
 * @returns {boolean}
 */
export function isTextLikeMime(mime) {
  const normalized = String(mime || '').toLowerCase();
  if (TEXT_LIKE_MIME.has(normalized)) return true;
  return TEXT_LIKE_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * @param {string} mime
 * @returns {boolean}
 */
export function isPdfMime(mime) {
  return String(mime || '').toLowerCase() === 'application/pdf';
}

/**
 * @param {string} mime
 * @returns {boolean}
 */
export function isSupportedAttachmentMime(mime) {
  return isImageMime(mime) || isTextLikeMime(mime) || isPdfMime(mime);
}

/**
 * @param {string} filename
 * @returns {string}
 */
function mimeFromFilename(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return EXTENSION_MIME.get(ext) || '';
}

/**
 * @param {string} dataUrl
 * @returns {{ mime: string, base64: string, bytes: number } | null}
 */
function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const header = dataUrl.slice(5, comma);
  const data = dataUrl.slice(comma + 1);
  const parts = header.split(';');
  const mime = (parts[0] || '').toLowerCase() || 'application/octet-stream';
  const isBase64 = parts.some((part) => part.trim() === 'base64');
  if (!isBase64) {
    // Percent-encoded payload — decode to utf-8 then re-encode as base64 for size.
    try {
      const decoded = decodeURIComponent(data);
      const base64 = Buffer.from(decoded, 'utf8').toString('base64');
      return { mime, base64, bytes: Buffer.byteLength(decoded, 'utf8') };
    } catch {
      return null;
    }
  }
  const bytes = Math.floor((data.length * 3) / 4);
  return { mime, base64: data, bytes };
}

/**
 * Resolve a file:// URL to an absolute filesystem path.
 * @param {string} url
 * @returns {string | null}
 */
export function fileUrlToPath(url) {
  if (typeof url !== 'string' || !url.startsWith('file:')) return null;
  try {
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

/**
 * Ensure a resolved path stays inside cwd (project sandbox).
 * @param {string} absolutePath
 * @param {string} cwd
 * @returns {string}
 */
export function assertPathInsideCwd(absolutePath, cwd) {
  const resolvedPath = path.resolve(absolutePath);
  const resolvedCwd = path.resolve(cwd);
  const relative = path.relative(resolvedCwd, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    const error = new Error('Attachment path is outside the project directory');
    error.code = 'ATTACHMENT_PATH_OUTSIDE_CWD';
    error.statusCode = 400;
    throw error;
  }
  return resolvedPath;
}

/**
 * @param {string} absolutePath
 * @param {{ mime?: string, filename?: string, maxBytes?: number, cwd?: string, readFileSync?: typeof fs.readFileSync, statSync?: typeof fs.statSync }} [options]
 * @returns {{ mime: string, base64: string, bytes: number, filename: string, path: string }}
 */
export function readFileAttachment(absolutePath, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : MAX_ATTACHMENT_BYTES;
  const filename = typeof options.filename === 'string' && options.filename.trim()
    ? options.filename.trim()
    : path.basename(absolutePath);
  const cwd = typeof options.cwd === 'string' && options.cwd.trim()
    ? options.cwd.trim()
    : '';
  const readFileSync = options.readFileSync || ((filePath) => fs.readFileSync(filePath));
  const statSync = options.statSync || ((filePath) => fs.statSync(filePath));

  const resolved = cwd
    ? assertPathInsideCwd(absolutePath, cwd)
    : path.resolve(absolutePath);

  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    const error = new Error(`Attachment "${filename}" could not be read`);
    error.code = 'ATTACHMENT_UNREADABLE';
    error.statusCode = 400;
    throw error;
  }
  if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()) {
    const error = new Error(`Attachment "${filename}" is not a file`);
    error.code = 'ATTACHMENT_INVALID';
    error.statusCode = 400;
    throw error;
  }
  if (Number.isFinite(stat.size) && stat.size > maxBytes) {
    const error = new Error(`Attachment "${filename}" exceeds max size of ${maxBytes} bytes`);
    error.code = 'ATTACHMENT_TOO_LARGE';
    error.statusCode = 400;
    throw error;
  }

  let buffer;
  try {
    buffer = readFileSync(resolved);
  } catch {
    const error = new Error(`Attachment "${filename}" could not be read`);
    error.code = 'ATTACHMENT_UNREADABLE';
    error.statusCode = 400;
    throw error;
  }
  if (!Buffer.isBuffer(buffer)) {
    buffer = Buffer.from(buffer);
  }
  if (buffer.byteLength > maxBytes) {
    const error = new Error(`Attachment "${filename}" exceeds max size of ${maxBytes} bytes`);
    error.code = 'ATTACHMENT_TOO_LARGE';
    error.statusCode = 400;
    throw error;
  }

  const mime = (typeof options.mime === 'string' && options.mime.trim()
    ? options.mime.trim().toLowerCase()
    : '') || mimeFromFilename(filename) || 'application/octet-stream';

  return {
    mime,
    base64: buffer.toString('base64'),
    bytes: buffer.byteLength,
    filename,
    path: resolved,
  };
}

/**
 * @param {{ mime: string, base64: string, bytes: number, filename: string }} parsed
 * @returns {{ block: Record<string, unknown>, bytes: number, filename: string }}
 */
function contentBlockFromParsed(parsed) {
  const { mime, base64, bytes, filename } = parsed;

  if (!isSupportedAttachmentMime(mime)) {
    const error = new Error(`Attachment "${filename}" type "${mime}" is not supported`);
    error.code = 'ATTACHMENT_UNSUPPORTED_TYPE';
    error.statusCode = 400;
    throw error;
  }

  if (isImageMime(mime)) {
    const mediaType = mime === 'image/jpg' ? 'image/jpeg' : mime;
    return {
      filename,
      bytes,
      block: {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: base64,
        },
      },
    };
  }

  if (isPdfMime(mime)) {
    return {
      filename,
      bytes,
      block: {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: base64,
        },
      },
    };
  }

  // Text-like: decode and send as labeled text (never log contents).
  let text;
  try {
    text = Buffer.from(base64, 'base64').toString('utf8');
  } catch {
    const error = new Error(`Attachment "${filename}" could not be decoded as text`);
    error.code = 'ATTACHMENT_INVALID';
    error.statusCode = 400;
    throw error;
  }

  return {
    filename,
    bytes,
    block: {
      type: 'text',
      text: `Attached file: ${filename}\n\n${text}`,
    },
  };
}

/**
 * @param {AttachedFile} file
 * @param {{ maxBytes?: number, cwd?: string, readFileSync?: typeof fs.readFileSync, statSync?: typeof fs.statSync }} [options]
 * @returns {{ block: Record<string, unknown>, bytes: number, filename: string }}
 */
export function mapAttachmentToContentBlock(file, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : MAX_ATTACHMENT_BYTES;
  const filename = typeof file?.filename === 'string' && file.filename.trim()
    ? file.filename.trim()
    : 'attachment';
  const declaredMime = typeof file?.mime === 'string' ? file.mime.toLowerCase() : '';
  const url = typeof file?.url === 'string' ? file.url : '';

  if (!url) {
    const error = new Error(`Attachment "${filename}" has no url`);
    error.code = 'ATTACHMENT_INVALID';
    error.statusCode = 400;
    throw error;
  }

  if (url.startsWith('data:')) {
    const parsed = parseDataUrl(url);
    if (!parsed) {
      const error = new Error(`Attachment "${filename}" could not be parsed`);
      error.code = 'ATTACHMENT_INVALID';
      error.statusCode = 400;
      throw error;
    }

    const mime = declaredMime || parsed.mime;
    if (parsed.bytes > maxBytes) {
      const error = new Error(`Attachment "${filename}" exceeds max size of ${maxBytes} bytes`);
      error.code = 'ATTACHMENT_TOO_LARGE';
      error.statusCode = 400;
      throw error;
    }

    return contentBlockFromParsed({
      mime,
      base64: parsed.base64,
      bytes: parsed.bytes,
      filename,
    });
  }

  if (url.startsWith('file:')) {
    const absolutePath = fileUrlToPath(url);
    if (!absolutePath) {
      const error = new Error(`Attachment "${filename}" file URL could not be parsed`);
      error.code = 'ATTACHMENT_INVALID';
      error.statusCode = 400;
      throw error;
    }
    if (!options.cwd) {
      const error = new Error(`Attachment "${filename}" file URL requires a project directory`);
      error.code = 'ATTACHMENT_PATH_REQUIRES_CWD';
      error.statusCode = 400;
      throw error;
    }
    const loaded = readFileAttachment(absolutePath, {
      mime: declaredMime,
      filename,
      maxBytes,
      cwd: options.cwd,
      readFileSync: options.readFileSync,
      statSync: options.statSync,
    });
    return contentBlockFromParsed(loaded);
  }

  // Absolute / relative filesystem paths (VS Code / server file pickers sometimes omit file://).
  if (path.isAbsolute(url) || url.startsWith('.')) {
    if (!options.cwd) {
      const error = new Error(`Attachment "${filename}" path requires a project directory`);
      error.code = 'ATTACHMENT_PATH_REQUIRES_CWD';
      error.statusCode = 400;
      throw error;
    }
    const absolutePath = path.isAbsolute(url) ? url : path.resolve(options.cwd, url);
    const loaded = readFileAttachment(absolutePath, {
      mime: declaredMime,
      filename,
      maxBytes,
      cwd: options.cwd,
      readFileSync: options.readFileSync,
      statSync: options.statSync,
    });
    return contentBlockFromParsed(loaded);
  }

  const error = new Error(`Attachment "${filename}" must be a data URL or project file path`);
  error.code = 'ATTACHMENT_UNSUPPORTED_URL';
  error.statusCode = 400;
  throw error;
}

/**
 * Prefer path references for project-local files (spec §11.4) when the
 * attachment is already on disk under cwd — Claude can Read it natively.
 * Clipboard/data URLs remain embedded content blocks.
 *
 * @param {AttachedFile} file
 * @param {string} cwd
 * @returns {string | null} relative path for text reference, or null to embed
 */
export function projectPathReference(file, cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  const url = typeof file?.url === 'string' ? file.url : '';
  let absolute = null;
  if (url.startsWith('file:')) {
    absolute = fileUrlToPath(url);
  } else if (path.isAbsolute(url)) {
    absolute = url;
  } else {
    return null;
  }
  if (!absolute) return null;
  try {
    const resolved = assertPathInsideCwd(absolute, cwd);
    return path.relative(path.resolve(cwd), resolved) || path.basename(resolved);
  } catch {
    return null;
  }
}

/**
 * @param {AttachedFile[] | undefined | null} files
 * @param {{ maxFileBytes?: number, maxTurnBytes?: number, cwd?: string, preferPathReferences?: boolean, readFileSync?: typeof fs.readFileSync, statSync?: typeof fs.statSync }} [options]
 * @returns {Array<Record<string, unknown>>}
 */
export function mapAttachmentsToContentBlocks(files, options = {}) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const maxFileBytes = options.maxFileBytes ?? MAX_ATTACHMENT_BYTES;
  const maxTurnBytes = options.maxTurnBytes ?? MAX_TURN_ATTACHMENT_BYTES;
  const preferPathReferences = options.preferPathReferences !== false;
  const blocks = [];
  let total = 0;

  for (const file of files) {
    const cwd = typeof options.cwd === 'string' ? options.cwd : '';
    if (preferPathReferences && cwd) {
      const relative = projectPathReference(file, cwd);
      if (relative) {
        const filename = typeof file?.filename === 'string' && file.filename.trim()
          ? file.filename.trim()
          : path.basename(relative);
        const declaredMime = typeof file?.mime === 'string' ? file.mime.toLowerCase() : '';
        const mime = declaredMime || mimeFromFilename(filename) || mimeFromFilename(relative);
        if (!isSupportedAttachmentMime(mime)) {
          const error = new Error(`Attachment "${filename}" type "${mime || 'unknown'}" is not supported`);
          error.code = 'ATTACHMENT_UNSUPPORTED_TYPE';
          error.statusCode = 400;
          throw error;
        }
        // Validate readability + size so we fail closed on missing/oversize files.
        const absolute = path.resolve(cwd, relative);
        readFileAttachment(absolute, {
          mime,
          filename,
          maxBytes: maxFileBytes,
          cwd,
          readFileSync: options.readFileSync,
          statSync: options.statSync,
        });
        blocks.push({
          type: 'text',
          text: `Attached project file: ${relative}`,
        });
        continue;
      }
    }

    const mapped = mapAttachmentToContentBlock(file, {
      maxBytes: maxFileBytes,
      cwd: options.cwd,
      readFileSync: options.readFileSync,
      statSync: options.statSync,
    });
    total += mapped.bytes;
    if (total > maxTurnBytes) {
      const error = new Error(`Attachments exceed max turn size of ${maxTurnBytes} bytes`);
      error.code = 'ATTACHMENTS_TOO_LARGE';
      error.statusCode = 400;
      throw error;
    }
    blocks.push(mapped.block);
  }
  return blocks;
}

/**
 * Helper for tests / debugging — normalize a path to a file URL.
 * @param {string} absolutePath
 * @returns {string}
 */
export function toFileUrl(absolutePath) {
  return pathToFileURL(path.resolve(absolutePath)).href;
}
