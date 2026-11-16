import type { StreamdownProps } from 'streamdown';
import { parseMarkdownStructure } from '@/lib/chatQuoteAnchor';

const opening = /^\\\[[ \t]*\r?\n/;
const closing = /(?:^|\r?\n) {0,3}(\\+)\][ \t]*$/;
const entity = /&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/i;
const punctuation = '\\[]()<>*_~$!#';
const defaultRemend: StreamdownProps['remend'] = { linkMode: 'text-only', singleTilde: false };

type PreparedMath = { content: string; remend: StreamdownProps['remend']; reserved: string[]; resumeAt: number | null; parsed: string | null };

export function prepareMarkdownMath(source: string, streaming: boolean, enabled = true): PreparedMath {
  const unchanged: PreparedMath = { content: source, remend: defaultRemend, reserved: [], resumeAt: null, parsed: null };
  if (!enabled || !source.includes('\\[') || !source.includes('\\]')) return unchanged;
  unchanged.parsed = source;
  const changes: number[] = [];
  let candidate: number | null = null;
  for (const node of parseMarkdownStructure(source).children) {
    if (node.type !== 'paragraph' || node.position?.start.offset === undefined || node.position.end.offset === undefined
      || node.children.some((child) => child.type !== 'text')) {
      candidate = null;
      continue;
    }
    const start = node.position.start.offset;
    const fragment = source.slice(start, node.position.end.offset);
    if (opening.test(fragment)) candidate = start;
    if (candidate === null) continue;
    const match = closing.exec(fragment);
    if (!match || match[1].length % 2 === 0) continue;
    const end = start + match.index + match[0].lastIndexOf('\\]');
    const body = source.slice(candidate + 2, end);
    if (body.trim() && /\r?\n[ \t]*\r?\n/.test(body) && !body.includes('$') && !body.includes('~') && !entity.test(body)
      && !body.includes('openchamber://session/')
      && !/(?:^|\r?\n) {0,3}\\\[/.test(body)) {
      changes.push(candidate, end);
    }
    candidate = null;
  }
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
    const tail = prepared.resumeAt === null ? '' : source.slice(prepared.resumeAt);
    const safeTail = streaming && prepared.resumeAt !== null
      && /^[ \t]*\r?\n[ \t]*\r?\n/.test(tail) && !tail.includes('\\[');
    previous = { source, prepared, safeTail };
    return prepared;
  };
}
