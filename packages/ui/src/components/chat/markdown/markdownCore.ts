import { Marked, marked, type MarkedExtension, type Tokens, type TokenizerAndRendererExtension } from 'marked';
import markedLinkifyIt from 'marked-linkify-it';
import remend from 'remend';
import katex from 'katex';
import DOMPurify, { type DOMPurify as DOMPurifyInstance } from 'dompurify';
import { buildAgentMentionUrl, parseAgentHref, parseSkillHref } from '@/lib/messages/inlineMessageLinks';
import { isAppLinkUrl } from '@/lib/url';
import { isSessionDeepLink } from '@/lib/sessionLinks';
import { isVSCodeRuntime } from '@/lib/desktop';
import { contentFingerprint, HighlightResultCache, utf16Bytes } from './highlightResultCache';
import { highlightCodeInWorker } from './markdown-worker';
import { streamTuning } from '../lib/streamTuningFlags';
import {
  DOCUMENT_HTML_ALLOWED_ATTR,
  DOCUMENT_HTML_ALLOWED_TAGS,
  escapeRawMarkdownHtml,
  isGeneratedMarkdownClass,
  isLocalFileUrl,
  isSafeSrcset,
  MARKDOWN_FORBIDDEN_TAGS,
} from './markdownSecurity';

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

/**
 * `escape` keeps raw HTML visible as text (assistant output and every other
 * untrusted surface). `sanitize` renders it through a GitHub-like allowlist and
 * is for documents a user opens to read, such as a README in the Files preview.
 */
export type MarkdownRawHtmlMode = 'escape' | 'sanitize';

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

  let candidates: MarkdownImageCandidate[];
  try {
    candidates = scanMarkdownImageCandidates(markdown);
  } catch {
    // Image discovery is optional; a malformed message must not hide the chat
    // or prevent discovery in the other messages.
    return [];
  }
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
  // When false, skip syntax highlighting for this block. Block-level commit
  // feeds the open fence whole lines at the throttle cadence (<=10/sec), so a
  // partial fence highlights too and streamed code arrives colored; only a
  // very large open fence falls back to plain text until it closes, keeping
  // the repeated worker re-tokenization bounded.
  highlight: boolean;
  // Set when the lexer already failed on this text. Parsing runs the same
  // lexer and would fail the same way, after the same cost.
  plainText?: true;
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

// Above this, re-highlighting the still-open fence on every committed line
// costs more than the colored preview is worth; the block highlights in one
// pass when the fence closes.
const OPEN_FENCE_HIGHLIGHT_LINE_LIMIT = 300;

// A single `~` between word characters would be escaped only while streaming,
// so the settled message could render differently.
const HEAL_OPTIONS = { linkMode: 'text-only', singleTilde: false } as const;

// remend 1.4 turns an unfinished image into one pointing at this placeholder,
// which our sanitizer drops, leaving a broken image while the message streams.
// Earlier versions removed the unfinished image, so the source is cut at its
// `![` and the rest healed again; closers for markers opened inside its alt
// text go with it. remend may rewrite the alt text, so the cut uses the last
// `![` of the source rather than matching the alt. A tail of many nested
// unfinished images stops after a few cuts and streams unhealed.
const INCOMPLETE_IMAGE_TARGET = '](streamdown:incomplete-image)';
const INCOMPLETE_IMAGE_MAX_CUTS = 4;

const heal = (text: string): string => {
  try {
    let source = text;
    let healed = remend(source, HEAL_OPTIONS);
    for (let cuts = 0; healed.includes(INCOMPLETE_IMAGE_TARGET); cuts += 1) {
      const start = source.lastIndexOf('![');
      if (start < 0 || cuts === INCOMPLETE_IMAGE_MAX_CUTS) return text;
      source = source.slice(0, start);
      healed = remend(source, HEAL_OPTIONS);
    }
    return healed;
  } catch {
    return text;
  }
};

// While a fence stays open, every new line of code used to lex the whole
// message again, although nothing above the fence can change and everything
// after its opening line is code. The previous split is remembered, and text
// that only extends an open trailing fence reuses it: the blocks above are
// returned as they were and the fence block grows by the added text. Anything
// that could change the split (a closing fence, a reference definition) takes
// the full path. A few entries cover parts that stream side by side.
type LiveSplit = { text: string; blocks: MarkdownBlock[]; fence: { char: string; size: number } };

const LIVE_SPLIT_MEMO_MAX = 4;
let liveSplits: LiveSplit[] = [];
const liveSplitStats = { reused: 0, lexed: 0 };

const openFenceMarker = (raw: string): { char: string; size: number } | null => {
  if (!hasOpenFence(raw)) return null;
  const mark = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)?.[1];
  return mark ? { char: mark[0] ?? '`', size: mark.length } : null;
};

const rememberLiveSplit = (text: string, blocks: MarkdownBlock[]): void => {
  // The lexer path keeps a text with reference definitions as one healed
  // block; extending it as a plain fence would render it differently.
  if (hasReferenceDefinitions(text)) return;
  const last = blocks.at(-1);
  const fence = last ? openFenceMarker(last.raw) : null;
  // The fence block has to be exactly the tail of the text for the added text
  // to belong to it, and a block the lexer failed on is not a split at all.
  if (!last || last.plainText || !fence || !text.endsWith(last.raw)) return;
  liveSplits = [{ text, blocks, fence }, ...liveSplits.filter((entry) => entry.text !== text)].slice(0, LIVE_SPLIT_MEMO_MAX);
};

const extendOpenFence = (text: string): MarkdownBlock[] | null => {
  let base: LiveSplit | undefined;
  for (const entry of liveSplits) {
    if (entry.text.length >= text.length || (base && base.text.length >= entry.text.length)) continue;
    if (text.startsWith(entry.text)) base = entry;
  }
  if (!base) return null;

  // Judge whole lines: the line the previous text ended in may only now have
  // become a closing fence or a reference definition.
  const region = text.slice(base.text.lastIndexOf('\n') + 1);
  if (hasReferenceDefinitions(region)) return null;
  const closing = new RegExp(`^[\\t ]{0,3}${base.fence.char}{${base.fence.size},}[\\t ]*$`, 'm');
  if (closing.test(region)) return null;

  const previous = base.blocks.at(-1);
  if (!previous) return null;
  const raw = previous.raw + text.slice(base.text.length);
  const blocks = [
    ...base.blocks.slice(0, -1),
    { raw, src: raw, mode: 'live' as const, highlight: raw.split('\n').length <= OPEN_FENCE_HIGHLIGHT_LINE_LIMIT },
  ];
  liveSplits = [{ text, blocks, fence: base.fence }, ...liveSplits.filter((entry) => entry !== base)].slice(0, LIVE_SPLIT_MEMO_MAX);
  return blocks;
};

/** Test-only: forget remembered splits and read how many were reused. */
export const resetLiveSplitMemoForTests = (): void => {
  liveSplits = [];
  liveSplitStats.reused = 0;
  liveSplitStats.lexed = 0;
};
export const __liveSplitStatsForTests = () => ({ ...liveSplitStats });
export const __streamBlocksForTests = (text: string, live: boolean): Array<Pick<MarkdownBlock, 'raw' | 'src' | 'mode' | 'highlight'>> =>
  streamBlocks(text, live).map(({ raw, src, mode, highlight }) => ({ raw, src, mode, highlight }));

/**
 * Split markdown into render blocks. When not streaming, returns a single
 * `full` block. While streaming, heals incomplete syntax and isolates an
 * unclosed trailing code fence into its own `live` block so a partial fence
 * does not corrupt the parse of stable content above it.
 */
const streamBlocks = (text: string, live: boolean): MarkdownBlock[] => {
  if (!live) return [{ raw: text, src: text, mode: 'full', highlight: true }];
  const extended = streamTuning.reuseLiveSplit() ? extendOpenFence(text) : null;
  if (extended) {
    liveSplitStats.reused += 1;
    return extended;
  }
  liveSplitStats.lexed += 1;
  const blocks = lexStreamBlocks(text);
  rememberLiveSplit(text, blocks);
  return blocks;
};

const lexStreamBlocks = (text: string): MarkdownBlock[] => {
  // Reference-style links/footnotes span multiple tokens (definition elsewhere);
  // keep them as a single block so per-block parsing doesn't break the refs.
  if (hasReferenceDefinitions(text)) {
    return [{ raw: text, src: heal(text), mode: 'live', highlight: true }];
  }

  let tokens: Tokens.Generic[];
  try {
    tokens = inlineImageParser.lexer(text);
  } catch {
    return [{ raw: text, src: text, mode: 'live', highlight: true, plainText: true }];
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
    const openFenceHighlight = openFence
      && raw.split('\n').length <= OPEN_FENCE_HIGHLIGHT_LINE_LIMIT;
    blocks.push({
      raw,
      // A finished block renders from its own text, as it will once the
      // message settles: healing it made, say, a ``` mentioned mid-sentence
      // show as code until the stream ended.
      src: openFence || !isLast ? raw : heal(raw),
      mode: isLast ? 'live' : 'full',
      highlight: !openFence || openFenceHighlight,
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
// Dollar math (`$...$` inline, `$$...$$` display) survives marked untouched
// (no backslash) and is rendered later from the parsed HTML, with currency
// guards — see renderMathExpressions.
type MathToken = { type: string; raw: string; text: string };

const renderKatex = (math: string, raw: string, displayMode: boolean): string => {
  try {
    return katex.renderToString(math, { displayMode, throwOnError: false });
  } catch {
    return raw;
  }
};

type MathRender = (math: string, raw: string, displayMode: boolean) => string;

// KaTeX output depends on inline styles, which the raw-HTML allowlist pass of
// `sanitize` mode drops. There the extensions leave a placeholder that
// survives the pass and becomes KaTeX after it; a placeholder written by the
// author only renders more math.
const MATH_PLACEHOLDER_RE = /<span data-oc-math="(inline|display)">([^<]*)<\/span>/g;

const renderMathPlaceholder: MathRender = (math, _raw, displayMode) =>
  `<span data-oc-math="${displayMode ? 'display' : 'inline'}">${escapeAttr(math)}</span>`;

const renderMathPlaceholders = (html: string): string => html.replace(
  MATH_PLACEHOLDER_RE,
  (_placeholder, mode: string, escapedMath: string) => {
    const math = unescapeHtml(escapedMath);
    return renderKatex(math, escapeAttr(math), mode === 'display');
  },
);

// No `start` hint: marked's inline text rule already stops before every
// backslash, so a hint could not end a text run any earlier, and searching the
// rest of the paragraph for `\(` at every inline token costs the square of its
// length (openchamber/openchamber#4204).
const createInlineMathExtension = (render: MathRender) => ({
  name: 'inlineMath',
  level: 'inline' as const,
  tokenizer(src: string): MathToken | undefined {
    const match = /^\\\(([\s\S]+?)\\\)/.exec(src);
    if (!match) return undefined;
    return { type: 'inlineMath', raw: match[0], text: match[1] ?? '' };
  },
  renderer(token: Tokens.Generic) {
    const math = token as MathToken;
    return render(math.text, math.raw, false);
  },
});

// `\[` is display math in LaTeX, but it is also CommonMark's escape for a
// literal `[`, and prose escapes brackets far more often than it opens display
// math. Reading every `\[` as math turned text like
// `[title \[Bug\] more](url)` into a KaTeX block that split the paragraph and
// tore the link apart. Display math therefore has to own its line: it must
// start one and its `\]` must end one. Anything mid-sentence stays an escape.
const BLOCK_MATH_RE = /^[ \t]*\\\[([\s\S]+?)\\\][ \t]*(?:\n|$)/;
const BLOCK_MATH_LINE_START_RE = /(?:^|\n)[ \t]*\\\[/;

// Characters the `start` searches below have read, so tests can show that a
// large message costs work in proportion to its length.
const scanStats = { linkify: 0, blockStart: 0 };

/** Test-only: reset and read the `start` search counters. */
export const resetScanStatsForTests = (): void => {
  scanStats.linkify = 0;
  scanStats.blockStart = 0;
};
export const __scanStatsForTests = () => ({ ...scanStats });

// A block extension's `start` only tells marked where to end the paragraph it
// is lexing. marked's paragraph never continues past a line that is empty or
// holds only spaces (a tab-only line does not end it), so the search stops
// there. Searching the whole rest made every block rescan the message, which
// cost seconds on messages of thousands of short paragraphs
// (openchamber/openchamber#4204). A hint beyond that line only flagged the
// paragraph as cut, which let marked glue a following stray line such as an
// empty `1. ` onto it; that no longer depends on text further down. User
// messages turn every newline into "  \n", so their empty lines hold two
// spaces. The newline before the ending line stays in, so patterns that end at
// a line break still match.
const untilParagraphEnd = (src: string): string => {
  const end = /\n *\n/.exec(src);
  const window = end ? src.slice(0, end.index + 1) : src;
  scanStats.blockStart += window.length;
  return window;
};

const createBlockMathExtension = (render: MathRender) => ({
  name: 'blockMath',
  level: 'block' as const,
  start(src: string) {
    const match = BLOCK_MATH_LINE_START_RE.exec(untilParagraphEnd(src));
    // Point marked at the `\[` itself, never at the newline before it.
    return match ? match.index + match[0].length - 2 : undefined;
  },
  tokenizer(src: string): MathToken | undefined {
    const match = BLOCK_MATH_RE.exec(src);
    if (!match) return undefined;
    return { type: 'blockMath', raw: match[0], text: match[1] ?? '' };
  },
  renderer(token: Tokens.Generic) {
    const math = token as MathToken;
    return render(math.text, math.raw, true);
  },
});

// Own the entire disclosure token, including an unfinished streamed body. HTML
// token boundaries otherwise split it at blank lines and close the DOM early.
const detailsExtension: TokenizerAndRendererExtension = {
  name: 'disclosure',
  level: 'block',
  start(src) {
    const match = /(?:^|\n) {0,3}<details(?:\s|>)/i.exec(untilParagraphEnd(src));
    return match ? match.index + (match[0].startsWith('\n') ? 1 : 0) : undefined;
  },
  tokenizer(src) {
    // Only the native boolean open attribute is accepted. Never forward raw
    // attributes, styles, event handlers, or an arbitrary HTML subtree.
    const opening = /^ {0,3}<details(?:\s+(open(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?))?\s*>\s*<summary\s*>([\s\S]*?)<\/summary\s*>/i.exec(src);
    if (!opening) return undefined;
    const bodyStart = opening[0].length;
    const body = src.slice(bodyStart);
    const markers = /(^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$))|(`+)|(<\/?details\b[^>]*>)/gim;
    let depth = 1;
    let bodyEnd = body.length;
    let end = src.length;
    let marker: RegExpExecArray | null;
    while ((marker = markers.exec(body))) {
      if (marker[2]) {
        const fence = marker[2];
        const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[\\t ]*(?:\\n|$)`, 'gm');
        close.lastIndex = markers.lastIndex;
        const found = close.exec(body);
        if (!found) break;
        markers.lastIndex = close.lastIndex;
      } else if (marker[3]) {
        const ticks = marker[3];
        const close = /`+/g;
        close.lastIndex = markers.lastIndex;
        let found: RegExpExecArray | null;
        while ((found = close.exec(body))) {
          if (found[0].length === ticks.length) {
            markers.lastIndex = close.lastIndex;
            break;
          }
        }
      } else if (marker[4]) {
        const lineStart = body.lastIndexOf('\n', marker.index - 1) + 1;
        const prefix = body.slice(lineStart, marker.index);
        // Quoted and indented code belongs to the child Markdown parser. Its
        // HTML-looking text must not terminate the surrounding disclosure.
        if (/^(?: {4}|\t| {0,3}>)/.test(prefix) || /(?:^|[^\\])(?:\\\\)*\\$/.test(prefix)) continue;
        depth += /^<\//.test(marker[4]) ? -1 : 1;
        if (depth === 0) {
          bodyEnd = marker.index;
          end = bodyStart + markers.lastIndex;
          break;
        }
      }
    }
    return {
      type: 'disclosure',
      raw: src.slice(0, end),
      open: Boolean(opening[1]),
      summary: this.lexer.inlineTokens(opening[2] ?? ''),
      tokens: this.lexer.blockTokens(body.slice(0, bodyEnd)),
    };
  },
  renderer(token) {
    return `<details data-md-details${token.open ? ' open' : ''}><summary>${this.parser.parseInline(token.summary)}</summary>${this.parser.parse(token.tokens ?? [])}</details>`;
  },
  childTokens: ['summary', 'tokens'],
};

// marked's GFM autolink swallows CJK punctuation after a bare URL, so switch
// to marked-linkify-it, which treats Unicode punctuation as a URL boundary.
// Plain CJK characters right after a URL are still consumed, matching GitHub.
//
// marked-linkify-it searches all the remaining inline text at every inline
// token, so one long paragraph costs the square of its length: a 250 KB data
// dump without blank lines froze the window for most of a minute
// (openchamber/openchamber#4204). While more than LINKIFY_SOURCE_LIMIT
// characters of inline text remain, it steps aside and marked's own GFM
// autolink, which is linear, links bare URLs without the CJK boundary.
export const LINKIFY_SOURCE_LIMIT = 5_000;

// A pasted session or message link (`openchamber://session/<id>?message=<id>`)
// becomes a link too; other `openchamber:` routes stay text.
const OPENCHAMBER_SESSION_LINK_TAIL = /^\/\/session\/[A-Za-z0-9_-]{1,128}(?:\?message=[A-Za-z0-9_-]{1,128})?/;
const OPENCHAMBER_SESSION_LINK_SCHEMA = {
  // Length of the link after `openchamber:` at `pos`, or 0 when it is not one.
  validate: (text: string, pos: number): number => OPENCHAMBER_SESSION_LINK_TAIL.exec(text.slice(pos))?.[0].length ?? 0,
};

const boundedLinkify = (): MarkedExtension => ({
  extensions: (markedLinkifyIt({ fuzzyLink: false, schemas: { 'openchamber:': OPENCHAMBER_SESSION_LINK_SCHEMA } }).extensions ?? []).map((extension) => {
    if (!('tokenizer' in extension)) return extension;
    const { start, tokenizer } = extension;
    return {
      ...extension,
      start(src) {
        if (src.length > LINKIFY_SOURCE_LIMIT) return undefined;
        scanStats.linkify += src.length;
        return start?.call(this, src);
      },
      tokenizer(src, tokens) {
        if (src.length > LINKIFY_SOURCE_LIMIT) return undefined;
        scanStats.linkify += src.length;
        return tokenizer.call(this, src, tokens);
      },
    };
  }),
});

const createParser = (imageMode: MarkdownImageMode, rawHtml: MarkdownRawHtmlMode) => {
  const renderMath = rawHtml === 'sanitize' ? renderMathPlaceholder : renderKatex;
  return new Marked().use(
    boundedLinkify(),
    {
      gfm: true,
      breaks: false,
      extensions: [createInlineMathExtension(renderMath), createBlockMathExtension(renderMath), detailsExtension],
      renderer: {
        // Assistant output is untrusted. Markdown constructs still render as
        // HTML, but raw HTML must remain visible text so it cannot introduce
        // active DOM such as stylesheets or positioned overlays into the
        // application shell. Documents keep it for the allowlist pass instead.
        html({ text }) {
          return rawHtml === 'sanitize' ? text : escapeRawMarkdownHtml(text);
        },
        link({ href, title, tokens }) {
          // The link text goes through the inline renderer, so an image
          // inside it (a badge) renders and raw HTML in it follows the mode.
          const text = this.parser.parseInline(tokens);
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
    },
  );
};

const inlineImageParser = createParser('inline', 'escape');
const imageLabelParser = createParser('label', 'escape');
const documentParser = createParser('inline', 'sanitize');

const parserFor = (imageMode: MarkdownImageMode, rawHtml: MarkdownRawHtmlMode) => {
  if (rawHtml === 'sanitize') return documentParser;
  return imageMode === 'label' ? imageLabelParser : inlineImageParser;
};

// ---------------------------------------------------------------------------
// Math (KaTeX) — post-process the parsed HTML, skipping code/pre/kbd content
// ---------------------------------------------------------------------------

// Dollar delimiters have no backslash, so marked passes them through and
// math is post-processed from the rendered HTML below.
//
// marked renders text with HTML entities (`'` → `&#39;`, `&` → `&amp;`, `<` →
// `&lt;`), so the captured LaTeX must be unescaped again before KaTeX sees
// it. Without this, a transpose `(y-X\beta)'` or an alignment `&` parse-fails
// and KaTeX paints the raw source red (`katex-error`, via index.css).
const unescapeHtml = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

// Both dollar forms are matched by one alternation so KaTeX output is never
// rescanned by the same pass:
//
//   `$$...$$`  display math, content may span lines but never markup.
//   `$...$`    inline math, guarded so currency prose stays text —
//                `$5 and $10`, `US$ 680`, `$50M to $72M` survive as literal:
//                - the opening `$` must be followed by a non-space, non-`$`
//                - the closing `$` must be preceded by a non-space and not
//                  followed by a digit
//                - content never contains `$`/`<`/`>`/`"`, so a pair cannot
//                  reach across markup or into an attribute
//                - purely numeric content (`$100$`) stays text
//
// `\$` escapes cannot be honored post-parse: marked has already consumed the
// backslash by the time this pass runs.
const MATH_DOLLAR_RE =
  /\$\$([\s\S]*?)\$\$|\$(?![\s$])([^\s$<>"](?:[^$<>"]*?[^\s$<>"])?)\$(?!\d)/g;

const DOLLAR_AMOUNT_RE = /^[\d.,\s]+$/;

const renderMathInText = (text: string): string =>
  text.replace(MATH_DOLLAR_RE, (match, display: string | undefined, inline: string | undefined) => {
    if (display !== undefined) {
      return renderKatex(unescapeHtml(display), match, true);
    }
    // The quote guard also runs on the decoded text, where `&quot;` is a quote.
    if (inline !== undefined && !unescapeHtml(inline).includes('"') && !DOLLAR_AMOUNT_RE.test(inline)) {
      return renderKatex(unescapeHtml(inline), match, false);
    }
    return match;
  });

// Math runs per text run, mirroring how KaTeX auto-render walks DOM text
// nodes: markup boundaries are excluded, so a `$...$` pair never stretches
// across elements or into an attribute (an href may legitimately hold `$`).
const TAG_RE = /(<[^>]*>)/;

const renderMathInTextRun = (part: string): string =>
  part
    .split(TAG_RE)
    .map((segment, index) => (index % 2 === 1 ? segment : renderMathInText(segment)))
    .join('');

const renderMathExpressions = (html: string): string => {
  // No `$` anywhere means no math to render — skip the split + regex passes on
  // the hot streaming path (the overwhelming majority of blocks have no math).
  if (html.indexOf('$') === -1) return html;

  const codeBlockPattern = /(<(?:pre|code|kbd)[^>]*>[\s\S]*?<\/(?:pre|code|kbd)>)/gi;
  return html
    .split(codeBlockPattern)
    .map((part, index) => (index % 2 === 1 ? part : renderMathInTextRun(part)))
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

const installAnchorHooks = (purifier: DOMPurifyInstance): void => {
  purifier.addHook('uponSanitizeAttribute', (node, data) => {
    if (!(node instanceof HTMLAnchorElement) || data.attrName !== 'href') return;
    // DOMPurify's default URI policy strips custom application schemes
    // (obsidian://, vscode://, ...). Keep them for anchors; dangerous schemes
    // stay excluded via isAppLinkUrl and clicks go through confirmation.
    // OpenChamber's own scheme is kept only for session links, which the chat
    // opens in place; pairing and other privileged routes stay stripped. VS
    // Code keeps them as text: its sessions live on its own OpenCode.
    const keepSessionLink = isSessionDeepLink(data.attrValue) && !isVSCodeRuntime();
    if (isLocalFileUrl(data.attrValue) || isAppLinkUrl(data.attrValue) || keepSessionLink) {
      data.forceKeepAttr = true;
    }
  });
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof HTMLAnchorElement)) return;
    if (node.target !== '_blank') return;
    node.setAttribute('rel', 'noopener noreferrer');
  });
};

const ensureSanitizeHook = (): void => {
  if (sanitizeHookInstalled) return;
  if (typeof window === 'undefined' || !DOMPurify.isSupported) return;
  sanitizeHookInstalled = true;
  installAnchorHooks(DOMPurify);
};

const sanitize = (html: string): string => {
  if (!DOMPurify.isSupported) return '';
  ensureSanitizeHook();
  return DOMPurify.sanitize(html, SANITIZE_CONFIG) as unknown as string;
};

// Raw HTML in a document passes this allowlist right after marked, before
// highlighting and KaTeX add the inline styles the final pass has to allow.
// It runs on its own DOMPurify instance so its hooks never touch that pass.
const DOCUMENT_HTML_SANITIZE_CONFIG = {
  ALLOWED_TAGS: [...DOCUMENT_HTML_ALLOWED_TAGS],
  ALLOWED_ATTR: [...DOCUMENT_HTML_ALLOWED_ATTR],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

let documentPurifier: DOMPurifyInstance | null = null;

const getDocumentPurifier = (): DOMPurifyInstance | null => {
  if (documentPurifier) return documentPurifier;
  // The default instance is unsupported exactly when there is no window.
  if (!DOMPurify.isSupported) return null;
  const purifier = DOMPurify(window);
  if (!purifier.isSupported) return null;
  installAnchorHooks(purifier);
  purifier.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName === 'class' && !isGeneratedMarkdownClass(data.attrValue)) data.keepAttr = false;
    if (data.attrName === 'srcset' && !isSafeSrcset(data.attrValue)) data.keepAttr = false;
  });
  purifier.addHook('afterSanitizeAttributes', (node) => {
    // Only the task-list checkbox marked renders; any other input is a form control.
    if (node.tagName === 'INPUT') {
      if (node.getAttribute('type') !== 'checkbox') {
        node.remove();
        return;
      }
      node.setAttribute('disabled', '');
    }
    // Tailwind preflight gives images `height: auto`, which beats the height
    // attribute, so `<img height="28">` would render at its natural size.
    // With a width too (a GitHub screenshot: 1920 x 906) the image is scaled
    // down to the column, so the pair becomes a ratio rather than a fixed
    // height that would stretch it.
    const height = node.tagName === 'IMG' ? node.getAttribute('height')?.trim() : undefined;
    const width = node.tagName === 'IMG' ? node.getAttribute('width')?.trim() : undefined;
    if (height && /^\d+$/.test(height)) {
      node.setAttribute('style', width && /^\d+$/.test(width) && Number(height) > 0
        ? `aspect-ratio:${width}/${height}`
        : `height:${height}px`);
    }
  });
  documentPurifier = purifier;
  return purifier;
};

const sanitizeDocumentHtml = (html: string): string => {
  const purifier = getDocumentPurifier();
  if (!purifier) return '';
  return renderMathPlaceholders(purifier.sanitize(html, DOCUMENT_HTML_SANITIZE_CONFIG));
};

const parseMarkdown = (text: string, imageMode: MarkdownImageMode, rawHtml: MarkdownRawHtmlMode): string => {
  const parsed = parserFor(imageMode, rawHtml).parse(text, { async: false });
  return rawHtml === 'sanitize' ? sanitizeDocumentHtml(parsed) : parsed;
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
  rawHtml: MarkdownRawHtmlMode,
): string => `${contentHash}:${mode}:${highlight ? 1 : 0}:${imageMode}${rawHtml === 'sanitize' ? ':html' : ''}`;

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

/**
 * Read a settled render synchronously when every block is already in the full
 * cache. Cache reads retain the existing LRU `get` semantics and do not insert
 * or expand either cache.
 */
export const getCachedMarkdownBlocks = (
  text: string,
  imageMode: MarkdownImageMode = 'inline',
  rawHtml: MarkdownRawHtmlMode = 'escape',
): RenderedBlock[] | null => {
  if (!text) return [];

  const blocks = streamBlocks(text, false);
  const rendered: RenderedBlock[] = [];
  for (const block of blocks) {
    const contentHash = contentFingerprint(block.raw);
    const id = markdownBlockCacheKey(contentHash, block.mode, block.highlight, imageMode, rawHtml);
    const html = fullBlockCache.get(id);
    if (html === undefined) return null;
    rendered.push({ id, html });
  }
  return rendered;
};

const renderPlainText = (text: string): string =>
  `<div class="whitespace-pre-wrap break-words">${escapeRawMarkdownHtml(text)}</div>`;

const parseBlock = async (
  block: MarkdownBlock,
  imageMode: MarkdownImageMode,
  rawHtml: MarkdownRawHtmlMode,
): Promise<string> => {
  if (block.plainText) return renderPlainText(block.raw);
  let parsed: string;
  try {
    parsed = parseMarkdown(block.src, imageMode, rawHtml);
  } catch {
    // Preserve the original source, not the syntax repaired for streaming.
    return renderPlainText(block.raw);
  }
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
  rawHtml: MarkdownRawHtmlMode = 'escape',
): string => {
  if (!text) return '';
  let parsed: string;
  try {
    parsed = parseMarkdown(text, imageMode, rawHtml);
  } catch {
    return renderPlainText(text);
  }
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
  rawHtml: MarkdownRawHtmlMode = 'escape',
): Promise<RenderedBlock[]> => {
  if (!text) return [];

  const blocks = streamBlocks(text, streaming);
  return Promise.all(
    blocks.map(async (block) => {
      const contentHash = contentFingerprint(block.raw);
      const id = markdownBlockCacheKey(contentHash, block.mode, block.highlight, imageMode, rawHtml);
      const cache = cacheForMode(block.mode);
      const cached = cache.get(id);
      if (cached !== undefined) {
        return { id, html: cached };
      }
      const html = await parseBlock(block, imageMode, rawHtml);
      cache.set(id, html, utf16Bytes(id) + utf16Bytes(html));
      return { id, html };
    }),
  );
};
