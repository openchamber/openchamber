import type { Root, RootContent } from 'mdast';

import { replaceEmojiShortcodes, type EmojiShortcodes } from '@/lib/emoji/shortcodes';

const SKIPPED: ReadonlySet<string> = new Set(['inlineCode', 'code', 'html', 'math', 'inlineMath']);

export function remarkEmojiShortcodes(shortcodes: EmojiShortcodes) {
  return (tree: Root) => {
    const walk = (node: Root | RootContent): void => {
      if (SKIPPED.has(node.type)) return;
      if (node.type === 'text') { node.value = replaceEmojiShortcodes(node.value, shortcodes); return; }
      if ('children' in node) for (const child of node.children) walk(child);
    };
    walk(tree);
  };
}
