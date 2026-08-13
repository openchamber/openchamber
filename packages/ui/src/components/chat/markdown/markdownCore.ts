import { Marked, marked, type Tokens } from 'marked';
import remend from 'remend';
import katex from 'katex';
import DOMPurify from 'dompurify';
import { buildAgentMentionUrl, parseAgentHref, parseSkillHref } from '@/lib/messages/inlineMessageLinks';
import { isVSCodeRuntime } from '@/lib/desktop';
import { highlightCodeInWorker } from './markdown-worker';
import { escapeRawMarkdownHtml, MARKDOWN_FORBIDDEN_TAGS } from './markdownSecurity';

const escapeAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const LOCAL_IMAGE_EXTENSION_RE = /\.(?:png|jpe?g|gif|webp)(?:[?#].*)?$/i;
const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z\d+.-]*:/;

export interface MarkdownImageCandidate {
  source: string;
  filename: string;
}

export const MAX_MARKDOWN_IMAGE_COUNT = 12;

const isLocalMarkdownImageSource = (source: string): boolean => {
  if (/^\/\//.test(source) || !LOCAL_IMAGE_EXTENSION_RE.test(source)) return false;
  return WINDOWS_ABSOLUTE_PATH_RE.test(source)
    || /^file:\/\//i.test(source)
    || !URL_SCHEME_RE.test(source);
};

const isSupportedMarkdownImageSource = (source: string): boolean => (
  /^(?:https?:)?\/\//i.test(source)
  || /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(source)
  || isLocalMarkdownImageSource(source)
);

export const getMarkdownImageFilename = (source: string, fallback: string): string => {
  if (/^data:/i.test(source)) return fallback.trim();

  const path = source.split(/[?#]/, 1)[0]?.replace(/\\/g, '/') ?? '';
  const encodedName = path.split('/').filter(Boolean).at(-1) ?? '';
  if (!encodedName) return fallback.trim();
  try {
    return decodeURIComponent(encodedName);
  } catch {
    return encodedName;
  }
};

export const extractMarkdownImageCandidates = (
  markdownTexts: readonly string[],
  limit = MAX_MARKDOWN_IMAGE_COUNT,
): MarkdownImageCandidate[] => {
  if (limit <= 0) return [];

  const candidates: MarkdownImageCandidate[] = [];
  const seen = new Set<string>();

  for (const markdown of markdownTexts) {
    if (!markdown || candidates.length >= limit) continue;
    const tokens = marked.lexer(markdown);
    marked.walkTokens(tokens, (token) => {
      if (candidates.length >= limit) return;

      if (token.type !== 'image' && token.type !== 'link') return;
      if (token.type === 'link' && !isLocalMarkdownImageSource(token.href ?? '')) return;

      const source = token.href ?? '';
      if (!source || !isSupportedMarkdownImageSource(source) || seen.has(source)) return;
      const fallback = typeof token.text === 'string' ? token.text : '';
      const filename = getMarkdownImageFilename(source, fallback);
      if (!filename) return;

      seen.add(source);
      candidates.push({ source, filename });
    });
  }

  return candidates;
};

const renderMarkdownImage = ({
  href,
  title,
  text,
}: {
  href: string;
  title?: string | null;
  text: string;
}): string => {
  const source = href ?? '';
  const alt = escapeAttr(text ?? '');
  const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
  const supported = isSupportedMarkdownImageSource(source);
  if (!supported) {
    return `<span role="img" aria-label="${alt}"${titleAttr}>${alt}</span>`;
  }

  return `<span role="img" aria-label="${alt}"${titleAttr} data-openchamber-markdown-image-placeholder="true">${alt}</span>`;
};

// ---------------------------------------------------------------------------
// Streaming block segmentation (port of OpenCode's markdown-stream)
// ---------------------------------------------------------------------------

type MarkdownBlock = {
  raw: string;
  src: string;
  mode: 'full' | 'live';
  // When false, skip syntax highlighting for this block. Set for the actively
  // streaming open code fence so we don't re-tokenize a growing block ~40x/sec
  // (O(n^2)); it highlights once the fence closes and becomes a stable block.
  highlight: boolean;
};

const hasReferenceDefinitions = (text: string): boolean =>
  /^\[[^\]]+\]:\s+\S+/m.test(text) || /^\[\^[^\]]+\]:\s+/m.test(text);

// Returns true when `raw` opens a fenced code block whose closing fence has not
// arrived yet — meaning the block is still streaming and must be rendered as
// raw text, not parsed.
const hasOpenFence = (raw: string): boolean => {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
  if (!match) return false;
  const mark = match[1];
  if (!mark) return false;
  const char = mark[0];
  const size = mark.length;
  const last = raw.trimEnd().split('\n').at(-1)?.trim() ?? '';
  return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last);
};

const heal = (text: string): string => {
  try {
    return remend(text, { linkMode: 'text-only' });
  } catch {
    return text;
  }
};

/**
 * Split markdown into render blocks. When not streaming, returns a single
 * `full` block. While streaming, heals incomplete syntax and isolates an
 * unclosed trailing code fence into its own `live` block so a partial fence
 * does not corrupt the parse of stable content above it.
 */
const streamBlocks = (text: string, live: boolean): MarkdownBlock[] => {
  if (!live) return [{ raw: text, src: text, mode: 'full', highlight: true }];
  // Reference-style links/footnotes span multiple tokens (definition elsewhere);
  // keep them as a single block so per-block parsing doesn't break the refs.
  if (hasReferenceDefinitions(text)) {
    return [{ raw: text, src: heal(text), mode: 'live', highlight: true }];
  }

  let tokens: Tokens.Generic[];
  try {
    tokens = marked.lexer(text) as Tokens.Generic[];
  } catch {
    return [{ raw: text, src: heal(text), mode: 'live', highlight: true }];
  }

  let tail = -1;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (tokens[i]?.type !== 'space') {
      tail = i;
      break;
    }
  }
  if (tail < 0) return [{ raw: text, src: heal(text), mode: 'live', highlight: true }];

  // Split into per-token blocks. Stable leading blocks become `full` (complete,
  // cache-stable, not re-healed); only the trailing block is `live` and gets
  // re-parsed as content streams in. This keeps per-step work proportional to
  // the last block rather than the whole message.
  const blocks: MarkdownBlock[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || token.type === 'space') continue;
    const raw = token.raw ?? '';
    const isLast = i === tail;
    const openFence = token.type === 'code' && hasOpenFence(raw);
    blocks.push({
      raw,
      src: openFence ? raw : heal(raw),
      mode: isLast ? 'live' : 'full',
      highlight: !openFence,
    });
  }

  if (blocks.length === 0) {
    return [{ raw: text, src: heal(text), mode: 'live', highlight: true }];
  }
  return blocks;
};

// ---------------------------------------------------------------------------
// marked parser (HTML string output) with safe external links
// ---------------------------------------------------------------------------

// Math delimiters that use backslashes — `\(...\)` (inline) and `\[...\]`
// (display) — must be caught during lexing: marked treats `\(`/`\[` as
// backslash escapes and strips the slash before any HTML post-process can see
// them. Registering them as tokenizers also makes them code-safe for free
// (marked tokenizes code spans/fences first, so these never fire inside code).
// Single-dollar `$...$` is intentionally NOT supported — it collides with
// currency text ($50, US$ 680); only `$$...$$` survives as display math (see
// renderMathExpressions). This mirrors KaTeX auto-render's default delimiters.
type MathToken = { type: string; raw: string; text: string };

const renderKatex = (math: string, raw: string, displayMode: boolean): string => {
  try {
    return katex.renderToString(math, { displayMode, throwOnError: false });
  } catch {
    return raw;
  }
};

const inlineMathExtension = {
  name: 'inlineMath',
  level: 'inline' as const,
  start(src: string) {
    const index = src.indexOf('\\(');
    return index < 0 ? undefined : index;
  },
  tokenizer(src: string): MathToken | undefined {
    const match = /^\\\(([\s\S]+?)\\\)/.exec(src);
    if (!match) return undefined;
    return { type: 'inlineMath', raw: match[0], text: match[1] ?? '' };
  },
  renderer(token: Tokens.Generic) {
    const math = token as MathToken;
    return renderKatex(math.text, math.raw, false);
  },
};

const blockMathExtension = {
  name: 'blockMath',
  level: 'block' as const,
  start(src: string) {
    const index = src.indexOf('\\[');
    return index < 0 ? undefined : index;
  },
  tokenizer(src: string): MathToken | undefined {
    const match = /^\\\[([\s\S]+?)\\\]/.exec(src);
    if (!match) return undefined;
    return { type: 'blockMath', raw: match[0], text: match[1] ?? '' };
  },
  renderer(token: Tokens.Generic) {
    const math = token as MathToken;
    return renderKatex(math.text, math.raw, true);
  },
};

const createParser = (deferImages: boolean) => new Marked().use({
  gfm: true,
  breaks: false,
  extensions: [inlineMathExtension, blockMathExtension],
  renderer: {
    // Assistant output is untrusted. Markdown constructs still render as HTML,
    // but raw HTML must remain visible text so it cannot introduce active DOM
    // such as stylesheets or positioned overlays into the application shell.
    html({ text }) {
      return escapeRawMarkdownHtml(text);
    },
    link({ href, title, text }) {
      const target = href ?? '';
      if (deferImages && isLocalMarkdownImageSource(target)) {
        const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
        const filename = getMarkdownImageFilename(target, '');
        return `<a href="${escapeAttr(target)}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer" data-openchamber-markdown-image-link="true" data-openchamber-markdown-image-source="${escapeAttr(target)}" data-openchamber-markdown-image-filename="${escapeAttr(filename)}">${text}</a>`;
      }
      const agentName = parseAgentHref(target);
      if (agentName) {
        return `<a href="${escapeAttr(buildAgentMentionUrl(agentName))}" data-openchamber-agent-mention="true" class="text-primary hover:underline" target="_blank" rel="noopener noreferrer">${text}</a>`;
      }
      const skillName = parseSkillHref(target);
      if (skillName) {
        return `<a href="${escapeAttr(target)}" data-skill-name="${escapeAttr(skillName)}" class="text-primary hover:underline">${text}</a>`;
      }
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
      return `<a href="${escapeAttr(target)}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    ...(deferImages ? { image: renderMarkdownImage } : {}),
  },
});

const parser = createParser(false);
const imageParser = createParser(true);

// ---------------------------------------------------------------------------
// Math (KaTeX) — post-process the parsed HTML, skipping code/pre/kbd content
// ---------------------------------------------------------------------------

// Only `$$...$$` (display) is handled here. Single-dollar `$...$` inline math is
// deliberately omitted: it parses currency text ($50, US$ 680, "$50M to $72M")
// as math and corrupts it. Inline math is supported via `\(...\)` (see the
// marked extensions above). `$$` survives marked untouched (no backslash), so
// post-processing the parsed HTML — skipping code via renderMathExpressions —
// stays correct and code-safe.
const renderMathInText = (text: string): string =>
  text.replace(/\$\$([\s\S]*?)\$\$/g, (_match, math: string) => {
    try {
      return katex.renderToString(math, { displayMode: true, throwOnError: false });
    } catch {
      return `$$${math}$$`;
    }
  });

const renderMathExpressions = (html: string): string => {
  // No `$` anywhere means no math to render — skip the split + regex passes on
  // the hot streaming path (the overwhelming majority of blocks have no math).
  if (html.indexOf('$') === -1) return html;

  const codeBlockPattern = /(<(?:pre|code|kbd)[^>]*>[\s\S]*?<\/(?:pre|code|kbd)>)/gi;
  return html
    .split(codeBlockPattern)
    .map((part, index) => (index % 2 === 1 ? part : renderMathInText(part)))
    .join('');
};

// ---------------------------------------------------------------------------
// Syntax highlighting (Shiki via @pierre/diffs shared highlighter)
// ---------------------------------------------------------------------------

const CODE_BLOCK_RE = /<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g;

// Skip syntax highlighting for very large blocks — tokenizing thousands of
// lines blocks the main thread. Plain (escaped) code is shown instead.
const CODE_HIGHLIGHT_LINE_LIMIT = 1200;
const VSCODE_CODE_HIGHLIGHT_LINE_LIMIT = 200;

const exceedsLineLimit = (value: string, limit: number): boolean => {
  let lines = 1;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) === 10 && ++lines > limit) return true;
  }
  return false;
};

const unescapeHtml = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

const highlightCodeBlocks = async (html: string): Promise<string> => {
  const matches = [...html.matchAll(CODE_BLOCK_RE)];
  if (matches.length === 0) return html;

  const lineLimit = isVSCodeRuntime() ? VSCODE_CODE_HIGHLIGHT_LINE_LIMIT : CODE_HIGHLIGHT_LINE_LIMIT;

  let result = html;
  for (const match of matches) {
    const [full, rawLang, escapedCode] = match;
    const requested = (rawLang || 'text').toLowerCase();
    // Leave mermaid fences untouched so the decorate pass can render them as
    // diagrams (highlighting would strip the `language-mermaid` class).
    if (requested === 'mermaid') continue;

    const code = unescapeHtml(escapedCode ?? '');

    // Oversized block: skip highlight, keep plain code but stamp the language.
    if (exceedsLineLimit(code, lineLimit)) {
      result = result.replace(full, () => full.replace('<pre', `<pre data-md-lang="${requested}"`));
      continue;
    }

    // Tokenize off the main thread. On failure the worker resolves to null and
    // we keep the original escaped <pre><code> (no main-thread highlight).
    const highlighted = await highlightCodeInWorker(code, requested);
    if (highlighted) {
      // Stamp the language so the decorate pass can show a header label.
      const stamped = highlighted.replace(/^<pre/, `<pre data-md-lang="${requested}"`);
      result = result.replace(full, () => stamped);
    }
  }

  return result;
};

// ---------------------------------------------------------------------------
// Sanitization (DOMPurify) — allow Shiki/KaTeX/SVG output
// ---------------------------------------------------------------------------

const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true, mathMl: true, svg: true },
  ADD_TAGS: ['svg', 'path', 'g', 'rect', 'line', 'polygon', 'polyline', 'circle', 'ellipse', 'text', 'tspan', 'defs', 'marker'],
  ADD_ATTR: ['d', 'viewBox', 'preserveAspectRatio', 'xmlns', 'target', 'fill', 'stroke', 'stroke-width', 'transform', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'style'],
  // Defense in depth for generated/highlighter HTML after raw markdown HTML
  // has been escaped by the marked renderer above.
  FORBID_TAGS: [...MARKDOWN_FORBIDDEN_TAGS],
  FORBID_CONTENTS: [...MARKDOWN_FORBIDDEN_TAGS],
};

let sanitizeHookInstalled = false;

const ensureSanitizeHook = (): void => {
  if (sanitizeHookInstalled) return;
  if (typeof window === 'undefined' || !DOMPurify.isSupported) return;
  sanitizeHookInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof HTMLAnchorElement)) return;
    if (node.target !== '_blank') return;
    node.setAttribute('rel', 'noopener noreferrer');
  });
};

const sanitize = (html: string): string => {
  if (!DOMPurify.isSupported) return '';
  ensureSanitizeHook();
  return DOMPurify.sanitize(html, SANITIZE_CONFIG) as unknown as string;
};


// ---------------------------------------------------------------------------
// Per-block HTML cache (LRU, mirrors OpenCode's checksum cache)
// ---------------------------------------------------------------------------

const CACHE_MAX = 240;
const htmlCache = new Map<string, { hash: string; html: string }>();

// FNV-1a 32-bit hash of the block content.
const hash = (value: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

const touch = (key: string, entry: { hash: string; html: string }): void => {
  htmlCache.delete(key);
  htmlCache.set(key, entry);
  if (htmlCache.size <= CACHE_MAX) return;
  const oldest = htmlCache.keys().next().value;
  if (oldest) htmlCache.delete(oldest);
};

const parseBlock = async (block: MarkdownBlock, deferImages: boolean): Promise<string> => {
  const parsed = await Promise.resolve((deferImages ? imageParser : parser).parse(block.src));
  const withMath = renderMathExpressions(parsed);
  const highlighted = block.highlight ? await highlightCodeBlocks(withMath) : withMath;
  return sanitize(highlighted);
};

/**
 * Synchronous styled render for the first paint, before the async pipeline
 * (Shiki-in-worker highlight) resolves. Produces the SAME structural HTML as
 * `renderMarkdownBlocks` minus syntax coloring: paragraphs, lists, code blocks
 * and bold all render at their final width, so the async pass only upgrades
 * code-block colors — no flash of full-width raw markdown source. `parser.parse`
 * is synchronous (marked is not configured `async`), so this never blocks on a
 * worker round-trip.
 */
export const renderMarkdownSync = (text: string, deferImages = false): string => {
  if (!text) return '';
  const parsed = (deferImages ? imageParser : parser).parse(text) as string;
  const withMath = renderMathExpressions(parsed);
  return sanitize(withMath);
};

export type RenderedBlock = {
  // Stable identity across renders for per-block DOM reconciliation. Encodes
  // content + mode + highlight so any change forces that block (and only that
  // block) to re-morph; unchanged leading blocks are skipped entirely.
  id: string;
  html: string;
};

/**
 * Render markdown into an array of per-block sanitized HTML. Streaming-aware:
 * splits into blocks, caches per-block, heals incomplete syntax. Returning
 * blocks (instead of one joined string) lets the renderer re-morph only the
 * block that changed, keeping per-step streaming cost ~O(last block).
 */
export const renderMarkdownBlocks = async (
  text: string,
  streaming: boolean,
  cacheKey: string,
  deferImages = false,
): Promise<RenderedBlock[]> => {
  if (!text) return [];

  const blocks = streamBlocks(text, streaming);
  return Promise.all(
    blocks.map(async (block, index) => {
      const contentHash = hash(block.raw);
      const id = `${contentHash}:${block.mode}:${block.highlight ? 1 : 0}:${deferImages ? 1 : 0}`;
      const key = `${cacheKey}:${index}:${block.mode}:${deferImages ? 1 : 0}`;
      const cached = htmlCache.get(key);
      if (cached && cached.hash === contentHash) {
        touch(key, cached);
        return { id, html: cached.html };
      }
      const html = await parseBlock(block, deferImages);
      touch(key, { hash: contentHash, html });
      return { id, html };
    }),
  );
};
