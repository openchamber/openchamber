
export type CommentLineSource = {
  first: number;
  last: number;
  lineAt: (line: number) => string | undefined;
  partial?: boolean;
};

export type CommentAnchorInput = {
  startLine: number;
  endLine: number;
  code: string;
  contextBefore?: string;
  contextAfter?: string;
};

type CommentAnchorResult = {
  startLine: number;
  endLine: number;
  changedCode?: string;
};

export const textLineSource = (text: string): CommentLineSource => {
  let lines: string[] | null = null;
  const all = () => (lines ??= text.split('\n'));
  return {
    first: 1,
    get last() {
      return all().length;
    },
    lineAt: (line) => all()[line - 1],
  };
};

const same = (left: string | undefined, right: string | undefined): boolean =>
  left !== undefined && right !== undefined && left.trim() === right.trim();

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

export const commentContext = (
  source: CommentLineSource,
  startLine: number,
  endLine: number,
): Pick<CommentAnchorInput, 'contextBefore' | 'contextAfter'> => {
  const context: Pick<CommentAnchorInput, 'contextBefore' | 'contextAfter'> = {};
  const before = source.lineAt(startLine - 1);
  const after = source.lineAt(endLine + 1);
  if (before?.trim()) context.contextBefore = before;
  if (after?.trim()) context.contextAfter = after;
  return context;
};

export const anchorComment = (source: CommentLineSource, comment: CommentAnchorInput): CommentAnchorResult => {
  const unchanged: CommentAnchorResult = { startLine: comment.startLine, endLine: comment.endLine };
  const codeLines = comment.code.split('\n');
  if (codeLines.every((line) => !line.trim())) return unchanged;

  const matchesAt = (start: number): boolean => codeLines.every((line, offset) => same(source.lineAt(start + offset), line));
  const contextAt = (start: number): number =>
    Number(same(source.lineAt(start - 1), comment.contextBefore))
    + Number(same(source.lineAt(start + codeLines.length), comment.contextAfter));
  const fullContext = Number(comment.contextBefore !== undefined) + Number(comment.contextAfter !== undefined);

  if (matchesAt(comment.startLine) && contextAt(comment.startLine) === fullContext) return unchanged;

  let best: { start: number; context: number; distance: number } | null = null;
  for (let start = source.first; start + codeLines.length - 1 <= source.last; start += 1) {
    if (!matchesAt(start)) continue;
    const candidate = { start, context: contextAt(start), distance: Math.abs(start - comment.startLine) };
    if (!best || candidate.context > best.context || (candidate.context === best.context && candidate.distance < best.distance)) {
      best = candidate;
    }
  }
  let unobserved = false;
  if (source.partial) {
    for (let line = comment.startLine; line <= comment.endLine; line += 1) {
      if (source.lineAt(line) === undefined) unobserved = true;
    }
  }
  if (best && !(unobserved && best.context === 0)) {
    return { startLine: best.start, endLine: best.start + codeLines.length - 1 };
  }
  if (unobserved) return unchanged;

  const nearest = (text: string | undefined, expected: number): number | null => {
    if (text === undefined) return null;
    let found: number | null = null;
    for (let line = source.first; line <= source.last; line += 1) {
      if (!same(source.lineAt(line), text)) continue;
      if (found === null || Math.abs(line - expected) < Math.abs(found - expected)) found = line;
    }
    return found;
  };
  const before = nearest(comment.contextBefore, comment.startLine - 1);
  const after = before === null ? nearest(comment.contextAfter, comment.startLine + codeLines.length) : null;
  const wanted = before !== null ? before + 1 : after !== null ? after - codeLines.length : comment.startLine;
  const startLine = clamp(wanted, source.first, Math.max(source.first, source.last));
  const endLimit = after !== null ? Math.max(startLine, after - 1) : source.last;
  const endLine = clamp(startLine + codeLines.length - 1, startLine, Math.max(startLine, endLimit));

  const current: string[] = [];
  for (let line = startLine; line <= endLine; line += 1) {
    const text = source.lineAt(line);
    if (text !== undefined) current.push(text);
  }
  return { startLine, endLine, changedCode: current.join('\n') };
};
