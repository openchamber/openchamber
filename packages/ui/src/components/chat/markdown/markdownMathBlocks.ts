import type { StreamdownProps } from 'streamdown';
import type { Root, RootContent } from 'mdast';
import { parseMarkdownStructure } from '@/lib/chatQuoteAnchor';
import { getMarkdownCjk } from './streamdownPlugins';

const opening = /^\\\[[ \t]*\r?\n/;
const entity = /&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/i;
const punctuation = '\\[]()<>*_~$!#';
const defaultRemend: StreamdownProps['remend'] = { linkMode: 'text-only', singleTilde: false };

type PreparedMath = { content: string; remend: StreamdownProps['remend']; reserved: string[]; resumeAt: number | null; parsed: string | null };

function hasUnescapedOpening(source: string): boolean {
  for (let index = 0; index < source.length; index++) {
    if (source[index] !== '\\') continue;
    const start = index;
    while (source[index + 1] === '\\') index++;
    if (source[index + 1] === '[' && (index - start + 1) % 2 === 1) return true;
  }
  return false;
}

export function prepareMarkdownMath(source: string, streaming: boolean, enabled = true): PreparedMath {
  const unchanged: PreparedMath = { content: source, remend: defaultRemend, reserved: [], resumeAt: null, parsed: null };
  if (!enabled || !source.includes('\\[') || !source.includes('\\]')) return unchanged;
  unchanged.parsed = source;
  const changes: number[] = [];
  function findCandidates(parent: Root | RootContent): void {
    if (!('children' in parent)) return;
    let candidate: number | null = null;
    let startLine: number | null = null;
    for (const node of parent.children) {
      if (node.type !== 'paragraph' || node.position?.start.offset === undefined || node.position.end.offset === undefined
        || node.children.some((child) => child.type !== 'text')) {
        candidate = null;
        startLine = null;
        if (node.type === 'list' || node.type === 'listItem' || node.type === 'blockquote') findCandidates(node);
        continue;
      }
      const start = node.position.start.offset;
      const fragment = source.slice(start, node.position.end.offset);
      if (opening.test(fragment)) { candidate = start; startLine = node.position.start.line; }
      if (candidate === null) continue;
      const endOfFragment = node.position.end.offset;
      const lineStart = source.lastIndexOf('\n', endOfFragment - 1) + 1;
      const line = source.slice(lineStart, endOfFragment);
      const marker = line.lastIndexOf('\\]');
      if (marker < 0 || line.slice(marker + 2).trim()) continue;
      const end = lineStart + marker;
      let slashStart = end;
      while (slashStart > lineStart && source[slashStart - 1] === '\\') slashStart--;
      if ((end - slashStart + 1) % 2 === 0) continue;
      const prefix = source.slice(lineStart, slashStart);
      const openingPrefix = source.slice(source.lastIndexOf('\n', candidate - 1) + 1, candidate);
      const openingMarkers = openingPrefix.replace(/(?:^|[ \t])(?:[-+*]|\d{1,9}[.)])(?=[ \t])/g, '');
      let sameContainer = false;
      if (parent.type === 'root') sameContainer = /^ {0,3}$/.test(prefix);
      else if (!prefix.includes('\t') && prefix.replaceAll(' ', '') === openingMarkers.replace(/[ \t]/g, '')) {
        if (parent.type === 'blockquote') sameContainer = prefix.length - prefix.lastIndexOf('>') - 1 <= 4;
        else if (parent.type === 'listItem') {
          const position = parent.position?.start;
          if (position?.offset !== undefined && !openingPrefix.includes('>')) {
            const marker = /^(?:[-+*]|\d{1,9}[.)])([ \t]*)(?=\S|\r?\n|$)/.exec(source.slice(position.offset));
            if (!marker) continue;
            const spaces = marker[1].length;
            const next = source[position.offset + marker[0].length];
            let padding = 0;
            if (next === undefined || next === '\r' || next === '\n') padding = 1;
            else for (const character of marker[1]) padding += character === '\t' ? 4 - ((position.column - 1 + marker[0].length - spaces + padding) % 4) : 1;
            if (padding < 1 || padding > 4) padding = 1;
            const base = position.column - 1 + marker[0].length - spaces + padding;
            sameContainer = prefix.length >= base && prefix.length <= base + 3;
          }
        }
      }
      if (!sameContainer) continue;
      const body = source.slice(candidate + 2, end);
      if (body.trim()
        && startLine !== null && node.position.start.line > startLine
        && !hasUnescapedOpening(body)
        && !body.includes('$') && !body.includes('~') && !entity.test(body) && !body.includes('openchamber://session/')) {
        changes.push(candidate, end);
      }
      candidate = null;
      startLine = null;
    }
  }
  const cjk = getMarkdownCjk(false);
  findCandidates(parseMarkdownStructure(source, cjk.remarkPluginsBefore, cjk.remarkPluginsAfter));
  if (changes.length === 0) return unchanged;
  const mask: string[] = [];
  if (streaming) {
    for (let code = 0xe000; code <= 0xf8ff && mask.length < punctuation.length; code++) {
      const character = String.fromCharCode(code);
      if (!source.includes(character)) mask.push(character);
    }
    if (mask.length < punctuation.length) return unchanged;
  }
  let result = '';
  let offset = 0;
  for (let i = 0; i < changes.length; i += 2) {
    const start = changes[i];
    const end = changes[i + 1];
    let body = source.slice(start + 2, end);
    if (streaming) body = body.replace(/[\\[\]()<>*_~$!#]/g, (character) => mask[punctuation.indexOf(character)]);
    result += source.slice(offset, start) + '$$' + body + '$$';
    offset = end + 2;
  }
  result += source.slice(offset);
  const remend = streaming ? {
    ...defaultRemend,
    handlers: [{ name: 'restore-display-math', priority: 101, handle: (text: string) => text.replace(/[\uE000-\uF8FF]/g, (character) => {
      const index = mask.indexOf(character);
      return index < 0 ? character : punctuation[index];
    }) }],
  } satisfies NonNullable<StreamdownProps['remend']> : defaultRemend;
  return { content: result, remend, reserved: mask, resumeAt: changes[changes.length - 1] + 2, parsed: source };
}

export function createMarkdownMathPreparer(): (source: string, streaming: boolean, enabled?: boolean) => PreparedMath {
  let previous: { source: string; prepared: ReturnType<typeof prepareMarkdownMath>; safeTail: boolean } | null = null;
  return (source: string, streaming: boolean, enabled = true) => {
    if (enabled && streaming && previous?.safeTail && source.startsWith(previous.source)) {
      const appended = source.slice(previous.source.length);
      const oldContent = previous.prepared.content;
      const unparsed = previous.prepared.parsed === null ? '' : source.slice(previous.prepared.parsed.length);
      if (!previous.source.endsWith('\\') && !previous.source.endsWith('\r')
        && !appended.includes('\\[') && !unparsed.includes(']:')
        && !previous.prepared.reserved.some((character) => appended.includes(character))) {
        const prepared = { ...previous.prepared, content: oldContent + appended };
        previous = { ...previous, source, prepared };
        return prepared;
      }
    }
    const prepared = prepareMarkdownMath(source, streaming, enabled);
    let tail = prepared.resumeAt === null ? '' : source.slice(prepared.resumeAt);
    const closeLine = /^[ \t]*\r?\n/.exec(tail);
    let safeTail = false;
    if (streaming && prepared.resumeAt !== null && closeLine) {
      tail = tail.slice(closeLine[0].length);
      const lineStart = source.lastIndexOf('\n', prepared.resumeAt - 1) + 1;
      const prefix = source.slice(lineStart, prepared.resumeAt - 2);
      const separator = /^[ \t>]*\r?\n/.exec(tail);
      safeTail = !!separator && separator[0].includes('>') === prefix.includes('>') && !tail.includes('\\[');
    }
    previous = { source, prepared, safeTail };
    return prepared;
  };
}
