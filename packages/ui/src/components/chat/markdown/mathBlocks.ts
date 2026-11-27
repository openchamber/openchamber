import { parseMarkdownIntoBlocks } from 'streamdown';

const CONTAINED_BLOCK = /^(?: {0,3}(?:`{3,}|~{3,}|>|[-*+](?:[ \t]|\r?$)|\d{1,9}[.)](?:[ \t]|\r?$))| {4}|\t)/;

export function parseMarkdownBlocksWithMath(source: string): string[] {
  let blocks = parseMarkdownIntoBlocks(source);
  if (source.includes('\\[')) {
    const normalized = source.replace(/\r\n?/g, '\n');
    if (blocks.join('') !== normalized) {
      const restored: string[] = [];
      const rejected = new Set<string>();
      let offset = 0;
      for (const block of blocks) {
        if (!block) continue;
        let start = offset;
        if (!normalized.startsWith(block, offset)) {
          if (rejected.has(block)) continue;
          start = normalized.indexOf(block, offset);
          while (start >= 0) {
            if (start === 0 || normalized[start - 1] === '\n') {
              const prefix = parseMarkdownIntoBlocks(normalized.slice(offset, start + block.length));
              if (prefix[prefix.length - 1] === block) break;
            }
            start = normalized.indexOf(block, start + 1);
          }
          if (start < 0) { rejected.add(block); continue; }
        }
        if (start > offset) restored.push(normalized.slice(offset, start));
        restored.push(block);
        offset = start + block.length;
        rejected.clear();
      }
      if (offset < normalized.length) restored.push(normalized.slice(offset));
      blocks = restored;
    }
  }
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
