/**
 * Comment-preserving edits for the JSONC config writers (`writeConfig` in
 * `shared.js` and in the VS Code extension's `opencodeConfig.ts`).
 *
 * The writers diff the parsed file against the wanted config and edit only
 * what changed. An array used to be replaced whole, which dropped every
 * comment inside it. When the wanted array only appends to the one on disk,
 * or only removes items from it, the edits below touch just those items. A
 * removed item or property that sat alone on its line takes the line with it,
 * so adding something and removing it again gives back the original text.
 * Anything else still replaces the array, and the writers' round-trip check
 * runs after these edits as after any other.
 */
import { createScanner, findNodeAtLocation, parseTree, SyntaxKind } from 'jsonc-parser';

/**
 * Item edits turning `current` into `next`, or `null` when `next` is not
 * `current` with items appended or removed. Removals come last index first,
 * so each one still finds its item.
 */
export function diffArrayItems(current, next, basePath, isEqual) {
  if (next.length > current.length && current.every((item, index) => isEqual(item, next[index]))) {
    return next.slice(current.length).map((value, offset) => ({
      type: 'insert-item',
      path: [...basePath, current.length + offset],
      value,
    }));
  }
  if (next.length < current.length) {
    const removed = [];
    let kept = 0;
    for (let index = 0; index < current.length; index += 1) {
      if (kept < next.length && isEqual(current[index], next[kept])) kept += 1;
      else removed.push(index);
    }
    if (kept !== next.length) return null;
    return removed.reverse().map((index) => ({ type: 'remove-item', path: [...basePath, index] }));
  }
  return null;
}

// The first token after `start`, comments skipped, when it is a comma before `end`.
function findSeparatorComma(text, start, end) {
  if (end <= start) return -1;
  const scanner = createScanner(text, true);
  scanner.setPosition(start);
  const token = scanner.scan();
  const offset = scanner.getTokenOffset();
  return token === SyntaxKind.CommaToken && offset < end ? offset : -1;
}

const isBlank = (value) => /^[ \t]*$/.test(value);

const lineStartOf = (text, offset) => text.lastIndexOf('\n', offset - 1) + 1;

// Offset of the line break ending the line at `offset` (`\r` of a `\r\n`), or the text length.
const lineEndOf = (text, offset) => {
  const newline = text.indexOf('\n', offset);
  if (newline === -1) return text.length;
  return newline > 0 && text[newline - 1] === '\r' ? newline - 1 : newline;
};

/**
 * Edits removing the node spanning `[start, end)` and one separator comma:
 * the one after it, else the one before it. A node alone on its line (its
 * comma after it included) goes with the whole line; on a shared line the
 * blanks between the node and its neighbour's comma go with it.
 */
export function removeNodeEdits(text, start, end, { nextStart, previousEnd }) {
  const commaAfter = findSeparatorComma(text, end, nextStart);
  let commaBefore = commaAfter === -1 ? findSeparatorComma(text, previousEnd, start) : -1;
  let removeStart = start;
  let removeEnd = commaAfter !== -1 && isBlank(text.slice(end, commaAfter)) ? commaAfter + 1 : end;

  const lineStart = lineStartOf(text, start);
  const lineEnd = lineEndOf(text, removeEnd);
  if (isBlank(text.slice(lineStart, start)) && isBlank(text.slice(removeEnd, lineEnd)) && lineEnd < text.length) {
    removeStart = lineStart;
    removeEnd = text.indexOf('\n', lineEnd) + 1;
  } else if (commaBefore !== -1 && isBlank(text.slice(commaBefore + 1, start))) {
    removeStart = commaBefore;
    commaBefore = -1;
  } else if (removeEnd === commaAfter + 1) {
    let blankStart = start;
    while (blankStart > 0 && (text[blankStart - 1] === ' ' || text[blankStart - 1] === '\t')) blankStart -= 1;
    if (blankStart < start && text[blankStart - 1] === ',') removeStart = blankStart;
  }

  const edits = [{ offset: removeStart, length: removeEnd - removeStart, content: '' }];
  if (commaAfter !== -1 && commaAfter >= removeEnd) edits.push({ offset: commaAfter, length: 1, content: '' });
  if (commaBefore !== -1) edits.push({ offset: commaBefore, length: 1, content: '' });
  return edits;
}

/**
 * Text edits for one `insert-item` (an append) or `remove-item` edit, or
 * `null` for an append to an empty array, which the caller leaves to
 * jsonc-parser's own insertion. An append to a list laid out one item per
 * line goes on a new line after the last item's line, with that item's
 * indentation and the list's trailing-comma style.
 */
export function arrayItemTextEdits(text, edit, eol) {
  const root = parseTree(text, [], { allowTrailingComma: true });
  const arrayPath = edit.path.slice(0, -1);
  const index = edit.path.at(-1);
  const arrayNode = root && (arrayPath.length > 0 ? findNodeAtLocation(root, arrayPath) : root);
  if (!arrayNode || arrayNode.type !== 'array') throw new Error('Failed to locate config array');
  const items = arrayNode.children ?? [];
  const closing = arrayNode.offset + arrayNode.length - 1;

  if (edit.type === 'remove-item') {
    const node = items[index];
    if (!node) throw new Error('Failed to locate config array item for removal');
    const previous = items[index - 1];
    return removeNodeEdits(text, node.offset, node.offset + node.length, {
      nextStart: items[index + 1]?.offset ?? closing,
      previousEnd: previous ? previous.offset + previous.length : arrayNode.offset + 1,
    });
  }

  const last = items.at(-1);
  if (!last || index !== items.length) return null;
  const lastEnd = last.offset + last.length;
  const trailingComma = findSeparatorComma(text, lastEnd, closing);
  const afterItem = trailingComma === -1 ? lastEnd : trailingComma + 1;
  const serialized = JSON.stringify(edit.value);
  const lead = text.slice(lineStartOf(text, last.offset), last.offset);
  const lineEnd = lineEndOf(text, afterItem);

  if (!isBlank(lead) || lineEnd >= closing) {
    return trailingComma === -1
      ? [{ offset: lastEnd, length: 0, content: `, ${serialized}` }]
      : [{ offset: afterItem, length: 0, content: ` ${serialized},` }];
  }
  const line = `${eol}${lead}${serialized}${trailingComma === -1 ? '' : ','}`;
  return trailingComma === -1
    ? [{ offset: lastEnd, length: 0, content: ',' }, { offset: lineEnd, length: 0, content: line }]
    : [{ offset: lineEnd, length: 0, content: line }];
}
