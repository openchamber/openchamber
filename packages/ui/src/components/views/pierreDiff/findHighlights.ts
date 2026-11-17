import type { FileDiffMetadata } from '@pierre/diffs';
import type { DiffFindSide } from '@/lib/diff/diffFind';
import { findWordAtOffset } from '@/lib/diff/findWord';
import { getDiffShadowRoot } from './diffDom';

const FIND_MARK_ATTR = 'data-oc-find-mark';
export const FIND_CURRENT_ATTR = 'data-oc-find-current';
const FIND_STYLE_ATTR = 'data-oc-find-style';

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
  // external: https://github.com/pierrecomputer/pierre Split context rows use their own column side; unified context rows use additions numbering.
  const column = row.closest('[data-deletions], [data-additions]');
  if (!column) return side === 'additions';
  return column.hasAttribute('data-deletions') ? side === 'deletions' : side === 'additions';
};

export const isWithinHunk = (fileDiff: FileDiffMetadata | undefined, lineNumber: number, side: DiffFindSide): boolean => {
  if (!fileDiff) return false;
  return fileDiff.hunks.some((hunk) => side === 'additions'
    ? lineNumber >= hunk.additionStart && lineNumber < hunk.additionStart + hunk.additionCount
    : lineNumber >= hunk.deletionStart && lineNumber < hunk.deletionStart + hunk.deletionCount);
};

// external: https://github.com/pierrecomputer/pierre The renderability oracle uses additions line numbers; unchanged gaps have a constant old/new offset.
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

const rowTextNodes = (row: HTMLElement): Text[] => {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node instanceof Text) nodes.push(node);
  }
  return nodes;
};

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
    // external: https://developer.mozilla.org/en-US/docs/Web/API/Document/caretPositionFromPoint ShadowRoot lacks caret hit-testing in Chromium; the collapsed mousedown selection supplies the caret.
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
