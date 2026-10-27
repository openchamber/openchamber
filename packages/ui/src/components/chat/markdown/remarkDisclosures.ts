import type { Heading, PhrasingContent, Root, RootContent, Parent } from 'mdast';
import type { Processor } from 'unified';

function isMarkdownRoot(tree: ReturnType<Processor['parse']>): tree is Root {
  return tree.type === 'root';
}

const opening = /^ {0,3}<details(?:\s+(open(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?))?\s*>\s*<summary\s*>([\s\S]*?)<\/summary\s*>/i;

function rebasePositions(tree: Root | RootContent, source: string, offset: number): void {
  const prefix = source.slice(0, offset).split(/\r\n|\r|\n/);
  const lineOffset = prefix.length - 1;
  const columnOffset = prefix[prefix.length - 1].length;
  function walk(node: Root | RootContent): void {
    if (node.position) {
      for (const point of [node.position.start, node.position.end]) {
        if (!point) continue;
        if (point.line === 1) point.column += columnOffset;
        point.line += lineOffset;
        if (point.offset !== undefined) point.offset += offset;
      }
    }
    if ('children' in node) for (const child of node.children) walk(child);
  }
  walk(tree);
}

// GitHub review bodies title disclosures with a heading tag. Inside the summary
// that tag forms its own HTML block, so it is read here into a heading node:
// the heading renders with and without raw HTML instead of as literal markup.
// Its attributes (GitHub bodies use align) are dropped with the tag.
const headingTag = /^(\s*<h([1-6])(?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=]+))?)*\s*>)([\s\S]*?)<\/h\2\s*>\s*$/i;
const headingDepths: Heading['depth'][] = [1, 2, 3, 4, 5, 6];

interface DisclosureSummary extends Parent {
  type: 'ocDisclosureSummary';
  children: Array<PhrasingContent | Heading>;
  data: { hName: 'summary' };
}

interface Disclosure extends Parent {
  type: 'ocDisclosure';
  children: RootContent[];
  data: { hName: 'details'; hProperties: { open?: boolean } };
}

declare module 'mdast' {
  interface BlockContentMap { ocDisclosure: Disclosure }
  interface RootContentMap { ocDisclosure: Disclosure; ocDisclosureSummary: DisclosureSummary }
}

// The scanner only identifies the disclosure boundary. Its body and summary
// go back through the same CommonMark parser, including nested disclosures.
function disclosureEnd(source: string, start: number) {
  const markers = /(^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$))|(`+)|(<\/?details\b[^>]*>)/gim;
  markers.lastIndex = start;
  let depth = 1;
  let marker: RegExpExecArray | null;
  while ((marker = markers.exec(source))) {
    if (marker[2]) {
      const fence = marker[2];
      const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[\\t ]*(?:\\r?\\n|$)`, 'gm');
      close.lastIndex = markers.lastIndex;
      if (!close.exec(source)) break;
      markers.lastIndex = close.lastIndex;
    } else if (marker[3]) {
      const ticks = /`+/g;
      ticks.lastIndex = markers.lastIndex;
      let close: RegExpExecArray | null;
      while ((close = ticks.exec(source))) {
        if (close[0].length === marker[3].length) { markers.lastIndex = ticks.lastIndex; break; }
      }
    } else if (marker[4]) {
      const lineStart = source.lastIndexOf('\n', marker.index - 1) + 1;
      const prefix = source.slice(lineStart, marker.index);
      if (/^(?: {4}|\t| {0,3}>)/.test(prefix) || /(?:^|[^\\])(?:\\\\)*\\$/.test(prefix)) continue;
      depth += /^<\//.test(marker[4]) ? -1 : 1;
      if (depth === 0) return { bodyEnd: marker.index, end: markers.lastIndex };
    }
  }
  return { bodyEnd: source.length, end: source.length };
}

export function remarkDisclosures(this: Processor) {
  const parse = (source: string): Root => {
    const tree = this.parse(source);
    if (!isMarkdownRoot(tree)) throw new Error('Disclosure parsing requires a Markdown root');
    // Micromark consumes an initial BOM without counting it in positions.
    // Restore local source coordinates before mapping into the parent source.
    if (source.startsWith('\uFEFF')) rebasePositions(tree, source, 1);
    return tree;
  };
  const transform = (tree: Root | RootContent, source: string): void => {
    if (!('children' in tree)) return;
    const children: RootContent[] = tree.children;
    // Reparse only this container, with one level of quote markers removed.
    if (tree.type === 'blockquote') {
      const start = tree.position?.start?.offset;
      const end = tree.position?.end?.offset;
      if (start === undefined || end === undefined) return;
      const offsets: number[] = [];
      let local = '';
      let cursor = start;
      for (const line of source.slice(start, end).split(/(?<=\n)/)) {
        const prefix = /^ {0,3}> ?/.exec(line)?.[0].length ?? 0;
        for (let i = prefix; i < line.length; i++) {
          offsets.push(cursor + i);
          local += line[i];
        }
        cursor += line.length;
      }
      offsets.push(end);
      const body = parse(local);
      transform(body, local);
      const restore = (node: Root | RootContent): void => {
        if (node.position) for (const point of [node.position.start, node.position.end]) {
          if (!point || point.offset === undefined) continue;
          point.offset = offsets[point.offset] ?? end;
          const lines = source.slice(0, point.offset).split(/\r\n|\r|\n/);
          point.line = lines.length;
          point.column = lines[lines.length - 1].length + 1;
        }
        if ('children' in node) for (const child of node.children) restore(child);
      };
      restore(body);
      children.splice(0, children.length, ...body.children);
      return;
    }
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.type !== 'html') { transform(child, source); continue; }
      const start = child.position?.start?.offset;
      if (start === undefined) continue;
      const match = opening.exec(source.slice(start));
      if (!match) continue;
      const bodyStart = start + match[0].length;
      const { bodyEnd, end } = disclosureEnd(source, bodyStart);
      const bodySource = source.slice(bodyStart, bodyEnd);
      const body = parse(bodySource);
      transform(body, bodySource);
      rebasePositions(body, source, bodyStart);
      const summaryMarker = /<summary\s*>/i.exec(match[0]);
      const summaryStart = start + (summaryMarker?.index ?? 0) + (summaryMarker?.[0].length ?? 0);
      const summarySource = match[2] ?? '';
      const tag = headingTag.exec(summarySource);
      const textSource = tag ? tag[3] : summarySource;
      const summaryTree = parse(textSource);
      rebasePositions(summaryTree, source, summaryStart + (tag?.[1].length ?? 0));
      const first = summaryTree.children[0];
      const text = first?.type === 'paragraph' ? first.children : [{ type: 'text' as const, value: textSource }];
      const depth = headingDepths.find((value) => String(value) === tag?.[2]);
      const summary: DisclosureSummary = {
        type: 'ocDisclosureSummary', data: { hName: 'summary' },
        children: depth ? [{ type: 'heading', depth, children: text }] : text,
      };
      const disclosure: Disclosure = { type: 'ocDisclosure', data: { hName: 'details', hProperties: match[1] ? { open: true } : {} }, children: [summary, ...body.children] };
      let count = 1;
      let consumedEnd = child.position?.end?.offset ?? end;
      while (i + count < children.length) {
        const next = children[i + count];
        if ((next.position?.start?.offset ?? source.length) >= end) break;
        consumedEnd = next.position?.end?.offset ?? end;
        count++;
      }
      const suffixTree = parse(source.slice(end, consumedEnd));
      rebasePositions(suffixTree, source, end);
      const suffix = suffixTree.children;
      children.splice(i, count, disclosure, ...suffix);
    }
  };
  return (tree: Root, file: { toString(): string }) => transform(tree, file.toString());
}
