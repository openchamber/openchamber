export type TerminalContext = {
  terminalId: string;
  terminalLabel: string;
  startLine: number;
  endLine: number;
  text: string;
};

export type ParsedTerminalContext = Omit<TerminalContext, 'terminalId'>;

const BLOCK = /\n*<terminal_context>\n([\s\S]*?)\n<\/terminal_context>\s*$/;

export const normalizeTerminalContext = (context: TerminalContext): TerminalContext | null => {
  const terminalId = context.terminalId.trim();
  const terminalLabel = context.terminalLabel.trim();
  const text = context.text.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
  if (!terminalId || !terminalLabel || !text) return null;
  const startLine = Math.max(1, Math.floor(context.startLine));
  return { terminalId, terminalLabel, startLine, endLine: Math.max(startLine, Math.floor(context.endLine)), text };
};

export const terminalContextKey = (context: TerminalContext): string =>
  `${context.terminalId}:${context.startLine}:${context.endLine}:${context.text}`;

export const appendTerminalContexts = (prompt: string, contexts: readonly TerminalContext[]): string => {
  const normalized = contexts.map(normalizeTerminalContext).filter((value): value is TerminalContext => value !== null);
  if (normalized.length === 0) return prompt;
  const lines = normalized.flatMap((context, index) => [
    `- ${context.terminalLabel} lines ${context.startLine}-${context.endLine}:`,
    ...context.text.split('\n').map((line, offset) => `  ${context.startLine + offset} | ${line}`),
    ...(index === normalized.length - 1 ? [] : ['']),
  ]);
  const block = ['<terminal_context>', ...lines, '</terminal_context>'].join('\n');
  return prompt.trim() ? `${prompt.trim()}\n\n${block}` : block;
};

export const extractTerminalContexts = (prompt: string): { visibleText: string; contexts: ParsedTerminalContext[] } => {
  const match = BLOCK.exec(prompt);
  if (!match) return { visibleText: prompt, contexts: [] };
  const contexts: ParsedTerminalContext[] = [];
  let current: ParsedTerminalContext | null = null;
  for (const line of (match[1] ?? '').split('\n')) {
    const header = /^- (.+) lines (\d+)-(\d+):$/.exec(line);
    if (header) {
      if (current) contexts.push(current);
      current = { terminalLabel: header[1], startLine: Number(header[2]), endLine: Number(header[3]), text: '' };
      continue;
    }
    const body = /^\s{2}\d+ \| ?(.*)$/.exec(line);
    if (current && body) current.text += `${current.text ? '\n' : ''}${body[1]}`;
  }
  if (current) contexts.push(current);
  return { visibleText: prompt.slice(0, match.index).trimEnd(), contexts };
};
