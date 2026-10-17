import express from 'express';
import { constants as fsConstants } from 'node:fs';
import { mintOutsideFileGrant } from '../fs/routes.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { renderPageImageSources } from '../openchamber-control/render-page.js';
import { isString } from '../shared/guards.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// A clip streams by byte ranges on every seek, so it is never read whole.
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
const VIDEO_EXTENSION_RE = /\.(?:mp4|m4v|mov|webm)$/i;
const MAX_IMAGE_SOURCES = 12;

const asString = (value) => typeof value === 'string' ? value.trim() : '';

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

const normalizeReferenceLabel = (value) => value.trim().replace(/\s+/g, ' ').toLowerCase();

const unescapeMarkdownDestination = (value) => value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\])/g, '$1');

const isEscapedAt = (value, index) => {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
};

const findClosingBracket = (value, start) => {
  for (let cursor = start; cursor < value.length; cursor += 1) {
    if (value[cursor] === ']' && !isEscapedAt(value, cursor)) return cursor;
  }
  return -1;
};

const findInlineImageEnd = (value, start) => {
  let cursor = start;
  while (/\s/.test(value[cursor] || '')) cursor += 1;
  if (value[cursor] === ')') return cursor;

  const opener = value[cursor];
  const closer = opener === '"' ? '"' : opener === "'" ? "'" : opener === '(' ? ')' : '';
  if (!closer) return -1;
  cursor += 1;
  for (; cursor < value.length; cursor += 1) {
    if (value[cursor] !== closer || isEscapedAt(value, cursor)) continue;
    cursor += 1;
    while (/\s/.test(value[cursor] || '')) cursor += 1;
    return value[cursor] === ')' ? cursor : -1;
  }
  return -1;
};

const parseInlineDestination = (value, start) => {
  let cursor = start;
  while (/\s/.test(value[cursor] || '')) cursor += 1;
  if (value[cursor] === '<') {
    const end = value.indexOf('>', cursor + 1);
    if (end < 0) return null;
    const imageEnd = findInlineImageEnd(value, end + 1);
    return imageEnd < 0
      ? null
      : { source: unescapeMarkdownDestination(value.slice(cursor + 1, end)), end: imageEnd };
  }

  let source = '';
  let depth = 0;
  for (; cursor < value.length; cursor += 1) {
    const char = value[cursor];
    if (char === '\\' && cursor + 1 < value.length) {
      source += char + value[cursor + 1];
      cursor += 1;
      continue;
    }
    if (char === '(') {
      depth += 1;
      source += char;
      continue;
    }
    if (char === ')') {
      if (depth === 0) return { source: unescapeMarkdownDestination(source), end: cursor };
      depth -= 1;
      source += char;
      continue;
    }
    if (/\s/.test(char) && depth === 0) {
      const imageEnd = findInlineImageEnd(value, cursor);
      return imageEnd < 0 ? null : { source: unescapeMarkdownDestination(source), end: imageEnd };
    }
    source += char;
  }
  return null;
};

const parseDefinitionDestination = (value) => {
  const trimmed = value.trimStart();
  if (trimmed.startsWith('<')) {
    const end = trimmed.indexOf('>', 1);
    return end < 0 ? '' : unescapeMarkdownDestination(trimmed.slice(1, end));
  }
  const match = /^(?:\\.|\S)+/.exec(trimmed);
  return match ? unescapeMarkdownDestination(match[0]) : '';
};

/**
 * v2 messages are flat records: an assistant one carries `content[]` and a user
 * one a single `text`. Both are read here, because an image link can come from
 * either side of the conversation.
 */
const messageContent = (message) => {
  if (Array.isArray(message?.content)) return message.content;
  if (typeof message?.text === 'string') return [{ type: 'text', text: message.text }];
  return [];
};

const collectMarkdownLinesOutsideCode = (message) => {
  const lines = [];
  for (const part of messageContent(message)) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    let fence = null;
    for (const line of part.text.split('\n')) {
      const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[1];
        if (!fence) {
          fence = { char: marker[0], size: marker.length };
        } else if (marker[0] === fence.char && marker.length >= fence.size) {
          fence = null;
        }
        continue;
      }
      if (fence) continue;
      lines.push(line.replace(/`+[^`]*`+/g, ''));
    }
  }
  return lines;
};

const markdownImageSources = (message) => {
  const sources = new Set();
  const markdownLines = collectMarkdownLinesOutsideCode(message);
  const definitions = new Map();
  for (const line of markdownLines) {
    const match = /^\s{0,3}\[([^\]]+)]\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const source = parseDefinitionDestination(match[2]);
    if (source) definitions.set(normalizeReferenceLabel(match[1]), source);
  }

  for (const line of markdownLines) {
    for (let cursor = 0; cursor < line.length; cursor += 1) {
      if (line[cursor] !== '!' || line[cursor + 1] !== '[' || isEscapedAt(line, cursor)) continue;
      const altEnd = findClosingBracket(line, cursor + 2);
      if (altEnd < 0) continue;
      const alt = line.slice(cursor + 2, altEnd);
      const next = line[altEnd + 1];
      if (next === '(') {
        const parsed = parseInlineDestination(line, altEnd + 2);
        if (parsed?.source) sources.add(parsed.source);
        cursor = parsed?.end ?? altEnd;
        continue;
      }
      let label = alt;
      if (next === '[') {
        const labelEnd = findClosingBracket(line, altEnd + 2);
        if (labelEnd < 0) continue;
        label = line.slice(altEnd + 2, labelEnd) || alt;
        cursor = labelEnd;
      } else {
        cursor = altEnd;
      }
      const source = definitions.get(normalizeReferenceLabel(label));
      if (source) sources.add(source);
    }
  }
  return sources;
};

/**
 * The local images the message's openchamber_render pages name. The page's
 * HTML is the call's input, which OpenCode stores with the message, so it
 * authorizes its paths the way assistant text does. The input is either the
 * page itself or, for a call made through the action form, its `parameters`.
 */
const renderPageSources = (message) => {
  const sources = new Set();
  for (const part of messageContent(message)) {
    if (part?.type !== 'tool' || part.name !== 'openchamber_render') continue;
    const input = part.state?.input;
    const html = input?.parameters?.html ?? input?.html;
    if (!isString(html)) continue;
    for (const source of renderPageImageSources(html)) sources.add(source);
  }
  return sources;
};

const fetchMessage = async ({ sessionId, messageId, directory, buildOpenCodeUrl, getOpenCodeAuthHeaders }) => {
  const url = new URL(buildOpenCodeUrl(
    `/api/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
    '',
  ));
  url.searchParams.set('directory', directory);
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      // Percent-encoded to match the SDK wire format; raw non-ASCII values
      // are rejected by OpenCode.
      'x-opencode-directory': encodeURIComponent(directory),
      ...getOpenCodeAuthHeaders(),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`OpenCode returned ${response.status}`);
  const message = unwrapOpenCodeResponse(await response.json().catch(() => null));
  return message && typeof message === 'object' && typeof message.id === 'string' ? message : null;
};

// A path outside the workspace may sit anywhere on the machine: the agent can
// read any file with its own tools, and image generators save wherever they
// like. Only the message reference, the signature and the size limit gate it.
// A workspace path still has to stay inside the workspace once symlinks resolve.
const inspectImage = async ({ source, directory, fsPromises, path }) => {
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

export const registerMarkdownImageGrantRoutes = (app, dependencies) => {
  const {
    fsPromises,
    path,
    crypto,
    validateDirectoryPath,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
  } = dependencies;

  app.post(
    '/api/openchamber/sessions/:sessionId/markdown-image-grants',
    express.json({ limit: '32kb' }),
    async (req, res) => {
      const sessionId = asString(req.params.sessionId);
      const messageId = asString(req.body?.messageId);
      const sources = Array.isArray(req.body?.sources)
        ? [...new Set(req.body.sources.map(asString).filter(Boolean))]
        : [];
      if (!sessionId || !messageId || sources.length === 0 || sources.length > MAX_IMAGE_SOURCES) {
        return res.status(400).json({ error: 'sessionId, messageId, and 1-12 sources are required' });
      }
      const validatedDirectory = await validateDirectoryPath(asString(req.body?.directory));
      if (!validatedDirectory.ok) {
        return res.status(400).json({ error: validatedDirectory.error || 'Invalid directory' });
      }

      try {
        const message = await fetchMessage({
          sessionId,
          messageId,
          directory: validatedDirectory.directory,
          buildOpenCodeUrl,
          getOpenCodeAuthHeaders,
        });
        // v2 messages are flat records with a `type` discriminator.
        if (!message || message.id !== messageId || message.type !== 'assistant') {
          return res.status(404).json({ error: 'Assistant message not found' });
        }
        // The assistant's text and pages are authoritative: a remote client cannot mint grants for unreferenced paths.
        const referenced = new Set([...markdownImageSources(message), ...renderPageSources(message)]);
        const results = [];
        for (const source of sources) {
          if (!referenced.has(source)) {
            results.push({ source, status: 'error' });
            continue;
          }
          try {
            const inspected = await inspectImage({
              source,
              directory: validatedDirectory.directory,
              fsPromises,
              path,
            });
            if (inspected.status !== 'ready') {
              results.push({ source, status: inspected.status });
              continue;
            }
            // Reuse the existing path-bound raw-file grant instead of creating another asset lifecycle.
            const grant = inspected.outsideWorkspace
              ? await mintOutsideFileGrant(inspected.path, {
                scopes: ['raw'],
                fsPromises,
                path,
                crypto,
              })
              : null;
            results.push({
              source,
              status: 'ready',
              path: inspected.path,
              outsideFileGrant: grant?.outsideFileGrant,
              expiresAt: grant?.expiresAt,
            });
          } catch {
            results.push({ source, status: 'error' });
          }
        }
        return res.json({ results });
      } catch (error) {
        console.warn('[MarkdownImageGrants] failed to prepare images:', error?.message || error);
        return res.status(503).json({ error: 'Failed to prepare session images' });
      }
    },
  );
};
