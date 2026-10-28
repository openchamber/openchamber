const CODE_SOURCE_ATTRIBUTE = 'data-oc-code-source';
const OPENUI_SOURCE_ATTRIBUTE = 'data-oc-openui-source';
const isElement = (node: Node): node is Element => node.nodeType === 1;

export const isOpenUISourceNode = (element: Element): boolean => element.hasAttribute(OPENUI_SOURCE_ATTRIBUTE);

export const normalizeOpenUISourceNodes = (root: Element): void => {
  const nodes = [root, ...Array.from(root.querySelectorAll(`[${OPENUI_SOURCE_ATTRIBUTE}]`))]
    .filter((element) => isOpenUISourceNode(element));
  for (const node of nodes) {
    const source = node.getAttribute(OPENUI_SOURCE_ATTRIBUTE);
    if (source === null) continue;
    const pre = root.ownerDocument.createElement('pre');
    const code = root.ownerDocument.createElement('code');
    code.className = 'language-openui-lang';
    code.textContent = source;
    pre.append(code);
    node.replaceWith(pre);
  }
};

const trimPartialSource = (range: Range, original: Node, clone: Node): void => {
  if (!isElement(original) || !isElement(clone) || clone.hasAttribute(OPENUI_SOURCE_ATTRIBUTE)
    || !clone.hasAttribute(CODE_SOURCE_ATTRIBUTE) || isOpenUISourceNode(original)) return;
  const full = original.ownerDocument.createRange();
  full.selectNodeContents(original);
  if (range.compareBoundaryPoints(0, full) > 0 || range.compareBoundaryPoints(2, full) < 0) {
    clone.removeAttribute(CODE_SOURCE_ATTRIBUTE);
  }
};

/** Clone selected DOM without letting a partial code shell copy its full source. */
export const cloneSelectionContent = (range: Range): DocumentFragment => {
  const fragment = range.cloneContents();
  const common = range.commonAncestorContainer;
  // Only the two boundary ancestor chains can be partially cloned. Each chain
  // becomes the first/last child path in the fragment; contained middle
  // subtrees keep their metadata without a scan or a positional query match.
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

/** Restore a missing ancestor using the same source-coverage rule as the fragment. */
export const cloneSelectionAncestor = (range: Range, original: Element): Node => {
  const clone = original.cloneNode(false);
  trimPartialSource(range, original, clone);
  return clone;
};
