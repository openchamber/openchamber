import { fromMarkdown, type Extension } from 'mdast-util-from-markdown';
import type { Code, RootContent } from 'mdast';
import { parseUiBlock } from './catalog';

export function validateUiBlock(source: string): string[] {
  const result = parseUiBlock(source, true);
  return result.kind === 'invalid' ? result.errors : [];
}

/** Markdown owns containers and escaping; a second fence token proves explicit closure. */
export function closedUiBlocks(text: string, ended: boolean): { offset: number; source: string }[] {
  const fences = new WeakMap<Code, number>();
  const extension: Extension = {
    enter: {
      codeFencedFence() {
        const node = [...this.stack].reverse().find((item) => item.type === 'code');
        if (node?.type === 'code') fences.set(node, (fences.get(node) ?? 0) + 1);
      },
    },
  };
  const tree = fromMarkdown(text, { mdastExtensions: [extension] });
  const blocks: { offset: number; source: string }[] = [];
  const visit = (node: RootContent): void => {
    if (node.type === 'code' && node.lang === 'openui-lang' && !node.meta && fences.get(node) === 2) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined && (ended || /^[\r\n]/.test(text.slice(end)))) {
        blocks.push({ offset: start, source: node.value });
      }
    }
    if ('children' in node) for (const child of node.children) visit(child);
  };
  for (const node of tree.children) visit(node);
  return blocks;
}
