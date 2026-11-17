import type { Element, ElementContent, Root } from 'hast';
import { proseTextDirection, type TextDirection } from '@/lib/i18n/textDirection';

const PROSE_BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote']);
const SKIPPED = new Set(['code', 'pre', 'ul', 'ol', 'blockquote', 'table', 'details']);
const WORD_BREAKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'br', 'div', 'td', 'th']);

function ownText(node: ElementContent): string {
  if (node.type === 'text') return node.value;
  if (node.type !== 'element' || SKIPPED.has(node.tagName)) return ' ';
  const text = node.children.map(ownText).join('');
  return WORD_BREAKS.has(node.tagName) ? ` ${text} ` : text;
}

function annotate(node: Element): TextDirection | undefined {
  const childDirections = node.children.map((child) => (child.type === 'element' ? annotate(child) : undefined));
  if (PROSE_BLOCKS.has(node.tagName) || node.tagName === 'table') {
    const dir = proseTextDirection(node.children.map(ownText).join(''));
    if (dir) node.properties = { ...node.properties, dir };
    return dir;
  }
  if (node.tagName === 'ul' || node.tagName === 'ol') {
    const itemDirections = new Set(childDirections.filter(Boolean));
    if (itemDirections.size === 1) node.properties = { ...node.properties, dir: [...itemDirections][0] };
  }
  return undefined;
}

export function rehypeTextDirection() {
  return (tree: Root) => {
    for (const child of tree.children) {
      if (child.type === 'element') annotate(child);
    }
  };
}
