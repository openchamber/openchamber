import type { HighlightResult } from 'streamdown';
import type { ThemedToken } from 'shiki';

export interface StreamdownCodeRequest {
  id: number;
  code: string;
  language: string;
  fromLine?: number;
  fullPass?: boolean;
}

export type StreamdownCodeResponse =
  | { id: number; result: PackedCodeTokens }
  | { id: number; error: true };

// Text stays with the caller. Only UTF-16 ranges and a small style palette cross
// the worker boundary; the two buffers are transferred, never cloned.
interface PackedCodeTokens {
  lines: Uint32Array<ArrayBuffer>;
  spans: Uint32Array<ArrayBuffer>;
  styles: Array<{ color?: string; bgColor?: string; fontStyle: number }>;
}

export function packCodeTokens(tokens: ThemedToken[][]): PackedCodeTokens {
  // Match the old HTML path's whitespace absorption conservatively: whitespace
  // may borrow foreground color, but never background, font or decorations.
  tokens = tokens.map((line) => {
    const compact: ThemedToken[] = [];
    for (const token of line) {
      const previous = compact.at(-1);
      if (previous && /^\s+$/.test(previous.content)
        && previous.offset + previous.content.length === token.offset
        && previous.bgColor === token.bgColor && (previous.fontStyle ?? 0) === (token.fontStyle ?? 0)
        && !((token.fontStyle ?? 0) & (4 | 8))) {
        compact[compact.length - 1] = { ...token, offset: previous.offset, content: previous.content + token.content };
      } else compact.push(token);
    }
    return compact;
  });
  const lines = new Uint32Array(tokens.length + 1);
  const spans = new Uint32Array(tokens.reduce((count, line) => count + line.length, 0) * 3);
  const styles: PackedCodeTokens['styles'] = [];
  const palette = new Map<string, number>();
  let cursor = 0;
  tokens.forEach((line, index) => {
    lines[index] = cursor;
    for (const token of line) {
      const fontStyle = Math.max(0, token.fontStyle ?? 0);
      const key = JSON.stringify([token.color, token.bgColor, fontStyle]);
      let style = palette.get(key);
      if (style === undefined) {
        style = styles.length;
        palette.set(key, style);
        styles.push({ color: token.color, bgColor: token.bgColor, fontStyle });
      }
      spans[cursor++] = token.offset;
      spans[cursor++] = token.content.length;
      spans[cursor++] = style;
    }
  });
  lines[tokens.length] = cursor;
  return { lines, spans, styles };
}

export function unpackCodeTokens(code: string, packed: PackedCodeTokens): HighlightResult {
  const { lines, spans } = packed;
  const styles = packed.styles.map(({ color, bgColor, fontStyle }) => {
    const htmlStyle: NonNullable<HighlightResult['tokens'][number][number]['htmlStyle']> = {};
    if (fontStyle & 1) htmlStyle.fontStyle = 'italic';
    if (fontStyle & 2) htmlStyle.fontWeight = 'bold';
    if (fontStyle & (4 | 8)) htmlStyle.textDecoration = [fontStyle & 4 ? 'underline' : '', fontStyle & 8 ? 'line-through' : ''].filter(Boolean).join(' ');
    return { color, bgColor, htmlStyle };
  });
  const tokens: HighlightResult['tokens'] = [];
  for (let line = 0; line < lines.length - 1; line++) {
    const row: HighlightResult['tokens'][number] = [];
    for (let i = lines[line]; i < lines[line + 1]; i += 3) {
      const offset = spans[i];
      row.push({ ...styles[spans[i + 2]], offset, content: code.slice(offset, offset + spans[i + 1]) });
    }
    tokens.push(row);
  }
  return { tokens };
}
