/**
 * Case-insensitive substring match ranges over a single text string, using
 * the same non-overlapping `String.prototype.indexOf` scan semantics as
 * standard find-in-page (e.g. "aaa" in "aaaa" yields a single [0,3]).
 */
export const findMatchRanges = (text: string, query: string): Array<{ start: number; end: number }> => {
  const normalized = query.trim().toLowerCase();
  const ranges: Array<{ start: number; end: number }> = [];
  if (!normalized) {
    return ranges;
  }
  const lower = text.toLowerCase();
  const starts: number[] = [];
  const ends: number[] = [];
  if (lower.length !== text.length) {
    // Keep the whole-string lowercase result for context-sensitive casing.
    // Map each folded UTF-16 unit back to its original code point so a
    // partial match of an expansion still selects the complete character.
    let offset = 0;
    for (const character of text) {
      const end = offset + character.length;
      for (let unit = 0; unit < character.toLowerCase().length; unit++) {
        starts.push(offset);
        ends.push(end);
      }
      offset = end;
    }
  }
  let cursor = 0;
  let previousEnd = 0;
  while (true) {
    const index = lower.indexOf(normalized, cursor);
    if (index === -1) {
      break;
    }
    const start = starts.length > 0 ? starts[index] : index;
    const end = ends.length > 0 ? ends[index + normalized.length - 1] : index + normalized.length;
    if (start >= previousEnd) {
      ranges.push({ start, end });
      previousEnd = end;
    }
    cursor = index + normalized.length;
  }
  return ranges;
};

/** Match within each text node, preserving the preview's existing semantics. */
export const findPreviewRanges = (container: HTMLElement, query: string): Range[] => {
  if (!query.trim()) return [];
  const document = container.ownerDocument;
  const walker = document.createTreeWalker(container, 4);
  const ranges: Range[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement || node.parentElement.closest('svg, script, style')) continue;
    for (const match of findMatchRanges(node.nodeValue ?? '', query)) {
      const range = document.createRange();
      range.setStart(node, match.start);
      range.setEnd(node, match.end);
      ranges.push(range);
    }
  }
  return ranges;
};

/** Scroll nested code panes and the preview itself to the selected text. */
export const scrollPreviewRangeIntoView = (container: HTMLElement, range: Range): void => {
  const view = container.ownerDocument.defaultView;
  if (!view || !container.contains(range.startContainer)) return;
  for (let element = range.startContainer.parentElement; element; element = element.parentElement) {
    const style = view.getComputedStyle(element);
    const scrollX = /(auto|scroll|hidden)/.test(style.overflowX);
    const scrollY = /(auto|scroll|hidden)/.test(style.overflowY);
    if (scrollX || scrollY) {
      const match = range.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      const top = bounds.top + element.clientTop;
      const left = bounds.left + element.clientLeft;
      const bottom = top + element.clientHeight;
      const right = left + element.clientWidth;
      const y = match.top < top ? match.top - top : Math.max(0, match.bottom - bottom);
      const x = match.left < left ? match.left - left : Math.max(0, match.right - right);
      if ((scrollX && x) || (scrollY && y)) element.scrollBy({ left: scrollX ? x : 0, top: scrollY ? y : 0 });
    }
    if (element === container) break;
  }
};
