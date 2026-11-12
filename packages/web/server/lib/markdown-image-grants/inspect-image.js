import { constants as fsConstants } from 'node:fs';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// A clip streams by byte ranges on every seek, so it is never read whole.
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
const VIDEO_EXTENSION_RE = /\.(?:mp4|m4v|mov|webm)$/i;

const isWithin = (target, root, path) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const parseFileSource = (source) => {
  if (/^file:\/\//i.test(source)) {
    try {
      const url = new URL(source);
      if (url.protocol !== 'file:' || (url.host && url.host !== 'localhost')) return '';
      const pathname = decodeURIComponent(url.pathname);
      return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
    } catch {
      return '';
    }
  }
  const pathname = source.split(/[?#]/, 1)[0] || '';
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
};

const hasImageSignature = (bytes) => {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes.subarray(1, 4).toString('ascii') === 'PNG'
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return true;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  const header = bytes.subarray(0, 12).toString('ascii');
  return header.startsWith('GIF87a')
    || header.startsWith('GIF89a')
    || (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP');
};

// MP4 and QuickTime start with an `ftyp` box; WebM with the EBML magic.
const hasVideoSignature = (bytes) => (bytes.length >= 8 && bytes.subarray(4, 8).toString('ascii') === 'ftyp')
  || (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3);

/**
 * Checks a local image or clip a message names: `ready` with its resolved path
 * and size, `missing`, or `error`. Reads only metadata and the first bytes.
 *
 * A path outside the workspace may sit anywhere on the machine: the agent can
 * read any file with its own tools, and image generators save wherever they
 * like. Only the message reference, the signature and the size limit gate it.
 * A workspace path still has to stay inside the workspace once symlinks resolve.
 */
export const inspectLocalImage = async ({ source, directory, fsPromises, path }) => {
  const parsed = parseFileSource(source);
  if (!parsed) return { status: 'error' };
  const sourcePath = path.isAbsolute(parsed) ? parsed : path.resolve(directory, parsed);
  const workspaceRoot = path.resolve(directory);
  const outsideWorkspace = !isWithin(path.resolve(sourcePath), workspaceRoot, path);

  try {
    // Resolve symlinks before comparing roots; lexical prefixes are not an authorization boundary.
    const [canonicalRoot, canonicalPath] = await Promise.all([
      fsPromises.realpath(workspaceRoot),
      fsPromises.realpath(sourcePath),
    ]);
    if (!outsideWorkspace && !isWithin(canonicalPath, canonicalRoot, path)) return { status: 'error' };
    const handle = await fsPromises.open(canonicalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      // The chat draws a clip or a picture by the name the message gave; a
      // link under one name to a file of the other kind gets neither limit.
      const video = VIDEO_EXTENSION_RE.test(sourcePath);
      if (video !== VIDEO_EXTENSION_RE.test(canonicalPath)) return { status: 'error' };
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > (video ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES)) return { status: 'error' };
      const header = Buffer.alloc(12);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      const signed = video ? hasVideoSignature : hasImageSignature;
      if (!signed(header.subarray(0, bytesRead))) return { status: 'error' };
      return {
        status: 'ready',
        path: outsideWorkspace ? canonicalPath : path.resolve(sourcePath),
        outsideWorkspace,
        size: stats.size,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing' };
    if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'ELOOP') {
      return { status: 'error' };
    }
    throw error;
  }
};
