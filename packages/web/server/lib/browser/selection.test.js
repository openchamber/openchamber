import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import { REMOTE_SELECTION_EXPRESSION } from './selection.js';

const readSelection = (document) => runInNewContext(REMOTE_SELECTION_EXPRESSION, { document });
const documentWith = (activeElement, text = 'ancestor selection') => ({
  activeElement, getSelection: () => ({ toString: () => text }),
});

describe('remote plain-text selection', () => {
  it.each(['INPUT', 'TEXTAREA'])('reads the selected range of %s without unrelated text', (tagName) => {
    expect(readSelection(documentWith({ tagName, type: 'text', value: 'before selected after',
      selectionStart: 7, selectionEnd: 15 }))).toEqual({ text: 'selected' });
  });

  it('preserves whitespace and newlines in document or contenteditable selection', () => {
    expect(readSelection(documentWith({ tagName: 'DIV', isContentEditable: true }, ' \nselected\t ')))
      .toEqual({ text: ' \nselected\t ' });
    expect(readSelection(documentWith(null, 'document text'))).toEqual({ text: 'document text' });
  });

  it.each([
    { tagName: 'INPUT', type: 'password', value: 'secret', selectionStart: 0, selectionEnd: 6 },
    { tagName: 'INPUT', type: 'number', value: '123', selectionStart: null, selectionEnd: null },
    { tagName: 'TEXTAREA', value: 'text', selectionStart: 2, selectionEnd: 2 },
  ])('does not return passwords, unsupported controls, or a collapsed range', (input) => {
    expect(readSelection(documentWith(input))).toEqual({ text: '' });
  });

  it('follows focus through nested open shadow roots and same-origin frames', () => {
    const input = { tagName: 'TEXTAREA', value: 'frame selected', selectionStart: 6, selectionEnd: 14 };
    const frameDocument = documentWith({ shadowRoot: { activeElement: input } });
    const document = documentWith({ shadowRoot: { activeElement: { tagName: 'IFRAME', contentDocument: frameDocument } } });
    expect(readSelection(document)).toEqual({ text: 'selected' });
  });

  it('reads a shadow-root selection for focused editable content', () => {
    const shadowRoot = { activeElement: { tagName: 'DIV' }, getSelection: () => ({ toString: () => 'shadow text' }) };
    expect(readSelection(documentWith({ shadowRoot }))).toEqual({ text: 'shadow text' });
  });

  it('refuses a focused inaccessible frame instead of returning ancestor selection', () => {
    expect(readSelection(documentWith({ tagName: 'IFRAME', contentDocument: null }))).toEqual({ code: 'COPY_FAILED' });
  });

  it('rejects an oversized selection without returning any of its text', () => {
    expect(readSelection(documentWith(null, 'x'.repeat(64 * 1024 + 1)))).toEqual({ code: 'COPY_TOO_LARGE' });
  });
});
