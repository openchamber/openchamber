import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { withLineDirectionMarks } from './plainTextLineDirection';
import type { InlineTextNode } from './attachmentCitationChips';

const dom = new Window();
function render(nodes: InlineTextNode[]) {
  const host = dom.document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<div>{withLineDirectionMarks(nodes, 'line')}</div>);
  return host;
}
const marks = (host: ReturnType<typeof render>) => Array.from(host.querySelectorAll('[data-oc-line-dir]'), (mark) => mark.getAttribute('data-oc-line-dir'));

describe('plain-text line direction', () => {
  test('English and Latin-first Arabic lines each take their own direction', () => {
    const text = 'Fix the login screen\nReact هي مكتبة لبناء واجهات المستخدم\n\nשלום';
    const host = render([text]);
    expect(marks(host)).toEqual(['ltr', 'rtl', 'rtl']);
    expect(host.textContent).toBe(text);
  });

  test('chips do not count, and a line without letters gets no mark', () => {
    const chip = <button key="chip" type="button">review-skill-name</button>;
    const host = render(['React ', chip, ' راجع هذا\n42\nok']);
    expect(marks(host)).toEqual(['rtl', 'ltr']);
    expect(host.textContent).toBe('React review-skill-name راجع هذا\n42\nok');
    expect(host.querySelector('[data-oc-line-dir="rtl"]')?.nextSibling?.textContent).toBe('React ');
  });
});
