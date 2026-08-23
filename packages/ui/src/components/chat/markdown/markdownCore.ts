import { Marked, marked, type Tokens } from 'marked';
import remend from 'remend';
import katex from 'katex';
import DOMPurify from 'dompurify';
import { buildAgentMentionUrl, parseAgentHref, parseSkillHref } from '@/lib/messages/inlineMessageLinks';
import { isAppLinkUrl } from '@/lib/url';
import { isVSCodeRuntime } from '@/lib/desktop';
import { contentFingerprint, HighlightResultCache, utf16Bytes } from './highlightResultCache';
import { highlightCodeInWorker } from './markdown-worker';
import { escapeRawMarkdownHtml, isLocalFileUrl, MARKDOWN_FORBIDDEN_TAGS } from './markdownSecurity';

const escapeAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const LOCAL_IMAGE_EXTENSION_RE = /\.(?:png|jpe?g|gif|webp)(?:[?#].*)?$/i;
const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z\d+.-]*:/;

export interface MarkdownImageCandidate {
  source: string;
  filename: string;
}

export type MarkdownImageMode = 'inline' | 'label';

export const MAX_MARKDOWN_IMAGE_COUNT = 12;

const MARKDOWN_IMAGE_CANDIDATE_CACHE_MAX_ENTRIES = 1024;
const MARKDOWN_IMAGE_CANDIDATE_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const MARKDOWN_IMAGE_CANDIDATE_CACHE_MAX_ENTRY_BYTES = 64 * 1024;

type MarkdownImageCandidateCacheEntry = {
  candidates: MarkdownImageCandidate[];
  bytes: number;
};

const markdownImageCandidateCache = new Map<string, MarkdownImageCandidateCacheEntry>();
let markdownImageCandidateCacheBytes = 0;
let markdownImageCandidateScanCount = 0;

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

const getMarkdownImageFilename = (source: string, fallback: string): string => {
  if (/^data:image\/(png|jpeg|gif|webp)/i.test(source)) {
    const extension = /^data:image\/([^;,]+)/i.exec(source)?.[1]?.replace('jpeg', 'jpg') ?? 'png';
    return fallback.trim() || `image.${extension}`;
  }

  const path = source.split(/[?#]/, 1)[0]?.replace(/\\/g, '/') ?? '';
  const encodedName = path.split('/').filter(Boolean).at(-1) ?? '';
  if (!encodedName) return fallback.trim();
  try {
    return decodeURIComponent(encodedName);
  } catch {
    return encodedName;
  }
};

const estimateMarkdownImageCandidateCacheEntryBytes = (
  markdown: string,
  candidates: readonly MarkdownImageCandidate[],
): number => (
  (markdown.length + candidates.reduce((total, candidate) => total + candidate.source.length + candidate.filename.length, 0)) * 2
);

const scanMarkdownImageCandidates = (markdown: string): MarkdownImageCandidate[] => {
  markdownImageCandidateScanCount += 1;
  const candidates: MarkdownImageCandidate[] = [];
  const seen = new Set<string>();
  const tokens = marked.lexer(markdown);
  marked.walkTokens(tokens, (token) => {
    if (token.type !== 'image') return;

    const source = token.href ?? '';
    if (!source || !isSupportedMarkdownImageSource(source) || seen.has(source)) return;
    const fallback = typeof token.text === 'string' ? token.text : '';
    const filename = getMarkdownImageFilename(source, fallback);
    if (!filename) return;

    seen.add(source);
    candidates.push({ source, filename });
  });
  return candidates;
};

const getMarkdownImageCandidates = (markdown: string): MarkdownImageCandidate[] => {
  const cached = markdownImageCandidateCache.get(markdown);
  if (cached) {
    markdownImageCandidateCache.delete(markdown);
    markdownImageCandidateCache.set(markdown, cached);
    return cached.candidates;
  }

  const candidates = scanMarkdownImageCandidates(markdown);
  const bytes = estimateMarkdownImageCandidateCacheEntryBytes(markdown, candidates);
  if (bytes > MARKDOWN_IMAGE_CANDIDATE_CACHE_MAX_ENTRY_BYTES) return candidates;

  while (
    markdownImageCandidateCache.size >= MARKDOWN_IMAGE_CANDIDATE_CACHE_MAX_ENTRIES
    || markdownImageCandidateCacheBytes + bytes > MARKDOWN_IMAGE_CANDIDATE_CACHE_MAX_BYTES
  ) {
    const oldest = markdownImageCandidateCache.entries().next().value;
    if (!oldest) break;
    markdownImageCandidateCache.delete(oldest[0]);
    markdownImageCandidateCacheBytes -= oldest[1].bytes;
  }
  markdownImageCandidateCache.set(markdown, { candidates, bytes });
  markdownImageCandidateCacheBytes += bytes;
  return candidates;
};

/** @internal Test-only cache instrumentation for deterministic regression tests. */
export const __markdownImageCandidateCacheForTests = {
  reset: (): void => {
    markdownImageCandidateCache.clear();
    markdownImageCandidateCacheBytes = 0;
    markdownImageCandidateScanCount = 0;
  },
  stats: () => ({
    entries: markdownImageCandidateCache.size,
    bytes: markdownImageCandidateCacheBytes,
    scans: markdownImageCandidateScanCount,
  }),
};

const renderMarkdownImageLabel = ({
  href,
  title,
  text,
}: {
  href: string;
  title?: string | null;
  text: string;
}): string => {
  const label = getMarkdownImageFilename(href ?? '', text);
  const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
  return `<span${titleAttr} class="inline-flex items-center gap-1 align-text-bottom text-muted-foreground" data-openchamber-markdown-image-label="true">${escapeAttr(label)}</span>`;
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
    for (const candidate of getMarkdownImageCandidates(markdown)) {
      if (candidates.length >= limit) break;
      if (seen.has(candidate.source)) continue;
      seen.add(candidate.source);
      candidates.push({ ...candidate });
    }
  }

  return candidates;
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

const createParser = (imageMode: MarkdownImageMode) => new Marked().use({
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
    ...(imageMode === 'label' ? { image: renderMarkdownImageLabel } : {}),
  },
});

const inlineImageParser = createParser('inline');
const imageLabelParser = createParser('label');

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

  // Highlight all eligible fences concurrently — sequential await was O(n)
  // worker round-trips for messages with multiple code blocks.
  const replacements = await Promise.all(
    matches.map(async (match) => {
      const [full, rawLang, escapedCode] = match;
      const requested = (rawLang || 'text').toLowerCase();
      // Leave mermaid fences untouched so the decorate pass can render them as
      // diagrams (highlighting would strip the `language-mermaid` class).
      if (requested === 'mermaid') return null;

      const code = unescapeHtml(escapedCode ?? '');

      // Oversized block: skip highlight, keep plain code but stamp the language.
      if (exceedsLineLimit(code, lineLimit)) {
        return { full, next: full.replace('<pre', `<pre data-md-lang="${requested}"`) };
      }

      // Tokenize off the main thread. On failure the worker resolves to null and
      // we keep the original escaped <pre><code> (no main-thread highlight).
      const highlighted = await highlightCodeInWorker(code, requested);
      if (!highlighted) return null;
      // Stamp the language so the decorate pass can show a header label.
      return { full, next: highlighted.replace(/^<pre/, `<pre data-md-lang="${requested}"`) };
    }),
  );

  let result = html;
  for (const replacement of replacements) {
    if (!replacement) continue;
    result = result.replace(replacement.full, () => replacement.next);
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
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (!(node instanceof HTMLAnchorElement) || data.attrName !== 'href') return;
    // DOMPurify's default URI policy strips custom application schemes
    // (obsidian://, vscode://, ...). Keep them for anchors; dangerous schemes
    // stay excluded via isAppLinkUrl and clicks go through confirmation.
    if (isLocalFileUrl(data.attrValue) || isAppLinkUrl(data.attrValue)) data.forceKeepAttr = true;
  });
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
// Per-block HTML cache (content-addressed LRU)
// ---------------------------------------------------------------------------
//
// Keyed by content hash + mode + highlight flag + image mode — NOT by renderer
// instance id. `SimpleMarkdownRenderer` historically used a shared
// `simple:${variant}` key, so every same-variant instance fought over one cache
// slot and re-highlighted unchanged content on every pass
// (openchamber/openchamber#2769). Content addressing makes identical blocks
// share one entry and stops that thrash. Bounds are high enough for long
// sessions; byte cap keeps memory bounded.
//
// `full` (settled) and `live` (trailing, still streaming) blocks get separate
// caches. A live block's content changes on every stream step, so under one
// shared content-addressed cache each step would insert a new entry and a long
// streaming message would evict the settled blocks this fix exists to keep
// warm. The live cache is small on purpose: it only has to absorb repeat
// renders of the *same* step.

const FULL_CACHE_MAX_ENTRIES = 2000;
const FULL_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const LIVE_CACHE_MAX_ENTRIES = 32;
const LIVE_CACHE_MAX_BYTES = 2 * 1024 * 1024;

const fullBlockCache = new HighlightResultCache<string>({
  maxEntries: FULL_CACHE_MAX_ENTRIES,
  maxBytes: FULL_CACHE_MAX_BYTES,
});
const liveBlockCache = new HighlightResultCache<string>({
  maxEntries: LIVE_CACHE_MAX_ENTRIES,
  maxBytes: LIVE_CACHE_MAX_BYTES,
});

const cacheForMode = (mode: MarkdownBlock['mode']): HighlightResultCache<string> =>
  (mode === 'live' ? liveBlockCache : fullBlockCache);

/** Content-addressed cache key for a markdown block. */
const markdownBlockCacheKey = (
  contentHash: string,
  mode: MarkdownBlock['mode'],
  highlight: boolean,
  imageMode: MarkdownImageMode,
): string => `${contentHash}:${mode}:${highlight ? 1 : 0}:${imageMode}`;

/** Test-only: clear the render HTML caches between cases. */
export const resetMarkdownHtmlCacheForTests = (): void => {
  fullBlockCache.clear();
  liveBlockCache.clear();
};

/** Test-only: entry counts per block cache, for churn/eviction assertions. */
export const __markdownBlockCacheSizesForTests = (): { full: number; live: number } => ({
  full: fullBlockCache.size,
  live: liveBlockCache.size,
});

const parseBlock = async (
  block: MarkdownBlock,
  imageMode: MarkdownImageMode,
): Promise<string> => {
  const parser = imageMode === 'label' ? imageLabelParser : inlineImageParser;
  const parsed = await Promise.resolve(parser.parse(block.src));
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
export const renderMarkdownSync = (
  text: string,
  imageMode: MarkdownImageMode = 'inline',
): string => {
  if (!text) return '';
  const parser = imageMode === 'label' ? imageLabelParser : inlineImageParser;
  const parsed = parser.parse(text) as string;
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
 *
 * Lookup is content-addressed: distinct renderers holding identical blocks
 * share one entry and cannot evict each other by identity collision.
 */
export const renderMarkdownBlocks = async (
  text: string,
  streaming: boolean,
  imageMode: MarkdownImageMode = 'inline',
): Promise<RenderedBlock[]> => {
  if (!text) return [];

  const blocks = streamBlocks(text, streaming);
  return Promise.all(
    blocks.map(async (block) => {
      const contentHash = contentFingerprint(block.raw);
      const id = markdownBlockCacheKey(contentHash, block.mode, block.highlight, imageMode);
      const cache = cacheForMode(block.mode);
      const cached = cache.get(id);
      if (cached !== undefined) {
        return { id, html: cached };
      }
      const html = await parseBlock(block, imageMode);
      cache.set(id, html, utf16Bytes(id) + utf16Bytes(html));
      return { id, html };
    }),
  );
};
