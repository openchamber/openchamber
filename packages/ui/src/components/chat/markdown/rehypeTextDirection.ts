import type { Element, ElementContent, Root } from 'hast';
import { proseTextDirection, type TextDirection } from '@/lib/i18n/textDirection';

// Blocks that take the direction of their own words.
const PROSE_BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote']);
// Content that never counts toward the block around it: code, and nested
// containers whose blocks resolve on their own.
const SKIPPED = new Set(['code', 'pre', 'ul', 'ol', 'blockquote', 'table', 'details']);
// Raw HTML such as `<p>a</p><p>b</p>` has no whitespace between blocks.
const WORD_BREAKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'br', 'div']);

function ownText(node: ElementContent): string {
  if (node.type === 'text') return node.value;
  if (node.type !== 'element' || SKIPPED.has(node.tagName)) return ' ';
  const text = node.children.map(ownText).join('');
  return WORD_BREAKS.has(node.tagName) ? ` ${text} ` : text;
}

function annotate(node: Element): TextDirection | undefined {
  const childDirections = node.children.map((child) => (child.type === 'element' ? annotate(child) : undefined));
  if (PROSE_BLOCKS.has(node.tagName)) {
    const dir = proseTextDirection(node.children.map(ownText).join(''));
    if (dir) node.properties = { ...node.properties, dir };
    return dir;
  }
  if (node.tagName === 'ul' || node.tagName === 'ol') {
    // A list whose items all run one way takes that direction too, so its
    // gutter and markers sit on their side. A mixed list keeps the direction
    // around it, and each item keeps its own.
    const itemDirections = new Set(childDirections.filter(Boolean));
    if (itemDirections.size === 1) node.properties = { ...node.properties, dir: [...itemDirections][0] };
  }
  return undefined;
}

/**
 * Gives every paragraph, heading, list item and quote the direction most of
 * its own words run, so Arabic prose that opens with an English term reads
 * right to left, and English and Arabic siblings each keep their own
 * direction. A nested list or quote resolves on its own, and code never
 * counts. Runs after `rehypeSanitize`, which drops any `dir` from raw HTML, so
 * every `dir` here is ours.
 */
export function rehypeTextDirection() {
  return (tree: Root) => {
    for (const child of tree.children) {
      if (child.type === 'element') annotate(child);
    }
  };
}
