// Adapted from T3 Code's libghostty-vt browser adapter (MIT, T3 Tools Inc.).
// See LICENSE-T3CODE in this directory.

export interface TerminalLinkMatch {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface TerminalBufferLineLike {
  readonly isWrapped?: boolean;
  translateToString(trimRight?: boolean): string;
}

export interface WrappedTerminalLinkLineSegment {
  readonly bufferLineNumber: number;
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
}

export interface WrappedTerminalLinkLine {
  readonly text: string;
  readonly segments: ReadonlyArray<WrappedTerminalLinkLineSegment>;
}

const URL_PATTERN = /https?:\/\/[^\s"'`<>]+/giu;
const TRAILING_PUNCTUATION_PATTERN = /[.,;!?]+$/;

function trimClosingDelimiters(value: string): string {
  let output = value.replace(TRAILING_PUNCTUATION_PATTERN, '');
  if (output.length === 0) return output;

  const trimUnbalanced = (open: string, close: string) => {
    while (output.endsWith(close)) {
      const opens = output.split(open).length - 1;
      const closes = output.split(close).length - 1;
      if (opens >= closes) return;
      output = output.slice(0, -1);
    }
  };

  trimUnbalanced('(', ')');
  trimUnbalanced('[', ']');
  trimUnbalanced('{', '}');
  return output;
}

/** http(s) URLs in one logical line, with trailing punctuation and unbalanced brackets trimmed. */
export function extractTerminalLinks(line: string): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];
  URL_PATTERN.lastIndex = 0;
  for (const rawMatch of line.matchAll(URL_PATTERN)) {
    const raw = rawMatch[0];
    const start = rawMatch.index ?? -1;
    if (start < 0 || raw.length === 0) continue;
    const trimmed = trimClosingDelimiters(raw);
    if (trimmed.length === 0) continue;
    matches.push({ text: trimmed, start, end: start + trimmed.length });
  }
  return matches;
}

/**
 * Joins a soft-wrapped line back together so a URL that the terminal broke
 * across rows matches as one string, remembering where each row's text sits.
 */
export function collectWrappedTerminalLinkLine(
  bufferLineNumber: number,
  getLine: (bufferLineIndex: number) => TerminalBufferLineLike | null | undefined,
): WrappedTerminalLinkLine | null {
  const anchorLine = getLine(bufferLineNumber - 1);
  if (!anchorLine) return null;

  let startBufferLineNumber = bufferLineNumber;
  let startLine = anchorLine;

  while (startBufferLineNumber > 1 && startLine.isWrapped) {
    const previousLine = getLine(startBufferLineNumber - 2);
    if (!previousLine) return null;
    startBufferLineNumber -= 1;
    startLine = previousLine;
  }

  const segments: WrappedTerminalLinkLineSegment[] = [];
  let nextStartIndex = 0;
  let currentBufferLineNumber = startBufferLineNumber;

  while (true) {
    const currentLine = getLine(currentBufferLineNumber - 1);
    if (!currentLine) break;

    const nextLine = getLine(currentBufferLineNumber);
    const hasWrappedContinuation = nextLine?.isWrapped === true;
    const text = currentLine.translateToString(!hasWrappedContinuation);

    segments.push({
      bufferLineNumber: currentBufferLineNumber,
      text,
      startIndex: nextStartIndex,
      endIndex: nextStartIndex + text.length,
    });
    nextStartIndex += text.length;

    if (!hasWrappedContinuation) break;
    currentBufferLineNumber += 1;
  }

  return {
    text: segments.map((segment) => segment.text).join(''),
    segments,
  };
}
