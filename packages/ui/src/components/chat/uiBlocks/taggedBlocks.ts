import type { Code, Nodes } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';

const OPEN_TAG = '<openui-lang>';
const CLOSE_TAG = '</openui-lang>';
const OPEN_LINE = /^ {0,3}<openui-lang>/;
const FENCE_MARKER = /^(`{3,}|~{3,})/;
const UI_PROGRAM = /root[ \t]*=[ \t]*Stack[ \t]*\(/;
const UI_PROGRAM_LINE = new RegExp(`^\\s*${UI_PROGRAM.source}`);
const BARE_OPENER = /^ {0,3}(?:`{3,}|~{3,})[ \t\r]*$/m;

type ProgramCheck = (source: string) => boolean;
let programCheck: ProgramCheck | null = null;

export const loadProgramCheck = (): Promise<ProgramCheck> => programCheck
  ? Promise.resolve(programCheck)
  : import('./catalog').then(({ parseUiBlock }) => {
    programCheck = (source) => parseUiBlock(source, true).kind === 'ready';
    return programCheck;
  });

export const needsProgramCheck = (text: string): boolean => !programCheck && BARE_OPENER.test(text) && UI_PROGRAM.test(text);

function streamingStartsUiProgram(source: string): boolean {
  for (const line of source.split('\n')) {
    const statement = line.trim();
    if (!statement || statement.startsWith('//')) continue;
    return UI_PROGRAM_LINE.test(line);
  }
  return false;
}

function lineOf(starts: number[], offset: number): number {
  let line = 0;
  while (line + 1 < starts.length && starts[line + 1] <= offset) line += 1;
  return line;
}

function fenceOpeners(text: string, lines: string[]) {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const insideCode = new Set<number>();
  const openers = new Map<number, string>();
  const visit = (node: Nodes, topLevel: boolean) => {
    if (node.type === 'code') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const first = lineOf(starts, start);
      const last = lineOf(starts, end);
      for (let line = first; line <= last; line += 1) insideCode.add(line);
      const column = start - starts[first];
      const marker = FENCE_MARKER.exec(lines[first].slice(column))?.[1];
      if (marker && recovers(node, topLevel, marker, last > first ? lines[last] : null)) {
        openers.set(first, lines[first].slice(0, column) + marker);
      }
      return;
    }
    if ('children' in node) for (const child of node.children) visit(child, node.type === 'root');
  };
  visit(fromMarkdown(text), false);
  return { insideCode, openers };
}

function recovers(node: Code, topLevel: boolean, marker: string, lastLine: string | null): boolean {
  if (node.lang === 'openui' && !node.meta) return true;
  if (node.lang || node.meta || !topLevel) return false;
  const close = lastLine?.trim().replace(/\r$/, '');
  const closed = !!close && close[0] === marker[0] && close.length >= marker.length && /^(`+|~+)$/.test(close);
  return closed ? !!programCheck?.(node.value) : streamingStartsUiProgram(node.value);
}

export function fenceUiBlocks(text: string): string {
  if (!text.includes('openui') && !UI_PROGRAM.test(text)) return text;
  const lines = text.split('\n');
  const { insideCode, openers } = fenceOpeners(text, lines);
  const out: string[] = [];
  let inTag = false;

  const takeBody = (line: string) => {
    const close = line.indexOf(CLOSE_TAG);
    if (close < 0) {
      out.push(line);
      return;
    }
    const body = line.slice(0, close);
    const after = line.slice(close + CLOSE_TAG.length).trim();
    if (body.trim()) out.push(body);
    out.push('```');
    if (after) out.push(after);
    inTag = false;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (inTag) {
      takeBody(line);
      continue;
    }
    const opener = openers.get(index);
    if (opener) {
      out.push(`${opener}openui-lang`);
      continue;
    }
    if (insideCode.has(index) || !OPEN_LINE.test(line)) {
      out.push(line);
      continue;
    }
    out.push('```openui-lang');
    inTag = true;
    const rest = line.slice(line.indexOf(OPEN_TAG) + OPEN_TAG.length);
    if (rest.trim()) takeBody(rest);
  }
  return out.join('\n');
}
