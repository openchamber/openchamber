const CODE_SOURCE_ATTRIBUTE = 'data-oc-code-source';
const isElement = (node: Node): node is Element => node.nodeType === 1;

const trimPartialSource = (range: Range, original: Node, clone: Node): void => {
  if (!isElement(original) || !isElement(clone) || !clone.hasAttribute(CODE_SOURCE_ATTRIBUTE)) return;
  const full = original.ownerDocument.createRange();
  full.selectNodeContents(original);
  if (range.compareBoundaryPoints(0, full) > 0 || range.compareBoundaryPoints(2, full) < 0) {
    clone.removeAttribute(CODE_SOURCE_ATTRIBUTE);
  }
};

export const cloneSelectionContent = (range: Range): DocumentFragment => {
  const fragment = range.cloneContents();
  const common = range.commonAncestorContainer;
  for (const edge of ['start', 'end'] as const) {
    const ancestors: Node[] = [];
    let original: Node | null = edge === 'start' ? range.startContainer : range.endContainer;
    while (original && original !== common) {
      ancestors.push(original);
      original = original.parentNode;
    }
    let clone: Node | null = fragment;
    for (const ancestor of ancestors.reverse()) {
      clone = edge === 'start' ? clone.firstChild : clone.lastChild;
      if (!clone) break;
      trimPartialSource(range, ancestor, clone);
    }
  }
  return fragment;
};

export const cloneSelectionAncestor = (range: Range, original: Element): Node => {
  const clone = original.cloneNode(false);
  trimPartialSource(range, original, clone);
  return clone;
};
