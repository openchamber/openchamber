import { parseMarkdownIntoBlocks } from 'streamdown';

const CONTAINED_BLOCK = /^(?: {0,3}(?:`{3,}|~{3,}|>|[-*+](?:[ \t]|\r?$)|\d{1,9}[.)](?:[ \t]|\r?$))| {4}|\t)/;

export function parseMarkdownBlocksWithMath(source: string): string[] {
  const blocks = parseMarkdownIntoBlocks(source);
  const result: string[] = [];
  let start = -1;
  let open = false;
  for (let i = 0; i < blocks.length; i++) {
    if (open || !CONTAINED_BLOCK.test(blocks[i])) {
      const delimiters = /^([ \t]*)\\\[[\t ]*(?=\r?$)|\\\][\t ]*(?=\r?$)/gm;
      for (const match of blocks[i].matchAll(delimiters)) {
        if (!open && match[1] !== undefined && match[1].length <= 3) {
          open = true;
          if (start === -1) start = i;
        } else if (open && match[1] === undefined) {
          open = false;
        }
      }
    }
    if (!open) {
      result.push(start === -1 ? blocks[i] : blocks.slice(start, i + 1).join(''));
      start = -1;
    }
  }
  if (start !== -1) for (let i = start; i < blocks.length; i++) result.push(blocks[i]);
  return result;
}
