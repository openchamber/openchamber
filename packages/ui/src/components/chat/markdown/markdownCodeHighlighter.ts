import type { HighlightResult } from 'streamdown';
import { contentFingerprint, HighlightResultCache, utf16Bytes } from './highlightResultCache';
import { highlightsNow, highlightsTokens, loadHighlights } from './highlightsEngine';

type Row = HighlightResult['tokens'][number];
type Previous = { code: string; language: string; result: HighlightResult };

const cacheKey = (code: string, language: string) => `highlight:${language}:${contentFingerprint(code)}`;

const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;
const STRIKETHROUGH = 8;

const styles = new Map<string, Pick<Row[number], 'color' | 'bgColor' | 'htmlStyle'>>();

function toRows(lines: ReturnType<typeof highlightsTokens>): Row[] {
  return lines.map((line) => {
    const compact: typeof line = [];
    for (const token of line) {
      const previous = compact.at(-1);
      if (previous && /^\s+$/.test(previous.content)
        && previous.offset + previous.content.length === token.offset
        && previous.bgColor === token.bgColor && (previous.fontStyle ?? 0) === (token.fontStyle ?? 0)
        && !((token.fontStyle ?? 0) & (UNDERLINE | STRIKETHROUGH))) {
        compact[compact.length - 1] = { ...token, offset: previous.offset, content: previous.content + token.content };
      } else compact.push(token);
    }
    return compact.map(({ content, offset, color, bgColor, fontStyle = 0 }) => {
      const key = `${color}|${bgColor}|${fontStyle}`;
      let style = styles.get(key);
      if (!style) {
        const htmlStyle: NonNullable<Row[number]['htmlStyle']> = {};
        if (fontStyle & ITALIC) htmlStyle.fontStyle = 'italic';
        if (fontStyle & BOLD) htmlStyle.fontWeight = 'bold';
        if (fontStyle & (UNDERLINE | STRIKETHROUGH)) {
          htmlStyle.textDecoration = [fontStyle & UNDERLINE ? 'underline' : '', fontStyle & STRIKETHROUGH ? 'line-through' : ''].filter(Boolean).join(' ');
        }
        style = { color, bgColor, htmlStyle };
        styles.set(key, style);
      }
      return { ...style, offset, content };
    });
  });
}

function sharedLineCount(base: Previous, code: string): number {
  if (code.startsWith(base.code)) return base.result.tokens.length - 1;
  const end = Math.min(base.code.length, code.length);
  let index = 0;
  let lines = 0;
  while (index < end && base.code.charCodeAt(index) === code.charCodeAt(index)) {
    if (code[index] === '\n') lines++;
    index++;
  }
  return lines;
}

const sameRow = (a: Row, b: Row): boolean => a.length === b.length && a.every((token, index) => {
  const other = b[index];
  return token.content === other.content && token.offset === other.offset && token.htmlStyle === other.htmlStyle;
});

export class MarkdownCodeHighlighter {
  private completed = new HighlightResultCache<HighlightResult>({ maxEntries: 2000, maxBytes: 24 * 1024 * 1024 });
  private recent: Array<{ key: string; result: HighlightResult }> = [];
  private previous: Previous[] = [];

  constructor() {
    void loadHighlights();
  }

  cached(code: string, language: string, isIncomplete = false): HighlightResult | undefined {
    const key = cacheKey(code, language);
    const settled = this.completed.get(key);
    if (settled) return settled;
    const recent = this.recent.find((entry) => entry.key === key)?.result;
    if (recent && !isIncomplete) this.remember(key, recent);
    return recent ?? this.tokenize(key, code, language, isIncomplete);
  }

  highlight(code: string, language: string, isIncomplete: boolean): Promise<HighlightResult | null> {
    const cached = this.cached(code, language, isIncomplete);
    if (cached) return Promise.resolve(cached);
    return loadHighlights().then(() => this.cached(code, language, isIncomplete) ?? null);
  }

  private tokenize(key: string, code: string, language: string, isIncomplete: boolean): HighlightResult | undefined {
    const input = highlightsNow(language, code);
    if (!input) return undefined;
    const result: HighlightResult = { tokens: toRows(highlightsTokens(input)) };
    let base: Previous | undefined;
    let shared = 0;
    for (const candidate of this.previous) {
      if (candidate.language !== language) continue;
      const count = sharedLineCount(candidate, code);
      if (count > shared) { shared = count; base = candidate; }
    }
    for (let line = 0; base && line < shared; line++) {
      if (sameRow(base.result.tokens[line], result.tokens[line])) result.tokens[line] = base.result.tokens[line];
    }
    this.previous = [{ code, language, result }, ...this.previous.filter((entry) => entry !== base)].slice(0, 4);
    if (isIncomplete) {
      this.recent = [{ key, result }, ...this.recent.filter((entry) => entry.key !== key)].slice(0, 4);
    } else this.remember(key, result);
    return result;
  }

  private remember(key: string, result: HighlightResult): void {
    let bytes = utf16Bytes(key);
    for (const line of result.tokens) {
      bytes += 32;
      for (const token of line) {
        bytes += 160 + utf16Bytes(token.content) + utf16Bytes(token.color ?? '') + utf16Bytes(token.bgColor ?? '');
      }
    }
    this.completed.set(key, result, bytes);
  }
}

export const markdownCodeHighlighter = new MarkdownCodeHighlighter();
