// Incremental highlighting for a code block that grows while it streams.
//
// A streamed fence reaches the highlighter once per new line, each time with
// the whole block so far. Tokenizing the whole block every time makes the cost
// quadratic in its length, and TextMate tokenization is the expensive part. A
// TextMate grammar is a line-by-line state machine, so the state after the
// last complete line is enough to continue: only the new lines are tokenized,
// and the HTML of the lines before them is reused.
//
// The output must equal what one pass over the full block produces, because
// the finished block is highlighted that way and any difference would show as
// a restyle. That holds by construction: the same renderer produces every
// line, and lines are joined the way Shiki joins them. The accompanying test
// compares the two byte for byte at every prefix.

import type { GrammarState } from 'shiki';

type RenderedChunk = { html: string; grammarState: GrammarState | undefined };

/** Renders `chunk` to full Shiki `<pre>` HTML, continuing from `grammarState`. */
export type ChunkRenderer = (chunk: string, lang: string, grammarState: GrammarState | undefined) => RenderedChunk;

type Lineage = {
  lang: string;
  /** The highlighted prefix. Always ends at a line break, or is empty. */
  stable: string;
  lines: string[];
  open: string;
  close: string;
  grammarState: GrammarState | undefined;
};

const DEFAULT_MAX_LINEAGES = 8;
const DEFAULT_MAX_LINEAGE_CHARS = 256 * 1024;

// No grammar, so no state to carry: every line stands alone.
const STATELESS_LANGUAGES = new Set(['text', 'plaintext', 'txt', 'plain']);
// ANSI colour state runs across lines and Shiki exposes no way to resume it.
const NON_RESUMABLE_LANGUAGES = new Set(['ansi']);

const WRAPPER = /^([\s\S]*?<code[^>]*>)([\s\S]*)(<\/code>[\s\S]*)$/;

const splitRendered = (html: string): { open: string; lines: string[]; close: string } | null => {
  const match = WRAPPER.exec(html);
  if (!match) return null;
  const [, open = '', inner = '', close = ''] = match;
  // A token never contains a line break, so breaks only separate line spans.
  return { open, lines: inner.split('\n'), close };
};

export const createIncrementalCodeHighlighter = ({
  render,
  maxLineages = DEFAULT_MAX_LINEAGES,
  maxLineageChars = DEFAULT_MAX_LINEAGE_CHARS,
}: {
  render: ChunkRenderer;
  maxLineages?: number;
  maxLineageChars?: number;
}) => {
  // Most recently used first.
  let lineages: Lineage[] = [];

  const findLineage = (lang: string, stable: string): Lineage | undefined => {
    let best: Lineage | undefined;
    for (const lineage of lineages) {
      if (lineage.lang !== lang || lineage.stable.length > stable.length) continue;
      if (best && best.stable.length >= lineage.stable.length) continue;
      if (stable.startsWith(lineage.stable)) best = lineage;
    }
    return best;
  };

  const remember = (lineage: Lineage): void => {
    lineages = [lineage, ...lineages.filter((entry) => entry !== lineage)].slice(0, maxLineages);
  };

  /** Full `<pre>` HTML for `code`, or null when the block cannot be resumed. */
  const highlight = (code: string, lang: string): string | null => {
    if (NON_RESUMABLE_LANGUAGES.has(lang) || code.length > maxLineageChars) return null;

    const lastBreak = code.lastIndexOf('\n');
    const stable = code.slice(0, lastBreak + 1);
    const tail = code.slice(lastBreak + 1);

    const lineage: Lineage = findLineage(lang, stable)
      ?? { lang, stable: '', lines: [], open: '', close: '', grammarState: undefined };

    const added = stable.slice(lineage.stable.length);
    if (added !== '') {
      // Without the final break: Shiki would render it as one more empty line.
      const rendered = render(added.slice(0, -1), lang, lineage.grammarState);
      const parts = splitRendered(rendered.html);
      if (!parts) return null;
      if (rendered.grammarState === undefined && !STATELESS_LANGUAGES.has(lang)) return null;
      lineage.lines.push(...parts.lines);
      lineage.open = parts.open;
      lineage.close = parts.close;
      lineage.grammarState = rendered.grammarState;
      lineage.stable = stable;
    }

    // The unfinished last line, or the empty line Shiki draws after a final
    // break. Rendered from the carried state and never kept.
    const last = splitRendered(render(tail, lang, lineage.grammarState).html);
    if (!last) return null;

    if (lineage.stable !== '') remember(lineage);
    return `${last.open}${[...lineage.lines, ...last.lines].join('\n')}${last.close}`;
  };

  return {
    highlight,
    reset(): void {
      lineages = [];
    },
  };
};
