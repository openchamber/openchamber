export const REMOTE_SELECTION_EXPRESSION = `(() => {
  let root = document;
  let ownerDocument = document;
  for (let depth = 0; depth < 64; depth += 1) {
    const active = root.activeElement;
    if (active?.tagName === 'IFRAME' || active?.tagName === 'FRAME') {
      const childDocument = active.contentDocument;
      if (!childDocument) return { code: 'COPY_FAILED' };
      root = childDocument;
      ownerDocument = childDocument;
      continue;
    }
    if (active?.shadowRoot) {
      root = active.shadowRoot;
      continue;
    }
    let text;
    if (active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA') {
      if (active.type === 'password' || !Number.isInteger(active.selectionStart)
        || !Number.isInteger(active.selectionEnd)) return { text: '' };
      if (active.selectionEnd - active.selectionStart > 65536) return { code: 'COPY_TOO_LARGE' };
      text = active.value.slice(active.selectionStart, active.selectionEnd);
    } else {
      const selection = root.getSelection?.() ?? ownerDocument.getSelection();
      text = selection?.toString() ?? '';
    }
    return text.length > 65536 ? { code: 'COPY_TOO_LARGE' } : { text };
  }
  return { code: 'COPY_FAILED' };
})()`;
