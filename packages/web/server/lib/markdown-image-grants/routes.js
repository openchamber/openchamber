import express from 'express';
import { mintOutsideFileGrant } from '../fs/routes.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { fitRenderPageImages, renderPageImageSources } from '../openchamber-control/render-page.js';
import { generatedImagePaths } from '../openchamber-control/generate-image.js';
import { isString } from '../shared/guards.js';
import { inspectLocalImage } from './inspect-image.js';

const asString = (value) => typeof value === 'string' ? value.trim() : '';

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
 * The message's openchamber_render pages, by tool call id. The page's HTML is
 * the call's input, which OpenCode stores with the message, so it authorizes
 * its paths the way assistant text does. The input is either the page itself
 * or, for a call made through the action form, its `parameters`.
 */
const renderPages = (message) => {
  const pages = new Map();
  for (const part of messageContent(message)) {
    if (part?.type !== 'tool' || part.name !== 'openchamber_render') continue;
    const input = part.state?.input;
    const html = input?.parameters?.html ?? input?.html;
    // A stored tool item's `id` is its call id: the chat's `callID` is this
    // field (projectToolPart in packages/ui/src/lib/opencode/projection.ts).
    if (isString(html)) pages.set(part.id, html);
  }
  return pages;
};

const renderPageSources = (message) => {
  const sources = new Set();
  for (const html of renderPages(message).values()) {
    for (const source of renderPageImageSources(html)) sources.add(source);
  }
  return sources;
};

/**
 * A file path the way two spellings of it compare: the chat sends the
 * destination Markdown made of it, percent-encoded and, for a Windows path, a
 * `file:` URL. Only the generated images compare this way; text and pages
 * keep their exact references.
 */
const comparablePath = (value) => {
  let text = value;
  if (/^file:\/\//i.test(text)) {
    try {
      text = new URL(text).pathname;
    } catch {
      return '';
    }
  }
  try {
    text = decodeURIComponent(text);
  } catch {
    // A stray % in a literal path stays as written.
  }
  text = text.replace(/\\/g, '/');
  return /^\/[A-Za-z]:\//.test(text) ? text.slice(1) : text;
};

/**
 * The files the message's openchamber_image calls saved, named by the result
 * each call stored, as `comparablePath` spells them. The chat draws them in the
 * call's row.
 */
const generatedImageSources = (message) => {
  const sources = new Set();
  for (const part of messageContent(message)) {
    if (part?.type !== 'tool' || part.name !== 'openchamber_image' || part.state?.status !== 'completed') continue;
    for (const item of Array.isArray(part.state.content) ? part.state.content : []) {
      if (item?.type !== 'text' || !isString(item.text)) continue;
      for (const source of generatedImagePaths(item.text)) sources.add(comparablePath(source));
    }
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
    // A drawn page may name hundreds of local images (the page itself takes up
    // to 200 000 characters), and the chat asks for all of them in one body.
    express.json({ limit: '256kb' }),
    async (req, res) => {
      const sessionId = asString(req.params.sessionId);
      const messageId = asString(req.body?.messageId);
      const sources = Array.isArray(req.body?.sources)
        ? [...new Set(req.body.sources.map(asString).filter(Boolean))]
        : [];
      // The page the sources belong to, when the chat draws an openchamber_render page.
      const callId = asString(req.body?.callId);
      if (!sessionId || !messageId || sources.length === 0) {
        return res.status(400).json({ error: 'sessionId, messageId, and sources are required' });
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
        const inspect = (source) => inspectLocalImage({
          source,
          directory: validatedDirectory.directory,
          fsPromises,
          path,
        }).catch(() => ({ status: 'error' }));
        // The assistant's text and pages are authoritative: a remote client cannot mint grants for unreferenced paths.
        // A page's images are checked together, so the page shows them in its own order up to its weight budget.
        let check;
        if (callId) {
          const html = renderPages(message).get(callId);
          if (html === undefined) return res.status(404).json({ error: 'Page not found' });
          const { images } = await fitRenderPageImages(html, inspect);
          const checked = new Map(images.map((image) => [image.source, image]));
          check = (source) => checked.get(source) ?? { status: 'error' };
        } else {
          const referenced = new Set([...markdownImageSources(message), ...renderPageSources(message)]);
          const generated = generatedImageSources(message);
          check = (source) => (referenced.has(source) || generated.has(comparablePath(source)) ? inspect(source) : { status: 'error' });
        }
        const results = [];
        for (const source of sources) {
          try {
            const inspected = await check(source);
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
