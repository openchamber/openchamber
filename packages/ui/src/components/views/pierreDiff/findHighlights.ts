import type { FileDiffMetadata } from '@pierre/diffs';
import type { DiffFindSide } from '@/lib/diff/diffFind';
import { findWordAtOffset } from '@/lib/diff/findWord';
import { getDiffShadowRoot } from './diffDom';

const FIND_MARK_ATTR = 'data-oc-find-mark';
export const FIND_CURRENT_ATTR = 'data-oc-find-current';
const FIND_STYLE_ATTR = 'data-oc-find-style';

// Injected into the diff's shadow root, so it must not rely on Tailwind. The
// theme's custom properties inherit through the shadow boundary; the tints
// match the Markdown preview's find marks (MarkdownPreviewSearch).
const FIND_MARK_CSS = `
  mark[${FIND_MARK_ATTR}] { background-color: color-mix(in srgb, var(--status-warning) 30%, transparent); color: inherit; border-radius: 2px; }
  mark[${FIND_CURRENT_ATTR}] { background-color: color-mix(in srgb, var(--status-warning) 60%, transparent); }
`;

const clearFindHighlights = (root: ShadowRoot): void => {
  const parents = new Set<Node>();
  root.querySelectorAll(`mark[${FIND_MARK_ATTR}]`).forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    mark.replaceWith(...Array.from(mark.childNodes));
    parents.add(parent);
  });
  parents.forEach((parent) => parent.normalize());
};

export const rowMatchesSide = (row: Element, side: DiffFindSide): boolean => {
  const lineType = row.getAttribute('data-line-type');
  if (lineType === 'deletion' || lineType === 'change-deletion') return side === 'deletions';
  if (lineType === 'addition' || lineType === 'change-addition') return side === 'additions';
  // A context row. Split view renders one in each column, numbered on that
  // column's side, so a row only answers for its own column; the unified
  // column numbers context rows on the additions side.
  const column = row.closest('[data-deletions], [data-additions]');
  if (!column) return side === 'additions';
  return column.hasAttribute('data-deletions') ? side === 'deletions' : side === 'additions';
};

/** A line inside a hunk is always rendered; gaps and trailing context may not be. */
export const isWithinHunk = (fileDiff: FileDiffMetadata | undefined, lineNumber: number, side: DiffFindSide): boolean => {
  if (!fileDiff) return false;
  return fileDiff.hunks.some((hunk) => side === 'additions'
    ? lineNumber >= hunk.additionStart && lineNumber < hunk.additionStart + hunk.additionCount
    : lineNumber >= hunk.deletionStart && lineNumber < hunk.deletionStart + hunk.deletionCount);
};

/**
 * The library's renderability oracle is additions-only, so a deletions line in
 * a collapsed gap is translated to the additions line sharing its row region
 * (the old/new offset is constant across an unchanged gap). Returns undefined
 * when the line is not in a gap.
 */
export const deletionGapToAdditionLine = (hunks: FileDiffMetadata['hunks'], deletionLine: number): number | undefined => {
  for (let index = 0; index <= hunks.length; index += 1) {
    const next = hunks[index];
    const prev = hunks[index - 1];
    const gapStart = prev ? prev.deletionStart + prev.deletionCount : 1;
    const gapEnd = next ? next.deletionStart : Number.POSITIVE_INFINITY;
    if (deletionLine < gapStart || deletionLine >= gapEnd) continue;
    const anchor = next ?? prev;
    return anchor ? deletionLine + (anchor.additionStart - anchor.deletionStart) : undefined;
  }
  return undefined;
};

// A row's text nodes in order — the offset space `wrapRowSpan` and matches share.
const rowTextNodes = (row: HTMLElement): Text[] => {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node instanceof Text) nodes.push(node);
  }
  return nodes;
};

/**
 * Wrap an absolute [spanStart, spanStart + spanLength) range of a row's text in
 * marks: one per text node it covers, each inside that node's own syntax token,
 * so clearing (unwrap, then normalize) gives the row back its exact structure.
 * Wrapping across token boundaries would split the tokens, and the row would
 * collect fragments with every repaint.
 */
const wrapRowSpan = (row: HTMLElement, spanStart: number, spanLength: number, current: boolean): void => {
  const end = spanStart + spanLength;
  let offset = 0;
  for (const node of rowTextNodes(row)) {
    const nodeStart = offset;
    const length = node.nodeValue?.length ?? 0;
    offset += length;
    const from = Math.max(spanStart, nodeStart) - nodeStart;
    const to = Math.min(end, nodeStart + length) - nodeStart;
    if (to <= from) continue;
    let segment = node;
    if (from > 0) segment = segment.splitText(from);
    if (to - from < segment.length) segment.splitText(to - from);
    const mark = document.createElement('mark');
    mark.setAttribute(FIND_MARK_ATTR, '');
    if (current) mark.setAttribute(FIND_CURRENT_ATTR, '');
    segment.replaceWith(mark);
    mark.appendChild(segment);
    if (offset >= end) break;
  }
};

/**
 * The word under a primary-modifier click, read from the row's own text so its
 * `spanStart` matches `DiffFindMatch.spanStart`. Returns null when the caret
 * APIs are unavailable or the point does not land on this row's text.
 */
export const findWordAtPoint = (row: HTMLElement, clientX: number, clientY: number): { word: string; spanStart: number } | null => {
  const root = row.getRootNode();
  if (!(root instanceof ShadowRoot)) return null;
  // SAFETY: Chromium exposes the caret APIs and getSelection on ShadowRoot
  // (CSSOM View's DocumentOrShadowRoot mixin) but lib.dom declares the caret
  // APIs only on Document and omits getSelection from ShadowRoot entirely.
  const host = root as ShadowRoot & {
    caretPositionFromPoint?: (x: number, y: number) => CaretPosition | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    getSelection?: () => Selection | null;
  };
  const caret = host.caretPositionFromPoint?.(clientX, clientY);
  const range = caret ? null : host.caretRangeFromPoint?.(clientX, clientY);
  let node: Node | null = caret?.offsetNode ?? range?.startContainer ?? null;
  let nodeOffset = caret?.offset ?? range?.startOffset ?? 0;
  if (node === null) {
    // Neither caret API is implemented on ShadowRoot in current Chromium; the
    // collapsed caret the browser placed on mousedown is the same information.
    const selection = host.getSelection?.();
    if (!selection?.isCollapsed) return null;
    node = selection.focusNode;
    nodeOffset = selection.focusOffset;
  }
  if (!(node instanceof Text) || node.parentElement?.closest('[data-line]') !== row) return null;

  const nodes = rowTextNodes(row);
  const text = nodes.map((textNode) => textNode.nodeValue ?? '').join('');
  let offset = 0;
  for (const candidate of nodes) {
    if (candidate === node) return findWordAtOffset(text, offset + nodeOffset);
    offset += candidate.nodeValue?.length ?? 0;
  }
  return null;
};

const ensureFindStyle = (root: ShadowRoot): void => {
  if (root.querySelector(`style[${FIND_STYLE_ATTR}]`)) return;
  const style = document.createElement('style');
  style.setAttribute(FIND_STYLE_ATTR, '');
  style.textContent = FIND_MARK_CSS;
  root.appendChild(style);
};

export const applyFindHighlightsToContainer = (
  container: HTMLElement | null,
  matches: ReadonlyArray<{ lineNumber: number; side: DiffFindSide; spanStart: number; spanLength: number }>,
  currentIndex: number,
): void => {
  const root = getDiffShadowRoot(container);
  if (!root) return;
  clearFindHighlights(root);
  if (matches.length === 0) {
    root.querySelector(`style[${FIND_STYLE_ATTR}]`)?.remove();
    return;
  }
  ensureFindStyle(root);
  // One pass over the rendered rows: a virtualized diff renders a window of a
  // file whose matches can run into the thousands.
  const rowsByLine = new Map<string, HTMLElement[]>();
  for (const row of root.querySelectorAll('[data-line]')) {
    const line = row.getAttribute('data-line');
    if (line === null || !(row instanceof HTMLElement)) continue;
    const rows = rowsByLine.get(line);
    if (rows) rows.push(row);
    else rowsByLine.set(line, [row]);
  }
  matches.forEach((match, index) => {
    for (const row of rowsByLine.get(String(match.lineNumber)) ?? []) {
      if (rowMatchesSide(row, match.side)) wrapRowSpan(row, match.spanStart, match.spanLength, index === currentIndex);
    }
  });
};
