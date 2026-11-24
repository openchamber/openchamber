import type { I18nContextValue } from '@/lib/i18n/react-context';

export const STRAY_QUOTE_ERROR = 'A quote may end a string early or be missing: put a backslash before a quote inside a string, as in \\"';

export function localizedProblem(problem: string, t: I18nContextValue['t']): string {
  if (problem === STRAY_QUOTE_ERROR) return t('chat.uiBlock.strayQuote');
  return /Unknown component "[A-Z]/.test(problem) ? t('chat.uiBlocks.extensionBlock.unavailable') : problem;
}

const SYNTAX = '\\s,:=()[\\]{}+*/%<>!&|?-';
const GLUED_TEXT = new RegExp(`[^"'${SYNTAX}](?:[^"\\n]*[^"'${SYNTAX}])?(?=")`, 'y');

type QuotedString = { quote: string; open: number; close: number | null };

// external: https://github.com/thesysdev/openui/tree/main/packages/lang-core The parser skips `//` and `#` comments outside strings (`stripComments`, not exported), and its tokens carry no positions.
function quotedStrings(source: string): QuotedString[] {
  const strings: QuotedString[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '#' || source.startsWith('//', index)) {
      const lineEnd = source.indexOf('\n', index);
      if (lineEnd === -1) break;
      index = lineEnd;
    } else if (char === '"' || char === "'") {
      let close = index + 1;
      while (close < source.length && source[close] !== char) close += source[close] === '\\' ? 2 : 1;
      const closed = close < source.length;
      strings.push({ quote: char, open: index, close: closed ? close : null });
      if (!closed) break;
      index = close;
      GLUED_TEXT.lastIndex = close + 1;
      if (char === '"' && GLUED_TEXT.test(source)) index = GLUED_TEXT.lastIndex - 1;
    }
  }
  return strings;
}

const STARTS_AS_TEXT = new RegExp(`^[ \\t]*[^${SYNTAX}]`);
const TOUCHES_A_QUOTE = new RegExp(`^[^${SYNTAX}]|[^${SYNTAX}]$`);
const VALUE_POSITION = /[,:=([{]\s*$/;

function leavesExpression(text: string): boolean {
  const open: string[] = [];
  for (const char of text) {
    if ('([{'.includes(char)) open.push(char);
    else if (')]}'.includes(char) && open.pop() !== '([{'[')]}'.indexOf(char)]) return true;
  }
  return open.length > 0;
}

export function escapeStrayQuotes(source: string): string | null {
  const strings = quotedStrings(source);
  const stray = new Set<number>();
  for (const [index, next] of strings.entries()) {
    const cut = strings[index - 1];
    if (!cut || cut.close === null || cut.quote !== next.quote) continue;
    if (!stray.has(cut.open) && !VALUE_POSITION.test(source.slice(0, cut.open))) continue;
    const between = source.slice(cut.close + 1, next.open);
    if (between.includes('\n') || !STARTS_AS_TEXT.test(between) || leavesExpression(between)) continue;
    if (next.close !== null && !TOUCHES_A_QUOTE.test(between)) continue;
    stray.add(cut.close);
    if (next.close !== null) stray.add(next.open);
  }
  if (!stray.size) return null;
  return source.split('').map((char, at) => (stray.has(at) ? `\\${char}` : char)).join('');
}
